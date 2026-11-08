import { describe, expect, it, vi } from 'vitest';
import {
  NexaError,
  PLATFORM_ERROR_CODES,
  SECRET_PURPOSES,
  UNREADABLE_SECRET_KINDS,
  unreadableSecretKindOf,
  type EncryptedSecret,
  type OperationalEventInput,
  type SecretCipher,
  type SecretContext,
  type TenantContext,
} from '@nexa/contracts';
import { unreadableSecretAlertFa } from '@nexa/i18n';
import {
  ReportingSecretCipher,
  UnreadableSecretReporter,
} from '../../apps/api/src/modules/platform/opslog/application/unreadable-secret-reporter';
import { OpsGroupMaintainer } from '../../apps/api/src/modules/control/ops-group/application/ops-group-maintainer';
import { TenantFanOut } from '../../apps/api/src/infrastructure/lifecycle/tenant-pass';
import { runGuardedTick } from '../../apps/api/src/infrastructure/lifecycle/loop-guard';
import { isUnreadableSecretError } from '../../apps/api/src/infrastructure/lifecycle/unreadable-secret';

/*
 * NEXA-FIX-RESTORE-SECRETS §2.6. A running installation whose stored secrets stopped
 * decrypting (a restore onto a server whose key had the same id and different material)
 * logged a stack trace every 15 s from the operations-group maintainer and told the owner
 * nothing. Now: ONE Web Admin alert per secret kind, ONE log line per change of state, quiet
 * until the value is re-entered, and the alert closes when it reads again.
 */

const TENANT = '01900000-0000-7000-8000-000000000001';
const BOT = '01900000-0000-7000-8000-0000000000b1';
const TOKEN: SecretContext = { purpose: 'bot_instance.token', tenantId: TENANT, entityId: BOT };

function authFailed(): NexaError {
  return new NexaError({
    kind: 'INTERNAL',
    code: PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED,
    message: 'A stored secret failed authenticated decryption.',
  });
}

/** Decrypts `good-*` ciphertexts; anything else fails authentication, as a wrong key does. */
const inner: SecretCipher = {
  encrypt: () => ({ keyId: 'k', ciphertext: 'good-x' }),
  decrypt(secret) {
    if (secret.ciphertext.startsWith('good-')) return `plain:${secret.ciphertext}`;
    if (secret.ciphertext === 'garbage') throw new Error('not an envelope at all');
    throw authFailed();
  },
  mask: () => '****',
};

/**
 * The open conditions, as the recorder and the condition reader see them: one row per dedupe
 * key (a failure replaces its context, a recovery resolves it). Shared by two reporters to
 * stand for two processes, or for a process and its previous life.
 */
class FakeConditions {
  readonly open = new Map<string, Record<string, unknown>>();
  readonly recorded: OperationalEventInput[] = [];
  readonly lookups: string[] = [];

  codes(): string[] {
    return this.recorded.map((event) => event.code);
  }

  /** As `DrizzleOperationalEventRecorder` does it: `mergeList` unions, `recoversListed` withholds. */
  record(event: OperationalEventInput): { withheld: boolean } {
    const list = (context: Record<string, unknown> | undefined, key: string): string[] =>
      (context?.[key] as string[] | undefined) ?? [];
    if (event.recoversDedupeKey !== undefined) {
      const open = this.open.get(event.recoversDedupeKey);
      if (open !== undefined && event.recoversListed !== undefined) {
        const { key, read } = event.recoversListed;
        const left = list(open, key).filter((item) => !read.includes(item));
        if (left.length > 0) {
          this.open.set(event.recoversDedupeKey, { ...open, [key]: left });
          return { withheld: true };
        }
      }
      this.recorded.push(event);
      this.open.delete(event.recoversDedupeKey);
      return { withheld: false };
    }
    this.recorded.push(event);
    if (event.dedupeKey !== undefined) {
      const open = this.open.get(event.dedupeKey);
      const context = { ...(event.context ?? {}) };
      if (open !== undefined && event.mergeList !== undefined) {
        context[event.mergeList] = [
          ...new Set([...list(open, event.mergeList), ...list(event.context, event.mergeList)]),
        ].sort();
      }
      this.open.set(event.dedupeKey, context);
    }
    return { withheld: false };
  }

  async openConditionContext(
    _scope: TenantContext,
    dedupeKey: string,
  ): Promise<Record<string, unknown> | null> {
    this.lookups.push(dedupeKey);
    return this.open.get(dedupeKey) ?? null;
  }
}

