import { z } from 'zod';
import { adminDisplayNameSchema, adminPasswordSchema, adminUsernameSchema } from './identity.js';
import { hostingProofSchema } from './hosting.js';

/**
 * Phase 6A PR-4 (D2) — the activation of a hosted bot.
 *
 * The installation owner creates a hosted bot (`hosting.ts`), then, in the creator panel and
 * on the hosted owner's behalf, enters the bot token and the domain the hosted owner pointed
 * at this server. Nexa then walks five steps, each one re-runnable and idempotent, each with
 * a Persian status and a Persian error:
 *
 *   TOKEN    the token answers Telegram's `getMe`, is not another bot instance's, and is stored
 *            encrypted on the hosted tenant's bot instance;
 *   DOMAIN   the domain's CNAME (or A/AAAA) resolves to this server;
 *   SSL      an HTTPS probe of the domain succeeds with a valid certificate (the edge issues it
 *            on demand, asking `HOSTED_DOMAIN_CHECK_PATH` first);
 *   WEBHOOK  Telegram's webhook is registered on the domain with the bot's own secret;
 *   LINK     a ONE-TIME activation link (24 hours, single use, stored only as a hash) the
 *            hosted owner opens to choose their Web Admin username and password.
 */

export const HOSTED_ACTIVATION_STEPS = ['TOKEN', 'DOMAIN', 'SSL', 'WEBHOOK', 'LINK'] as const;
export type HostedActivationStep = (typeof HOSTED_ACTIVATION_STEPS)[number];

/** The steps the owner can re-run with no input (the link is made with a fresh code instead). */
export const HOSTED_ACTIVATION_RUNNABLE_STEPS = ['token', 'domain', 'ssl', 'webhook'] as const;
export type HostedActivationRunnableStep = (typeof HOSTED_ACTIVATION_RUNNABLE_STEPS)[number];

export const HOSTED_ACTIVATION_STEP_STATES = ['PENDING', 'DONE', 'FAILED'] as const;
export type HostedActivationStepState = (typeof HOSTED_ACTIVATION_STEP_STATES)[number];

/** How long an activation link lives. */
export const HOSTED_ACTIVATION_LINK_TTL_SECONDS = 24 * 60 * 60;

export const HOSTED_ACTIVATION_LINK_STATES = ['ACTIVE', 'USED', 'EXPIRED'] as const;
export type HostedActivationLinkState = (typeof HOSTED_ACTIVATION_LINK_STATES)[number];

export const HOSTING_ACTIVATION_ERROR_CODES = {
  /** Nothing configured yet, or this server's DNS target is not configured. */
  NOT_CONFIGURED: 'hosting.activation_not_configured',
  /** The hosted bot is not ACTIVE: nothing is set up for a stopped or deleted one. */
  BOT_NOT_ACTIVE: 'hosting.activation_bot_not_active',
  /** An earlier step is not done yet. */
  STEP_BLOCKED: 'hosting.activation_step_blocked',
  TOKEN_MALFORMED: 'hosting.activation_token_malformed',
  /** Telegram answered, and its answer was no. */
  TOKEN_REJECTED: 'hosting.activation_token_rejected',
  /** Telegram could not be asked; try again. */
  TOKEN_UNREACHABLE: 'hosting.activation_token_unreachable',
  /** The token belongs to a bot another bot instance on this server already uses. */
  TOKEN_IN_USE: 'hosting.activation_token_in_use',
  /** The token is a DIFFERENT bot than the one this hosted bot is already bound to. */
  TOKEN_OTHER_BOT: 'hosting.activation_token_other_bot',
  /** Same Telegram bot, but not the token already stored: replacing a stored token is not done here. */
  TOKEN_DIFFERS: 'hosting.activation_token_differs',
  DOMAIN_INVALID: 'hosting.activation_domain_invalid',
  /** The domain is one of this server's own names. */
  DOMAIN_RESERVED: 'hosting.activation_domain_reserved',
  DOMAIN_TAKEN: 'hosting.activation_domain_taken',
  /** The hosted owner already signed in with the link: the domain no longer changes. */
  DOMAIN_LOCKED: 'hosting.activation_domain_locked',
  /** The domain does not (yet) point at this server. */
  DNS_NOT_POINTED: 'hosting.activation_dns_not_pointed',
  /** The name could not be looked up in time. */
  DNS_LOOKUP_FAILED: 'hosting.activation_dns_lookup_failed',
  /** HTTPS on the domain did not answer with a valid certificate yet. */
  SSL_NOT_READY: 'hosting.activation_ssl_not_ready',
  WEBHOOK_FAILED: 'hosting.activation_webhook_failed',
  /** The link is unknown, or not for this address. */
  LINK_INVALID: 'hosting.activation_link_invalid',
  LINK_EXPIRED: 'hosting.activation_link_expired',
  LINK_USED: 'hosting.activation_link_used',
  /** Another administrator of the hosted bot already has that username. */
  USERNAME_TAKEN: 'hosting.activation_username_taken',
} as const;

