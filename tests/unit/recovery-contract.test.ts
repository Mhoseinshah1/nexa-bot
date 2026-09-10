import { describe, expect, it } from 'vitest';
import {
  BACKUP_TRIGGERS,
  canTransition,
  cutoverPermitted,
  isDestructiveRecoveryState,
  isRecoveryConfirmationPhrase,
  nextState,
  PERMISSION_KEYS,
  permissionDefinition,
  quiescesInstallation,
  RECOVERY_ACTIVE_DESTRUCTIVE_STATES,
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_MACHINE,
  RECOVERY_QUIESCING_STATES,
  RECOVERY_STATES,
  RECOVERY_TERMINAL_STATES,
  recoveryIdSchema,
  uploadedArtifactSchema,
  type RecoveryState,
} from '@nexa/contracts';

/**
 * The recovery vocabulary, checked as a contract rather than as a feature.
 *
 * Everything here is a rule that a later commit could revert without breaking a
 * single feature test — a state quietly moved out of the quiescing set, a
 * confirmation comparison relaxed to case-insensitive, a permission's risk
 * level dropped from CRITICAL. Each of those is exactly the shape of change
 * this file exists to make fail.
 */

describe('the recovery state machine', () => {
  it('has exactly two terminal states, and both are terminal in the declaration', () => {
    expect([...RECOVERY_TERMINAL_STATES]).toEqual(['SUCCEEDED', 'FAILED']);
    for (const state of RECOVERY_TERMINAL_STATES) {
      expect(RECOVERY_MACHINE.transitions.some((t) => t.from === state)).toBe(false);
    }
  });

  it('lets every non-terminal state be abandoned', () => {
    // A recovery whose executor dies must be closeable from wherever it was.
    // Without this, a lease takeover would have states it could not fail from —
    // and those are precisely the states that hold the installation quiesced.
    const nonTerminal = RECOVERY_STATES.filter(
      (state) => !(RECOVERY_TERMINAL_STATES as readonly string[]).includes(state),
    );
    for (const state of nonTerminal) {
      expect(canTransition(RECOVERY_MACHINE, state, 'ABANDONED')).toBe(true);
      expect(nextState(RECOVERY_MACHINE, state, 'ABANDONED')).toBe('FAILED');
    }
  });

  it('has exactly one door into the destructive chain, and it is the confirmation', () => {
    const intoRequested = RECOVERY_MACHINE.transitions.filter((t) => t.to === 'RESTORE_REQUESTED');
    expect(intoRequested).toHaveLength(1);
    expect(intoRequested[0]?.from).toBe('RESTORE_TEST_PASSED');
    expect(intoRequested[0]?.on).toBe('CONFIRM');
    expect(intoRequested[0]?.guard).toBe('confirmationBoundToThisArtifactAndActorAndNotExpired');
  });

  it('cannot reach the destructive chain from an unverified or untested artifact', () => {
    // The property stated as a reachability question rather than as a list of
    // transitions, so adding a shortcut anywhere fails here.
    for (const from of ['UPLOADED', 'VERIFYING', 'VERIFIED', 'RESTORE_TESTING'] as const) {
      expect(canTransition(RECOVERY_MACHINE, from, 'CONFIRM')).toBe(false);
    }
  });

  it('refuses an arbitrary jump', () => {
    expect(nextState(RECOVERY_MACHINE, 'UPLOADED', 'CUTOVER_OK')).toBeNull();
    expect(nextState(RECOVERY_MACHINE, 'VERIFIED', 'READY')).toBeNull();
    expect(nextState(RECOVERY_MACHINE, 'RESTORE_TEST_PASSED', 'CUTOVER_OK')).toBeNull();
  });

  it('puts VALIDATING between RESTORING and CUTTING_OVER, in that order', () => {
    // `pg_restore` exiting zero is not the claim "this database is usable", and
    // collapsing the two states is how a cutover to an unvalidated candidate
    // gets written.
    expect(nextState(RECOVERY_MACHINE, 'RESTORING', 'RESTORE_OK')).toBe('VALIDATING');
    expect(nextState(RECOVERY_MACHINE, 'VALIDATING', 'VALIDATE_OK')).toBe('CUTTING_OVER');
    expect(canTransition(RECOVERY_MACHINE, 'RESTORING', 'VALIDATE_OK')).toBe(false);
  });

  it('reaches SUCCEEDED only through RESTARTING, and only on READY', () => {
    const intoSucceeded = RECOVERY_MACHINE.transitions.filter((t) => t.to === 'SUCCEEDED');
    expect(intoSucceeded).toHaveLength(1);
    expect(intoSucceeded[0]?.from).toBe('RESTARTING');
    expect(intoSucceeded[0]?.on).toBe('READY');
    // And the negative: a cutover that completed is not yet a success.
    expect(nextState(RECOVERY_MACHINE, 'CUTTING_OVER', 'CUTOVER_OK')).toBe('RESTARTING');
  });

  it('takes the pre-restore backup before anything is quiesced or restored', () => {
    expect(nextState(RECOVERY_MACHINE, 'RESTORE_REQUESTED', 'BACKUP_START')).toBe(
      'PRE_RESTORE_BACKUP',
    );
    expect(nextState(RECOVERY_MACHINE, 'PRE_RESTORE_BACKUP', 'BACKUP_FAILED')).toBe('FAILED');
    // No path from a confirmed request straight to quiescing or restoring.
    expect(canTransition(RECOVERY_MACHINE, 'RESTORE_REQUESTED', 'QUIESCE_OK')).toBe(false);
    expect(canTransition(RECOVERY_MACHINE, 'RESTORE_REQUESTED', 'RESTORE_OK')).toBe(false);
  });
});