function setup(options: { store?: FakeConditions; rerecordMs?: number } = {}) {
  let now = Date.parse('2026-11-08T10:00:00Z');
  const store = options.store ?? new FakeConditions();
  const log = { warn: vi.fn(), info: vi.fn() };
  const reporter = new UnreadableSecretReporter({
    recorder: {
      async record(_scope, event) {
        const { withheld } = store.record(event);
        return { isNew: true, reopened: false, withheld } as never;
      },
    },
    conditions: store,
    clock: { now: () => new Date(now) },
    logger: log,
    ...(options.rerecordMs === undefined ? {} : { rerecordMs: options.rerecordMs }),
  });
  const cipher = new ReportingSecretCipher(inner, reporter);
  return {
    reporter,
    cipher,
    store,
    recorded: store.recorded,
    log,
    advance: (ms: number) => {
      now += ms;
    },
    codes: () => store.recorded.map((event) => event.code),
  };
}

/** The stored token row, as the bots page would replace it. */
function tokenRow(ciphertext: string): EncryptedSecret {
  return { keyId: 'install-20261107', ciphertext };
}

describe('a loop hitting an unreadable bot token (§2.6)', () => {
  it('raises ONE alert across many ticks of the ops-group maintainer, and logs no tick', async () => {
    const t = setup();
    let stored = tokenRow('sealed-under-the-other-servers-key');
    const loopLog = { info: vi.fn(), error: vi.fn() };
    const maintainer = new OpsGroupMaintainer(
      {
        // What `OpsGroupService.maintain` does first: resolve the group's bot token.
        async maintain() {
          t.cipher.decrypt(stored, TOKEN);
          return 'IDLE';
        },
      } as never,
      {
        scope: () => ({ tenantId: TENANT as never, botInstanceId: null }),
        actor: () => ({}) as never,
        intervalMs: 15_000,
        now: () => 0,
        logger: loopLog,
      },
    );

    for (let tick = 0; tick < 40; tick += 1) {
      await maintainer.tick();
      t.advance(15_000);
    }
    await t.reporter.settle();

    expect(t.codes()).toEqual(['secrets.read_failed']);
    expect(t.recorded[0]).toMatchObject({
      severity: 'ERROR',
      dedupeKey: 'secrets.read_failed:BOT_TOKEN',
      context: { kind: 'BOT_TOKEN', purpose: 'bot_instance.token', entityId: BOT },
    });
    // The loop says nothing per tick; the reporter said it once, without a stack.
    expect(loopLog.error).not.toHaveBeenCalled();
    expect(t.log.warn).toHaveBeenCalledTimes(1);
    const [fields] = t.log.warn.mock.calls[0]!;
    expect(fields).toMatchObject({ kind: 'BOT_TOKEN', code: 'platform.secret_auth_failed' });
    expect(JSON.stringify(fields)).not.toContain('sealed-under');
    expect(Object.values(fields as object).some((value) => value instanceof Error)).toBe(false);

    // The owner re-enters the token: the next tick reads it and closes the alert, once.
    stored = tokenRow('good-reentered');
    for (let tick = 0; tick < 5; tick += 1) await maintainer.tick();
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_ok']);
    expect(t.recorded[1]).toMatchObject({
      recoversCode: 'secrets.read_failed',
      recoversDedupeKey: 'secrets.read_failed:BOT_TOKEN',
    });
    expect(t.log.info).toHaveBeenCalledTimes(1);
    expect(loopLog.error).not.toHaveBeenCalled();
  });

  it('still logs a pass that failed for any other reason', async () => {
    const loopLog = { info: vi.fn(), error: vi.fn() };
    const maintainer = new OpsGroupMaintainer(
      {
        async maintain() {
          throw new Error('the database is unreachable');
        },
      } as never,
      {
        scope: () => ({ tenantId: TENANT as never, botInstanceId: null }),
        actor: () => ({}) as never,
        intervalMs: 15_000,
        now: () => 0,
        logger: loopLog,
      },
    );
    await maintainer.tick();
    expect(loopLog.error).toHaveBeenCalledTimes(1);
  });
});

