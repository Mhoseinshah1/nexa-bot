import { describe, expect, it } from 'vitest';
import {
  isNexaError,
  PLATFORM_ERROR_CODES,
  type AuditEntry,
  type TenantContext,
} from '@nexa/contracts';
import {
  BotBootstrapService,
  type BotBootstrapDeps,
} from '../../apps/api/src/modules/platform/tenancy/application/bot-bootstrap.service';
import type {
  BotBootstrapRepository,
  BotBootstrapTelegram,
  BotBootstrapView,
  BotIdentityProbe,
  WebhookRegistration,
} from '../../apps/api/src/modules/platform/tenancy/application/ports';
import {
  currentTransactionLabel,
  withinTransaction,
} from '../../apps/api/src/infrastructure/transaction-boundary';

/**
 * The fresh-install Telegram bootstrap, against fakes rather than a socket.
 *
 * The whole point of the service is what happens when something fails halfway,
 * and the interesting failures are a crash between a database commit and a
 * Telegram call, and a crash between Telegram accepting and the marker being
 * written. Neither can be provoked against a real Telegram, so the port exists
 * partly so both can be provoked here — a run is stopped exactly where a
 * `kill -9` would stop it, and the NEXT run is then asked to converge.
 *
 * Every fake below records what it was asked, because most of these assertions
 * are about a call that must NOT have been made: a token that must not be
 * re-encrypted, a `setWebhook` that must not discard a running installation's
 * queued updates, a prompt that must not be asked for twice.
 */

const TENANT = '01890000-0000-7000-8000-0000000073e1';
const scope: TenantContext = { tenantId: TENANT as TenantContext['tenantId'], botInstanceId: null };
const ORIGIN = 'https://bot.example.com';
const SECRET = 'a-webhook-secret-long-enough';
const TOKEN = '8123456789:AAH0ffbeefcafe0ffbeefcafe0ffbeefcaf';
const OTHER_TOKEN = '9999999999:BBH0ffbeefcafe0ffbeefcafe0ffbeefcaf';

interface Row {
  id: string;
  username: string;
  status: 'ACTIVE' | 'STOPPED' | 'DISABLED';
  telegramBotId: string | null;
  webhookRegisteredAt: Date | null;
  webhookUrl: string | null;
  webhookSecretFingerprint: string | null;
  token: string;
}

/**
 * The bot table, plus a ledger of every write.
 *
 * `tokenWrites` is the one that matters most: ADR-0029 decision 3 says a rerun
 * never rotates a credential, and the only way to hold a test to that is to
 * count the writes rather than to read the value afterwards and find it
 * unchanged — an identical rewrite would pass that and violate the rule.
 */
class FakeBots implements BotBootstrapRepository {
  rows: Row[] = [];
  tokenWrites: string[] = [];
  identityWrites: { id: string; telegramBotId: string }[] = [];
  webhookMarks: { id: string; url: string }[] = [];
  locks = 0;
  /** Runs inside the transaction, once, just after the lock is taken. */
  onLocked: (() => void) | null = null;

  async lockTenantForBotChange(): Promise<'ACTIVE'> {
    this.locks += 1;
    const hook = this.onLocked;
    this.onLocked = null;
    hook?.();
    return 'ACTIVE';
  }

  async findBootstrapTarget(): Promise<BotBootstrapView | null> {
    const row = this.rows[0];
    if (!row) return null;
    return {
      id: row.id as BotBootstrapView['id'],
      username: row.username,
      status: row.status,
      telegramBotId: row.telegramBotId,
      webhookRegisteredAt: row.webhookRegisteredAt,
      webhookUrl: row.webhookUrl,
      webhookSecretFingerprint: row.webhookSecretFingerprint,
    };
  }

  async createFromBootstrap(
    _scope: unknown,
    input: {
      readonly id: string;
      readonly username: string;
      readonly telegramBotId: string;
      readonly token: string;
    },
  ): Promise<void> {
    this.tokenWrites.push(input.token);
    this.rows.push({
      id: input.id,
      username: input.username,
      status: 'ACTIVE',
      telegramBotId: input.telegramBotId,
      webhookRegisteredAt: null,
      webhookUrl: null,
      webhookSecretFingerprint: null,
      token: input.token,
    });
  }

