import { describe, expect, it } from 'vitest';
import { isNexaError, PLATFORM_ERROR_CODES, type TenantContext } from '@nexa/contracts';
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
      token: input.token,
    });
  }

  async markWebhookRegistered(
    _scope: unknown,
    id: string,
    input: { readonly url: string; readonly now: Date },
  ): Promise<void> {
    this.webhookMarks.push({ id, url: input.url });
    const row = this.rows.find((candidate) => candidate.id === id);
    if (row) {
      row.webhookRegisteredAt = input.now;
      row.webhookUrl = input.url;
    }
  }

  async recordTelegramIdentity(
    _scope: unknown,
    id: string,
    input: { readonly telegramBotId: string; readonly username: string },
  ): Promise<void> {
    const row = this.rows.find((candidate) => candidate.id === id);
    // The real statement carries `telegram_bot_id IS NULL` in its WHERE; the
    // fake honours the same rule, so a test cannot pass here and fail in
    // Postgres.
    if (!row || row.telegramBotId !== null) return;
    this.identityWrites.push({ id, telegramBotId: input.telegramBotId });
    row.telegramBotId = input.telegramBotId;
    row.username = input.username;
  }

  async resolveToken(_scope: unknown, id: string): Promise<string> {
    const row = this.rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`no bot instance ${id}`);
    return row.token;
  }
}

class FakeTelegram implements BotBootstrapTelegram {
  identifyCalls: string[] = [];
  webhookCalls: { token: string; url: string; secretToken: string }[] = [];
  probe: BotIdentityProbe = { outcome: 'IDENTIFIED', botId: '8123456789', username: 'acme_bot' };
  registration: WebhookRegistration = { outcome: 'REGISTERED' };
  /** Thrown instead of answering, to simulate the process dying mid-call. */
  crashOnWebhook: Error | null = null;

  async identify(token: string): Promise<BotIdentityProbe> {
    // The rule the whole design rests on: never inside a transaction. A fake
    // that did not check this would let the service be refactored into one.
    expect(currentTransactionLabel()).toBeUndefined();
    this.identifyCalls.push(token);
    return this.probe;
  }

  async registerWebhook(input: {
    readonly token: string;
    readonly url: string;
    readonly secretToken: string;
  }): Promise<WebhookRegistration> {
    expect(currentTransactionLabel()).toBeUndefined();
    this.webhookCalls.push({ ...input });
    if (this.crashOnWebhook !== null) throw this.crashOnWebhook;
    return this.registration;
  }
}

function build(overrides: Partial<BotBootstrapDeps> = {}): {
  service: BotBootstrapService;
  bots: FakeBots;
  telegram: FakeTelegram;
  audit: { action: string; entityId: string | null; after: unknown }[];
  ids: string[];
} {
  const bots = new FakeBots();
  const telegram = new FakeTelegram();
  const audit: { action: string; entityId: string | null; after: unknown }[] = [];
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
    scopeActivity: { scopeIsActive: async () => true },
    audit: {
      record: async (_s, _a, entry) => {
        audit.push({ action: entry.action, entityId: entry.entityId, after: entry.after });
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
  };

  return {
    service: new BotBootstrapService({ ...deps, ...overrides }),
    bots,
    telegram,
    audit,
    ids,
  };
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
    ]);
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

  it('does not rewrite the token when the same one is supplied again', async () => {
    const { service, bots } = await installed();
    await service.execute(scope, { token: TOKEN, publicBaseUrl: ORIGIN });
    // Counted, not compared. An identical re-encryption would leave the value
    // looking unchanged and would still be a credential write on a rerun.
    expect(bots.tokenWrites).toEqual([TOKEN]);
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
      token: TOKEN,
    });

    const result = await service.execute(scope, { token: null, publicBaseUrl: ORIGIN });

    expect(result.kind).toBe('RECONCILED');
    expect(bots.identityWrites).toEqual([
      { id: '01890000-0000-7000-8000-0000000001dd', telegramBotId: '8123456789' },
    ]);
    // The username came from Telegram too, so a BotFather rename is picked up
    // rather than left to rot in a column nothing reconciles.
    expect(bots.rows[0]?.username).toBe('acme_bot');
    expect(bots.tokenWrites).toHaveLength(0);
    // Asked with the STORED token. The installer supplied none, and the row's
    // credential is what identified it.
    expect(telegram.identifyCalls).toEqual([TOKEN]);
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
