import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_REGISTRY_ROWS,
  DEFAULT_PANEL_POLICY,
  PANEL_CUSTOMER_ACTIONS,
  canAddTime,
  canAddVolume,
  canAdjustDeviceLimit,
  canDeleteUser,
  canDisableUser,
  canEnableUser,
  canFetchSubscriptionFiles,
  canRenewUser,
  canRotateSubscription,
  customerActionVerdict,
  deriveCapabilityRegistry,
  effectiveCooldownMs,
  isServiceAdapter,
  panelPolicySchema,
  policyMaxDeviceLimit,
  policyMaxTrafficBytes,
  resolvePanelPolicy,
  unsupportedPolicyActions,
  BYTES_PER_GB,
  type CapabilityRegistryRow,
  type CreateProviderUserInput,
  type PanelSellability,
  type ProviderAdapter,
  type ProviderCapability,
  type ProviderConnectionAdapter,
  type ProviderHttpClient,
  type ProviderHttpRequest,
  type ProviderServiceTarget,
  type ProviderType,
  type ServiceId,
} from '@nexa/contracts';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import { SanaeiAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter';
import { PROVIDER_RULES } from '../../apps/api/src/modules/platform/providers/infrastructure/provider-rules';
import {
  IMPLEMENTED_PROVIDER_TYPES,
  providerAdapter,
} from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { diagnosePanel } from '../../apps/api/src/modules/platform/panels/application/panel-diagnostics';
import type {
  PanelHealthSnapshot,
  PanelView,
} from '../../apps/api/src/modules/platform/panels/application/ports';

/**
 * WP-A8: the capability registry, the panel policy's rules, the diagnostics projection
 * and the provider rules an operator is shown.
 */

const supportedRows = (adapter: ProviderConnectionAdapter): CapabilityRegistryRow[] =>
  deriveCapabilityRegistry(adapter)
    .filter((entry) => entry.supported)
    .map((entry) => entry.row);

const entryFor = (adapter: ProviderConnectionAdapter, row: CapabilityRegistryRow) => {
  const found = deriveCapabilityRegistry(adapter).find((entry) => entry.row === row);
  if (found === undefined) throw new Error(`no ${row} row`);
  return found;
};

/** An adapter whose descriptor declares exactly `declared`, over another's methods. */
function declaring(
  base: ProviderConnectionAdapter,
  declared: readonly ProviderCapability[],
): ProviderConnectionAdapter {
  return Object.assign(Object.create(base) as ProviderConnectionAdapter, {
    supports: (capability: ProviderCapability) => declared.includes(capability),
  });
}

/** An adapter with one method removed, whatever it declares. */
function without(base: ProviderConnectionAdapter, method: keyof ProviderAdapter) {
  return Object.assign(Object.create(base) as ProviderConnectionAdapter, { [method]: undefined });
}

describe('the capability registry', () => {
  it('lists every row, in order, for every provider', () => {
    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      expect(deriveCapabilityRegistry(providerAdapter(type)).map((entry) => entry.row)).toEqual([
        ...CAPABILITY_REGISTRY_ROWS,
      ]);
    }
  });

  /*
   * The exact supported set per provider, named rather than derived: a derived
   * expectation would be the same computation as the code under test.
   */
  it('says exactly what each registered adapter can do', () => {
    expect(supportedRows(new MarzbanAdapter())).toEqual([
      'CREATE_SERVICE',
      'RENEW',
      'ADD_TRAFFIC',
      'ADD_TIME',
      'DISABLE_ENABLE',
      'USAGE_READ',
      'TERMINATE',
    ]);
    expect(supportedRows(new RickpanelAdapter())).toEqual([
      'CREATE_SERVICE',
      'RENEW',
      'ADD_TRAFFIC',
      'ADD_TIME',
      'DISABLE_ENABLE',
      'ROTATE_SUBSCRIPTION',
      'SUBSCRIPTION_FILES',
      'USAGE_READ',
      'TERMINATE',
    ]);
    // 3X-UI is frozen at what it has (CLAUDE.md): creation and the usage read.
    expect(supportedRows(new SanaeiAdapter())).toEqual(['CREATE_SERVICE', 'USAGE_READ']);
  });

  it('reads location change as absent from this release for every provider', () => {
    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      expect(entryFor(providerAdapter(type), 'LOCATION_CHANGE')).toEqual({
        row: 'LOCATION_CHANGE',
        supported: false,
        gap: 'NOT_IN_RELEASE',
      });
    }
  });

  it('reads reset traffic and extra users as unsupported by every provider', () => {
    for (const type of IMPLEMENTED_PROVIDER_TYPES) {
      expect(entryFor(providerAdapter(type), 'RESET_TRAFFIC').supported).toBe(false);
      // WP-A5: no provider declares DEVICE_LIMIT_ADJUSTMENT in this release.
      expect(entryFor(providerAdapter(type), 'EXTRA_DEVICES').supported).toBe(false);
    }
  });

  /*
   * The owner's rule: an implemented-but-undeclared operation is refused rather than
   * offered. Marzban HAS `applyAllowance`; a descriptor that stops declaring RENEW_USER
   * must read the row as unsupported and say why.
   */
  it('shows an implemented but undeclared capability as unsupported, and says so', () => {
    const marzban = new MarzbanAdapter();
    const undeclared = declaring(
      marzban,
      marzban.descriptor.capabilities.filter((capability) => capability !== 'RENEW_USER'),
    );
    expect(entryFor(undeclared, 'RENEW')).toEqual({
      row: 'RENEW',
      supported: false,
      gap: 'NOT_DECLARED',
    });
    // The two capabilities sharing the method are separate promises and stay offered.
    expect(entryFor(undeclared, 'ADD_TRAFFIC').supported).toBe(true);
  });

  it('shows a declared capability with no method as unsupported, and says so', () => {
    const missing = without(new RickpanelAdapter(), 'rotateSubscription');
    expect(entryFor(missing, 'ROTATE_SUBSCRIPTION')).toEqual({
      row: 'ROTATE_SUBSCRIPTION',
      supported: false,
      gap: 'NOT_IMPLEMENTED',
    });
  });

  it('needs BOTH halves of disable / enable', () => {
    const rick = new RickpanelAdapter();
    const onlyDisable = declaring(
      rick,
      rick.descriptor.capabilities.filter((capability) => capability !== 'ENABLE_USER'),
    );
    expect(entryFor(onlyDisable, 'DISABLE_ENABLE').supported).toBe(false);
    expect(entryFor(without(rick, 'resumeUser'), 'DISABLE_ENABLE').supported).toBe(false);
  });

  it('offers nothing for a connection-only adapter, whatever it declares', () => {
    const marzban = new MarzbanAdapter();
    const connectionOnly: ProviderConnectionAdapter = {
      descriptor: marzban.descriptor,
      supports: (capability) => marzban.supports(capability),
      probe: (target, http) => marzban.probe(target, http),
    };
    expect(isServiceAdapter(connectionOnly)).toBe(false);
    expect(supportedRows(connectionOnly)).toEqual([]);
  });

  /*
   * The registry must agree with the guards the executor and the surfaces already call,
   * over every adapter — real and synthetic — so the screen cannot say yes where the
   * product says no, or the reverse.
   */
  it('agrees with the existing can* guards for every adapter', () => {
    const rick = new RickpanelAdapter();
    const adapters: ProviderConnectionAdapter[] = [
      new MarzbanAdapter(),
      rick,
      new SanaeiAdapter(),
      declaring(rick, []),
      declaring(new SanaeiAdapter(), [...rick.descriptor.capabilities, 'DEVICE_LIMIT_ADJUSTMENT']),
      without(rick, 'applyAllowance'),
      without(rick, 'terminateUser'),
      without(rick, 'fetchSubscriptionFiles'),
    ];
    const guards: Partial<Record<CapabilityRegistryRow, (adapter: ProviderAdapter) => boolean>> = {
      RENEW: canRenewUser,
      ADD_TRAFFIC: canAddVolume,
      ADD_TIME: canAddTime,
      DISABLE_ENABLE: (adapter) => canDisableUser(adapter) && canEnableUser(adapter),
      ROTATE_SUBSCRIPTION: canRotateSubscription,
      SUBSCRIPTION_FILES: canFetchSubscriptionFiles,
      EXTRA_DEVICES: canAdjustDeviceLimit,
      TERMINATE: canDeleteUser,
      CREATE_SERVICE: (adapter) => adapter.supports('CREATE_USER'),
      USAGE_READ: (adapter) => adapter.supports('READ_USAGE'),
    };
    for (const adapter of adapters) {
      for (const entry of deriveCapabilityRegistry(adapter)) {
        const guard = guards[entry.row];
        if (guard === undefined) {
          expect(entry.supported, entry.row).toBe(false);
          continue;
        }
        const expected = isServiceAdapter(adapter) && guard(adapter);
        expect(entry.supported, entry.row).toBe(expected);
        expect(entry.gap === null, entry.row).toBe(entry.supported);
      }
    }
  });
});

