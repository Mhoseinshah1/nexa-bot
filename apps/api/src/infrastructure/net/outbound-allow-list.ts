import {
  OUTBOUND_PRIVATE_TARGETS_SETTING_KEY,
  type SettingKey,
  type TenantContext,
} from '@nexa/contracts';

/**
 * The owner's outbound allow-list (`security.outbound_private_targets`, R12 F2 item 4), held
 * in memory for the URL policy.
 *
 * The policy is consulted synchronously — on a URL as it is typed, and again inside the
 * socket factory on the address being dialled — so it cannot await a settings read. This
 * keeps the parsed list and refreshes it from the installation tenant's setting on a timer,
 * in every role, the way the installation keys are kept (`resolveInstallationTenant`).
 *
 * FAIL CLOSED: before the first successful read, and while the setting cannot be read, the
 * list is what it last was — initially empty, which allows nothing beyond the defaults.
 */
export interface OutboundAllowListSource {
  /** The installation tenant's value of the setting, or null when there is no tenant. */
  read(): Promise<string | null>;
}

export class OutboundAllowList {
  private entries: readonly string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly source: OutboundAllowListSource,
    private readonly logger: { warn(context: Record<string, unknown>, message: string): void },
  ) {}

  /** The entries the policy re-opens, as last read. */
  current(): readonly string[] {
    return this.entries;
  }

  async refresh(): Promise<void> {
    const value = await this.source.read();
    this.entries = parseOutboundAllowList(value ?? '');
  }

  /** A refresh that logs instead of throwing: a timer tick must not crash the role. */
  async refreshQuietly(): Promise<void> {
    try {
      await this.refresh();
    } catch (error) {
      this.logger.warn(
        { err: String(error) },
        'outbound allow-list not refreshed; keeping the last one',
      );
    }
  }

  start(intervalMs: number): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.refreshQuietly(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export function parseOutboundAllowList(value: string): readonly string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/** The source the container composes: the setting, read on the installation tenant. */
export function settingAllowListSource(deps: {
  readonly installationTenant: () => TenantContext | null;
  readonly valueOf: (scope: TenantContext, key: SettingKey) => Promise<unknown>;
}): OutboundAllowListSource {
  return {
    async read() {
      const scope = deps.installationTenant();
      if (scope === null) return null;
      const value = await deps.valueOf(scope, OUTBOUND_PRIVATE_TARGETS_SETTING_KEY as SettingKey);
      return typeof value === 'string' ? value : null;
    },
  };
}
