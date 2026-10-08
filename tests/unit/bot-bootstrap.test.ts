import { describe, expect, it } from 'vitest';
import {
  isNexaError,
  NexaError,
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
  BotCommandsRegistration,
  BotIdentityProbe,
  WebhookRegistration,
} from '../../apps/api/src/modules/platform/tenancy/application/ports';
import type { BotWebhookRead } from '../../apps/api/src/modules/platform/tenancy/application/bot-management-ports';
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
  commandsRevision: string | null;
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
  commandMarks: { id: string; revision: string }[] = [];
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
      commandsRevision: row.commandsRevision,
    };
  }

  async markCommandsRegistered(
    _scope: unknown,
    id: string,
    input: { readonly revision: string; readonly now: Date },
  ): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) row.commandsRevision = input.revision;
    this.commandMarks.push({ id, revision: input.revision });
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
      commandsRevision: null,
      token: input.token,
    });
  }

  /**
   * R4 — the token-replacement claim, as the conditional UPDATEs keep it: free, or held
   * by one id until an instant. `claimCalls` counts every attempt to take it.
   */
  claim: { id: string; until: Date } | null = null;
  claimCalls = 0;

  async claimTokenReplacement(
    _scope: unknown,
    _id: string,
    claim: { readonly id: string; readonly now: Date; readonly until: Date },
  ): Promise<boolean> {
    this.claimCalls += 1;
    if (this.claim !== null && this.claim.until > claim.now) return false;
    this.claim = { id: claim.id, until: claim.until };
    return true;
  }

  async releaseTokenReplacement(_scope: unknown, _id: string, claimId: string): Promise<void> {
    if (this.claim?.id === claimId) this.claim = null;
  }

  async markWebhookRegistered(
    _scope: unknown,
    id: string,
    input: {
      readonly url: string;
      readonly secretFingerprint: string;
      readonly now: Date;
      readonly claimId: string;
    },
  ): Promise<boolean> {
    // Written only while the registration still holds the claim, as the SQL requires.
    if (this.claim?.id !== input.claimId) return false;
    this.webhookMarks.push({ id, url: input.url });
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.webhookRegisteredAt = input.now;
      row.webhookUrl = input.url;
      row.webhookSecretFingerprint = input.secretFingerprint;
    }
    return true;
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

  usernameWrites: { id: string; username: string }[] = [];
  /** Review N2: what the next `reconcileUsername` throws instead of answering. */
  reconcileThrows: unknown = null;

  async usernameHeldByAnotherRow(_scope: unknown, id: string, username: string): Promise<boolean> {
    return this.rows.some((other) => other.id !== id && other.username === username);
  }

  /** D3: the real statement's predicates — same bot id, and no other row holding the name. */
  async reconcileUsername(
    _scope: unknown,
    id: string,
    input: { readonly telegramBotId: string; readonly username: string },
  ): Promise<
    | { readonly outcome: 'UPDATED'; readonly before: string }
    | { readonly outcome: 'UNCHANGED' }
    | { readonly outcome: 'TAKEN'; readonly before: string }
  > {
    if (this.reconcileThrows !== null) throw this.reconcileThrows;
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row || row.telegramBotId !== input.telegramBotId || row.username === input.username) {
      return { outcome: 'UNCHANGED' };
    }
    const before = row.username;
    if (this.rows.some((other) => other.id !== id && other.username === input.username)) {
      return { outcome: 'TAKEN', before };
    }
    this.usernameWrites.push({ id, username: input.username });
    row.username = input.username;
    return { outcome: 'UPDATED', before };
  }

  async resolveToken(_scope: unknown, id: string): Promise<string> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no bot instance ${id}`);
    return row.token;
  }
}

/** A `getWebhookInfo` answer holding `url` (null: no webhook), as Telegram reports one. */
function webhookRead(
  url: string | null,
  extra: Partial<Extract<BotWebhookRead, { outcome: 'READ' }>> = {},
): Extract<BotWebhookRead, { outcome: 'READ' }> {
  return {
    outcome: 'READ',
    url,
    pendingUpdateCount: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    maxConnections: 40,
    allowedUpdates: null,
    ...extra,
  };
}

class FakeTelegram implements BotBootstrapTelegram {
  identifyCalls: string[] = [];
  webhookCalls: {
    token: string;
    url: string;
    secretToken: string;
    dropPendingUpdates: boolean;
    resetAllowedUpdates?: boolean;
  }[] = [];
  probe: BotIdentityProbe = {
    outcome: 'IDENTIFIED',
    botId: '8123456789',
    username: 'acme_bot',
    isBot: true,
  };
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

  /**
   * The digest of the menu the fake `CommandMenu` (below, in `build`) answers. Changing it
   * is a release that added a command, or an operator who reworded a description.
   */
  revision = 'rev-1';

  async registerCommands(input: {
    readonly token: string;
    readonly commands: readonly { command: string; description: string }[];
  }): Promise<BotCommandsRegistration> {
    // Same rule as every other call here: never inside a transaction.
    expect(currentTransactionLabel()).toBeUndefined();
    this.commandCalls.push(input.token);
    return this.commandsRegister
      ? { outcome: 'REGISTERED' }
      : { outcome: 'UNREACHABLE', code: 'telegram.unreachable' };
  }

  async registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
    readonly dropPendingUpdates: boolean;
    readonly resetAllowedUpdates?: boolean;
  }): Promise<WebhookRegistration> {
    expect(currentTransactionLabel()).toBeUndefined();
    this.webhookCalls.push({ ...input });
    if (this.crashOnWebhook !== null) throw this.crashOnWebhook;
    if (this.registration.outcome === 'REGISTERED') {
      // What the Bot API does: the registration is REPLACED, `allowed_updates` reset only
      // when sent, and the queue dropped only on `drop_pending_updates: true`.
      const previous = this.held.outcome === 'READ' ? this.held : webhookRead(null);
      this.held = this.heldAfterRegister ?? {
        ...previous,
        url: input.url,
        allowedUpdates: input.resetAllowedUpdates === true ? null : previous.allowedUpdates,
        pendingUpdateCount: input.dropPendingUpdates ? 0 : previous.pendingUpdateCount,
      };
    }
    return this.registration;
  }

  /**
   * What `getWebhookInfo` answers: Telegram's STATE, which an accepted `setWebhook`
   * replaces (above). Starts with no webhook. A test may set a failure answer
   * (`REJECTED`, `UNREACHABLE`) or a foreign registration directly.
   *
   * Hardening 2026-10-07: this was a constant UNREACHABLE, which the bootstrap read as "no
   * evidence against the marker". Since the registration is now READ BACK, and an unread
   * registration is no longer ALREADY_COMPLETE, the fake has to hold state like Telegram.
   */
  held: BotWebhookRead = webhookRead(null);
  /** Set to make Telegram ACCEPT a `setWebhook` and then report this instead. */
  heldAfterRegister: BotWebhookRead | null = null;
  readWebhookCalls = 0;

  async readWebhook(): Promise<BotWebhookRead> {
    expect(currentTransactionLabel()).toBeUndefined();
    this.readWebhookCalls += 1;
    return this.held;
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
    // Round P: the desired menu, whose digest the fake gateway's `revision` stands for.
    commandMenu: {
      desiredFor: async () => ({
        entries: [{ command: 'start', description: 'شروع' }],
        hash: telegram.revision,
      }),
    },
    webhookSecret: () => SECRET,
    webhookEnabled: () => true,
    telegramCallTimeoutMs: 10_000,
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
   * `OQ-TG-04` item 12. The installer's classifier had no arm for this code, so
   * an outbound failure during `getMe` fell through to a summary about inbound
   * DNS and certificates — the opposite network boundary, for a call that never
   * reached `setWebhook`. The classifier is gone; the code still has to say
   * which direction it is, because that is what the operator acts on.
   */
  it('names the OUTBOUND boundary when Telegram cannot be reached', async () => {
    const { service, telegram } = build();
    telegram.probe = { outcome: 'UNREACHABLE', detail: 'ETIMEDOUT' };

    const message = await messageThrownBy(() =>
      service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN }),
    );

    expect(message).toContain('OUTBOUND');
    expect(message).toContain('before any webhook is registered');
    // And it rules out the two things the webhook summary sent people to.
    expect(message).toContain('your certificate are not involved');
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

  /*
   * R4. The marker is this installation's record of what it registered; it cannot see a
   * registration Telegram dropped on its side. The owner's staging bot went silent that
   * way while this command answered ALREADY_COMPLETE, so a rerun now asks.
   */
  it('asks Telegram, and keeps ALREADY_COMPLETE only when Telegram holds exactly this URL', async () => {
    const { service, telegram } = await installed();
    const url = telegram.webhookCalls[0]?.url ?? '';
    const before = telegram.webhookCalls.length;
    telegram.held = {
      outcome: 'READ',
      url,
      pendingUpdateCount: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      maxConnections: 40,
      allowedUpdates: null,
    };

    const reads = telegram.readWebhookCalls;
    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(result.kind).toBe('ALREADY_COMPLETE');
    expect(telegram.readWebhookCalls).toBe(reads + 1);
    expect(telegram.webhookCalls).toHaveLength(before);
  });

  it('re-registers, keeping the queue, when Telegram no longer holds what the marker says', async () => {
    const held = (url: string | null, allowedUpdates: string[] | null): BotWebhookRead => ({
      outcome: 'READ',
      url,
      pendingUpdateCount: 5,
      lastErrorAt: null,
      lastErrorMessage: null,
      maxConnections: 40,
      allowedUpdates,
    });
    for (const [label, answer] of [
      ['dropped', () => held(null, null)],
      ['elsewhere', () => held('https://elsewhere.example.test/hook', null)],
      ['narrowed', (url: string) => held(url, ['message'])],
    ] as const) {
      const { service, telegram } = await installed();
      const url = telegram.webhookCalls[0]?.url ?? '';
      telegram.held = answer(url);

      const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
      expect(result.kind, label).toBe('RECONCILED');
      expect(telegram.webhookCalls, label).toHaveLength(2);
      // A running installation: whatever Telegram queued is customers' messages.
      expect(telegram.webhookCalls[1], label).toMatchObject({ url, dropPendingUpdates: false });
    }
  });

  /*
   * R4 lead review. The Bot API keeps the previous `allowed_updates` when the field is
   * omitted, so a re-registration sent here because the list was NARROWED must reset it,
   * or every rerun re-registers and leaves the fault in place. A fresh install resets
   * too: the empty list is Telegram's default set, the one this installation relies on.
   */
  it('resets allowed_updates on every registration, create and reconcile alike', async () => {
    const { service, telegram } = await installed();
    expect(telegram.webhookCalls[0]).toMatchObject({
      dropPendingUpdates: true,
      resetAllowedUpdates: true,
    });
    const url = telegram.webhookCalls[0]?.url ?? '';
    telegram.held = {
      outcome: 'READ',
      url,
      pendingUpdateCount: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      maxConnections: 40,
      allowedUpdates: ['message'],
    };

    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(telegram.webhookCalls[1]).toMatchObject({
      url,
      dropPendingUpdates: false,
      resetAllowedUpdates: true,
    });
  });

  // Codex F5: a REJECTED read is Telegram's answer, not a flake; only UNREACHABLE keeps
  // the marker's word. The rerun re-registers, and a rejected token fails there.
  it('re-registers when Telegram REJECTS the webhook read, rather than trusting the marker', async () => {
    const { service, telegram } = await installed();
    telegram.held = { outcome: 'REJECTED' };
    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(result.kind).toBe('RECONCILED');
    expect(telegram.webhookCalls).toHaveLength(2);

    // UNREACHABLE is still no evidence either way — so it changes nothing, AND (hardening
    // 2026-10-07) it is no longer reported as ALREADY_COMPLETE: that answer prints "already
    // configured and receiving updates", which an unread registration cannot support.
    const quiet = await installed();
    quiet.telegram.held = { outcome: 'UNREACHABLE' };
    const calls = quiet.telegram.webhookCalls.length;
    expect(
      await codeThrownBy(() =>
        quiet.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_UNREACHABLE);
    expect(quiet.telegram.webhookCalls).toHaveLength(calls);
  });

  // Codex F6: the registration takes the same claim a Web Admin replacement holds.
  it('refuses to register while a token replacement holds the claim, and registers after', async () => {
    const { service, bots, telegram } = build();
    bots.claim = { id: 'web-admin-replacement', until: new Date('2999-01-01T00:00:00Z') };

    const error = await service
      .execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN })
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(isNexaError(error) && error.kind).toBe('CONFLICT');
    expect(isNexaError(error) && error.message).toContain('in progress in the Web Admin');
    expect(telegram.webhookCalls).toHaveLength(0);
    expect(bots.webhookMarks).toHaveLength(0);
    expect(bots.claim?.id).toBe('web-admin-replacement');

    bots.claim = null;
    const done = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(done.kind).toBe('RECONCILED');
    expect(telegram.webhookCalls).toHaveLength(1);
    expect(bots.webhookMarks).toHaveLength(1);
    // Released after the marker, whatever happened.
    expect(bots.claim).toBeNull();
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
  /*
   * Hardening 2026-10-07 (incident A). This pinned "no supported recovery … OQ-TG-01", which
   * stopped being true when R4 shipped the Web Admin replacement — and is the sentence an
   * operator with a revoked token (`telegram.rejected.401`) was handed. It now names the
   * recovery that exists, and still says rerunning this command cannot help.
   */
  it('sends a STORED token Telegram rejects to the Web Admin replacement, not to a rerun', async () => {
    const { service, telegram } = await installed();
    telegram.probe = { outcome: 'REJECTED', detail: 'Unauthorized' };

    const message = await messageThrownBy(() =>
      service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
    );

    expect(message).toMatch(/Web Admin/);
    expect(message).toMatch(/cannot help/);
    expect(message).not.toMatch(/no supported recovery/);
    expect(message).not.toMatch(/Nothing was stored/);
  });

  /*
   * `OQ-4H-02`. `setMyCommands` ran only on the register-and-mark path, which an
   * installation whose webhook is already current never reaches: `execute`
   * returns ALREADY_COMPLETE above it. So every installation that UPGRADED into
   * the release carrying `BOT_COMMANDS` kept whatever menu it had — for most,
   * none — and 4H's discoverability applied to fresh installs only.
   */
  it('registers a CHANGED command menu on an installation that is already complete', async () => {
    const { service, telegram, bots } = await installed();
    const before = telegram.commandCalls.length;

    // The release that adds a command, or reworders one: the digest is computed
    // from the rendered menu, so both look the same from here.
    telegram.revision = 'rev-2';
    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('ALREADY_COMPLETE');
    expect(telegram.commandCalls).toHaveLength(before + 1);
    expect(bots.rows[0]?.commandsRevision).toBe('rev-2');
    // And it did NOT re-register the webhook, which carries dropPendingUpdates.
    expect(telegram.webhookCalls).toHaveLength(1);
  });

  it('does not re-register an UNCHANGED menu on every rerun', async () => {
    // Otherwise this is an outbound Telegram call on every `botctl update` of
    // every installation, for a menu that has not moved.
    const { service, telegram } = await installed();
    const before = telegram.commandCalls.length;

    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(telegram.commandCalls).toHaveLength(before);
  });

  it('does not record a revision the registration did not achieve', async () => {
    // A digest stored after a FAILED call would make the next reconcile skip it,
    // and the menu would stay wrong until the list changed again — the failure
    // this whole item is about, reintroduced by its own fix.
    const { service, telegram, bots } = await installed();
    telegram.revision = 'rev-2';
    telegram.commandsRegister = false;

    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('ALREADY_COMPLETE');
    expect(bots.rows[0]?.commandsRevision).not.toBe('rev-2');

    // And the next run tries again.
    telegram.commandsRegister = true;
    const calls = telegram.commandCalls.length;
    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(telegram.commandCalls).toHaveLength(calls + 1);
    expect(bots.rows[0]?.commandsRevision).toBe('rev-2');
  });

  it('treats a NULL stored revision as unknown rather than as matching', async () => {
    // The pre-0059 row, which is every installation that upgrades into this
    // release. The same rule `webhook_secret_fingerprint` states: one
    // unnecessary call is cheaper than a silent claim.
    const { service, telegram, bots } = await installed();
    bots.rows[0]!.commandsRevision = null;
    const before = telegram.commandCalls.length;

    await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(telegram.commandCalls).toHaveLength(before + 1);
    expect(bots.rows[0]?.commandsRevision).toBe(telegram.revision);
  });

  /*
   * The menu write is a WRITE, and CLAUDE.md's non-negotiable applies to it:
   * "Every write path also reads `ScopeActivityReader` INSIDE its transaction".
   *
   * `execute` checks activity earlier, but outside this transaction, and a stop
   * can commit in between — which is the whole reason the rule says "inside".
   * The reader answers TRUE outside a transaction and FALSE inside one, which is
   * not a contrivance: it is the exact race, and a constant `false` would be
   * caught by the readiness read long before this write.
   *
   * This test exists because the first falsification of the check SURVIVED. The
   * check was added by the self-review of this phase's diff and had nothing
   * asserting it, so removing it again left the suite green — recorded as
   * F4I-18 in `docs/phase4i-falsification.md`.
   */
  it('refuses to record a menu revision for a scope that stopped mid-run', async () => {
    const built = await installed();
    built.telegram.revision = 'rev-2';
    const refusing = new BotBootstrapService({
      ...serviceDeps(built),
      scopeActivity: { scopeIsActive: async (_scope: unknown, tx?: unknown) => tx === undefined },
    });

    expect(
      await codeThrownBy(() => refusing.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
    // Telegram WAS asked — the call happens outside the transaction, as it must
    // — and the durable record of it was refused, so the next run tries again.
    expect(built.bots.rows[0]?.commandsRevision).not.toBe('rev-2');
  });

  it('takes the bot-change lock before recording a menu revision', async () => {
    // The same lock every other write here takes, and in the same order: the
    // activity check takes a SHARE lock on the tenant row, so taking the shared
    // one first and upgrading is how two writers deadlock instead of queueing.
    const built = await installed();
    const before = built.bots.locks;
    built.telegram.revision = 'rev-2';

    await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(built.bots.locks).toBe(before + 1);
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
      commandsRevision: null,
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
      commandsRevision: null,
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
      commandsRevision: null,
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

  /*
   * The PRECEDENCE, which 4I moved and which nothing pinned.
   *
   * The three causes used to be ordered webhook route, bot status, tenant
   * activity; splitting the scope-level pair out for item 11 made it webhook
   * route, tenant activity, bot status. Every existing test builds one cause at
   * a time, so both orders passed identically — found by the self-review of this
   * phase's own diff, and pinned here rather than left as a comment.
   */
  it('reports the tenant before the bot when BOTH are in the way', async () => {
    const stopped = await installed();
    stopped.bots.rows[0]!.status = 'STOPPED';
    const both = new BotBootstrapService({
      ...serviceDeps(stopped),
      scopeActivity: { scopeIsActive: async () => false },
    });

    // Starting the bot changes nothing while the tenant refuses every update,
    // so naming the bot first would send an operator to fix what is not in the
    // way.
    await expect(both.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('tenant is not accepting work'),
    });
  });

  it('reports the webhook route being off before either of those', async () => {
    const stopped = await installed();
    stopped.bots.rows[0]!.status = 'STOPPED';
    const all3 = new BotBootstrapService({
      ...serviceDeps(stopped),
      scopeActivity: { scopeIsActive: async () => false },
      webhookEnabled: () => false,
    });

    // It is the widest of the three: with the route unserved, nothing this
    // installation does with a tenant or a bot makes an update arrive.
    await expect(all3.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      reason: expect.stringContaining('TELEGRAM_WEBHOOK_ENABLED is false'),
    });
  });

  it('carries no reason for a state that has nothing to explain', async () => {
    // Otherwise a caller printing `reason` unconditionally would narrate every
    // healthy run, and `none` in particular is not a problem to diagnose.
    const { service } = build();
    await expect(service.statusWithReason(scope, ORIGIN)).resolves.toEqual({
      state: 'none',
      reason: null,
      detail: null,
    });

    const ready = await installed();
    await expect(ready.service.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
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
      commandsRevision: null,
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
        commandsRevision: null,
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
        commandsRevision: null,
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

/*
 * Hardening batch 2026-10-07, incident A.
 *
 * After a server move `botctl telegram status` printed `ready` from the LOCAL marker alone
 * while Telegram's own `getWebhookInfo` said `url: ""` with 22 updates queued; replies then
 * failed with `telegram.rejected.401` because the stored token had been revoked. Each case
 * below is one half of that disagreement, and the word `status` must not paper over it.
 */
describe('bot bootstrap — status asks Telegram, and ready means BOTH halves agree', () => {
  async function installed(): Promise<ReturnType<typeof build>> {
    const built = build();
    await built.service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    return built;
  }
  const expectedUrlOf = (built: ReturnType<typeof build>): string =>
    built.telegram.webhookCalls[0]?.url ?? '';

  it('local marker registered, Telegram holding NO url → NOT ready, with the queue counted', async () => {
    const built = await installed();
    built.telegram.held = webhookRead(null, { pendingUpdateCount: 22 });

    const report = await built.service.statusWithReason(scope, ORIGIN);

    expect(report.state).toBe('incomplete');
    expect(report.detail?.local.registered).toBe(true);
    expect(report.detail?.remote).toMatchObject({
      outcome: 'READ',
      url: null,
      matchesExpected: false,
      pendingUpdateCount: 22,
    });
    expect(report.detail?.problems).toContain('WEBHOOK_NOT_SET');
    expect(report.reason).toContain('NO webhook URL');
    expect(report.reason).toContain('22 queued update(s)');
    expect(report.reason).toContain('botctl telegram register');
  });

  it('local marker registered, Telegram delivering ELSEWHERE → NOT ready, foreign URL cut', async () => {
    const built = await installed();
    built.telegram.held = webhookRead(`https://elsewhere.example.test/${TOKEN}`);

    const report = await built.service.statusWithReason(scope, ORIGIN);

    expect(report.state).toBe('incomplete');
    expect(report.detail?.remote.matchesExpected).toBe(false);
    // A foreign URL's path can carry a token; only its origin is shown.
    expect(report.detail?.remote.url).toBe('https://elsewhere.example.test/…');
    expect(report.detail?.problems).toContain('WEBHOOK_ELSEWHERE');
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  it('a narrowed update set is NOT ready either', async () => {
    const built = await installed();
    built.telegram.held = webhookRead(expectedUrlOf(built), { allowedUpdates: ['message'] });

    const report = await built.service.statusWithReason(scope, ORIGIN);
    expect(report.state).toBe('incomplete');
    expect(report.detail?.remote.updatesNarrowed).toBe(true);
  });

  it('Telegram holding exactly this URL, with the marker current → ready, and both halves shown', async () => {
    const built = await installed();
    const url = expectedUrlOf(built);
    built.telegram.held = webhookRead(url, { pendingUpdateCount: 3 });

    const report = await built.service.statusWithReason(scope, ORIGIN);

    expect(report).toMatchObject({ state: 'ready', reason: null });
    expect(report.detail).toMatchObject({
      expectedUrl: url,
      local: { registered: true, recordedUrl: url, secret: 'MATCHES' },
      remote: { outcome: 'READ', url, matchesExpected: true, pendingUpdateCount: 3 },
      problems: [],
    });
  });

  it('Telegram holding this URL but the LOCAL marker not current → NOT ready', async () => {
    const built = await installed();
    built.bots.rows[0]!.webhookSecretFingerprint = null;

    const report = await built.service.statusWithReason(scope, ORIGIN);
    expect(report.state).toBe('incomplete');
    expect(report.detail?.local).toMatchObject({ registered: false, secret: 'UNKNOWN' });
    expect(report.detail?.remote.matchesExpected).toBe(true);
  });

  it('a stored token Telegram REJECTS is unavailable — not ready, not "register" — and names the Web Admin', async () => {
    const built = await installed();
    built.telegram.probe = { outcome: 'REJECTED', detail: 'Unauthorized' };

    const report = await built.service.statusWithReason(scope, ORIGIN);

    expect(report.state).toBe('unavailable');
    expect(report.detail?.remote.outcome).toBe('TOKEN_REJECTED');
    expect(report.reason).toContain('Web Admin');
    expect(report.reason).toContain('cannot fix this');
    // Asked once; nothing else was tried with a token Telegram refused.
    expect(built.telegram.webhookCalls).toHaveLength(1);
  });

  // Review 2026-10-07: getMe has just PROVED the token, so a permanent getWebhookInfo
  // failure must not send the operator to replace it.
  it('a webhook read that fails permanently AFTER getMe accepted the token is not blamed on the token', async () => {
    const built = await installed();
    built.telegram.held = { outcome: 'REJECTED' };
    const report = await built.service.statusWithReason(scope, ORIGIN);
    expect(report.state).toBe('unavailable');
    expect(report.detail?.remote.outcome).toBe('WEBHOOK_READ_REFUSED');
    expect(report.reason).toContain('getWebhookInfo');
    expect(report.reason).toContain('TELEGRAM_API_BASE_URL');
    expect(report.reason).toContain('does not need replacing');
    expect(report.reason).not.toContain('Replace the token');
  });

  it('Telegram that cannot be asked is UNKNOWN, and unknown is not ready', async () => {
    for (const unreachable of ['getMe', 'getWebhookInfo'] as const) {
      const built = await installed();
      if (unreachable === 'getMe') {
        built.telegram.probe = { outcome: 'UNREACHABLE', detail: 'socket hang up' };
      } else {
        built.telegram.held = { outcome: 'UNREACHABLE' };
      }
      const report = await built.service.statusWithReason(scope, ORIGIN);
      expect(report.state, unreachable).toBe('unavailable');
      expect(report.detail?.remote.outcome, unreachable).toBe('UNREACHABLE');
      expect(report.reason, unreachable).toContain('UNKNOWN');
    }
  });

  it('an API base that is not Telegram, a token for ANOTHER bot, and an undecryptable token are each unavailable', async () => {
    const notTelegram = await installed();
    notTelegram.telegram.probe = { outcome: 'NOT_TELEGRAM', detail: 'not a bot' };
    await expect(notTelegram.service.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      state: 'unavailable',
      detail: { remote: { outcome: 'NOT_TELEGRAM' } },
    });

    const other = await installed();
    other.telegram.probe = {
      outcome: 'IDENTIFIED',
      botId: '9999999999',
      username: 'other',
      isBot: true,
    };
    const otherReport = await other.service.statusWithReason(scope, ORIGIN);
    expect(otherReport).toMatchObject({
      state: 'unavailable',
      detail: { remote: { outcome: 'DIFFERENT_BOT' } },
    });
    expect(otherReport.detail?.problems).toContain('DIFFERENT_BOT');

    const sealed = await installed();
    sealed.bots.resolveToken = async () => {
      throw new NexaError({
        kind: 'CONFIGURATION',
        code: 'platform.secret_key_unknown',
        message: `key for ${TOKEN} not loaded`,
      });
    };
    const report = await sealed.service.statusWithReason(scope, ORIGIN);
    expect(report.state).toBe('unavailable');
    expect(report.detail?.remote).toMatchObject({
      outcome: 'TOKEN_UNREADABLE',
      tokenErrorCode: 'platform.secret_key_unknown',
    });
    // The code, never the error's message.
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(sealed.telegram.identifyCalls).toHaveLength(1); // the install's, none from status
  });

  it('is read-only: no registration, no marker, no audit row, no claim', async () => {
    const built = await installed();
    built.telegram.held = webhookRead(null, { pendingUpdateCount: 22 });
    const calls = built.telegram.webhookCalls.length;
    const marks = built.bots.webhookMarks.length;
    const audits = built.audit.length;
    const claims = built.bots.claimCalls;

    await built.service.statusWithReason(scope, ORIGIN);

    expect(built.telegram.webhookCalls).toHaveLength(calls);
    expect(built.bots.webhookMarks).toHaveLength(marks);
    expect(built.audit).toHaveLength(audits);
    expect(built.bots.claimCalls).toBe(claims);
  });

  it('never returns the token or the webhook secret, whatever Telegram says', async () => {
    const built = await installed();
    built.telegram.held = webhookRead(expectedUrlOf(built), {
      pendingUpdateCount: 1,
      lastErrorAt: new Date('2026-10-06T10:00:00Z'),
      // Telegram echoing a request URL, the shape `redaction.ts` records.
      lastErrorMessage: `Wrong response from https://api.telegram.org/bot${TOKEN}/x ${SECRET}`,
    });

    const report = await built.service.statusWithReason(scope, ORIGIN);
    const text = JSON.stringify(report);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN.split(':')[1]);
    expect(text).not.toContain(SECRET);
    expect(report.detail?.remote.lastErrorMessage).toContain('Wrong response');
  });
});