describe('UnreadableSecretReporter', () => {
  it('rethrows the original error and returns the plaintext untouched', async () => {
    const t = setup();
    expect(() => t.cipher.decrypt(tokenRow('bad'), TOKEN)).toThrow(
      expect.objectContaining({ code: PLATFORM_ERROR_CODES.SECRET_AUTH_FAILED }),
    );
    await t.reporter.settle();
    expect(t.cipher.decrypt(tokenRow('good-1'), TOKEN)).toBe('plain:good-1');
    // A failure that is not about the key is not reported as one.
    expect(() => t.cipher.decrypt(tokenRow('garbage'), TOKEN)).toThrow('not an envelope');
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_ok']);
  });

  it('treats an unknown key id like a failed authentication', async () => {
    const t = setup();
    const unknownKey: SecretCipher = {
      ...inner,
      decrypt() {
        throw new NexaError({
          kind: 'CONFIGURATION',
          code: PLATFORM_ERROR_CODES.SECRET_KEY_UNKNOWN,
          message: 'unknown key',
        });
      },
    };
    const cipher = new ReportingSecretCipher(unknownKey, t.reporter);
    for (let i = 0; i < 10; i += 1) expect(() => cipher.decrypt(tokenRow('x'), TOKEN)).toThrow();
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed']);
    expect(t.recorded[0]?.context).toMatchObject({ errorCode: 'platform.secret_key_unknown' });
  });

  it('logs and records once more when a DIFFERENT ciphertext also fails (a change of state)', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1)
      expect(() => t.cipher.decrypt(tokenRow('bad-1'), TOKEN)).toThrow();
    for (let i = 0; i < 5; i += 1)
      expect(() => t.cipher.decrypt(tokenRow('bad-2'), TOKEN)).toThrow();
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_failed']);
    expect(t.log.warn).toHaveBeenCalledTimes(2);
  });

  it('re-records a secret that stays unreadable only after the window, silently', async () => {
    const t = setup({ rerecordMs: 60_000 });
    for (let i = 0; i < 4; i += 1) {
      expect(() => t.cipher.decrypt(tokenRow('bad'), TOKEN)).toThrow();
      t.advance(20_000);
    }
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_failed']);
    expect(t.log.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the kind open while another row of it is still unreadable', async () => {
    const t = setup();
    const panelA: SecretContext = { purpose: 'panel.password', tenantId: TENANT, entityId: 'a' };
    const panelB: SecretContext = { purpose: 'panel.password', tenantId: TENANT, entityId: 'b' };
    expect(() => t.cipher.decrypt(tokenRow('bad-a'), panelA)).toThrow();
    expect(() => t.cipher.decrypt(tokenRow('bad-b'), panelB)).toThrow();
    t.cipher.decrypt(tokenRow('good-a'), panelA);
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_failed']);
    t.cipher.decrypt(tokenRow('good-b'), panelB);
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_failed', 'secrets.read_ok']);
    expect(t.recorded[2]?.recoversDedupeKey).toBe('secrets.read_failed:PANEL_CREDENTIALS');
  });

  it('closes a backup-password alert when a NEW row is entered (the old one is superseded)', async () => {
    const t = setup();
    const old: SecretContext = {
      purpose: 'backup.archive_password',
      tenantId: TENANT,
      entityId: 'row-1',
    };
    const replacement: SecretContext = { ...old, entityId: 'row-2' };
    expect(() => t.cipher.decrypt(tokenRow('bad'), old)).toThrow();
    await t.reporter.settle();
    t.cipher.decrypt(tokenRow('good-new'), replacement);
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_failed', 'secrets.read_ok']);
    expect(t.recorded[1]?.recoversDedupeKey).toBe('secrets.read_failed:BACKUP_PASSWORD');
  });

  it('closes, once, a condition a previous life left open for THIS secret, and asks once', async () => {
    const store = new FakeConditions();
    store.open.set('secrets.read_failed:BOT_TOKEN', {
      kind: 'BOT_TOKEN',
      unreadable: [`bot_instance.token|${BOT}`],
    });
    const t = setup({ store });
    for (let i = 0; i < 5; i += 1) t.cipher.decrypt(tokenRow('good-1'), TOKEN);
    await t.reporter.settle();
    for (let i = 0; i < 5; i += 1) t.cipher.decrypt(tokenRow('good-1'), TOKEN);
    await t.reporter.settle();
    expect(t.codes()).toEqual(['secrets.read_ok']);
    expect(store.lookups).toEqual(['secrets.read_failed:BOT_TOKEN']);
  });

  /*
   * Lead review: a process that reads a HEALTHY secret of the same kind must not close a
   * condition another process raised for a broken one — it reopened within the re-record
   * window and was announced again.
   */
  it('two processes: a healthy read of ANOTHER row leaves the condition open; reading the broken one closes it', async () => {
    const store = new FakeConditions();
    const a = setup({ store });
    const b = setup({ store });
    const x: SecretContext = { purpose: 'panel.password', tenantId: TENANT, entityId: 'panel-x' };
    const y: SecretContext = { purpose: 'panel.password', tenantId: TENANT, entityId: 'panel-y' };

    expect(() => a.cipher.decrypt(tokenRow('bad-x'), x)).toThrow();
    await a.reporter.settle();
    expect(store.open.get('secrets.read_failed:PANEL_CREDENTIALS')).toMatchObject({
      kind: 'PANEL_CREDENTIALS',
      unreadable: ['panel.password|panel-x'],
    });

    for (let i = 0; i < 10; i += 1) {
      b.cipher.decrypt(tokenRow('good-y'), y);
      await b.reporter.settle();
    }
    expect(store.codes()).toEqual(['secrets.read_failed']);
    expect(store.open.has('secrets.read_failed:PANEL_CREDENTIALS')).toBe(true);

    // X is re-entered; process B reads it, and that closes the condition, once.
    b.cipher.decrypt(tokenRow('good-x'), x);
    await b.reporter.settle();
    b.cipher.decrypt(tokenRow('good-x'), x);
    await b.reporter.settle();
    expect(store.codes()).toEqual(['secrets.read_failed', 'secrets.read_ok']);
    expect(store.open.has('secrets.read_failed:PANEL_CREDENTIALS')).toBe(false);
  });

  it('lists the rows two processes failed on, and closes only when both read', async () => {
    const store = new FakeConditions();
    const a = setup({ store });
    const b = setup({ store });
    const x: SecretContext = { purpose: 'panel.password', tenantId: TENANT, entityId: 'panel-x' };
    const y: SecretContext = { purpose: 'panel.password', tenantId: TENANT, entityId: 'panel-y' };
    expect(() => a.cipher.decrypt(tokenRow('bad-x'), x)).toThrow();
    await a.reporter.settle();
    expect(() => b.cipher.decrypt(tokenRow('bad-y'), y)).toThrow();
    await b.reporter.settle();
    expect(store.open.get('secrets.read_failed:PANEL_CREDENTIALS')?.['unreadable']).toEqual([
      'panel.password|panel-x',
      'panel.password|panel-y',
    ]);
    // A's own row reads again, but B's is still listed: A does not close it.
    a.cipher.decrypt(tokenRow('good-x'), x);
    await a.reporter.settle();
    expect(store.open.has('secrets.read_failed:PANEL_CREDENTIALS')).toBe(true);
    b.cipher.decrypt(tokenRow('good-y'), y);
    await b.reporter.settle();
    b.cipher.decrypt(tokenRow('good-x'), x);
    await b.reporter.settle();
    expect(store.codes()).toEqual([
      'secrets.read_failed',
      'secrets.read_failed',
      'secrets.read_ok',
    ]);
  });

  it('records nothing for a healthy installation', async () => {
    const t = setup();
    for (let i = 0; i < 20; i += 1) t.cipher.decrypt(tokenRow('good-1'), TOKEN);
    await t.reporter.settle();
    expect(t.codes()).toEqual([]);
    expect(t.log.warn).not.toHaveBeenCalled();
  });

  it('maps every purpose to a kind, and every kind has its Persian sentence', () => {
    for (const purpose of SECRET_PURPOSES) {
      expect(UNREADABLE_SECRET_KINDS).toContain(unreadableSecretKindOf(purpose));
    }
    expect(unreadableSecretKindOf('bot_instance.token')).toBe('BOT_TOKEN');
    expect(unreadableSecretKindOf('payment_gateway.webhook_secret')).toBe('GATEWAY_KEYS');
    expect(unreadableSecretKindOf('admin.totp_secret')).toBe('OTHER');
    for (const kind of UNREADABLE_SECRET_KINDS) expect(unreadableSecretAlertFa(kind)).toBeTruthy();
    expect(unreadableSecretAlertFa('BOT_TOKEN')).toBe(
      'توکن ربات قابل خواندن نیست؛ آن را در صفحهٔ ربات‌ها دوباره وارد کنید.',
    );
    expect(unreadableSecretAlertFa('nope')).toBeNull();
  });
});

describe('the shared loop plumbing stays quiet about an unreadable secret', () => {
  it('recognises the two codes, through a wrapping cause', () => {
    expect(isUnreadableSecretError(authFailed())).toBe(true);
    expect(isUnreadableSecretError(new Error('wrapped', { cause: authFailed() }))).toBe(true);
    expect(isUnreadableSecretError(new Error('other'))).toBe(false);
  });

  it('the fan-out logs no tenant whose pass met one, and still fails the pass', async () => {
    const logger = { error: vi.fn() };
    const fanOut = new TenantFanOut({
      activeTenants: async () => [TENANT as never],
      installationTenantId: () => TENANT as never,
      now: () => 0,
      logger,
    });
    await expect(
      fanOut.pass('ops-group', { budgetMs: 1_000 }).each(async () => {
        throw authFailed();
      }),
    ).rejects.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('the loop guard counts it and does not log it', async () => {
    const logger = { error: vi.fn() };
    await runGuardedTick('unreadable-secret-test', () => Promise.reject(authFailed()), logger);
    expect(logger.error).not.toHaveBeenCalled();
    await runGuardedTick('unreadable-secret-test', () => Promise.reject(new Error('x')), logger);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