describe('the panel policy', () => {
  const policy = (actions: Record<string, unknown>) => ({
    delivery: { mode: 'CARD_WITH_QR' },
    actions,
  });

  it('reads no row as the default, which restricts nothing', () => {
    const resolved = resolvePanelPolicy(null);
    expect(resolved).toEqual({ readable: true, policy: DEFAULT_PANEL_POLICY });
    for (const action of PANEL_CUSTOMER_ACTIONS) {
      expect(customerActionVerdict(resolved, action)).toEqual({ allowed: true });
    }
  });

  /*
   * A policy is a RESTRICTION, so an unreadable one is read as the strictest: every
   * customer action on the panel refused. Reading it as "no policy" would re-enable
   * what an operator switched off whenever a row stopped parsing.
   */
  it('refuses every customer action on a panel whose stored policy does not parse', () => {
    for (const stored of [
      { delivery: { mode: 'CARD_WITH_QR' }, actions: { RENEW: { customerEnabled: 'no' } } },
      { delivery: { mode: 'CARD_WITH_QR' }, actions: {}, invented: true },
      { delivery: { mode: 'BOTH' }, actions: {} },
      'a string',
    ]) {
      const resolved = resolvePanelPolicy(stored);
      expect(resolved.readable).toBe(false);
      for (const action of PANEL_CUSTOMER_ACTIONS) {
        expect(customerActionVerdict(resolved, action)).toEqual({
          allowed: false,
          reason: 'POLICY_UNREADABLE',
        });
      }
    }
  });

  it('refuses exactly the action switched off, and no other', () => {
    const resolved = resolvePanelPolicy(policy({ RENEW: { customerEnabled: false } }));
    expect(customerActionVerdict(resolved, 'RENEW')).toEqual({
      allowed: false,
      reason: 'POLICY_DISABLED',
    });
    expect(customerActionVerdict(resolved, 'ADD_TRAFFIC')).toEqual({ allowed: true });
  });

  it('accepts a knob only on the action it means something for', () => {
    expect(
      panelPolicySchema.safeParse(
        policy({ ROTATE_SUBSCRIPTION: { customerEnabled: true, cooldownMinutes: 90 } }),
      ).success,
    ).toBe(true);
    // A cooldown on a renewal is a control nothing reads: refused at the schema.
    expect(
      panelPolicySchema.safeParse(policy({ RENEW: { customerEnabled: true, cooldownMinutes: 90 } }))
        .success,
    ).toBe(false);
    // Operator and system rows are not customer actions, so a policy cannot name them.
    expect(
      panelPolicySchema.safeParse(policy({ TERMINATE: { customerEnabled: false } })).success,
    ).toBe(false);
    // Zero is not "no cooldown"; null is.
    expect(
      panelPolicySchema.safeParse(
        policy({ USAGE_READ: { customerEnabled: true, cooldownMinutes: 0 } }),
      ).success,
    ).toBe(false);
  });

  it('can lengthen a cooldown and never shorten it', () => {
    const hourFloor = 3_600_000;
    const longer = resolvePanelPolicy(
      policy({ ROTATE_SUBSCRIPTION: { customerEnabled: true, cooldownMinutes: 120 } }),
    );
    expect(effectiveCooldownMs(hourFloor, longer, 'ROTATE_SUBSCRIPTION')).toBe(7_200_000);
    const shorter = resolvePanelPolicy(
      policy({ ROTATE_SUBSCRIPTION: { customerEnabled: true, cooldownMinutes: 5 } }),
    );
    expect(effectiveCooldownMs(hourFloor, shorter, 'ROTATE_SUBSCRIPTION')).toBe(hourFloor);
    expect(effectiveCooldownMs(hourFloor, resolvePanelPolicy(null), 'ROTATE_SUBSCRIPTION')).toBe(
      hourFloor,
    );
  });

  it('turns a GB cap into bytes and a device cap into a limit', () => {
    const resolved = resolvePanelPolicy(
      policy({
        ADD_TRAFFIC: { customerEnabled: true, maxTrafficGb: 50 },
        EXTRA_DEVICES: { customerEnabled: true, maxDeviceLimit: 4 },
      }),
    );
    expect(policyMaxTrafficBytes(resolved)).toBe(50n * BYTES_PER_GB);
    expect(policyMaxDeviceLimit(resolved)).toBe(4);
    expect(policyMaxTrafficBytes(resolvePanelPolicy(null))).toBeNull();
  });

  it('names the actions a policy sets that the adapter cannot perform', () => {
    const parsed = panelPolicySchema.parse(
      policy({
        RENEW: { customerEnabled: false },
        SUBSCRIPTION_FILES: { customerEnabled: false },
        EXTRA_DEVICES: { customerEnabled: true, maxDeviceLimit: 3 },
      }),
    );
    expect(
      unsupportedPolicyActions(parsed, deriveCapabilityRegistry(new MarzbanAdapter())),
    ).toEqual(['EXTRA_DEVICES', 'SUBSCRIPTION_FILES']);
    expect(
      unsupportedPolicyActions(parsed, deriveCapabilityRegistry(new RickpanelAdapter())),
    ).toEqual(['EXTRA_DEVICES']);
  });
});

