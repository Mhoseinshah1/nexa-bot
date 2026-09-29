import {
  PANEL_REQUIRED_CAPABILITIES,
  isServiceAdapter,
  providerDescriptor,
  shapeIsSatisfiedBy,
  type DiagnosticVerdict,
  type PanelDiagnosticCheck,
  type PanelDiagnosticOverall,
  type PanelDiagnostics,
  type PanelSellability,
  type ProviderCapability,
  type ProviderConnectionAdapter,
} from '@nexa/contracts';
import type { PanelView } from './ports.js';
import { readHealth } from './panel-health-view.js';

/**
 * Operator diagnostics for one panel (WP-A8), from what is already stored.
 *
 * Pure, and a projection only. Nothing here dials a panel: connectivity and
 * authentication are what the LATEST probe concluded, written by `probe-core.ts` — the
 * one probe implementation, whether the operator's "test connection" or the monitor ran
 * it — and a panel nobody has probed reads `UNKNOWN`, never a guess.
 *
 * Every verdict is one of four, and `UNKNOWN` is kept apart from `FAIL` everywhere: an
 * unreachable panel says nothing about whether its credentials work, so AUTHENTICATION
 * after `UNREACHABLE` is unknown rather than failed — telling an operator to replace a
 * password because the machine is off is the remedy the failure taxonomy exists to stop.
 */
export function diagnosePanel(input: {
  readonly view: PanelView;
  readonly sellability: PanelSellability;
  readonly adapter: ProviderConnectionAdapter | null;
  readonly now: Date;
}): PanelDiagnostics {
  const { view, sellability, adapter, now } = input;
  const health = view.health;
  const stored = health?.state ?? null;
  const reading = readHealth(view.panel, health, now);
  const descriptor = providerDescriptor(view.panel.providerType);

  const credentialsConfigured =
    descriptor !== null &&
    shapeIsSatisfiedBy(descriptor.credentialShape, {
      username: view.credentials.usernameSetAt !== null,
      password: view.credentials.passwordSetAt !== null,
      apiToken: view.credentials.apiTokenSetAt !== null,
    });

  const requiredCapabilities = PANEL_REQUIRED_CAPABILITIES.map((capability) => ({
    capability,
    available: capabilityAvailable(adapter, capability),
  }));

  const checks: { check: PanelDiagnosticCheck; verdict: DiagnosticVerdict }[] = [
    {
      check: 'CONNECTIVITY',
      // Reached means ANSWERED: a rejected login is a panel that is up.
      verdict: stored === null ? 'UNKNOWN' : stored === 'UNREACHABLE' ? 'FAIL' : 'PASS',
    },
    { check: 'CREDENTIALS', verdict: credentialsConfigured ? 'PASS' : 'FAIL' },
    {
      check: 'AUTHENTICATION',
      verdict: !credentialsConfigured
        ? 'FAIL'
        : stored === 'HEALTHY' || stored === 'DEGRADED'
          ? 'PASS'
          : stored === 'AUTH_FAILED'
            ? 'FAIL'
            : 'UNKNOWN',
    },
    {
      check: 'PROVIDER_STATUS',
      // DEGRADED: authenticated, then the status read failed. Worrying, not unusable.
      verdict: stored === 'HEALTHY' ? 'PASS' : stored === 'DEGRADED' ? 'WARN' : 'UNKNOWN',
    },
    { check: 'CONFIGURATION', verdict: sellability.activationComplete ? 'PASS' : 'FAIL' },
    // A test bound to what the panel is NOW, which enabling requires. Missing is a
    // warning: an ACTIVE panel can predate the rule, and nothing is broken by it yet.
    { check: 'CONNECTION_TEST', verdict: sellability.connectionValidated ? 'PASS' : 'WARN' },
    {
      check: 'FRESHNESS',
      verdict: health === null ? 'UNKNOWN' : reading.stale ? 'WARN' : 'PASS',
    },
    {
      check: 'REQUIRED_CAPABILITIES',
      verdict: requiredCapabilities.every((entry) => entry.available) ? 'PASS' : 'FAIL',
    },
  ];

  return {
    overall: overallOf(view.panel.status, health === null, checks),
    checks,
    failure: health?.failure ?? null,
    httpStatus: health?.statusCode ?? null,
    providerVersion: health?.providerVersion ?? null,
    lastCheckedAt: health?.checkedAt.toISOString() ?? null,
    lastSuccessfulCheckAt: health?.lastHealthyAt?.toISOString() ?? null,
    stale: reading.stale,
    requiredCapabilities,
    missingActivationFields: [...sellability.missingActivationFields],
  };
}

/**
 * A capability the adapter both declares and can perform. The service half is required
 * for everything but the probe, for the reason `SERVICE_PROVIDER_TYPES` gives: a
 * connection adapter that declares `CREATE_USER` still cannot create one.
 */
function capabilityAvailable(
  adapter: ProviderConnectionAdapter | null,
  capability: ProviderCapability,
): boolean {
  if (adapter === null || !adapter.supports(capability)) return false;
  return capability === 'HEALTH_CHECK' || isServiceAdapter(adapter);
}

function overallOf(
  status: string,
  neverChecked: boolean,
  checks: readonly { readonly verdict: DiagnosticVerdict }[],
): PanelDiagnosticOverall {
  // The operator's own decision is reported as that, before anything a probe said.
  if (status !== 'ACTIVE') return 'DISABLED';
  if (checks.some((entry) => entry.verdict === 'FAIL')) return 'ERROR';
  if (neverChecked) return 'NOT_CHECKED';
  if (checks.some((entry) => entry.verdict === 'WARN')) return 'DEGRADED';
  return 'OK';
}
