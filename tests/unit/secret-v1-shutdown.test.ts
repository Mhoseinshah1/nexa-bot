import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shutdownVerdict, type ShutdownEvidence } from '../../apps/api/src/secrets.cli';
import { acceptsV1 } from '../../apps/api/src/infrastructure/config/config.schema';
import { parseKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';

/**
 * Turning v1 off, and the gate that decides when.
 *
 * `SECRETS_ACCEPT_V1=false` on an installation that still holds a v1 row does
 * not fail at boot. It fails the first time something reads that row — in
 * production, one credential at a time, at whatever hour that read happens.
 * There is no safe way to discover this afterwards, so the whole question has
 * to be answered before the switch moves.
 */
const READY: ShutdownEvidence = {
  v1Rows: 0,
  unknownRows: 0,
  mismatchedRows: 0,
  format: 'canonical',
  activeKeyId: 'install-20260903',
  configuredKeyIds: ['install-20260903'],
};

const blockers = (evidence: Partial<ShutdownEvidence>): string =>
  shutdownVerdict({ ...READY, ...evidence }).blockers.join(' | ');

describe('the v1 shutdown gate', () => {
  it('is ready only when every condition holds', () => {
    const verdict = shutdownVerdict(READY);
    expect(verdict.ready).toBe(true);
    expect(verdict.blockers).toEqual([]);
  });

  it('is blocked by a remaining v1 row', () => {
    const verdict = shutdownVerdict({ ...READY, v1Rows: 3 });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('3 row(s) still hold a v1 envelope');
    // A blocker without a next step is how an operator ends up hand-editing
    // nexa.env, which is the thing this command exists to replace.
    expect(verdict.blockers.join(' ')).toContain('botctl secrets rewrap');
  });

  it('is blocked by a key-id mismatch', () => {
    // Retirement counts the stored COLUMN. A row whose column disagrees with
    // its envelope could let a key be retired while ciphertext still needs it,
    // so a mismatch is never "ready", however few v1 rows remain.
    expect(blockers({ mismatchedRows: 1 })).toContain('record a key id that is not the one inside');
  });

  it('is blocked by an envelope that is neither v1 nor v2', () => {
    // Already unreadable. Calling that ready would be reading "no v1 rows" as
    // "nothing to worry about", which is exactly the wrong inference.
    expect(blockers({ unknownRows: 2 })).toContain('neither v1 nor v2');
  });

  it('is blocked by a legacy-configured host, however clean its rows are', () => {
    // The pre-keyring spelling leaves the active key implicit — derived from
    // there being exactly one — and an explicit active key is part of the
    // final state, not a nicety.
    const verdict = shutdownVerdict({ ...READY, format: 'legacy' });
    expect(verdict.ready).toBe(false);
    expect(verdict.blockers.join(' ')).toContain('botctl secrets migrate-config');
  });

  it('is blocked when the active key is not in the keyring', () => {
    expect(blockers({ activeKeyId: 'gone' })).toContain('is not in the keyring');
    expect(blockers({ activeKeyId: '', configuredKeyIds: [] })).toContain('no keys configured');
  });

  it('reports every blocker at once, not the first', () => {
    // Same contract as the config schema: an operator fixing one problem at a
    // time across four runs is how a ten-minute job takes an afternoon.
    const verdict = shutdownVerdict({
      ...READY,
      v1Rows: 1,
      mismatchedRows: 1,
      format: 'legacy',
      activeKeyId: 'gone',
    });
    expect(verdict.blockers.length).toBe(4);
  });

  it('names no key material in any blocker', () => {
    // Ids and counts only. The evidence never carries key bytes, and this is
    // the assertion that keeps it that way.
    const verdict = shutdownVerdict({ ...READY, activeKeyId: 'gone', format: 'legacy' });
    for (const blocker of verdict.blockers) {
      expect(blocker).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    }
  });
});

describe('whether v1 is accepted', () => {
  const canonical = { SECRETS_KEYS: `k:${Buffer.alloc(32, 1).toString('base64')}` };
  const legacy = {
    SECRETS_KEK: Buffer.alloc(32, 1).toString('base64'),
    SECRETS_KEK_ID: 'install-20260101',
  };
  const ring = (input: Parameters<typeof parseKeyring>[0]) => {
    const result = parseKeyring(input);
    if (!result.ok) throw new Error(result.problems.join('; '));
    return result.keyring;
  };

  it('reads the format from which spelling configured the keys', () => {
    expect(ring(canonical).format).toBe('canonical');
    expect(ring(legacy).format).toBe('legacy');
  });

  it('prefers SECRETS_KEYS for the format as well as for the keys', () => {
    // The parser prefers SECRETS_KEYS when both are present. If the format did
    // not agree, a half-migrated host would be told it is legacy while running
    // canonical keys.
    expect(ring({ ...canonical, ...legacy }).format).toBe('canonical');
  });

  it('defaults OFF for a canonical host and ON for a legacy one', () => {
    // The load-bearing rule. A flat default('true') meant acceptance was what
    // happened when nobody decided — and no host installed before the setting
    // existed has a line in nexa.env deciding it, so "nobody decided"
    // described the entire installed base.
    expect(acceptsV1({ SECRETS_ACCEPT_V1: undefined }, ring(canonical))).toBe(false);
    expect(acceptsV1({ SECRETS_ACCEPT_V1: undefined }, ring(legacy))).toBe(true);
  });

  it('lets an explicit setting win in both directions', () => {
    expect(acceptsV1({ SECRETS_ACCEPT_V1: 'true' }, ring(canonical))).toBe(true);
    expect(acceptsV1({ SECRETS_ACCEPT_V1: 'false' }, ring(legacy))).toBe(false);
  });
});

describe('what a new installation is configured with', () => {
  const template = readFileSync(join(__dirname, '../../deploy/nexa.env.template'), 'utf8');
  const assignment = (key: string): string | null => {
    const match = template.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1]! : null;
  };

  it('uses the canonical keyring spelling, not the legacy one', () => {
    expect(assignment('SECRETS_KEYS')).not.toBeNull();
    expect(assignment('SECRETS_ACTIVE_KEY_ID')).not.toBeNull();
    expect(assignment('SECRETS_KEK')).toBeNull();
    expect(assignment('SECRETS_KEK_ID')).toBeNull();
  });

  it('disables v1 explicitly', () => {
    // Explicitly, not by relying on the canonical default. A fresh install has
    // no v1 rows by construction, and a line in the file is what an operator
    // reads six months later when they are deciding whether it was chosen.
    expect(assignment('SECRETS_ACCEPT_V1')).toBe('false');
  });

  it('the template a new install writes resolves to v1 disabled', () => {
    // Through the real resolver, on the real substituted values, rather than
    // by reading the line: the line only matters if the code agrees with it.
    const key = Buffer.alloc(32, 3).toString('base64');
    const substituted = template
      .replace(/__SECRETS_KEK__/g, key)
      .replace(/__SECRETS_ACTIVE_KEY_ID__/g, 'install-20260903');
    const env: Record<string, string> = {};
    for (const line of substituted.split('\n')) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (match) env[match[1]!] = match[2]!;
    }
    const result = parseKeyring(env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyring.format).toBe('canonical');
    expect(result.keyring.activeKeyId).toBe('install-20260903');
    expect(
      acceptsV1({ SECRETS_ACCEPT_V1: env.SECRETS_ACCEPT_V1 as 'true' | 'false' }, result.keyring),
    ).toBe(false);
  });
});