describe('panel diagnostics', () => {
  const NOW = new Date('2026-09-28T12:00:00.000Z');
  const sellability: PanelSellability = {
    sellable: true,
    reason: null,
    activationComplete: true,
    missingActivationFields: [],
    connectionValidated: true,
  };

  function viewWith(
    health: Partial<PanelHealthSnapshot> | null,
    overrides: { status?: string; passwordSetAt?: Date | null } = {},
  ): PanelView {
    return {
      panel: {
        id: 'p',
        tenantId: 't',
        name: 'A',
        providerType: 'marzban',
        baseUrl: 'https://panel.example',
        status: overrides.status ?? 'ACTIVE',
        activation: null,
        maxServices: null,
        usernamePolicy: {
          allowCustom: true,
          allowAutomatic: true,
          strategy: 'PREFIX_RANDOM',
          prefix: 'nx',
          template: null,
        },
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      credentials: {
        usernameSetAt: NOW,
        passwordSetAt: overrides.passwordSetAt === undefined ? NOW : overrides.passwordSetAt,
        apiTokenSetAt: null,
      },
      health:
        health === null
          ? null
          : {
              state: 'HEALTHY',
              checkedAt: new Date(NOW.getTime() - 60_000),
              latencyMs: 30,
              failure: null,
              statusCode: 200,
              providerVersion: '0.8.4',
              lastHealthyAt: new Date(NOW.getTime() - 60_000),
              unusableStreak: 0,
              validatedIdentity: 'x',
              ...health,
            },
    } as unknown as PanelView;
  }

  const verdicts = (view: PanelView, sell: PanelSellability = sellability) => {
    const diagnosed = diagnosePanel({
      view,
      sellability: sell,
      adapter: new MarzbanAdapter(),
      now: NOW,
    });
    return {
      overall: diagnosed.overall,
      ...Object.fromEntries(diagnosed.checks.map((check) => [check.check, check.verdict])),
    } as Record<string, string>;
  };

  it('reads a healthy, configured panel as OK and names the last success', () => {
    const view = viewWith({});
    const diagnosed = diagnosePanel({ view, sellability, adapter: new MarzbanAdapter(), now: NOW });
    expect(diagnosed.overall).toBe('OK');
    expect(diagnosed.lastSuccessfulCheckAt).toBe('2026-09-28T11:59:00.000Z');
    expect(diagnosed.requiredCapabilities.every((entry) => entry.available)).toBe(true);
  });

  /*
   * The taxonomy's point: an unreachable panel says nothing about its credentials, so
   * authentication is UNKNOWN there — never FAIL, which would send an operator to
   * replace a working password on a machine that is off.
   */
  it('does not call authentication failed when the panel could not be reached', () => {
    const read = verdicts(
      viewWith({ state: 'UNREACHABLE', failure: 'TIMEOUT', statusCode: null, lastHealthyAt: null }),
    );
    expect(read['CONNECTIVITY']).toBe('FAIL');
    expect(read['AUTHENTICATION']).toBe('UNKNOWN');
    expect(read.overall).toBe('ERROR');
  });

  it('says authentication failed when the panel rejected the credentials', () => {
    const read = verdicts(
      viewWith({ state: 'AUTH_FAILED', failure: 'AUTHENTICATION_FAILED', statusCode: 401 }),
    );
    expect(read['CONNECTIVITY']).toBe('PASS');
    expect(read['AUTHENTICATION']).toBe('FAIL');
  });

  it('warns on a degraded panel without calling it broken', () => {
    const read = verdicts(viewWith({ state: 'DEGRADED' }));
    expect(read['AUTHENTICATION']).toBe('PASS');
    expect(read['PROVIDER_STATUS']).toBe('WARN');
    expect(read.overall).toBe('DEGRADED');
  });

  it('reports a never-probed panel as not checked, with nothing guessed', () => {
    const read = verdicts(viewWith(null));
    expect(read.overall).toBe('NOT_CHECKED');
    expect(read['CONNECTIVITY']).toBe('UNKNOWN');
    expect(read['FRESHNESS']).toBe('UNKNOWN');
  });

  it('fails credentials and authentication when the shape is not satisfied', () => {
    const read = verdicts(viewWith({}, { passwordSetAt: null }));
    expect(read['CREDENTIALS']).toBe('FAIL');
    expect(read['AUTHENTICATION']).toBe('FAIL');
  });

  it('reports an incomplete activation and a stale result', () => {
    const read = verdicts(viewWith({ checkedAt: new Date(NOW.getTime() - 3_600_000) }), {
      ...sellability,
      activationComplete: false,
      missingActivationFields: ['inboundTags'],
    });
    expect(read['CONFIGURATION']).toBe('FAIL');
    expect(read['FRESHNESS']).toBe('WARN');
  });

  it('reports the operator decision first on a disabled panel', () => {
    expect(verdicts(viewWith({}, { status: 'DISABLED' })).overall).toBe('DISABLED');
  });
});

/**
 * The fixed provider rules an operator is shown, pinned to the request each adapter
 * actually sends. A scripted client answers the token exchange and records the create;
 * the create itself is answered 500, because only its BODY is being read.
 */
describe('provider rules, pinned to the create request', () => {
  function recordingHttp(): { http: ProviderHttpClient; sent: ProviderHttpRequest[] } {
    const sent: ProviderHttpRequest[] = [];
    return {
      sent,
      http: {
        send: async (request) => {
          sent.push(request);
          if (request.path.includes('admin/token')) {
            return {
              ok: true,
              status: 200,
              headers: {},
              bodyText: JSON.stringify({ access_token: 'token', token_type: 'bearer' }),
              setCookie: [],
            };
          }
          return { ok: true, status: 500, headers: {}, bodyText: '{}', setCookie: [] };
        },
      },
    };
  }

  const input: CreateProviderUserInput = {
    serviceId: '0190aaaa-0000-7000-8000-000000000001' as ServiceId,
    username: 'pinuser01',
    subscriptionRef: 'ref0123456789abcdef',
    clientId: '0190aaaa-0000-4000-8000-000000000002',
    volumeBytes: 10n * BYTES_PER_GB,
    durationDays: 30,
    expiresAt: new Date('2026-10-28T00:00:00Z'),
    deviceLimit: 2,
  };

  async function createBody(
    type: ProviderType,
    target: ProviderServiceTarget,
  ): Promise<Record<string, unknown>> {
    const adapter = providerAdapter(type) as ProviderAdapter;
    const { http, sent } = recordingHttp();
    await adapter.createUser(target, http, input);
    const create = sent.find((request) => !request.path.includes('admin/token'));
    if (create?.body?.kind !== 'json') throw new Error(`${type} sent no JSON create`);
    return create.body.value as Record<string, unknown>;
  }

  it('Marzban: never resets, sends the operator’s protocols and tags, and no device field', async () => {
    const body = await createBody('marzban', {
      baseUrl: 'https://m.example',
      credentials: { shape: 'USERNAME_PASSWORD', username: 'u', password: 'p' },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS_TCP'] } },
    });
    expect(PROVIDER_RULES.marzban.trafficReset).toBe('NEVER');
    expect(body['data_limit_reset_strategy']).toBe('no_reset');
    expect(PROVIDER_RULES.marzban.protocols).toBe('OPERATOR_CHOSEN');
    expect(Object.keys(body['proxies'] as object)).toEqual(['vless']);
    expect(PROVIDER_RULES.marzban.inbounds).toBe('OPERATOR_TAGS');
    expect(body['inbounds']).toEqual({ vless: ['VLESS_TCP'] });
    expect(PROVIDER_RULES.marzban.deviceLimitOnCreate).toBe('NOT_SENT');
    expect(JSON.stringify(body)).not.toMatch(/limit_ip|device/i);
  });

  it('RickPanel: never resets, names no inbound, and sends no device field', async () => {
    const body = await createBody('rickpanel', {
      baseUrl: 'https://r.example',
      credentials: { shape: 'USERNAME_PASSWORD', username: 'u', password: 'p' },
      activation: {},
    });
    expect(PROVIDER_RULES.rickpanel.trafficReset).toBe('NEVER');
    expect(body['data_limit_reset_strategy']).toBe('no_reset');
    expect(PROVIDER_RULES.rickpanel.inbounds).toBe('PANEL_ASSIGNED');
    expect(body).not.toHaveProperty('inbounds');
    expect(PROVIDER_RULES.rickpanel.deviceLimitOnCreate).toBe('NOT_SENT');
    expect(JSON.stringify(body)).not.toMatch(/limit_ip|device/i);
  });

  it('3X-UI: never resets, uses the configured inbound, and writes the product’s device limit', async () => {
    const body = await createBody('sanaei', {
      baseUrl: 'https://x.example',
      credentials: { shape: 'OPAQUE_TOKEN', token: 't' },
      activation: { subscriptionDomain: 'sub.example', inboundId: 7 },
    });
    const client = body['client'] as Record<string, unknown>;
    expect(PROVIDER_RULES.sanaei.trafficReset).toBe('NEVER');
    expect(client['reset']).toBe(0);
    expect(PROVIDER_RULES.sanaei.inbounds).toBe('OPERATOR_INBOUND_ID');
    expect(body['inboundIds']).toEqual([7]);
    expect(PROVIDER_RULES.sanaei.deviceLimitOnCreate).toBe('FROM_PRODUCT');
    expect(client['limitIp']).toBe(2);
    expect(PROVIDER_RULES.sanaei.subscriptionLink).toBe('SUBSCRIPTION_DOMAIN');
  });
});
