import {
  DEFAULT_PANEL_QR_KIND,
  SINGBOX_INTERVAL_DEFAULT_MINUTES,
  type PanelQrKind,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelRepository } from './ports.js';

/**
 * R11 A4: whether a panel is set to «فقط فایل، بدون لینک ساب» — its services' subscription
 * link is never shown to a customer.
 *
 * ONE narrow reader, asked by every place that would otherwise show a link (the delivery
 * card and the link change, «سرویس‌های من», the mini app). Narrow for the reason
 * `PanelPolicyGate` is: those callers hold no way to write the setting.
 */
export interface PanelFilesOnlyGate {
  isFilesOnly(scope: TenantContext, panelId: string, tx?: unknown): Promise<boolean>;
}

export class PanelFilesOnlyReader implements PanelFilesOnlyGate {
  constructor(private readonly panels: Pick<PanelRepository, 'find'>) {}

  /**
   * A panel that cannot be read is read as files only. This is a RESTRICTION on what a
   * customer is shown, so the safe reading of "unknown" is the strict one: a link that is
   * withheld is asked for again from support, a link that leaks cannot be taken back.
   */
  async isFilesOnly(scope: TenantContext, panelId: string, tx?: unknown): Promise<boolean> {
    const view = await this.panels.find(scope, panelId, tx as TransactionScope | undefined);
    return view === null ? true : view.panel.filesOnlyDelivery;
  }
}

/**
 * R11 A4, «نوع بارکد»: which QR a panel's customers are shown, and the sing-box refresh
 * interval in minutes. Read by delivery and the mini app; `qrPayloads` turns it into the QRs.
 */
export interface PanelQrOptionsGate {
  qrOptionsOf(
    scope: TenantContext,
    panelId: string,
    tx?: unknown,
  ): Promise<{ readonly kind: PanelQrKind; readonly intervalMinutes: number }>;
}

export class PanelQrOptionsReader implements PanelQrOptionsGate {
  constructor(private readonly panels: Pick<PanelRepository, 'find'>) {}

  /** A panel that cannot be read draws the plain link QR, which is what every panel drew. */
  async qrOptionsOf(scope: TenantContext, panelId: string, tx?: unknown) {
    const view = await this.panels.find(scope, panelId, tx as TransactionScope | undefined);
    return view === null
      ? { kind: DEFAULT_PANEL_QR_KIND, intervalMinutes: SINGBOX_INTERVAL_DEFAULT_MINUTES }
      : { kind: view.panel.qrKind, intervalMinutes: view.panel.singboxIntervalMinutes };
  }
}
