import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MINIAPP_ERROR_CODES,
  NexaError,
  errors,
  uuidV7Schema,
  type ActorContext,
  type AuditWriter,
  type BotInstance,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type CustomerArrival,
  type IdGenerator,
  type ScopeContext,
  type TelegramChannel,
  type Tenant,
  type TenantContext,
  type TenantId,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { CustomerRecord } from '../../customers/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import { verifyInitData } from '../domain/init-data.js';
import type { MiniAppSessionRecord, MiniAppSessionRepository } from './ports.js';

/** The feature flag the whole mini app sits behind (default OFF). */
export const MINIAPP_FEATURE = 'mini_app';

/**
 * The actor a mini-app request acts as: `SYSTEM_JOB`, exactly what the bot's turn acts as —
 * so it holds exactly `SYSTEM_JOB_PERMISSIONS` (`maintenance.run`) and nothing wider — with
 * the surface `MINI_APP`, so its audit rows, its surface-namespaced idempotency keys and the
 * rows it creates say where they came from. Never a customer-chosen id: the job id names
 * the session, which was minted from a verified launch.
 */
export function miniAppActor(jobId: string, correlationId: CorrelationId): ActorContext {
  return {
    type: 'SYSTEM_JOB',
    id: jobId,
    label: `job:${jobId}`,
    surface: 'MINI_APP',
    correlationId,
  };
}

/**
 * What one authenticated mini-app request runs as. Every field is derived from the session
 * row and the rows it names — none from the request.
 */
export interface MiniAppContext {
  readonly scope: TenantContext;
  readonly botInstanceId: BotInstanceId;
  readonly sessionId: string;
  readonly customer: CustomerRecord;
  readonly telegramUserId: string;
}

/** Where the customer is held, if anywhere: the bot's four gates, in the bot's order. */
export type MiniAppGateState =
  | { readonly kind: 'BLOCKED' }
  /** R10 D5 (a): the bot's `/start` question, unanswered. Answered in the chat only. */
  | { readonly kind: 'CAPTCHA' }
  | {
      readonly kind: 'CHANNELS';
      readonly channels: readonly TelegramChannel[];
    }
  | {
      readonly kind: 'TERMS';
      readonly terms: { readonly id: string; readonly title: string; readonly body: string };
    }
  | null;

export interface MiniAppSessionServiceDeps {
  readonly bots: {
    findById(id: BotInstanceId): Promise<BotInstance | null>;
    resolveToken(scope: ScopeContext, id: BotInstanceId): Promise<string>;
  };
  readonly tenants: { findById(id: TenantId): Promise<Tenant | null> };
  readonly features: {
    isEnabled(scope: TenantContext, key: typeof MINIAPP_FEATURE, tx?: unknown): Promise<boolean>;
  };
  readonly settings: { valueOf<T>(scope: TenantContext, key: string, tx?: unknown): Promise<T> };
  /** The ONE customer resolution the bot uses — never a second lookup that skips its rules. */
  readonly customers: {
    resolveFromUpdate(
      scope: TenantContext,
      actor: ActorContext,
      input: {
        readonly idempotencyKey: string;
        readonly telegramUserId: string;
        readonly from: unknown;
        readonly botInstanceId: BotInstanceId;
        readonly startPayload?: string | null;
      },
    ): Promise<{ readonly customer: CustomerRecord; readonly arrival: CustomerArrival }>;
  };
  /** The row a session names, re-read on every request so a block applies to the next one. */
  readonly customerRecords: {
    findById(scope: ScopeContext, id: UserId, tx?: unknown): Promise<CustomerRecord | null>;
  };
  readonly sessions: MiniAppSessionRepository;
  /** The bot's gates, through the same services the bot's router asks. */
  readonly membership?: {
    missingRequired(
      scope: TenantContext,
      input: {
        readonly botInstanceId: string;
        readonly telegramUserId: string;
        readonly fresh: boolean;
      },
    ): Promise<readonly TelegramChannel[]>;
  };
  /**
   * R10 D5 (a): the bot's `/start` captcha — whether it holds this customer now (a PENDING
   * row while `start_captcha` is on). Absent, nobody is held by it.
   */
  readonly captcha?: {
    holds(scope: TenantContext, customerId: string): Promise<boolean>;
  };
  readonly terms?: {
    requirement(
      scope: TenantContext,
      customerId: string,
    ): Promise<{ readonly id: string; readonly title: string; readonly body: string } | null>;
  };
  readonly telegramAdmins?: {
    resolve(
      scope: TenantContext,
      telegramUserId: string,
      correlationId: CorrelationId,
    ): Promise<unknown>;
  };
  readonly uow: UnitOfWork;
  readonly scopeActivity: ScopeActivityReader;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
  /** 32 random bytes as base64url; injected so a test can fix a token. */
  readonly secret?: () => string;
}

/** SHA-256 hex of a bearer secret: what is stored and compared. */
export function tokenHashOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/u;