/** Under `API_PREFIX`. `:tenantId` is the hosted bot's tenant id; `:step` a runnable step. */
export const HOSTING_ACTIVATION_ROUTES = {
  status: '/hosting/bots/:tenantId/activation',
  configure: '/hosting/bots/:tenantId/activation/configure',
  runStep: '/hosting/bots/:tenantId/activation/steps/:step',
  link: '/hosting/bots/:tenantId/activation/link',
} as const;

/** Under `API_PREFIX`, ANONYMOUS by design: the hosted owner has no account yet. */
export const HOSTED_ACTIVATION_ROUTES = {
  redeem: '/hosted-activation/redeem',
} as const;

/**
 * NOT under `API_PREFIX`, and not proxied by the edge: the endpoint the edge's on-demand TLS
 * asks (`GET <path>?domain=<name>`) before issuing a certificate. 200 only for a verified
 * hosted domain of an ACTIVE hosted bot; 404 for everything else.
 */
export const HOSTED_DOMAIN_CHECK_PATH = '/internal/hosting/domain-check';

/** The page the hosted owner opens (a web route, with the token in the URL FRAGMENT). */
export const HOSTED_ACTIVATION_PAGE_PATH = '/activate';

const idempotencyKey = z.string().min(8).max(255);

export const hostedActivationConfigureRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  /** Telegram's `<bot id>:<secret>`; never returned, never in the request hash. */
  botToken: z.string().trim().min(10).max(256),
  /** The domain the hosted owner pointed (a CNAME) at this server. */
  domain: z.string().trim().min(1).max(260),
});
export type HostedActivationConfigureRequest = z.infer<
  typeof hostedActivationConfigureRequestSchema
>;

export const hostedActivationStepRequestSchema = z.object({ idempotencyKey });

export const hostedActivationLinkRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
});

/** The hosted owner's own choice, made on the activation page. */
export const hostedActivationRedeemRequestSchema = z.object({
  /** From the link's fragment. */
  token: z.string().trim().min(20).max(256),
  username: adminUsernameSchema,
  password: adminPasswordSchema,
  /** Optional: keeps the name the creator gave when absent. */
  displayName: adminDisplayNameSchema.optional(),
});
export type HostedActivationRedeemRequest = z.infer<typeof hostedActivationRedeemRequestSchema>;

export interface HostedActivationStepView {
  readonly step: HostedActivationStep;
  readonly state: HostedActivationStepState;
  readonly doneAt: string | null;
  /** A `HOSTING_ACTIVATION_ERROR_CODES` value while the step is FAILED. */
  readonly errorCode: string | null;
}

export interface HostedActivationView {
  readonly hostedTenantId: string;
  readonly domain: string | null;
  /** The bot's username as Telegram reported it. */
  readonly botUsername: string | null;
  /** What the hosted owner points the domain at: this server's hostname, and/or its addresses. */
  readonly dnsTarget: { readonly hostname: string | null; readonly addresses: readonly string[] };
  readonly steps: readonly HostedActivationStepView[];
  /** The newest link: its state, never the token. */
  readonly link: {
    readonly state: HostedActivationLinkState;
    readonly createdAt: string;
    readonly expiresAt: string;
  } | null;
  /** When the hosted owner redeemed a link and chose their credentials. */
  readonly ownerActivatedAt: string | null;
}

export interface HostedActivationResponse {
  readonly activation: HostedActivationView;
  readonly replayed: boolean;
}

export interface HostedActivationLinkResponse extends HostedActivationResponse {
  /** Shown ONCE. Null on an idempotent replay: only a hash of the token is kept. */
  readonly activationUrl: string | null;
}

export interface HostedActivationRedeemResponse {
  readonly ok: true;
}
