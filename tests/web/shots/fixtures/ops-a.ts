import {
  CAPABILITY_REGISTRY_ROWS,
  panelListResponseSchema,
  panelResponseSchema,
  providerListResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/*
 * Page family OPS-A: panels, providers, bots, payment gateways and accounts,
 * client apps. The OPS-A agent adds the fixtures its pages need here.
 */

type Json = Record<string, unknown>;

function health(over: Json = {}): Json {
  return {
    state: 'HEALTHY',
    checkedAt: ago(2),
    latencyMs: 42,
    failure: null,
    status: 200,
    providerVersion: '0.8.4',
    lastHealthyAt: ago(2),
    stale: false,
    ...over,
  };
}

/** One panel, in `panelSummarySchema`'s shape — the web suite's `panel()` defaults. */
export function panel(id: string, name: string, over: Json = {}): Json {
  return {
    id,
    name,
    providerType: 'marzban',
    providerName: 'Marzban',
    baseUrl: `https://${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/api`,
    status: 'ACTIVE',
    capabilities: ['HEALTH_CHECK'],
    credentials: {
      username: { configured: true, lastReplacedAt: ago(60 * 24 * 30) },
      password: { configured: true, lastReplacedAt: ago(60 * 24 * 30) },
      apiToken: { configured: false, lastReplacedAt: null },
    },
    activation: null,
    health: health(),
    capacity: { maxServices: 400, services: 212, reservations: 3, used: 215, available: 185 },
    sellability: {
      sellable: false,
      reason: 'ACTIVATION_INCOMPLETE',
      activationComplete: false,
      missingActivationFields: ['proxyProtocols', 'inboundTags'],
      connectionValidated: false,
    },
    usernamePolicy: {
      allowCustom: true,
      allowAutomatic: true,
      strategy: 'PREFIX_RANDOM',
      prefix: 'nx',
      template: null,
    },
    createdAt: ago(60 * 24 * 200),
    updatedAt: ago(60 * 24 * 3),
    ...over,
  };
}

export const PANELS: readonly Json[] = [
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292c8', 'Frankfurt A'),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292c9', 'Frankfurt B', {
    health: health({ state: 'DEGRADED', latencyMs: 2140 }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292ca', 'Amsterdam', {
    providerType: 'sanaei',
    providerName: '3X-UI (MHSanaei)',
    health: health({
      state: 'UNREACHABLE',
      failure: 'TIMEOUT',
      status: null,
      latencyMs: null,
      lastHealthyAt: ago(190),
      stale: true,
    }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292cb', 'Tehran Edge', {
    status: 'DISABLED',
    health: health({
      state: 'DISABLED',
      checkedAt: null,
      latencyMs: null,
      status: null,
      providerVersion: null,
    }),
  }),
  panel('01a05e35-c9ad-7e93-bef3-1ed9b55292cc', 'Stockholm', {
    providerType: 'sanaei',
    providerName: '3X-UI (MHSanaei)',
    health: health({
      state: 'AUTH_FAILED',
      failure: 'AUTHENTICATION_REQUIRES_INTERACTION',
      status: 401,
      latencyMs: 88,
    }),
  }),
];

function registry(supported: readonly string[]): Json[] {
  return CAPABILITY_REGISTRY_ROWS.map((row) =>
    supported.includes(row)
      ? { row, supported: true, gap: null }
      : { row, supported: false, gap: 'NOT_IMPLEMENTED' },
  );
}

export const OPS_A: readonly ShotFixture[] = [
  fixture('/panels', panelListResponseSchema, { panels: PANELS, nextCursor: null }),
  fixture('/panels/:id', panelResponseSchema, { panel: PANELS[0] }),
  fixture('/providers', providerListResponseSchema, {
    providers: [
      {
        key: 'marzban',
        canonicalName: 'Marzban',
        credentialShape: 'USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: [],
        capabilityRegistry: registry(['HEALTH_CHECK']),
      },
      {
        key: 'sanaei',
        canonicalName: '3X-UI (MHSanaei)',
        credentialShape: 'TOKEN_OR_USERNAME_PASSWORD',
        capabilities: ['HEALTH_CHECK'],
        requiredActivationFields: ['subscriptionDomain'],
        capabilityRegistry: registry(['HEALTH_CHECK']),
      },
    ],
  }),
];