/**
 * The mini app's sessions (Round 9, C5): a verified Telegram launch exchanged for ONE
 * short-lived bearer token bound to a tenant, a bot and a customer.
 *
 * Why a row and not a self-signed token: the replay rule needs memory. A launch is a bearer
 * credential for as long as its `auth_date` is fresh; a stateless token minted from it could
 * be minted again from a copy of it, every time. The unique `(tenant, bot, init_data_hash)`
 * index makes the launch single-use under any concurrency, and the row also makes a session
 * revocable and lets the token carry no claims a forger could edit (it is an id and a
 * random secret; the claims are the row). The cost is one primary-key read per request.
 */
export class MiniAppSessionService {
  constructor(private readonly deps: MiniAppSessionServiceDeps) {}

  /**
   * The bot a launch names, ACTIVE, under an ACTIVE tenant with the mini app switched on —
   * or `MINIAPP_UNAVAILABLE`, the same answer for an unknown id, a stopped bot, a stopped
   * tenant and a tenant with the flag off, so the route says nothing about which bots exist.
   */
  async liveBot(botInstanceId: string): Promise<{ bot: BotInstance; scope: TenantContext }> {
    const unavailable = () =>
      errors.notFound(MINIAPP_ERROR_CODES.MINIAPP_UNAVAILABLE, 'The mini app is not available.');
    const parsed = uuidV7Schema.safeParse(botInstanceId);
    if (!parsed.success) throw unavailable();
    const bot = await this.deps.bots.findById(parsed.data as unknown as BotInstanceId);
    if (bot === null || bot.status !== 'ACTIVE') throw unavailable();
    const tenant = await this.deps.tenants.findById(bot.tenantId);
    if (tenant === null || tenant.status !== 'ACTIVE') throw unavailable();
    const scope: TenantContext = { tenantId: bot.tenantId, botInstanceId: bot.id };
    if (!(await this.deps.features.isEnabled(scope, MINIAPP_FEATURE))) throw unavailable();
    return { bot, scope };
  }