  async markWebhookRegistered(
    _scope: unknown,
    id: string,
    input: { readonly url: string; readonly secretFingerprint: string; readonly now: Date },
  ): Promise<void> {
    this.webhookMarks.push({ id, url: input.url });
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.webhookRegisteredAt = input.now;
      row.webhookUrl = input.url;
      row.webhookSecretFingerprint = input.secretFingerprint;
    }
  }

  async recordTelegramIdentity(
    _scope: unknown,
    id: string,
    input: { readonly telegramBotId: string; readonly username: string },
  ): Promise<boolean> {
    const row = this.rows.find((candidate) => candidate.id === id);
    // The real statement carries `telegram_bot_id IS NULL` in its WHERE and
    // RETURNS the rows it changed; the fake honours both, so a test cannot pass
    // here and fail in Postgres.
    if (!row || row.telegramBotId !== null) return false;
    this.identityWrites.push({ id, telegramBotId: input.telegramBotId });
    row.telegramBotId = input.telegramBotId;
    row.username = input.username;
    return true;
  }

  async resolveToken(_scope: unknown, id: string): Promise<string> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no bot instance ${id}`);
    return row.token;
  }
}

class FakeTelegram implements BotBootstrapTelegram {
  identifyCalls: string[] = [];
  webhookCalls: {
    token: string;
    url: string;
    secretToken: string;
    dropPendingUpdates: boolean;
  }[] = [];
  probe: BotIdentityProbe = { outcome: 'IDENTIFIED', botId: '8123456789', username: 'acme_bot' };
  registration: WebhookRegistration = { outcome: 'REGISTERED' };
  /** Thrown instead of answering, to simulate the process dying mid-call. */
  crashOnWebhook: Error | null = null;
  /** How many times a command menu was registered, and with which token. */
  commandCalls: string[] = [];
  /** What `registerCommands` answers. FALSE is the case the install must survive. */
  commandsRegister = true;

  async identify(token: string): Promise<BotIdentityProbe> {
    // The rule the whole design rests on: never inside a transaction. A fake
    // that did not check this would let the service be refactored into one.
    expect(currentTransactionLabel()).toBeUndefined();
    this.identifyCalls.push(token);
    return this.probe;
  }

  async registerCommands(input: { readonly token: string }): Promise<boolean> {
    // Same rule as every other call here: never inside a transaction.
    expect(currentTransactionLabel()).toBeUndefined();
    this.commandCalls.push(input.token);
    return this.commandsRegister;
  }

  async registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
    readonly dropPendingUpdates: boolean;
  }): Promise<WebhookRegistration> {
    expect(currentTransactionLabel()).toBeUndefined();
    this.webhookCalls.push({ ...input });
    if (this.crashOnWebhook !== null) throw this.crashOnWebhook;
    return this.registration;
  }
}

/** The deps a `build()` result was composed from, for constructing a variant. */
const DEPS = new WeakMap<object, BotBootstrapDeps>();
function serviceDeps(built: { service: BotBootstrapService }): BotBootstrapDeps {
  const deps = DEPS.get(built.service);
  if (deps === undefined) throw new Error('that service was not built here');
  return deps;
}

function build(overrides: Partial<BotBootstrapDeps> = {}): {
  service: BotBootstrapService;
  bots: FakeBots;
  telegram: FakeTelegram;
  audit: AuditEntry[];
  ids: string[];
} {
  const bots = new FakeBots();
  const telegram = new FakeTelegram();
  /*
   * The WHOLE entry, not three fields of it.
   *
   * An earlier fake recorded only `{action, entityId, after}`, so the test that
   * says the token never reaches an audit payload was satisfied by the fake's
   * shape rather than by the rule: a production change putting the token in
   * `before` or in the `reason` string left it green.
   */
  const audit: AuditEntry[] = [];
  const ids: string[] = [];
  let counter = 0;
  let clockMs = 1_700_000_000_000;

  const deps: BotBootstrapDeps = {
    // Marked the way `DrizzleUnitOfWork` marks it, so the two
    // `currentTransactionLabel` assertions above are testing the real rule and
    // not an absence the fake guaranteed.
    uow: {
      run: (runScope, fn) =>
        withinTransaction('test', () => fn({ tx: undefined as never, scope: runScope })),
      // The bootstrap uses neither. They throw rather than delegating to `run`,
      // so a future call to one is a loud failure here rather than a silently
      // different isolation level in production.
      runSnapshot: () => {
        throw new Error('the bootstrap does not use runSnapshot');
      },
      runNested: () => {
        throw new Error('the bootstrap does not use runNested');
      },
    },
    bots: bots as unknown as BotBootstrapDeps['bots'],
    scopeActivity: {
      scopeIsActive: async (_scope: unknown, tx?: unknown) => {
        // Outside a transaction this is the READ that decides what to report —
        // `unavailableReason` — and no lock is held or wanted.
        if (tx === undefined) return true;
        /*
         * The lock must already be held when the activity check runs.
         *
         * `scopeIsActive` takes a SHARE lock on the same tenant row the
         * exclusive lock takes. Two transactions that both take the shared one
         * first and then try to upgrade deadlock; taking the exclusive one
         * first makes them queue. That is a Postgres property no unit test can
         * demonstrate — but the ORDER is this service's to get right, and this
         * is what holds it to it.
         */
        expect(bots.locks).toBeGreaterThan(0);
        return true;
      },
    },
    audit: {
      record: async (_s, _a, entry) => {
        audit.push(entry);
      },
    },
    clock: { now: () => new Date((clockMs += 1_000)) },
    ids: {
      uuid: () => {
        counter += 1;
        const id = `01890000-0000-7000-8000-00000000b0${counter}`;
        ids.push(id);
        return id;
      },
      callbackRef: () => {
        throw new Error('the bootstrap issues no callback references');
      },
    },
    telegram,
    webhookSecret: () => SECRET,
    webhookEnabled: () => true,
  };

  const composed = { ...deps, ...overrides };
  const service = new BotBootstrapService(composed);
  DEPS.set(service, composed);
  return { service, bots, telegram, audit, ids };
}

function codeOf(error: unknown): string {
  return isNexaError(error) ? error.code : `not a NexaError: ${String(error)}`;
}

async function codeThrownBy(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return codeOf(error);
  }
  return 'nothing was thrown';
}

/** The message of whatever a call threw, for the strings an operator reads. */
async function messageThrownBy(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the call to throw, and it did not');
}

describe('bot bootstrap — a fresh install', () => {
  it('validates the token with getMe BEFORE it writes anything', async () => {
    const { service, bots, telegram } = build();
    telegram.probe = { outcome: 'REJECTED', detail: 'Unauthorized' };

    const code = await codeThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    expect(code).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED);
    // The ordering rule, stated as an observation: a token Telegram refused
    // never became a row. A stored credential that has never worked is
    // indistinguishable from one that stopped working.
    expect(bots.rows).toHaveLength(0);
    expect(bots.tokenWrites).toHaveLength(0);

    /*
     * And the message names no remedy that does not exist.
     *
     * It used to end "If the token was revoked, restore it in BotFather rather
     * than issuing a new one" — which cannot be done, contradicted the installer
     * summary printed immediately afterwards, and contradicted the sentence
     * before it in the same string. That is the second time on this branch that
     * a message invented a recovery; the first was the installer's own summary.
     *
     * This assertion has itself been CORRECTED, and the correction is `OQ-TG-04`
     * item 1. It used to require "no supported recovery" and "OQ-TG-01" HERE, on
     * a fresh install — and both are statements about a stored credential, of
     * which this path has none. So the test pinned the defect: it made the
     * sentence mandatory in the one state where it is false, and a rerun that
     * removed it from this path would have failed a green suite for being right.
     * The stored-credential sentence is asserted where it is true, in "still asks
     * Telegram whether the stored token works".
     */
    const message = await messageThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );
    expect(message).not.toMatch(/restore it in BotFather/);
    expect(message).toMatch(/Nothing was stored/);
    expect(message).not.toMatch(/no supported recovery/);
  });

  it('creates the bot, registers the webhook, and marks it afterwards', async () => {
    const { service, bots, telegram, audit } = build();

    const result = await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('CREATED');
    expect(result.telegramBotId).toBe('8123456789');
    expect(result.username).toBe('acme_bot');
    expect(result.webhookUrl).toBe(`${ORIGIN}/telegram/webhook/${result.botInstanceId}`);
    // The identity is Telegram's, not the operator's: nothing the caller passed
    // could have produced this username.
    expect(bots.rows[0]?.telegramBotId).toBe('8123456789');
    expect(telegram.webhookCalls[0]?.url).toBe(result.webhookUrl);
    expect(telegram.webhookCalls[0]?.secretToken).toBe(SECRET);
    expect(bots.webhookMarks).toEqual([{ id: result.botInstanceId, url: result.webhookUrl }]);
    expect(audit.map((entry) => entry.action)).toEqual([
      'bot_instance.bootstrap',
      'bot_instance.webhook_registered',
      /*
       * The command menu, LAST and deliberately so.
       *
       * It is registered after the webhook marker is durable, because the two failures
       * are of very different weight: a webhook that did not register means updates do
       * not arrive and `status` must keep answering `incomplete`, while a menu that did
       * not register means a customer types `/help` instead of tapping it. Ordering the
       * weaker one first would put a convenience between the install and the one fact
       * that makes it usable.
       */
      'bot.commands.register',
    ]);
    // Registered once, with the bot's own token. WHICH commands is the gateway's, and
    // `telegram-command-menu.test.ts` is where that list is pinned — an application
    // file may not import the catalogue, so it cannot be asserted from here.
    expect(telegram.commandCalls).toEqual([TOKEN]);
  });

  it('completes the install when Telegram refuses the command menu', async () => {
    /*
     * The asymmetry, asserted rather than assumed. A failed `setMyCommands` is recorded
     * and the run CONTINUES: the bot works, `/help` answers, and only the tap-to-pick
     * menu is missing. Failing the install here would send an operator hunting a
     * problem they do not have — and the audit row is where the real answer lives.
     */
    const { service, telegram, audit, bots } = build();
    telegram.commandsRegister = false;

    const result = await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('CREATED');
    expect(bots.webhookMarks).toHaveLength(1);
    expect(audit.find((entry) => entry.action === 'bot.commands.register')?.result).toBe('FAILED');
  });

  it('never puts the token in an audit payload', async () => {
    const { service, audit } = build();
    await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    const serialised = JSON.stringify(audit);
    expect(serialised).not.toContain(TOKEN);
    // Not even the secret half on its own. `check-boundaries.sh` has a
    // repository-wide version of this rule; this one holds the exact payloads
    // this service writes.
    expect(serialised).not.toContain(TOKEN.split(':')[1]);
  });

  it('refuses a token that is not shaped like one, without asking Telegram', async () => {
    const { service, telegram } = build();
    for (const bad of ['', '   ', 'no-colon-here', ':leading', 'trailing:', 'has space:abc']) {
      const code = await codeThrownBy(() =>
        service.execute(scope, { token: bad, publicBaseUrl: ORIGIN }),
      );
      expect(code).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED);
    }
    expect(telegram.identifyCalls).toHaveLength(0);
  });

  it('refuses an origin Telegram could never deliver to, before any call', async () => {
    const { service, telegram, bots } = build();
    for (const bad of [
      'not a url',
      'http://bot.example.com',
      'https://bot.example.com/hook',
      'https://bot.example.com/?x=1',
    ]) {
      const code = await codeThrownBy(() =>
        service.execute(scope, { token: TOKEN, publicBaseUrl: bad }),
      );
      expect(code).toBe(PLATFORM_ERROR_CODES.CONFIG_INVALID);
    }
    expect(telegram.identifyCalls).toHaveLength(0);
    expect(bots.rows).toHaveLength(0);
  });

  it('refuses to register a webhook without a usable secret', async () => {
    const { service, bots, telegram } = build({ webhookSecret: () => 'short' });

    const code = await codeThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    expect(code).toBe(PLATFORM_ERROR_CODES.CONFIG_INVALID);
    // The row survives — it is correct — but Telegram was never pointed at an
    // endpoint that would refuse every update it delivered.
    expect(bots.rows).toHaveLength(1);
    expect(telegram.webhookCalls).toHaveLength(0);
    expect(bots.webhookMarks).toHaveLength(0);
  });
});

describe('bot bootstrap — a webhook failure is recoverable and is not success', () => {
  it('keeps the row and the token, and still fails the run', async () => {
    const { service, bots, telegram } = build();
    telegram.registration = { outcome: 'UNREACHABLE', detail: 'socket hang up' };

    const code = await codeThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    expect(code).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED);
    expect(bots.rows).toHaveLength(1);
    expect(bots.rows[0]?.token).toBe(TOKEN);
    expect(bots.rows[0]?.webhookRegisteredAt).toBeNull();
    expect(await service.status(scope, ORIGIN)).toBe('incomplete');
  });

  /*
   * `OQ-TG-04` item 8. `REFUSED` means Telegram LOOKED AT the URL and would not
   * take it, and both outcomes used to share one code and one sentence telling
   * the operator to rerun — which submits the same URL and is refused again.
   */
  it('reports a URL Telegram refused separately from one it could not be asked about', async () => {
    const { service, telegram } = build();
    telegram.registration = { outcome: 'REFUSED', detail: 'Bad webhook: HTTPS url must be https' };

    expect(
      await codeThrownBy(() => service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_REFUSED);
  });

  it('does not tell an operator to rerun a registration that would be refused again', async () => {
    const { service, telegram } = build();
    telegram.registration = { outcome: 'REFUSED', detail: 'Bad webhook: HTTPS url must be https' };

    const message = await messageThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    // Asserted on the advice, not only the code: the code alone is satisfied by
    // a refusal that then repeats the rerun sentence underneath it, which is the
    // defect exactly.
    expect(message).toContain('is refused the same way');
    expect(message).not.toContain('Rerun the installer to retry the registration');
    // And it still says the expensive things survived, because that is true of
    // both halves and is the first thing somebody at a failed install asks.
    expect(message).toContain('nothing was undone');
  });

  it('resumes from the stored token on the next run, without being given one', async () => {
    const { service, bots, telegram } = build();
    telegram.registration = { outcome: 'UNREACHABLE', detail: 'socket hang up' };
    await codeThrownBy(() => service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }));

    telegram.registration = { outcome: 'REGISTERED' };
    // `token: null` is the rerun: the installer asked `status`, was told
    // `incomplete`, and did NOT prompt.
    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(bots.tokenWrites).toEqual([TOKEN]);
    expect(telegram.webhookCalls.at(-1)?.token).toBe(TOKEN);
    expect(await service.status(scope, ORIGIN)).toBe('ready');
  });

  it('converges after a crash between the local commit and the Telegram call', async () => {
    const { service, bots, telegram } = build();
    telegram.crashOnWebhook = new Error('SIGKILL');
    await expect(
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    ).rejects.toThrowError(/SIGKILL/);

    // What a `kill -9` in that window leaves behind: a row, a token, no marker.
    expect(bots.rows).toHaveLength(1);
    expect(bots.rows[0]?.webhookRegisteredAt).toBeNull();

    telegram.crashOnWebhook = null;
    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(result.kind).toBe('RECONCILED');
    expect(bots.rows).toHaveLength(1);
    expect(bots.tokenWrites).toEqual([TOKEN]);
  });

  it('converges after a crash AFTER Telegram accepted but before the marker', async () => {
    const { service, bots, telegram } = build();
    /*
     * The second crash window, and the reason the marker is a separate column.
     *
     * Telegram has the webhook; the database does not know it. The state on
     * disk is identical to the first crash — which is the design — so the rerun
     * cannot tell them apart and must not need to: it registers again, Telegram
     * treats the repeat as a no-op, and the marker is written.
     */
    telegram.registration = { outcome: 'REGISTERED' };
    telegram.crashOnWebhook = new Error('SIGKILL after accept');
    await expect(
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    ).rejects.toThrowError(/SIGKILL after accept/);
    expect(telegram.webhookCalls).toHaveLength(1);
    expect(bots.rows[0]?.webhookRegisteredAt).toBeNull();

    telegram.crashOnWebhook = null;
    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(telegram.webhookCalls).toHaveLength(2);
    expect(bots.rows[0]?.webhookRegisteredAt).not.toBeNull();
  });

  it('reports an unreachable Telegram differently from a rejected token', async () => {
    const { service, telegram } = build();
    telegram.probe = { outcome: 'UNREACHABLE', detail: 'ETIMEDOUT' };
    expect(
      await codeThrownBy(() => service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_UNREACHABLE);
  });

  /*
   * `OQ-TG-04` item 1. The rejection message is a statement about a STORED
   * credential, and on a first bootstrap there is none: `getMe` runs before
   * `createFromBootstrap` precisely so a rejected token writes nothing, and
   * rerunning with a corrected one IS the recovery. The installer's own
   * nothing-stored summary said exactly that, so the two contradicted each other.
   */
  it('does not tell a FIRST bootstrap that a rejected token is unrecoverable', async () => {
    const { service, telegram } = build();
    telegram.probe = { outcome: 'REJECTED', detail: 'Unauthorized' };

    const message = await messageThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    expect(message).toContain('Nothing was stored');
    expect(message).toContain('run this again with a corrected one');
    expect(message).not.toContain('There is no supported recovery');
    expect(message).not.toContain('OQ-TG-01');
  });

  /*
   * items 6 and 7. An API base that is not Telegram used to be
   * reported as a revoked token, which sends the operator to BotFather to
   * reissue a credential that is fine — and reissuing is the one action that
   * makes the real problem harder to see, because the new token fails the same
   * way against the same wrong host.
   */
  it('reports a configured API base that is not Telegram as its own failure', async () => {
    const { service, telegram } = build();
    telegram.probe = { outcome: 'NOT_TELEGRAM', detail: 'getMe answered without a usable id' };

    expect(
      await codeThrownBy(() => service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_API_BASE_INVALID);
  });

  it('does not send the operator to BotFather for a misconfigured API base', async () => {
    const { service, telegram } = build();
    telegram.probe = { outcome: 'NOT_TELEGRAM', detail: 'getMe answered without a usable id' };

    const message = await messageThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    // The variable to look at, and the thing that is NOT the problem. Asserted
    // separately from the code, because the code alone would be satisfied by a
    // refusal that then repeated the revoked-token advice underneath it.
    expect(message).toContain('TELEGRAM_API_BASE_URL');
    expect(message).toContain('does not need reissuing in BotFather');
  });
});

describe('bot bootstrap — a rerun reconciles and never rotates', () => {
  async function installed(): Promise<ReturnType<typeof build>> {
    const built = build();
    await built.service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    return built;
  }

  it('does nothing at all when Telegram is already pointed here', async () => {
    const { service, bots, telegram } = await installed();
    const before = telegram.webhookCalls.length;

    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('ALREADY_COMPLETE');
    // No second `setWebhook`. It carries `drop_pending_updates`, so a rerun that
    // "just re-registers to be sure" would discard whatever a RUNNING
    // installation had queued — real customers' messages, thrown away by an
    // installer somebody ran for an unrelated reason.
    expect(telegram.webhookCalls).toHaveLength(before);
    expect(bots.webhookMarks).toHaveLength(1);
    expect(bots.rows).toHaveLength(1);
  });

  it('still asks Telegram whether the stored token works', async () => {
    const { service, telegram } = await installed();
    telegram.probe = { outcome: 'REJECTED', detail: 'Unauthorized' };

    expect(
      await codeThrownBy(() => service.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_TOKEN_REJECTED);
  });

  /*
   * The other half of `OQ-TG-04` item 1, and the reason the message branches
   * rather than losing a sentence. HERE a credential IS stored, `execute` always
   * registers with the one in the row, and this release ships nothing that
   * replaces it — so "there is no supported recovery" is true, and telling this
   * operator to rerun with a reissued token would be the invented remedy the
   * fresh-install branch exists to stop giving to somebody else.
   */
  it('still says a STORED token has no supported replacement in this release', async () => {
    const { service, telegram } = await installed();
    telegram.probe = { outcome: 'REJECTED', detail: 'Unauthorized' };

    const message = await messageThrownBy(() =>
      service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
    );

    expect(message).toMatch(/no supported recovery/);
    expect(message).toMatch(/OQ-TG-01/);
    expect(message).not.toMatch(/Nothing was stored/);
  });

  it('does not rewrite the token when the same one is supplied again', async () => {
    const { service, bots } = await installed();
    await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    // Counted, not compared. An identical re-encryption would leave the value
    // looking unchanged and would still be a credential write on a rerun.
    expect(bots.tokenWrites).toEqual([TOKEN]);
  });

  it('registers with the STORED token, not one handed to the rerun', async () => {
    const { service, bots, telegram } = await installed();
    // The same bot, a different secret half: an operator who rotated in
    // BotFather and reran the installer expecting it to be picked up. It is not
    // picked up, and it is not used for anything either — the run reconciles
    // with the credential on the row, which is the one this installation holds.
    const rotated = `8123456789:CCH${'x'.repeat(32)}`;
    const moved = 'https://moved.example.com';

    const result = await service.execute(scope, { token: rotated, publicBaseUrl: moved });

    expect(result.kind).toBe('RECONCILED');
    expect(telegram.webhookCalls.at(-1)?.token).toBe(TOKEN);
    expect(telegram.identifyCalls).not.toContain(rotated);
    expect(bots.tokenWrites).toEqual([TOKEN]);
    expect(bots.rows[0]?.token).toBe(TOKEN);
  });

  it('refuses a token for a different bot instead of repointing', async () => {
    const { service, bots, telegram } = await installed();
    const marks = bots.webhookMarks.length;

    expect(
      await codeThrownBy(() =>
        service.execute(scope, { token: OTHER_TOKEN, publicBaseUrl: ORIGIN }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT);

    expect(bots.rows[0]?.telegramBotId).toBe('8123456789');
    expect(bots.tokenWrites).toEqual([TOKEN]);
    expect(bots.webhookMarks).toHaveLength(marks);
    // Refused locally, from the id half of the token. The other bot's secret
    // was never sent anywhere.
    expect(telegram.identifyCalls).not.toContain(OTHER_TOKEN);
  });

  it('refuses a different bot on a row that predates the identity column', async () => {
    /*
     * `refuseRepointing` runs against the STORED row, and on a row created
     * before migration 0038 that row's `telegram_bot_id` is NULL — so it
     * returned having compared nothing, and a supplied token naming a DIFFERENT
     * bot was silently ignored on exactly the rows an upgrade produces. The
     * installer then printed success having changed nothing.
     *
     * `getMe` has since said which bot the STORED token belongs to, and that is
     * the value the first comparison did not have.
     */
    const { service, bots, telegram } = build();
    bots.rows.push({
      id: '01890000-0000-7000-8000-0000000001dd',
      username: 'stale_name_bot',
      status: 'ACTIVE',
      telegramBotId: null,
      webhookRegisteredAt: null,
      webhookUrl: null,
      webhookSecretFingerprint: null,
      token: TOKEN,
    });

    expect(
      await codeThrownBy(() =>
        service.execute(scope, { token: OTHER_TOKEN, publicBaseUrl: ORIGIN }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT);

    // The stored credential is untouched, and the other bot's secret half was
    // never sent anywhere.
    expect(bots.tokenWrites).toHaveLength(0);
    expect(bots.rows[0]?.token).toBe(TOKEN);
    expect(telegram.identifyCalls).not.toContain(OTHER_TOKEN);
    // The row DID learn its own identity on the way past — that is a correct
    // fill, not a repoint, and it is what makes the next run refuse earlier.
    expect(bots.rows[0]?.telegramBotId).toBe('8123456789');
    // And nothing was registered: the refusal is before `setWebhook`.
    expect(telegram.webhookCalls).toHaveLength(0);
  });

  it('still reconciles a legacy row when the supplied token names the SAME bot', async () => {
    // The other half. A refusal that refuses too much is the same defect from
    // the other side, and this is the ordinary upgrade path: an operator reruns
    // with the token file they have always used.
    const { service, bots } = build();
    bots.rows.push({
      id: '01890000-0000-7000-8000-0000000001dd',
      username: 'stale_name_bot',
      status: 'ACTIVE',
      telegramBotId: null,
      webhookRegisteredAt: null,
      webhookUrl: null,
      webhookSecretFingerprint: null,
      token: TOKEN,
    });

    const result = await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(bots.rows[0]?.telegramBotId).toBe('8123456789');
  });

  it('refuses when the stored token has come to belong to another bot', async () => {
    const { service, telegram } = await installed();
    telegram.probe = { outcome: 'IDENTIFIED', botId: '5555555555', username: 'someone_else_bot' };

    expect(
      await codeThrownBy(() => service.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT);
  });

  it('re-registers when the installation has moved to a new domain', async () => {
    const { service, bots, telegram } = await installed();
    const moved = 'https://new.example.com';

    expect(await service.status(scope, moved)).toBe('incomplete');
    const result = await service.execute(scope, { token: null, publicBaseUrl: moved });

    expect(result.kind).toBe('RECONCILED');
    expect(telegram.webhookCalls.at(-1)?.url).toBe(
      `${moved}/telegram/webhook/${result.botInstanceId}`,
    );
    expect(bots.rows[0]?.webhookUrl).toBe(result.webhookUrl);
    expect(bots.tokenWrites).toEqual([TOKEN]);
  });

  it('treats a trailing slash as the same origin', async () => {
    const { service, telegram } = await installed();
    const before = telegram.webhookCalls.length;

    expect(await service.status(scope, `${ORIGIN}/`)).toBe('ready');
    const result = await service.execute(scope, { token: null, publicBaseUrl: `${ORIGIN}/` });

    expect(result.kind).toBe('ALREADY_COMPLETE');
    expect(telegram.webhookCalls).toHaveLength(before);
  });

  it('fills in an identity for a row that predates the column, without rotating', async () => {
    const { service, bots, telegram } = build();
    // A bot instance from the development seed, or from any installation older
    // than migration 0038.
    bots.rows.push({
      id: '01890000-0000-7000-8000-0000000001dd',
      username: 'stale_name_bot',
      status: 'ACTIVE',
      telegramBotId: null,
      webhookRegisteredAt: null,
      webhookUrl: null,
      webhookSecretFingerprint: null,
      token: TOKEN,
    });

    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(bots.identityWrites).toEqual([
      { id: '01890000-0000-7000-8000-0000000001dd', telegramBotId: '8123456789' },
    ]);
    // The username came from Telegram too — but only on this path. A row whose
    // `telegram_bot_id` is already set returns before the write, so for every
    // row this release creates a later BotFather rename is NOT picked up. That
    // is a gap, not a feature; it is recorded in docs/open-questions.md rather
    // than described here as a rule the code has.
    expect(bots.rows[0]?.username).toBe('acme_bot');
    expect(bots.tokenWrites).toHaveLength(0);
    // Asked with the STORED token. The installer supplied none, and the row's
    // credential is what identified it.
    expect(telegram.identifyCalls).toEqual([TOKEN]);
  });
});

describe('bot bootstrap — the rules the review found untested', () => {
  async function installed(): Promise<ReturnType<typeof build>> {
    const built = build();
    await built.service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    return built;
  }

  it('re-registers when the webhook SECRET has been rotated', async () => {
    /*
     * The rotation procedure `nexa.env.template` documents, end to end.
     *
     * Recording only the URL made this unfixable: the installation reported
     * itself ready while the webhook route refused every update Telegram signed
     * with the old secret, `botctl telegram register` answered "nothing was
     * changed", and the only way out was SQL.
     */
    const { bots, telegram } = await installed();
    const rotated = build();
    rotated.bots.rows = bots.rows;
    const after = new BotBootstrapService({
      ...serviceDeps(rotated),
      webhookSecret: () => 'a-completely-different-secret',
    });

    expect(await after.status(scope, ORIGIN)).toBe('incomplete');
    const result = await after.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(rotated.telegram.webhookCalls.at(-1)?.secretToken).toBe('a-completely-different-secret');
    expect(await after.status(scope, ORIGIN)).toBe('ready');
    // And the credential was still not touched.
    expect(rotated.bots.tokenWrites).toHaveLength(0);
    expect(telegram.webhookCalls).toHaveLength(1);
  });

  it('discards queued updates on a first registration and NEVER on a reconcile', async () => {
    // `drop_pending_updates` on a re-registration throws away a RUNNING
    // installation's customers' messages — no count, no confirmation, no record.
    const { service, telegram } = await installed();
    expect(telegram.webhookCalls[0]?.dropPendingUpdates).toBe(true);

    const moved = 'https://moved.example.com';
    await service.execute(scope, { token: null, publicBaseUrl: moved });
    expect(telegram.webhookCalls.at(-1)?.dropPendingUpdates).toBe(false);
  });

  it('refuses a STOPPED bot rather than registering a webhook nothing will answer', async () => {
    // The webhook route refuses an update whose bot is not ACTIVE, so
    // registering one produces a bot that is configured, reported ready, and
    // silent.
    const { service, bots, telegram } = await installed();
    bots.rows[0]!.status = 'STOPPED';
    const before = telegram.webhookCalls.length;

    expect(await service.status(scope, ORIGIN)).toBe('unavailable');
    expect(
      await codeThrownBy(() => service.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED);
    expect(telegram.webhookCalls).toHaveLength(before);
  });

  it('is NOT ready when this installation does not serve the webhook route', async () => {
    // `app.module.ts` registers the controller only when
    // TELEGRAM_WEBHOOK_ENABLED is true. A row with a current URL and fingerprint
    // on an installation with the flag off answered `ready` while every delivery
    // would 404.
    const { bots } = await installed();
    const off = build({ webhookEnabled: () => false });
    off.bots.rows = bots.rows;

    expect(await off.service.status(scope, ORIGIN)).toBe('unavailable');
    expect(
      await codeThrownBy(() => off.service.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED);
    expect(off.telegram.webhookCalls).toHaveLength(0);
  });

  it('is NOT ready when the TENANT has stopped accepting work', async () => {
    // The webhook route refuses every update for a tenant that is not active,
    // so a complete registration is still a bot that receives nothing. This was
    // checked only inside the write transactions, which protect the WRITE — not
    // the claim.
    const { bots } = await installed();
    const stopped = build({ scopeActivity: { scopeIsActive: async () => false } });
    stopped.bots.rows = bots.rows;

    expect(await stopped.service.status(scope, ORIGIN)).toBe('unavailable');
    expect(
      await codeThrownBy(() =>
        stopped.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED);
    expect(stopped.telegram.webhookCalls).toHaveLength(0);
  });

  it('names WHICH of the three reasons a bot is unavailable', async () => {
    // One status value, three causes, and an operator sent looking in the wrong
    // place is the cost of collapsing them into one message.
    const { bots } = await installed();

    const off = build({ webhookEnabled: () => false });
    off.bots.rows = bots.rows;
    await expect(
      off.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
    ).rejects.toThrowError(/TELEGRAM_WEBHOOK_ENABLED is false/);

    const inactive = build({ scopeActivity: { scopeIsActive: async () => false } });
    inactive.bots.rows = bots.rows;
    await expect(
      inactive.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
    ).rejects.toThrowError(/tenant is not accepting work/);

    const halted = build();
    halted.bots.rows = bots.rows.map((row) => ({ ...row, status: 'STOPPED' as const }));
    await expect(
      halted.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
    ).rejects.toThrowError(/not ACTIVE/);
  });

  /*
   * `OQ-TG-04` item 11, and it is a credential leak rather than a wording bug.
   *
   * `scopeIsActive` used to be consulted only inside `unavailableReason`, which
   * was reached only when a bot row EXISTED. A tenant an operator had stopped,
   * with no bot yet, therefore answered `none` — and `none` is the one state in
   * which the installer PROMPTS for a bearer credential, sends it to `getMe`,
   * and only then has the create transaction refuse. The token need never have
   * left the host.
   */
  it('does not answer none for a stopped tenant that has no bot yet', async () => {
    const fresh = build({ scopeActivity: { scopeIsActive: async () => false } });
    expect(fresh.bots.rows).toHaveLength(0);

    expect(await fresh.service.status(scope, ORIGIN)).toBe('unavailable');
  });

  it('does not answer none when this installation does not serve the webhook route', async () => {
    const off = build({ webhookEnabled: () => false });
    expect(off.bots.rows).toHaveLength(0);

    expect(await off.service.status(scope, ORIGIN)).toBe('unavailable');
  });

  it('still answers none for an ACTIVE tenant with no bot', async () => {
    // The other side, so `unavailable` cannot become the answer to everything:
    // a fresh install of a healthy tenant must still reach the path that asks
    // for a token, or nothing can ever be configured.
    const { service } = build();
    expect(await service.status(scope, ORIGIN)).toBe('none');
  });

  /*
   * `OQ-TG-04` item 9. `unavailableReason` computes a cause-specific sentence
   * for each of its three causes and `status` collapsed all three to one word,
   * so `botctl telegram status` could say a bot was held back and not which of
   * three things was holding it — while `--skip-telegram` sent operators there
   * to find out.
   */
  it('reports WHICH condition makes a bot unavailable, alongside the state', async () => {
    const off = build({ webhookEnabled: () => false });
    await expect(off.service.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('TELEGRAM_WEBHOOK_ENABLED is false'),
    });

    const stopped = build({ scopeActivity: { scopeIsActive: async () => false } });
    await expect(stopped.service.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      reason: expect.stringContaining('tenant is not accepting work'),
    });

    const halted = await installed();
    halted.bots.rows[0]!.status = 'STOPPED';
    await expect(halted.service.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('not ACTIVE'),
    });
  });

  it('carries no reason for a state that has nothing to explain', async () => {
    // Otherwise a caller printing `reason` unconditionally would narrate every
    // healthy run, and `none` in particular is not a problem to diagnose.
    const { service } = build();
    await expect(service.statusWithReason(scope, ORIGIN)).resolves.toEqual({
      state: 'none',
      reason: null,
    });

    const ready = await installed();
    await expect(ready.service.statusWithReason(scope, ORIGIN)).resolves.toEqual({
      state: 'ready',
      reason: null,
    });
  });

  it('refuses a scope that has stopped accepting work, inside the transaction', async () => {
    /*
     * A CLAUDE.md non-negotiable that had no test at all: deleting all three
     * `requireActiveScope` calls used to leave the whole suite green.
     *
     * The reader answers TRUE outside a transaction and FALSE inside one, which
     * is not a contrivance — it is the exact race the in-transaction check
     * exists for. A constant `false` would be caught by the readiness read
     * before the write path is ever reached, and would prove nothing about it.
     */
    const built = build();
    const refusing = new BotBootstrapService({
      ...serviceDeps(built),
      scopeActivity: { scopeIsActive: async (_scope: unknown, tx?: unknown) => tx === undefined },
    });

    expect(
      await codeThrownBy(() => refusing.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
    // Nothing was written, and Telegram was never asked to register anything —
    // the refusal is inside the transaction, before the row exists.
    expect(built.bots.rows).toHaveLength(0);
    expect(built.telegram.webhookCalls).toHaveLength(0);
  });

  it('refuses the same scope on the RECONCILE path too', async () => {
    const { bots } = await installed();
    const second = build();
    second.bots.rows = bots.rows;
    second.bots.rows[0]!.webhookUrl = 'https://old.example.com/telegram/webhook/x';
    const refusing = new BotBootstrapService({
      ...serviceDeps(second),
      scopeActivity: { scopeIsActive: async (_scope: unknown, tx?: unknown) => tx === undefined },
    });

    expect(
      await codeThrownBy(() => refusing.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
    expect(second.bots.webhookMarks).toHaveLength(0);
  });

  it('does not audit an identity write that changed no row', async () => {
    // `telegram_bot_id IS NULL` is in the UPDATE's WHERE, so a concurrent run
    // can fill the blank first. Auditing regardless writes a row asserting a
    // `before` that was not true and a change that did not happen.
    const { service, bots, audit } = build();
    bots.rows.push({
      id: '01890000-0000-7000-8000-0000000001dd',
      username: 'stale_name_bot',
      status: 'ACTIVE',
      telegramBotId: null,
      webhookRegisteredAt: null,
      webhookUrl: null,
      webhookSecretFingerprint: null,
      token: TOKEN,
    });
    // The concurrent run, landing between the unlocked read and the UPDATE.
    bots.onLocked = () => {
      bots.rows[0]!.telegramBotId = '8123456789';
    };

    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(bots.identityWrites).toHaveLength(0);
    expect(audit.map((entry) => entry.action)).not.toContain('bot_instance.identity_recorded');
  });
});

describe('bot bootstrap — two installers at once', () => {
  it('makes the loser reconcile the winner’s row rather than create a second', async () => {
    const { service, bots, telegram } = build();
    // The race, provoked exactly where it happens: both processes found no row,
    // both validated their token, and the winner committed while the loser was
    // waiting for the tenant lock.
    bots.onLocked = () => {
      bots.rows.push({
        id: '01890000-0000-7000-8000-000000009117',
        username: 'acme_bot',
        status: 'ACTIVE',
        telegramBotId: '8123456789',
        webhookRegisteredAt: null,
        webhookUrl: null,
        webhookSecretFingerprint: null,
        token: TOKEN,
      });
    };

    const result = await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(result.botInstanceId).toBe('01890000-0000-7000-8000-000000009117');
    expect(bots.rows).toHaveLength(1);
    // The loser did not write its own copy of the credential over the winner's.
    expect(bots.tokenWrites).toHaveLength(0);
    expect(telegram.webhookCalls.at(-1)?.url).toBe(
      `${ORIGIN}/telegram/webhook/01890000-0000-7000-8000-000000009117`,
    );
  });

  it('refuses when the loser was aiming at a different bot', async () => {
    const { service, bots } = build();
    bots.onLocked = () => {
      bots.rows.push({
        id: '01890000-0000-7000-8000-000000009117',
        username: 'acme_bot',
        status: 'ACTIVE',
        telegramBotId: '8123456789',
        webhookRegisteredAt: null,
        webhookUrl: null,
        webhookSecretFingerprint: null,
        token: TOKEN,
      });
    };

    expect(
      await codeThrownBy(() =>
        service.execute(scope, { token: OTHER_TOKEN, publicBaseUrl: ORIGIN }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_DIFFERENT_BOT);
    expect(bots.tokenWrites).toHaveLength(0);
  });
});

describe('bot bootstrap — status', () => {
  it('answers none, then incomplete, then ready', async () => {
    const { service, telegram } = build();
    expect(await service.status(scope, ORIGIN)).toBe('none');

    telegram.registration = {
      outcome: 'REFUSED',
      detail: 'bad webhook: HTTPS url must be provided',
    };
    await codeThrownBy(() => service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }));
    expect(await service.status(scope, ORIGIN)).toBe('incomplete');

    telegram.registration = { outcome: 'REGISTERED' };
    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(await service.status(scope, ORIGIN)).toBe('ready');
  });

  it('does not create, decrypt or call anything', async () => {
    const { service, bots, telegram } = build();
    await service.status(scope, ORIGIN);
    expect(bots.rows).toHaveLength(0);
    expect(bots.locks).toBe(0);
    expect(telegram.identifyCalls).toHaveLength(0);
    expect(telegram.webhookCalls).toHaveLength(0);
  });
});
