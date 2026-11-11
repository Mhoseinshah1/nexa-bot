import {
  NexaError,
  RESELLER_PREFERENCE_DEFAULTS,
  RESELLER_WEB_ACTIVITY_ACTIONS,
  RESELLER_WEB_ACTIVITY_PAGE_SIZE,
  RESELLER_WEB_AUDIT_ACTIONS,
  RESELLER_WEB_ERROR_CODES as CODES,
  RESELLER_WEB_LINK_TTL_SECONDS,
  RESELLER_WEB_LINKS_PER_HOUR,
  RESELLER_WEB_PANEL_FEATURE,
  RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS,
  TOTP_ENROLMENT_TTL_SECONDS,
  TOTP_ISSUER,
  TOTP_PARAMETERS,
  errors,
  resellerPreferencesWriteSchema,
  resellerTotpCodeRequestSchema,
  resellerWebForceLogoutRequestSchema,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type FeatureFlagKey,
  type IdGenerator,
  type ResellerActivityResponse,
  type ResellerPreferences,
  type ResellerSessionsResponse,
  type ResellerTotpEnrolResponse,
  type ResellerWebPanelSummary,
  type ScopeContext,
  type SecretCipher,
  type SecretContext,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import { refuseImpersonatedSecretWrite } from '../../../platform/identity/application/impersonation.js';
import {
  generateTotpSecret,
  matchTotp,
  otpauthUri,
} from '../../../platform/identity/application/totp.js';
import type { CustomerRecord } from '../../customers/application/ports.js';
import type { CustomerNotifier } from '../../messaging/application/customer-notifier.js';
import type {
  ResellerService,
  ResellerStanding,
} from '../../resellers/application/reseller.service.js';
import {
  SESSION_TOUCH_INTERVAL_MS,
  generateAccessToken,
  hashLinkToken,
  hashResellerSessionToken,
  linkExpiry,
  loginUrl,
  sessionAbsoluteEnd,
  sessionLive,
} from '../domain/access-tokens.js';
import { deviceFingerprint, deviceLabelOf, networkOf } from '../domain/device.js';
import type { ResellerWebRepository, ResellerWebSessionRecord } from './ports.js';

/** What the bot's turn and the panel's requests act with: the bot's own `SYSTEM_JOB` key. */
export const RESELLER_WEB_PERMISSION = 'maintenance.run' as const;

export interface ResellerWebAccessDeps {
  readonly repository: ResellerWebRepository;
  readonly resellers: Pick<ResellerService, 'standing'>;
  readonly customers: {
    findById(scope: ScopeContext, id: UserId, tx?: unknown): Promise<CustomerRecord | null>;
  };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  readonly guard: Pick<PermissionGuard, 'check'>;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly scopeActivity: ScopeActivityReader;
  readonly notifier: Pick<CustomerNotifier, 'notifyThrough'>;
  readonly cipher: SecretCipher;
  readonly qr: { encode(text: string): Uint8Array } | null;
  readonly clock: Clock;
  readonly ids: Pick<IdGenerator, 'uuid'>;
  /**
   * The tenant's own web origin (`https://host`): the installation's admin origin, or a
   * hosted tenant's verified domain. Null while it has none, and then no link is issued.
   */
  readonly webOrigin: (scope: TenantContext) => Promise<string | null>;
}

/** Who one authenticated panel request is: every field from the session row and its reseller. */
export interface ResellerWebContext {
  readonly scope: TenantContext;
  readonly sessionId: string;
  readonly sessionCreatedAt: Date;
  readonly sessionExpiresAt: Date;
  readonly customer: CustomerRecord;
  readonly standing: ResellerStanding;
  readonly botInstanceId: BotInstanceId;
  readonly actor: ActorContext;
}

/** What the HTTP surface sets the cookie from. The token leaves the service exactly here. */
export interface OpenedResellerSession {
  readonly token: string;
  readonly state: 'ACTIVE' | 'SECOND_FACTOR_REQUIRED';
  readonly expiresAt: Date;
}

export type LinkIssueOutcome =
  | { readonly kind: 'ISSUED'; readonly url: string; readonly minutes: number }
  | { readonly kind: 'RATE_LIMITED' }
  | { readonly kind: 'UNAVAILABLE' };

export interface RequestFacts {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly correlationId: CorrelationId;
}

/**
 * The actor a reseller panel request acts as: `SYSTEM_JOB`, exactly what the bot's turn acts
 * as (`maintenance.run` and nothing wider), its job id naming the session — never anything the
 * request chose. Its surface is `WEB`; the audit rows it writes name the session in `actor_id`.
 */
export function resellerWebActor(
  sessionId: string,
  correlationId: CorrelationId,
  request: { readonly ip: string | null } = { ip: null },
): ActorContext {
  const id = `reseller-web:${sessionId}`;
  return {
    type: 'SYSTEM_JOB',
    id,
    label: `job:${id}`,
    surface: 'WEB',
    correlationId,
    ...(request.ip === null ? {} : { ip: request.ip }),
  };
}

function totpContext(tenantId: string, factorId: string): SecretContext {
  return { purpose: 'reseller_web.totp_secret', tenantId, entityId: factorId };
}

const sessionInvalid = (): NexaError =>
  errors.unauthenticated(CODES.SESSION_INVALID, 'This panel session is not valid.');
const unavailable = (): NexaError =>
  errors.notFound(CODES.UNAVAILABLE, 'The reseller panel is not available.');

/**
 * PR-4 §5.1 — the reseller panel's way in and its sessions.
 *
 * `issueLink` (the bot's «ورود به پنل وب»): a ten-minute, single-use link bound to the reseller's
 * customer, the tenant and the bot asked from; at most five an hour; only its hash is stored.
 * `exchange` spends it — ONE conditional UPDATE — and opens a session of the panel's own type,
 * ACTIVE, or waiting for the TOTP code when the reseller turned that on. `authenticate` runs on
 * EVERY request: the flag, the session's life (30 days idle, 90 absolute), the customer not
 * blocked and the reseller row still ACTIVE — a suspended reseller is an ordinary customer and
 * is refused at the next request. Nothing here moves money or prices anything.
 */
export class ResellerWebAccessService {
  constructor(private readonly deps: ResellerWebAccessDeps) {}

  async panelEnabled(scope: TenantContext): Promise<boolean> {
    return this.deps.features.isEnabled(scope, RESELLER_WEB_PANEL_FEATURE);
  }

  /** Whether the bot draws «ورود به پنل وب» for this customer: flag on and reseller ACTIVE. */
  async offered(scope: TenantContext, customerId: string): Promise<boolean> {
    if (!(await this.panelEnabled(scope))) return false;
    return (await this.deps.resellers.standing(scope, customerId, undefined)) !== null;
  }

  // --- The bot: issuing the link ------------------------------------------------------------

  async issueLink(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly customerId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<LinkIssueOutcome> {
    await this.deps.guard.check(scope, actor, RESELLER_WEB_PERMISSION);
    const tenantScope: TenantContext = { tenantId: scope.tenantId, botInstanceId: null };
    if (!(await this.panelEnabled(tenantScope))) return { kind: 'UNAVAILABLE' };
    const origin = await this.deps.webOrigin(tenantScope);
    if (origin === null) return { kind: 'UNAVAILABLE' };
    const token = generateAccessToken();
    const outcome = await this.deps.uow.run(tenantScope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(tenantScope, tx))) return 'UNAVAILABLE';
      if (!(await this.deps.repository.lockReseller(tenantScope, input.customerId, tx))) {
        return 'UNAVAILABLE';
      }
      const customer = await this.deps.customers.findById(
        tenantScope,
        input.customerId as UserId,
        tx,
      );
      if (customer === null || customer.status === 'BLOCKED') return 'UNAVAILABLE';
      if ((await this.deps.resellers.standing(tenantScope, input.customerId, tx)) === null) {
        return 'UNAVAILABLE';
      }
      const now = this.deps.clock.now();
      const since = new Date(now.getTime() - 3600 * 1000);
      const recent = await this.deps.repository.countLinksSince(
        tenantScope,
        input.customerId,
        since,
        tx,
      );
      if (recent >= RESELLER_WEB_LINKS_PER_HOUR) return 'RATE_LIMITED';
      const id = this.deps.ids.uuid();
      const expiresAt = linkExpiry(now);
      await this.deps.repository.insertLink(
        tenantScope,
        {
          id,
          customerId: input.customerId,
          botInstanceId: input.botInstanceId,
          tokenHash: hashLinkToken(token),
          createdAt: now,
          expiresAt,
        },
        tx,
      );
      await this.deps.audit.record(
        tenantScope,
        actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.LINK_ISSUED,
          entityType: 'Customer',
          entityId: input.customerId,
          before: null,
          // The link's id and lifetime — never the token, never its hash.
          after: {
            linkId: id,
            botInstanceId: input.botInstanceId,
            expiresAt: expiresAt.toISOString(),
          },
          result: 'SUCCESS',
        },
        tx,
      );
      return 'ISSUED';
    });
    if (outcome !== 'ISSUED') return { kind: outcome };
    return {
      kind: 'ISSUED',
      url: loginUrl(origin, token),
      minutes: Math.round(RESELLER_WEB_LINK_TTL_SECONDS / 60),
    };
  }

  // --- The panel: the link exchange and the code step ---------------------------------------

  /**
   * The `/r/login` page posts the token from its fragment. `tenant` is the tenant the request's
   * Host resolves to — never the body — so a link carried to another tenant's domain finds no
   * row under that tenant's row-level security and is invalid there.
   */
  async exchange(
    tenant: TenantContext,
    request: RequestFacts,
    token: string,
  ): Promise<OpenedResellerSession> {
    if (!(await this.panelEnabled(tenant))) throw unavailable();
    const tokenHash = hashLinkToken(token);
    const sessionToken = generateAccessToken();
    const sessionId = this.deps.ids.uuid();
    const label = deviceLabelOf(request.userAgent);
    const network = networkOf(request.ip);
    const actor = resellerWebActor(sessionId, request.correlationId, request);
    let refusedFor: string | null = null;
    try {
      const opened = await this.deps.uow.run(tenant, async (tx) => {
        const now = this.deps.clock.now();
        const link = await this.deps.repository.lockLinkByHash(tenant, tokenHash, tx);
        if (link === null) {
          throw errors.unauthenticated(CODES.LINK_INVALID, 'This sign-in link is not valid.');
        }
        if (link.usedAt !== null) {
          throw errors.unauthenticated(CODES.LINK_USED, 'This sign-in link was already opened.');
        }
        if (now.getTime() >= link.expiresAt.getTime()) {
          throw errors.unauthenticated(CODES.LINK_EXPIRED, 'This sign-in link has expired.');
        }
        refusedFor = link.customerId;
        if (!(await this.deps.scopeActivity.scopeIsActive(tenant, tx))) {
          throw errors.unauthenticated(CODES.LINK_INVALID, 'This sign-in link is not valid.');
        }
        const customer = await this.deps.customers.findById(tenant, link.customerId as UserId, tx);
        const standing = await this.deps.resellers.standing(tenant, link.customerId, tx);
        if (customer === null || customer.status === 'BLOCKED' || standing === null) {
          throw errors.unauthenticated(CODES.LINK_INVALID, 'This sign-in link is not valid.');
        }
        // Spent FIRST of the writes; everything below shares the transaction.
        if (!(await this.deps.repository.spendLink(tenant, { id: link.id, sessionId, now }, tx))) {
          throw errors.unauthenticated(CODES.LINK_USED, 'This sign-in link was already opened.');
        }
        const factor = await this.deps.repository.findFactor(tenant, link.customerId, tx);
        const state = factor?.state === 'ACTIVE' ? 'PENDING_SECOND_FACTOR' : 'ACTIVE';
        const absoluteExpiresAt = sessionAbsoluteEnd(now, state);
        const fingerprint = deviceFingerprint(label, network);
        await this.deps.repository.insertSession(
          tenant,
          {
            id: sessionId,
            customerId: link.customerId,
            botInstanceId: link.botInstanceId,
            tokenHash: hashResellerSessionToken(sessionToken),
            state,
            now,
            absoluteExpiresAt,
            deviceFingerprint: fingerprint,
            deviceLabel: label,
            network,
          },
          tx,
        );
        if (state === 'ACTIVE') {
          await this.signedIn(tenant, actor, {
            sessionId,
            customerId: link.customerId,
            botInstanceId: link.botInstanceId as BotInstanceId,
            fingerprint,
            now,
            secondFactor: false,
            tx,
          });
        }
        return {
          state: state === 'ACTIVE' ? ('ACTIVE' as const) : ('SECOND_FACTOR_REQUIRED' as const),
          expiresAt: absoluteExpiresAt,
        };
      });
      return { token: sessionToken, ...opened };
    } catch (error) {
      if (refusedFor !== null && error instanceof NexaError) {
        // The refusal is the reseller's own record («کارهای اخیر روی حساب»), in its own commit.
        await this.deps.audit.record(tenant, actor, {
          action: RESELLER_WEB_AUDIT_ACTIONS.LOGIN_REFUSED,
          entityType: 'Customer',
          entityId: refusedFor,
          before: null,
          after: { code: error.code, device: label },
          result: 'DENIED',
        });
      }
      throw error;
    }
  }

  /** The TOTP step after the link, when the reseller turned it on. */
  async secondFactor(
    tenant: TenantContext,
    request: RequestFacts,
    sessionToken: string | null,
    input: unknown,
  ): Promise<{ readonly expiresAt: Date }> {
    if (!(await this.panelEnabled(tenant))) throw unavailable();
    if (sessionToken === null) throw sessionInvalid();
    const parsed = resellerTotpCodeRequestSchema.safeParse(input);
    const session = await this.deps.repository.findSessionByHash(
      tenant,
      hashResellerSessionToken(sessionToken),
    );
    const now = this.deps.clock.now();
    if (session === null || !sessionLive(session, now, 'PENDING_SECOND_FACTOR')) {
      throw sessionInvalid();
    }
    const actor = resellerWebActor(session.id, request.correlationId, request);
    /*
     * The attempt bound is decided UNDER the session row's lock, in the same transaction that
     * judges the code: a wrong code is counted (and the session ended at the bound) before the
     * transaction commits, so parallel wrong codes serialise on the row and never exceed it.
     */
    const outcome = await this.deps.uow.run(tenant, async (tx) => {
      const at = this.deps.clock.now();
      const locked = await this.deps.repository.lockSession(tenant, session.id, tx);
      if (locked === null || !sessionLive(locked, at, 'PENDING_SECOND_FACTOR')) {
        return { kind: 'GONE' as const };
      }
      if (locked.secondFactorAttempts >= RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS) {
        await this.endAtBound(tenant, locked, at, tx);
        return { kind: 'GONE' as const };
      }
      const factor = await this.deps.repository.lockFactor(tenant, locked.customerId, tx);
      if (factor === null || factor.state !== 'ACTIVE') return { kind: 'GONE' as const };
      const step = parsed.success
        ? matchTotp(
            this.deps.cipher.decrypt(
              { ciphertext: factor.ciphertext, keyId: factor.keyId },
              totpContext(tenant.tenantId, factor.id),
            ),
            parsed.data.code,
            at,
            factor.lastUsedStep,
          )
        : null;
      if (
        step === null ||
        !(await this.deps.repository.consumeStep(tenant, { id: factor.id, step }, tx))
      ) {
        const attempts = await this.wrongAttempt(tenant, locked, at, tx);
        return { kind: 'WRONG' as const, attempts };
      }
      const absoluteExpiresAt = sessionAbsoluteEnd(at, 'ACTIVE');
      if (
        !(await this.deps.repository.activateSession(
          tenant,
          { id: locked.id, now: at, absoluteExpiresAt },
          tx,
        ))
      ) {
        return { kind: 'GONE' as const };
      }
      await this.signedIn(tenant, actor, {
        sessionId: locked.id,
        customerId: locked.customerId,
        botInstanceId: locked.botInstanceId as BotInstanceId,
        fingerprint: locked.deviceFingerprint,
        now: at,
        secondFactor: true,
        tx,
      });
      return { kind: 'ACTIVE' as const, expiresAt: absoluteExpiresAt };
    });
    if (outcome.kind === 'GONE') throw sessionInvalid();
    if (outcome.kind === 'WRONG') {
      await this.deps.audit.record(tenant, actor, {
        action: RESELLER_WEB_AUDIT_ACTIONS.SECOND_FACTOR,
        entityType: 'Customer',
        entityId: session.customerId,
        before: null,
        after: { attempts: outcome.attempts },
        result: 'DENIED',
      });
      throw errors.unauthenticated(CODES.SECOND_FACTOR_INVALID, 'The code is not valid.');
    }
    return { expiresAt: outcome.expiresAt };
  }

  /**
   * One wrong code on a LOCKED session row, inside the caller's transaction: counted, and the
   * session ended when the count reaches the bound. Answers the new count.
   */
  private async wrongAttempt(
    tenant: TenantContext,
    locked: ResellerWebSessionRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const attempts = await this.deps.repository.countSecondFactorAttempt(tenant, locked.id, tx);
    if (attempts >= RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS) {
      await this.endAtBound(tenant, locked, now, tx);
    }
    return attempts;
  }

  private async endAtBound(
    tenant: TenantContext,
    locked: ResellerWebSessionRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.repository.endSession(
      tenant,
      { id: locked.id, customerId: locked.customerId, reason: 'SECOND_FACTOR_FAILED', now },
      tx,
    );
  }

  /** A session became ACTIVE: the device is recorded, a new one announced, the login audited. */
  private async signedIn(
    tenant: TenantContext,
    actor: ActorContext,
    input: {
      readonly sessionId: string;
      readonly customerId: string;
      readonly botInstanceId: BotInstanceId;
      readonly fingerprint: string;
      readonly now: Date;
      readonly secondFactor: boolean;
      readonly tx: TransactionScope;
    },
  ): Promise<void> {
    const fresh = await this.deps.repository.recordDevice(
      tenant,
      { customerId: input.customerId, fingerprint: input.fingerprint, now: input.now },
      input.tx,
    );
    const preferences = await this.preferencesIn(tenant, input.customerId, input.tx);
    let alerted = false;
    if (fresh && preferences.newDeviceAlert) {
      // The notification lane, in this transaction: a fact about the session, never a string.
      alerted = await this.deps.notifier.notifyThrough(
        tenant,
        input.customerId as UserId,
        input.botInstanceId,
        'RESELLER_WEB_NEW_DEVICE',
        input.sessionId,
        input.now,
        input.tx,
      );
    }
    await this.deps.audit.record(
      tenant,
      actor,
      {
        action: RESELLER_WEB_AUDIT_ACTIONS.LOGIN,
        entityType: 'Customer',
        entityId: input.customerId,
        before: null,
        after: {
          sessionId: input.sessionId,
          newDevice: fresh,
          alerted,
          secondFactor: input.secondFactor,
        },
        result: 'SUCCESS',
      },
      input.tx,
    );
  }

  // --- Every request ------------------------------------------------------------------------

  /**
   * The one door every panel route passes. Order: the flag (off = the route does not exist),
   * the cookie, the session's life, the customer, the reseller row ACTIVE — each re-read now,
   * so a suspension, a block, a revoke or the flag applies to the very next request.
   */
  async authenticate(
    tenant: TenantContext,
    request: RequestFacts,
    sessionToken: string | null,
  ): Promise<ResellerWebContext> {
    if (!(await this.panelEnabled(tenant))) throw unavailable();
    if (sessionToken === null) throw sessionInvalid();
    const session = await this.deps.repository.findSessionByHash(
      tenant,
      hashResellerSessionToken(sessionToken),
    );
    const now = this.deps.clock.now();
    if (session === null) throw sessionInvalid();
    if (!sessionLive(session, now, 'ACTIVE')) {
      if (sessionLive(session, now, 'PENDING_SECOND_FACTOR')) {
        throw errors.unauthenticated(CODES.SECOND_FACTOR_REQUIRED, 'The sign-in code is owed.');
      }
      throw sessionInvalid();
    }
    const customer = await this.deps.customers.findById(tenant, session.customerId as UserId);
    if (customer === null || customer.status === 'BLOCKED') throw sessionInvalid();
    const standing = await this.deps.resellers.standing(tenant, session.customerId, undefined);
    if (standing === null) throw sessionInvalid();
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS) {
      await this.deps.repository.touchSession(tenant, session.id, now);
    }
    const botInstanceId = session.botInstanceId as BotInstanceId;
    return {
      scope: { tenantId: tenant.tenantId, botInstanceId },
      sessionId: session.id,
      sessionCreatedAt: session.createdAt,
      sessionExpiresAt: session.absoluteExpiresAt,
      customer,
      standing,
      botInstanceId,
      actor: resellerWebActor(session.id, request.correlationId, request),
    };
  }

  // --- Sessions -----------------------------------------------------------------------------

  async logout(context: ResellerWebContext): Promise<void> {
    await this.endOne(context, context.sessionId, 'LOGOUT', RESELLER_WEB_AUDIT_ACTIONS.LOGOUT);
  }

  async sessions(context: ResellerWebContext): Promise<ResellerSessionsResponse> {
    const now = this.deps.clock.now();
    const rows = await this.deps.repository.openSessionsOf(
      this.tenantOf(context),
      context.customer.id,
    );
    return {
      items: rows
        .filter((row) => sessionLive(row, now, 'ACTIVE'))
        .map((row) => ({
          id: row.id,
          current: row.id === context.sessionId,
          device: row.deviceLabel,
          network: row.network,
          createdAt: row.createdAt.toISOString(),
          lastSeenAt: row.lastSeenAt.toISOString(),
        })),
    };
  }

  /** One session of the reseller's own; another reseller's id is "not found". */
  async revoke(context: ResellerWebContext, sessionId: string): Promise<void> {
    await this.endOne(context, sessionId, 'REVOKED', RESELLER_WEB_AUDIT_ACTIONS.SESSION_REVOKED);
  }

  /** «خروج از همهٔ دستگاه‌ها»: every session of the reseller, this one included. */
  async revokeAll(context: ResellerWebContext): Promise<number> {
    const tenant = this.tenantOf(context);
    return this.deps.uow.run(tenant, async (tx) => {
      const ended = await this.deps.repository.endSessionsOf(
        tenant,
        {
          customerId: context.customer.id,
          reason: 'REVOKED_ALL',
          now: this.deps.clock.now(),
          keep: null,
        },
        tx,
      );
      await this.deps.audit.record(
        tenant,
        context.actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.SESSIONS_REVOKED_ALL,
          entityType: 'Customer',
          entityId: context.customer.id,
          before: null,
          after: { ended },
          result: 'SUCCESS',
        },
        tx,
      );
      return ended;
    });
  }

  private async endOne(
    context: ResellerWebContext,
    sessionId: string,
    reason: 'LOGOUT' | 'REVOKED',
    action: string,
  ): Promise<void> {
    const tenant = this.tenantOf(context);
    const ended = await this.deps.uow.run(tenant, async (tx) => {
      const done = await this.deps.repository.endSession(
        tenant,
        { id: sessionId, customerId: context.customer.id, reason, now: this.deps.clock.now() },
        tx,
      );
      if (!done) return false;
      await this.deps.audit.record(
        tenant,
        context.actor,
        {
          action,
          entityType: 'Customer',
          entityId: context.customer.id,
          before: null,
          after: { sessionId },
          result: 'SUCCESS',
        },
        tx,
      );
      return true;
    });
    if (!ended) throw errors.notFound(CODES.NOT_FOUND, 'Not found.');
  }

  // --- «کارهای اخیر روی حساب» --------------------------------------------------------------

  async activity(
    context: ResellerWebContext,
    cursor: string | null,
  ): Promise<ResellerActivityResponse> {
    const before = cursor === null ? null : decodeCursor(cursor);
    const rows = await this.deps.repository.activityPage(this.tenantOf(context), {
      customerId: context.customer.id,
      actions: RESELLER_WEB_ACTIVITY_ACTIONS,
      before,
      limit: RESELLER_WEB_ACTIVITY_PAGE_SIZE + 1,
    });
    const page = rows.slice(0, RESELLER_WEB_ACTIVITY_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        result: row.result,
        at: row.occurredAt.toISOString(),
      })),
      nextCursor:
        rows.length > RESELLER_WEB_ACTIVITY_PAGE_SIZE && last !== undefined
          ? Buffer.from(`${last.occurredAt.toISOString()}|${last.id}`, 'utf8').toString('base64url')
          : null,
    };
  }

  // --- Two-step sign-in ---------------------------------------------------------------------

  /**
   * Starts (or restarts) an enrolment. There is no password to ask for, so the stand-in is a
   * FRESH sign-in: only a session opened from a one-time link within the enrolment window may
   * enrol or turn the factor off — a session stolen later cannot lock its owner out.
   */
  async enrolTotp(context: ResellerWebContext): Promise<ResellerTotpEnrolResponse> {
    const actor = context.actor;
    refuseImpersonatedSecretWrite(actor, 'reseller_web.totp_secret');
    this.requireFreshSignIn(context);
    const tenant = this.tenantOf(context);
    const secret = generateTotpSecret();
    const factorId = this.deps.ids.uuid();
    const expiresAt = await this.deps.uow.run(tenant, async (tx) => {
      const now = this.deps.clock.now();
      const existing = await this.deps.repository.lockFactor(tenant, context.customer.id, tx);
      if (existing?.state === 'ACTIVE') {
        throw errors.conflict(CODES.SECOND_FACTOR_STATE, 'Two-step sign-in is already on.');
      }
      const sealed = this.deps.cipher.encrypt(secret, totpContext(tenant.tenantId, factorId));
      await this.deps.repository.replacePendingFactor(
        tenant,
        {
          id: factorId,
          customerId: context.customer.id,
          ciphertext: sealed.ciphertext,
          keyId: sealed.keyId,
          now,
        },
        tx,
      );
      const ends = new Date(now.getTime() + TOTP_ENROLMENT_TTL_SECONDS * 1000);
      await this.deps.audit.record(
        tenant,
        context.actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.TOTP_ENROL,
          entityType: 'Customer',
          entityId: context.customer.id,
          before: existing === null ? null : { state: existing.state },
          after: { state: 'PENDING', expiresAt: ends.toISOString() },
          result: 'SUCCESS',
        },
        tx,
      );
      return ends;
    });
    const account = context.customer.username ?? context.customer.telegramUserId;
    const uri = otpauthUri({ issuer: TOTP_ISSUER, account, secret });
    return {
      secret,
      otpauthUri: uri,
      qrPngDataUrl: this.qrDataUrl(uri),
      expiresAt: expiresAt.toISOString(),
      parameters: {
        algorithm: TOTP_PARAMETERS.algorithm,
        digits: TOTP_PARAMETERS.digits,
        periodSeconds: TOTP_PARAMETERS.periodSeconds,
      },
    };
  }

  /**
   * Turns a pending enrolment on with a code; every OTHER session of the reseller ends.
   *
   * The pending factor's row is locked, its attempt count read and incremented in THAT
   * transaction: past `RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS` wrong codes the pending factor is
   * deleted (enrolment starts again), so parallel guesses never exceed the bound. The pending
   * factor itself is the freshness: it was enrolled from a fresh sign-in, within its window.
   */
  async activateTotp(context: ResellerWebContext, input: unknown): Promise<{ ended: number }> {
    const tenant = this.tenantOf(context);
    const command = this.parseCode(input);
    const outcome = await this.deps.uow.run(tenant, async (tx) => {
      const now = this.deps.clock.now();
      const factor = await this.deps.repository.lockFactor(tenant, context.customer.id, tx);
      if (
        factor === null ||
        factor.state !== 'PENDING' ||
        now.getTime() >= factor.createdAt.getTime() + TOTP_ENROLMENT_TTL_SECONDS * 1000
      ) {
        return { kind: 'NOT_PENDING' as const };
      }
      if (factor.activationAttempts >= RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS) {
        await this.deps.repository.deleteFactor(tenant, context.customer.id, tx);
        return { kind: 'NOT_PENDING' as const };
      }
      const secret = this.deps.cipher.decrypt(
        { ciphertext: factor.ciphertext, keyId: factor.keyId },
        totpContext(tenant.tenantId, factor.id),
      );
      const step = command === null ? null : matchTotp(secret, command.code, now, null);
      if (step === null) {
        const attempts = await this.deps.repository.countActivationAttempt(
          tenant,
          context.customer.id,
          tx,
        );
        if (
          (attempts ?? RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS) >=
          RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS
        ) {
          await this.deps.repository.deleteFactor(tenant, context.customer.id, tx);
        }
        return { kind: 'WRONG' as const };
      }
      if (!(await this.deps.repository.activateFactor(tenant, { id: factor.id, step, now }, tx))) {
        return { kind: 'NOT_PENDING' as const };
      }
      const ended = await this.deps.repository.endSessionsOf(
        tenant,
        {
          customerId: context.customer.id,
          reason: 'SECOND_FACTOR_ENABLED',
          now,
          keep: context.sessionId,
        },
        tx,
      );
      await this.deps.audit.record(
        tenant,
        context.actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.TOTP_ENABLE,
          entityType: 'Customer',
          entityId: context.customer.id,
          before: { state: 'PENDING' },
          after: { state: 'ACTIVE', endedSessions: ended },
          result: 'SUCCESS',
        },
        tx,
      );
      return { kind: 'DONE' as const, ended };
    });
    if (outcome.kind === 'NOT_PENDING') {
      throw errors.conflict(CODES.SECOND_FACTOR_STATE, 'No enrolment is waiting.');
    }
    if (outcome.kind === 'WRONG') {
      throw errors.unauthenticated(CODES.SECOND_FACTOR_INVALID, 'The code is not valid.');
    }
    return { ended: outcome.ended };
  }

  /**
   * Turns the factor off: a fresh sign-in AND a current code — under the replay rule (the step
   * is consumed before the factor goes, so a code already used cannot be used again) and the
   * same per-session attempt bound as the code step, decided under this session's row lock: at
   * the bound the session ends and the reseller must sign in again from a fresh link.
   */
  async disableTotp(context: ResellerWebContext, input: unknown): Promise<void> {
    this.requireFreshSignIn(context);
    const tenant = this.tenantOf(context);
    const command = this.parseCode(input);
    const outcome = await this.deps.uow.run(tenant, async (tx) => {
      const now = this.deps.clock.now();
      const locked = await this.deps.repository.lockSession(tenant, context.sessionId, tx);
      if (locked === null || !sessionLive(locked, now, 'ACTIVE')) return 'GONE' as const;
      if (locked.secondFactorAttempts >= RESELLER_WEB_SECOND_FACTOR_MAX_ATTEMPTS) {
        await this.endAtBound(tenant, locked, now, tx);
        return 'GONE' as const;
      }
      const factor = await this.deps.repository.lockFactor(tenant, context.customer.id, tx);
      if (factor === null || factor.state !== 'ACTIVE') return 'NOT_ACTIVE' as const;
      const secret = this.deps.cipher.decrypt(
        { ciphertext: factor.ciphertext, keyId: factor.keyId },
        totpContext(tenant.tenantId, factor.id),
      );
      const step =
        command === null ? null : matchTotp(secret, command.code, now, factor.lastUsedStep);
      if (
        step === null ||
        !(await this.deps.repository.consumeStep(tenant, { id: factor.id, step }, tx))
      ) {
        await this.wrongAttempt(tenant, locked, now, tx);
        return 'WRONG' as const;
      }
      await this.deps.repository.deleteFactor(tenant, context.customer.id, tx);
      await this.deps.audit.record(
        tenant,
        context.actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.TOTP_DISABLE,
          entityType: 'Customer',
          entityId: context.customer.id,
          before: { state: 'ACTIVE' },
          after: null,
          result: 'SUCCESS',
        },
        tx,
      );
      return 'DONE' as const;
    });
    if (outcome === 'GONE') throw sessionInvalid();
    if (outcome === 'NOT_ACTIVE') {
      throw errors.conflict(CODES.SECOND_FACTOR_STATE, 'Two-step sign-in is not on.');
    }
    if (outcome === 'WRONG') {
      throw errors.unauthenticated(CODES.SECOND_FACTOR_INVALID, 'The code is not valid.');
    }
  }

  async secondFactorOn(context: ResellerWebContext): Promise<boolean> {
    const factor = await this.deps.repository.findFactor(
      this.tenantOf(context),
      context.customer.id,
    );
    return factor?.state === 'ACTIVE';
  }

  // --- Preferences --------------------------------------------------------------------------

  async preferences(context: ResellerWebContext): Promise<ResellerPreferences> {
    return this.preferencesIn(this.tenantOf(context), context.customer.id);
  }

  /**
   * The reseller's switches, read by their lanes. `scope` is the tenant's; a customer with no
   * row has every default. Exported for the lanes that consume them.
   */
  async preferencesIn(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerPreferences> {
    return (
      (await this.deps.repository.findPreferences(
        { tenantId: scope.tenantId, botInstanceId: null },
        customerId,
        tx,
      )) ?? RESELLER_PREFERENCE_DEFAULTS
    );
  }

  async setPreferences(context: ResellerWebContext, input: unknown): Promise<ResellerPreferences> {
    const parsed = resellerPreferencesWriteSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw errors.validation(CODES.REQUEST_INVALID, 'The request is invalid.');
    }
    const tenant = this.tenantOf(context);
    return this.deps.uow.run(tenant, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(tenant, tx))) throw sessionInvalid();
      const before = await this.preferencesIn(tenant, context.customer.id, tx);
      const next = { ...before, ...stripUndefined(parsed.data) } as ResellerPreferences;
      await this.deps.repository.upsertPreferences(
        tenant,
        { customerId: context.customer.id, value: next, now: this.deps.clock.now() },
        tx,
      );
      await this.deps.audit.record(
        tenant,
        context.actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.PREFERENCES,
          entityType: 'Customer',
          entityId: context.customer.id,
          before,
          after: next,
          result: 'SUCCESS',
        },
        tx,
      );
      return next;
    });
  }

  // --- The Web Admin's reseller drawer --------------------------------------------------------

  /** «پنل وب: آخرین ورود …» — `resellers.view`. */
  async adminSummary(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
  ): Promise<ResellerWebPanelSummary> {
    await this.deps.guard.check(scope, actor, 'resellers.view');
    const tenant: TenantContext = { tenantId: scope.tenantId, botInstanceId: null };
    const now = this.deps.clock.now();
    const open = await this.deps.repository.openSessionsOf(tenant, customerId);
    const factor = await this.deps.repository.findFactor(tenant, customerId);
    const lastLoginAt = await this.deps.repository.lastLoginAt(tenant, customerId);
    return {
      lastLoginAt: lastLoginAt === null ? null : lastLoginAt.toISOString(),
      activeSessions: open.filter((row) => sessionLive(row, now, 'ACTIVE')).length,
      secondFactor: factor?.state === 'ACTIVE',
    };
  }

  /** «خروج اجباری از همهٔ دستگاه‌ها» — `resellers.edit`, a reason, audited. */
  async adminForceLogout(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: unknown,
  ): Promise<{ ended: number }> {
    await this.deps.guard.check(scope, actor, 'resellers.edit');
    const command = resellerWebForceLogoutRequestSchema.parse(input);
    const tenant: TenantContext = { tenantId: scope.tenantId, botInstanceId: null };
    return this.deps.uow.run(tenant, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(tenant, tx))) {
        throw errors.conflict(CODES.UNAVAILABLE, 'This tenant has stopped accepting work.');
      }
      if (!(await this.deps.repository.lockReseller(tenant, customerId, tx))) {
        throw errors.notFound(CODES.NOT_FOUND, 'No such reseller.');
      }
      const ended = await this.deps.repository.endSessionsOf(
        tenant,
        { customerId, reason: 'ADMIN_FORCE_LOGOUT', now: this.deps.clock.now(), keep: null },
        tx,
      );
      await this.deps.audit.record(
        tenant,
        actor,
        {
          action: RESELLER_WEB_AUDIT_ACTIONS.FORCE_LOGOUT,
          entityType: 'Customer',
          entityId: customerId,
          before: null,
          after: { ended, reason: command.reason },
          result: 'SUCCESS',
        },
        tx,
      );
      return { ended };
    });
  }

  // --- helpers ------------------------------------------------------------------------------

  private tenantOf(context: ResellerWebContext): TenantContext {
    return { tenantId: context.scope.tenantId, botInstanceId: null };
  }

  private requireFreshSignIn(context: ResellerWebContext): void {
    const age = this.deps.clock.now().getTime() - context.sessionCreatedAt.getTime();
    if (age > TOTP_ENROLMENT_TTL_SECONDS * 1000) {
      throw errors.conflict(
        CODES.SECOND_FACTOR_STATE,
        'Sign in again from a fresh link to change two-step sign-in.',
        { reason: 'FRESH_SIGN_IN_REQUIRED' },
      );
    }
  }

  /** A code that is not six digits is a wrong code: counted like one, never a free try. */
  private parseCode(input: unknown): { readonly code: string } | null {
    const parsed = resellerTotpCodeRequestSchema.safeParse(input ?? {});
    return parsed.success ? parsed.data : null;
  }

  private qrDataUrl(uri: string): string | null {
    if (this.deps.qr === null) return null;
    try {
      return `data:image/png;base64,${Buffer.from(this.deps.qr.encode(uri)).toString('base64')}`;
    } catch (error) {
      if (error instanceof NexaError) return null;
      throw error;
    }
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

function decodeCursor(cursor: string): { readonly at: Date; readonly id: string } | null {
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const when = new Date(at ?? '');
    if (Number.isNaN(when.getTime()) || id === undefined || !/^[0-9a-f-]{36}$/u.test(id)) {
      return null;
    }
    return { at: when, id };
  } catch {
    return null;
  }
}

/** For tests and the surface: what an ended session looks like to `sessionLive`. */
export type { ResellerWebSessionRecord };
