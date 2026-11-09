import type { ActorImpersonation, SystemContext, TenantContext } from '@nexa/contracts';
import type { SessionImpersonationMark } from '../../identity/application/ports.js';

/** What a spent token answers: whose it was, and the section session it ends with. */
export interface SpentEnterToken {
  readonly id: string;
  readonly installationTenantId: string;
  readonly ownerAdminId: string;
  readonly hostingSessionId: string;
}

/** Phase 6B «ورود به پنل» — the persistence the enter service needs (`DrizzleHostingEnterRepository`). */
export interface HostingEnterRepository {
  insertToken(
    installation: TenantContext,
    row: {
      readonly id: string;
      readonly hostedTenantId: string;
      readonly domain: string;
      readonly ownerAdminId: string;
      readonly hostingSessionId: string;
      readonly tokenHash: string;
      readonly createdAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<void>;
  /** The hosted tenant's ACTIVE HOST principal, read in its own scope. */
  hostOf(hosted: TenantContext, tx: unknown): Promise<string | null>;
  /** The hosted tenant's HOST principal, created on first use. Answers its id. */
  ensureHost(
    context: SystemContext,
    input: {
      readonly hostedTenantId: string;
      readonly id: string;
      readonly username: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<string>;
  /** Spends the token for exactly this audience; null when it is not good (one answer). */
  spend(
    context: SystemContext,
    input: {
      readonly tokenHash: string;
      readonly hostedTenantId: string;
      readonly domain: string;
      readonly adminSessionId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<SpentEnterToken | null>;
  ownerOf(
    mark: SessionImpersonationMark,
    now: Date,
    tx?: unknown,
  ): Promise<ActorImpersonation | null>;
  sectionFacts(
    mark: SessionImpersonationMark,
    now: Date,
    tx?: unknown,
  ): Promise<{
    readonly installationTenantId: string;
    readonly ownerAdminId: string;
    readonly ownerLabel: string;
    readonly expiresAt: Date;
  } | null>;
  /** Ends the hosted sessions entered from this owner's ended section sessions. */
  revokeEndedSections(
    context: SystemContext,
    input: {
      readonly installationTenantId: string;
      readonly ownerAdminId: string;
      readonly now: Date;
    },
    tx?: unknown,
  ): Promise<number>;
}