describe('bot bootstrap — register is the safe reconcile for the incident state', () => {
  async function installed(): Promise<ReturnType<typeof build>> {
    const built = build();
    await built.service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    return built;
  }

  it('re-registers a webhook Telegram dropped, KEEPS the 22 queued updates, reads it back, and is then ready', async () => {
    const built = await installed();
    const url = built.telegram.webhookCalls[0]?.url ?? '';
    // What a BotFather revocation / server move left: marker current, Telegram empty.
    built.telegram.held = webhookRead(null, { pendingUpdateCount: 22 });
    const reads = built.telegram.readWebhookCalls;

    const result = await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    // Read FIRST, then register, then read BACK.
    expect(built.telegram.readWebhookCalls).toBe(reads + 2);
    expect(built.telegram.webhookCalls).toHaveLength(2);
    // Every registration a reconcile issues keeps the queue; the port has no deleteWebhook,
    // so nothing else could drop it.
    for (const call of built.telegram.webhookCalls.slice(1)) {
      expect(call).toMatchObject({ url, dropPendingUpdates: false, resetAllowedUpdates: true });
    }
    expect(built.telegram.held).toMatchObject({ url, pendingUpdateCount: 22 });
    // The success audit says what was proved, and no credential.
    const row = built.audit.at(-1);
    expect(row).toMatchObject({
      action: 'bot_instance.webhook_registered',
      result: 'SUCCESS',
      after: {
        webhookUrl: url,
        verifiedBy: ['setWebhook', 'getWebhookInfo'],
        pendingUpdateCount: 22,
        dropPendingUpdates: false,
      },
    });
    expect(JSON.stringify(built.audit)).not.toContain(TOKEN);
    expect(JSON.stringify(built.audit)).not.toContain(SECRET);

    await expect(built.service.statusWithReason(scope, ORIGIN)).resolves.toMatchObject({
      state: 'ready',
    });

    // Idempotent: a second run changes nothing.
    const again = await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });
    expect(again.kind).toBe('ALREADY_COMPLETE');
    expect(built.telegram.webhookCalls).toHaveLength(2);
  });

  it('fails EXPLICITLY, writes no marker, and audits the stage when the read-back does not show this URL', async () => {
    for (const [label, after] of [
      ['empty', webhookRead(null)],
      ['elsewhere', webhookRead('https://elsewhere.example.test/hook')],
      ['unreadable', { outcome: 'UNREACHABLE' } as BotWebhookRead],
    ] as const) {
      const built = await installed();
      built.telegram.held = webhookRead(null, { pendingUpdateCount: 22 });
      built.telegram.heldAfterRegister = after;
      const marks = built.bots.webhookMarks.length;
      const markedAt = built.bots.rows[0]!.webhookRegisteredAt;
      built.bots.rows[0]!.webhookSecretFingerprint = null; // force a re-registration

      const message = await messageThrownBy(() =>
        built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
      );
      expect(message, label).toContain('reading it back');
      expect(message, label).not.toContain(TOKEN);
      expect(built.bots.webhookMarks, label).toHaveLength(marks);
      expect(built.bots.rows[0]!.webhookRegisteredAt, label).toBe(markedAt);
      expect(built.audit.at(-1), label).toMatchObject({
        action: 'bot_instance.webhook_registered',
        result: 'FAILED',
        after: { stage: 'VERIFY_WEBHOOK', dropPendingUpdates: false },
      });
      // The claim is released, so the next rerun is not refused.
      expect(built.bots.claim, label).toBeNull();
      await expect(built.service.statusWithReason(scope, ORIGIN), label).resolves.not.toMatchObject(
        { state: 'ready' },
      );
    }
  });

  it("an audit writer that fails does not replace the registration's own error", async () => {
    const built = await installed();
    const brokenAudit = new BotBootstrapService({
      ...serviceDeps(built),
      audit: {
        record: async (_s, _a, entry) => {
          if (entry.result === 'FAILED') throw new Error('audit store unavailable');
          built.audit.push(entry);
        },
      },
    });
    built.bots.rows[0]!.webhookSecretFingerprint = null;
    built.telegram.heldAfterRegister = webhookRead(null);

    expect(
      await codeThrownBy(() => brokenAudit.execute(scope, { token: null, publicBaseUrl: ORIGIN })),
    ).toBe(PLATFORM_ERROR_CODES.TELEGRAM_BOOTSTRAP_WEBHOOK_FAILED);
    expect(built.bots.claim).toBeNull();
  });

  it('audits a registration Telegram refused, with its reason redacted and no token', async () => {
    const built = await installed();
    built.bots.rows[0]!.webhookSecretFingerprint = null;
    built.telegram.registration = {
      outcome: 'REFUSED',
      detail: `Bad Request: bad webhook for bot${TOKEN}`,
    };

    const message = await messageThrownBy(() =>
      built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN }),
    );
    expect(message).not.toContain(TOKEN);
    expect(built.audit.at(-1)).toMatchObject({
      result: 'FAILED',
      after: { stage: 'SET_WEBHOOK', outcome: 'REFUSED' },
    });
    expect(JSON.stringify(built.audit)).not.toContain(TOKEN);
  });
});