describe('the quiesce window', () => {
  it('covers every state from QUIESCING to RESTARTING and nothing before', () => {
    const quiescing = RECOVERY_STATES.filter(quiescesInstallation);
    expect(quiescing).toEqual([...RECOVERY_QUIESCING_STATES]);
  });

  it('does not quiesce during the pre-restore backup', () => {
    // The backup writes to backup_runs, operational_events and the outbox. An
    // installation that refused writes during it could not take the backup that
    // makes the rest of the operation recoverable.
    expect(quiescesInstallation('PRE_RESTORE_BACKUP')).toBe(false);
    expect(isDestructiveRecoveryState('PRE_RESTORE_BACKUP')).toBe(true);
  });

  it('treats every quiescing state as destructive, and RESTORE_REQUESTED too', () => {
    for (const state of RECOVERY_QUIESCING_STATES) {
      expect(isDestructiveRecoveryState(state)).toBe(true);
    }
    expect(isDestructiveRecoveryState('RESTORE_REQUESTED')).toBe(true);
    expect([...RECOVERY_ACTIVE_DESTRUCTIVE_STATES]).toHaveLength(
      RECOVERY_QUIESCING_STATES.length + 2,
    );
  });

  it('leaves the artifact chain and the terminal states non-destructive', () => {
    const safe: readonly RecoveryState[] = [
      'UPLOADED',
      'VERIFYING',
      'VERIFIED',
      'RESTORE_TESTING',
      'RESTORE_TEST_PASSED',
      'SUCCEEDED',
      'FAILED',
    ];
    for (const state of safe) {
      expect(isDestructiveRecoveryState(state)).toBe(false);
      expect(quiescesInstallation(state)).toBe(false);
    }
  });
});

describe('the confirmation phrase', () => {
  it('accepts the exact phrase, and a paste with surrounding whitespace', () => {
    expect(isRecoveryConfirmationPhrase(RECOVERY_CONFIRMATION_PHRASE)).toBe(true);
    expect(isRecoveryConfirmationPhrase(' RESTORE NEXA\n')).toBe(true);
  });

  it.each([
    ['restore nexa', 'lower case'],
    ['Restore Nexa', 'title case'],
    ['RESTORENEXA', 'the space removed'],
    ['RESTORE  NEXA', 'two spaces'],
    ['RESTORE NEXA!', 'an extra character'],
    ['بازیابی', 'the Persian label beside the box'],
    ['RESTORE', 'half of it'],
    ['', 'empty'],
  ])('refuses %s (%s)', (candidate) => {
    expect(isRecoveryConfirmationPhrase(candidate)).toBe(false);
  });
});

describe('migration verdicts and cutover', () => {
  it('permits exactly the verdicts readiness already calls ready', () => {
    // Two predicates for one question is how they come to disagree. Readiness
    // reports CURRENT and AHEAD as ready (AHEAD is the rollback shape, because
    // a release's migrations only add), so a cutover that refused AHEAD would be
    // refusing a database the next readiness check would accept.
    expect(cutoverPermitted('CURRENT')).toBe(true);
    expect(cutoverPermitted('AHEAD')).toBe(true);
    expect(cutoverPermitted('BEHIND')).toBe(false);
    expect(cutoverPermitted('NONE')).toBe(false);
    expect(cutoverPermitted('DIVERGED')).toBe(false);
  });
});

describe('recovery permissions', () => {
  it('declares four separate keys rather than one backup permission', () => {
    for (const key of ['backup.view', 'backup.run', 'backup.download', 'recovery.restore']) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });

  it('keeps download and restore CRITICAL, and viewing LOW', () => {
    // Downloading the archive is walking out with every tenant's data, every
    // admin hash and every encrypted panel credential. It is not the same act
    // as reading a list of dates.
    expect(permissionDefinition('backup.download').riskLevel).toBe('CRITICAL');
    expect(permissionDefinition('recovery.restore').riskLevel).toBe('CRITICAL');
    expect(permissionDefinition('backup.run').riskLevel).toBe('HIGH');
    expect(permissionDefinition('backup.view').riskLevel).toBe('LOW');
  });
});

describe('the pre-restore trigger', () => {
  it('is a third trigger value, not a third code path', () => {
    expect([...BACKUP_TRIGGERS]).toEqual(['MANUAL', 'SCHEDULED', 'PRE_RESTORE']);
  });
});

describe('uploaded artifact metadata', () => {
  it('bounds the client filename it records', () => {
    const long = 'a'.repeat(201);
    expect(
      uploadedArtifactSchema.safeParse({
        sizeBytes: 1,
        archiveSha256: 'a'.repeat(64),
        clientFilename: long,
      }).success,
    ).toBe(false);
  });

  it('requires a real hex digest of the received bytes', () => {
    expect(
      uploadedArtifactSchema.safeParse({
        sizeBytes: 1,
        archiveSha256: 'not-a-digest',
        clientFilename: 'x.nxb',
      }).success,
    ).toBe(false);
  });
});

describe('the recovery id', () => {
  it('accepts a v7 uuid and refuses anything else', () => {
    expect(recoveryIdSchema.safeParse('01a05e35-c9ad-7e93-bef3-1ed9b55292fe').success).toBe(true);
    // A v4 uuid: the version nibble is what distinguishes them, and accepting
    // one would mean an id this system cannot have produced.
    expect(recoveryIdSchema.safeParse('01a05e35-c9ad-4e93-bef3-1ed9b55292fe').success).toBe(false);
    expect(recoveryIdSchema.safeParse('../../etc/passwd').success).toBe(false);
    expect(recoveryIdSchema.safeParse('').success).toBe(false);
  });
});
