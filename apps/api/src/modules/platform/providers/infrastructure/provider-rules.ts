import type { ProviderRules, ProviderType } from '@nexa/contracts';

/**
 * The fixed provider-side behaviour each adapter applies (WP-A8), beside the adapters
 * that apply it.
 *
 * A statement about the request bodies in this directory, and pinned to them:
 * `tests/unit/provider-rules.test.ts` drives each adapter's `createUser` and reads the
 * body it sends, so a change to an adapter that makes one of these false fails there
 * rather than leaving an operator reading a rule the panel no longer follows.
 *
 *   - Marzban: `data_limit_reset_strategy: 'no_reset'`; the activation's
 *     `proxyProtocols` and `inboundTags`; the panel's own `subscription_url`; no device
 *     field (v0.8.4 has none — `provider.ts`, the Marzban descriptor).
 *   - RickPanel: `no_reset`; a proxy seed the panel ignores and no inbounds, because its
 *     contract assigns every protocol and inbound itself; its own `subscription_url`.
 *   - 3X-UI: `reset: 0`; one inbound, `activation.inboundId`, whose own protocol the
 *     client gets; a link built from `activation.subscriptionDomain`; `limitIp` from the
 *     product's device limit.
 */
export const PROVIDER_RULES: Readonly<Record<ProviderType, ProviderRules>> = {
  marzban: {
    trafficReset: 'NEVER',
    protocols: 'OPERATOR_CHOSEN',
    inbounds: 'OPERATOR_TAGS',
    subscriptionLink: 'PANEL_ISSUED',
    deviceLimitOnCreate: 'NOT_SENT',
  },
  rickpanel: {
    trafficReset: 'NEVER',
    protocols: 'PANEL_ASSIGNED',
    inbounds: 'PANEL_ASSIGNED',
    subscriptionLink: 'PANEL_ISSUED',
    deviceLimitOnCreate: 'NOT_SENT',
  },
  sanaei: {
    trafficReset: 'NEVER',
    protocols: 'INBOUND_DEFINED',
    inbounds: 'OPERATOR_INBOUND_ID',
    subscriptionLink: 'SUBSCRIPTION_DOMAIN',
    deviceLimitOnCreate: 'FROM_PRODUCT',
  },
};