  /**
   * One launch, one session.
   *
   * The token is verified against the token of the bot the URL names; a launch from another
   * bot fails the HMAC. The customer is resolved by `resolveFromUpdate`, the bot's own
   * resolution — created on first contact, `last_seen_at` refreshed, status never changed —
   * under a key derived from the launch's hash, so a retry of a mint that failed after the
   * customer committed replays it. No referral is attributed here: an attribution is made
   * only from a `/start ref-…` (standing rule), and a mini-app launch is not one.
   */
  async mint(
    botInstanceId: string,
    initData: string,
    correlationId: CorrelationId,
  ): Promise<{ readonly token: string; readonly expiresAt: Date; readonly sessionId: string }> {
    const { bot, scope } = await this.liveBot(botInstanceId);
    const token = await this.deps.bots.resolveToken(scope, bot.id);
    const now = this.deps.clock.now();
    const maxAgeSeconds = await this.deps.settings.valueOf<number>(
      scope,
      'miniapp.init_data_max_age_seconds',
    );
    const verdict = verifyInitData({ raw: initData, botToken: token, now, maxAgeSeconds });
    if (verdict.outcome === 'INVALID') {
      throw errors.unauthenticated(
        MINIAPP_ERROR_CODES.MINIAPP_INIT_DATA_INVALID,
        'The Telegram launch data could not be verified.',
      );
    }
    if (verdict.outcome === 'EXPIRED') {
      throw errors.unauthenticated(
        MINIAPP_ERROR_CODES.MINIAPP_INIT_DATA_EXPIRED,
        'The Telegram launch is too old. Open the mini app again.',
      );
    }

    const launchKey = `miniapp:${bot.id}:launch:${verdict.hash}`;
    const actor = miniAppActor(
      `miniapp-launch:${bot.id}:${verdict.hash.slice(0, 16)}`,
      correlationId,
    );
    const { customer } = await this.deps.customers.resolveFromUpdate(scope, actor, {
      idempotencyKey: launchKey,
      telegramUserId: String(verdict.user.id),
      from: verdict.from,
      botInstanceId: bot.id,
      startPayload: null,
    });

    const ttlMinutes = await this.deps.settings.valueOf<number>(
      scope,
      'miniapp.session_ttl_minutes',
    );
    const secret = this.deps.secret?.() ?? randomBytes(32).toString('base64url');
    const record: MiniAppSessionRecord = {
      id: this.deps.ids.uuid(),
      tenantId: bot.tenantId,
      botInstanceId: bot.id,
      customerId: customer.id,
      telegramUserId: String(verdict.user.id),
      initDataHash: verdict.hash,
      tokenHash: tokenHashOf(secret),
      authDate: verdict.authDate,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
    };
    const outcome = await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return 'STOPPED' as const;
      const inserted = await this.deps.sessions.insert(scope, record, tx);
      if (inserted === 'INSERTED') {
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'miniapp.session.mint',
            entityType: 'Customer',
            entityId: customer.id,
            before: null,
            after: {
              sessionId: record.id,
              botInstanceId: bot.id,
              expiresAt: record.expiresAt.toISOString(),
            },
            result: 'SUCCESS',
          },
          tx,
        );
      }
      return inserted;
    });
    if (outcome === 'STOPPED') {
      throw errors.notFound(
        MINIAPP_ERROR_CODES.MINIAPP_UNAVAILABLE,
        'The mini app is not available.',
      );
    }
    if (outcome === 'ALREADY_MINTED') {
      throw errors.unauthenticated(
        MINIAPP_ERROR_CODES.MINIAPP_INIT_DATA_REPLAYED,
        'This Telegram launch was already used. Open the mini app again.',
      );
    }
    return { token: `${record.id}.${secret}`, expiresAt: record.expiresAt, sessionId: record.id };
  }

  /**
   * A bearer token to the context it acts in, or `MINIAPP_SESSION_INVALID` — one answer for a
   * malformed token, an unknown one, a wrong secret, an expired session and a session whose
   * bot, tenant or flag has since stopped. Re-read every time: a stopped bot ends its
   * sessions on their next request, not when they lapse.
   */
  async authenticate(authorization: string | undefined): Promise<MiniAppContext> {
    const invalid = () =>
      errors.unauthenticated(MINIAPP_ERROR_CODES.MINIAPP_SESSION_INVALID, 'Sign in again.');
    if (authorization === undefined) throw invalid();
    const match = /^Bearer ([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/u.exec(authorization.trim());
    if (match === null) throw invalid();
    const [, id, secret] = match as unknown as [string, string, string];
    if (!uuidV7Schema.safeParse(id).success || !SECRET_SHAPE.test(secret)) throw invalid();
    const session = await this.deps.sessions.findById(id);
    if (session === null) throw invalid();
    const supplied = Buffer.from(tokenHashOf(secret), 'hex');
    const stored = Buffer.from(session.tokenHash, 'hex');
    if (stored.length !== supplied.length || !timingSafeEqual(supplied, stored)) throw invalid();
    if (this.deps.clock.now().getTime() >= session.expiresAt.getTime()) throw invalid();

    let live: { bot: BotInstance; scope: TenantContext };
    try {
      live = await this.liveBot(session.botInstanceId);
    } catch (error) {
      if (error instanceof NexaError) throw invalid();
      throw error;
    }
    if (live.bot.tenantId !== session.tenantId) throw invalid();
    const customer = await this.deps.customerRecords.findById(live.scope, session.customerId);
    if (customer === null) throw invalid();
    return {
      scope: live.scope,
      botInstanceId: live.bot.id,
      sessionId: session.id,
      customer,
      telegramUserId: session.telegramUserId,
    };
  }

  /**
   * The gate this customer is held at, asked exactly as the bot's router asks it: BLOCKED
   * first (the turn never reaches `act`), then the `/start` captcha (R10 D5), then the
   * REQUIRED channels (skipped for an operator's per-customer exemption), then the CURRENT
   * published terms. A bound administrator is never held by the last three, and the binding
   * is asked only when something would hold them. `fresh` re-asks Telegram, as «عضو شدم»
   * does. The captcha is never ANSWERED here: the mini app says so and links to the bot.
   */
  async gateFor(
    context: MiniAppContext,
    correlationId: CorrelationId,
    options: { readonly fresh: boolean } = { fresh: false },
  ): Promise<MiniAppGateState> {
    const { scope, customer } = context;
    if (customer.status === 'BLOCKED') return { kind: 'BLOCKED' };
    let admin: boolean | null = null;
    const isAdmin = async (): Promise<boolean> => {
      admin ??=
        (await this.deps.telegramAdmins?.resolve(scope, context.telegramUserId, correlationId)) !=
        null;
      return admin;
    };
    if (
      this.deps.captcha !== undefined &&
      (await this.deps.captcha.holds(scope, customer.id)) &&
      !(await isAdmin())
    ) {
      return { kind: 'CAPTCHA' };
    }
    if (this.deps.membership !== undefined && customer.channelMembershipExemptAt === null) {
      const missing = await this.deps.membership.missingRequired(scope, {
        botInstanceId: context.botInstanceId,
        telegramUserId: context.telegramUserId,
        fresh: options.fresh,
      });
      if (missing.length > 0 && !(await isAdmin())) return { kind: 'CHANNELS', channels: missing };
    }
    if (this.deps.terms !== undefined) {
      const required = await this.deps.terms.requirement(scope, customer.id);
      if (required !== null && !(await isAdmin())) {
        return {
          kind: 'TERMS',
          terms: { id: required.id, title: required.title, body: required.body },
        };
      }
    }
    return null;
  }

  /** `gateFor`, as the refusal every gated endpoint answers while the customer is held. */
  async assertUngated(context: MiniAppContext, correlationId: CorrelationId): Promise<void> {
    const gate = await this.gateFor(context, correlationId);
    if (gate !== null) {
      throw errors.permissionDenied(
        MINIAPP_ERROR_CODES.MINIAPP_GATE_REQUIRED,
        'A gate holds this customer; read /me.',
        { gate: gate.kind },
      );
    }
  }
}