/**
 * Roadmap D3 — a bot renamed in BotFather.
 *
 * The stored `username` is what the ops-group connect command and the Web Admin's
 * `t.me/…` links print. A rename used to leave it stale until a token replacement; a
 * register (or installer rerun) now records the name `getMe` reports for the SAME bot,
 * audited, while `status` only shows the drift.
 */
describe('bot bootstrap — a BotFather rename is reconciled by register, shown by status', () => {
  async function installed(): Promise<ReturnType<typeof build>> {
    const built = build();
    await built.service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    built.telegram.held = webhookRead(built.telegram.webhookCalls[0]?.url ?? null);
    return built;
  }
  const renamed = (built: ReturnType<typeof build>, username: string) => {
    built.telegram.probe = {
      outcome: 'IDENTIFIED',
      botId: '8123456789',
      username,
      isBot: true,
    };
  };

  it('register records the new name for the same bot, audits it, and rotates nothing', async () => {
    const built = await installed();
    const audits = built.audit.length;
    renamed(built, 'acme_renamed_bot');

    const result = await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result).toMatchObject({
      kind: 'ALREADY_COMPLETE',
      username: 'acme_renamed_bot',
      usernameReconcile: 'UPDATED',
    });
    expect(built.bots.rows[0]?.username).toBe('acme_renamed_bot');
    expect(built.bots.usernameWrites).toEqual([
      { id: built.bots.rows[0]?.id, username: 'acme_renamed_bot' },
    ]);
    expect(built.bots.tokenWrites).toEqual([TOKEN]);
    const entry = built.audit
      .slice(audits)
      .find((row) => row.action === 'bot_instance.username_reconciled');
    expect(entry).toMatchObject({
      result: 'SUCCESS',
      before: { username: 'acme_bot' },
      after: { username: 'acme_renamed_bot' },
    });
    expect(JSON.stringify(built.audit)).not.toContain(TOKEN);
  });

  it('writes nothing when the name has not changed', async () => {
    const built = await installed();
    const audits = built.audit.length;

    const result = await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result).not.toHaveProperty('usernameReconcile');
    expect(built.bots.usernameWrites).toEqual([]);
    expect(built.audit.slice(audits).map((row) => row.action)).not.toContain(
      'bot_instance.username_reconciled',
    );
  });

  it('keeps the stored name when another row holds the new one, audits FAILED, and still completes', async () => {
    const built = await installed();
    built.bots.rows.push({
      ...built.bots.rows[0]!,
      id: '01890000-0000-7000-8000-0000000001ee',
      username: 'acme_renamed_bot',
      telegramBotId: '1111111111',
    });
    renamed(built, 'acme_renamed_bot');

    const result = await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    // Review N1: the STORED name is reported, with the outcome, not the name Telegram gave.
    expect(result).toMatchObject({
      kind: 'ALREADY_COMPLETE',
      username: 'acme_bot',
      usernameReconcile: 'TAKEN',
    });
    expect(built.bots.rows[0]?.username).toBe('acme_bot');
    expect(built.audit.at(-1)).toMatchObject({
      action: 'bot_instance.username_reconciled',
      result: 'FAILED',
      before: { username: 'acme_bot' },
      after: { username: 'acme_bot', reported: 'acme_renamed_bot' },
    });
  });

  it('status SHOWS the drift and writes nothing; ready is unaffected', async () => {
    const built = await installed();
    renamed(built, 'acme_renamed_bot');
    const audits = built.audit.length;

    const report = await built.service.statusWithReason(scope, ORIGIN);

    expect(report.state).toBe('ready');
    expect(report.detail?.usernameDrift).toEqual({
      stored: 'acme_bot',
      reported: 'acme_renamed_bot',
      heldByAnotherRow: false,
    });
    expect(built.bots.usernameWrites).toEqual([]);
    expect(built.audit).toHaveLength(audits);
  });

  it('status says when another row holds the new name, so register is not prescribed', async () => {
    const built = await installed();
    built.bots.rows.push({
      ...built.bots.rows[0]!,
      id: '01890000-0000-7000-8000-0000000001ee',
      username: 'acme_renamed_bot',
      telegramBotId: '1111111111',
    });
    renamed(built, 'acme_renamed_bot');

    const report = await built.service.statusWithReason(scope, ORIGIN);
    expect(report.detail?.usernameDrift).toMatchObject({ heldByAnotherRow: true });
  });

  it.each([
    ['a unique violation from a concurrent writer', { code: '23505' }, 'TAKEN'],
    ['the same violation wrapped by the driver', { cause: { code: '23505' } }, 'TAKEN'],
    ['any other failure', new Error('connection reset'), 'UNRESOLVED'],
  ])(
    'review N2: %s keeps the stored name and never fails register',
    async (_label, thrown, outcome) => {
      const warnings: Record<string, unknown>[] = [];
      const built = build({ logger: { warn: (context) => warnings.push(context) } });
      await built.service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
      built.telegram.held = webhookRead(built.telegram.webhookCalls[0]?.url ?? null);
      renamed(built, 'acme_renamed_bot');
      built.bots.reconcileThrows = thrown;

      const result = await built.service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

      expect(result).toMatchObject({
        kind: 'ALREADY_COMPLETE',
        username: 'acme_bot',
        usernameReconcile: outcome,
      });
      expect(built.bots.rows[0]?.username).toBe('acme_bot');
      expect(warnings).toEqual([expect.objectContaining({ outcome })]);
    },
  );

  it('status carries no drift for a bot whose name matches', async () => {
    const built = await installed();
    const report = await built.service.statusWithReason(scope, ORIGIN);
    expect(report.detail).not.toHaveProperty('usernameDrift');
  });
});
