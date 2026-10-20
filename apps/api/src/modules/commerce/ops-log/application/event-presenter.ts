import {
  PAYMENT_LINK_FAILURE_KINDS,
  PAYMENT_LINK_CREATE_FAILED_CODE,
  money,
  type CurrencyCode,
  type OperationalEventInput,
  type OpsLogButton,
  type RecordedOperationalEvent,
  type TemplateKey,
  type TemplateValue,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  safeHttpStatus,
  safeIdentifier,
  safeTelegramUserId,
  sanitizedErrorCode,
} from '../../../platform/opslog/application/error-events.js';
import type { OpsLogFacts, OpsLogWords } from './ports.js';
import { identityOf, technicalLine } from './presenters.js';
import type {
  OpsEventPresenter,
  PresentedOpsEvent,
} from '../../../control/notifications/application/ports.js';

const GATEWAY_CREATE_UNKNOWN = 'payments.gateway_create_unknown';
const PANEL_DOWN_PREFIX = 'panel.health.';
/** The `panel.health.*` codes that are not a panel going out of reach. */
const PANEL_NOT_DOWN = new Set([
  'panel.health.recovered',
  'panel.health.restored',
  'panel.health.retired',
  'panel.health.degraded',
]);

/**
 * Whether every occurrence of this code is a message of its own (Round 4 PR-D, global rule 5:
 * «every error is its own message»). The aggregation window still counts them on one row —
 * the notification centre keeps the live counter — but the group is told of each, because a
 * customer's failure is a customer's failure. The optional storm roll-up is the only thing
 * that merges them.
 */
export function everyOccurrenceIsAMessage(code: string): boolean {
  return code === PAYMENT_LINK_CREATE_FAILED_CODE || code === GATEWAY_CREATE_UNKNOWN;
}

/**
 * Lays out the operational events the owner reviewed (L22 and L25) from the event's own
 * context, and names the rest in Persian.
 *
 * The context is read through an allow-list of keys with their types re-checked — an
 * operational event is whatever its recorder put there, and the group is a chat that keeps
 * everything for ever. A context that does not have what a layout needs answers null and the
 * projector's generic layout is used: a presentation never makes an event unrenderable.
 */
export class OperationalEventPresenter implements OpsEventPresenter {
  constructor(
    private readonly deps: {
      readonly facts: OpsLogFacts;
      readonly words: OpsLogWords;
    },
  ) {}

  projectsEveryOccurrence(code: string): boolean {
    return everyOccurrenceIsAMessage(code);
  }

  title(code: string): string {
    return this.deps.words.eventTitle(code);
  }

  severity(klass: string): string {
    return this.deps.words.severity(klass);
  }

  async present(
    scope: TenantContext,
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
    tx: unknown,
  ): Promise<PresentedOpsEvent | null> {
    const scoped = tx as TransactionScope;
    if (everyOccurrenceIsAMessage(recorded.code)) {
      return this.paymentLink(scope, input, recorded, scoped);
    }
    if (recorded.code === 'panel.health.recovered') {
      return this.panelUp(scope, input, recorded, scoped);
    }
    if (recorded.code.startsWith(PANEL_DOWN_PREFIX) && !PANEL_NOT_DOWN.has(recorded.code)) {
      return this.panelDown(scope, input, recorded, scoped);
    }
    return null;
  }

  // --- L22 ------------------------------------------------------------------------------

  private async paymentLink(
    scope: TenantContext,
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
    tx: TransactionScope,
  ): Promise<PresentedOpsEvent | null> {
    const { words, facts } = this.deps;
    const context = input.context;
    if (context === undefined || context['phase'] !== 'PAYMENT_LINK_CREATE') return null;
    const kind = context['failureKind'];
    if (typeof kind !== 'string' || !(kind in PAYMENT_LINK_FAILURE_KINDS)) return null;
    const provider = safeIdentifier(context['provider'], 40);
    if (provider === null) return null;

    // Every value is re-read through the same allow-list the old layout used: an id against
    // the id alphabet, the Telegram id as digits, the error code through the redactor — a
    // context that somehow carried a link, a key or a card number has nowhere to put it.
    const customerId = safeIdentifier(context['customerId']);
    const customer = customerId === null ? null : await facts.customer(scope, customerId, tx);
    const who = identityOf(customer, words);
    const telegramId = customer?.telegramUserId ?? safeTelegramUserId(context['telegramUserId']);

    const unknown = context['classification'] === 'UNKNOWN';
    const retryable =
      typeof context['retryable'] === 'boolean'
        ? context['retryable']
        : PAYMENT_LINK_FAILURE_KINDS[kind as keyof typeof PAYMENT_LINK_FAILURE_KINDS].retryable;
    const status = safeHttpStatus(context['httpStatus']);
    const rawCode = context['errorCode'] ?? context['reason'];
    const code = typeof rawCode === 'string' ? sanitizedErrorCode(rawCode) : null;
    const technical = technicalLine(
      status === null ? null : `HTTP ${String(status)}`,
      code ?? kind,
    );
    const cause = words.paymentLinkCause(kind);

    const values: Record<string, TemplateValue> = {
      ...who,
      telegramId: telegramId ?? words.noTelegram,
      gateway: words.gatewayName(provider),
      cause,
      technical,
      retry: unknown ? words.retry('UNKNOWN') : words.retry(retryable ? 'YES' : 'NO'),
      impact: unknown ? words.impact('paymentLinkUnknown') : words.impact('paymentLinkNoCharge'),
      at: recorded.lastSeenAt,
    };
    const amountMinor = context['amountMinor'];
    const currency = context['currency'];
    if (
      typeof amountMinor === 'string' &&
      /^\d{1,30}$/.test(amountMinor) &&
      typeof currency === 'string'
    ) {
      values['amount'] = money(BigInt(amountMinor), currency as CurrencyCode);
    }
    const tracking = safeIdentifier(context['trackingCode'], 64);
    if (tracking !== null) values['reference'] = tracking;
    const invoice = safeIdentifier(context['providerInvoiceId']);
    if (invoice !== null) values['providerInvoiceId'] = invoice;
    const orderId = safeIdentifier(context['orderId']);
    if (orderId !== null) {
      const order = await facts.order(scope, orderId, tx);
      if (order?.code !== null && order?.code !== undefined) values['orderCode'] = order.code;
    }
    const buttons: OpsLogButton[] = [
      { kind: 'GATEWAY', ref: provider },
      ...(customerId === null ? [] : [{ kind: 'USER' as const, ref: customerId }]),
    ];
    return {
      templateKey: 'ops.notification.payment_link_failed' as TemplateKey,
      values,
      logType: 'ERROR_PAYMENT_LINK',
      buttons,
      storm: {
        key: `ERROR_PAYMENT_LINK:${provider}:${kind}`,
        customer: telegramId,
        rollup: { heading: words.stormHeading, cause, technical },
      },
    };
  }

  // --- L25 ------------------------------------------------------------------------------

  private async panelDown(
    scope: TenantContext,
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
    tx: TransactionScope,
  ): Promise<PresentedOpsEvent | null> {
    const { words, facts } = this.deps;
    const panelId =
      typeof input.context?.['panelId'] === 'string' ? input.context['panelId'] : null;
    if (panelId === null) return null;
    const name =
      (typeof input.context?.['panelName'] === 'string' ? input.context['panelName'] : null) ??
      (await facts.panelName(scope, panelId, tx));
    if (name === null) return null;
    return {
      templateKey: 'ops.log.panel_down' as TemplateKey,
      values: {
        panelName: name,
        cause: words.eventTitle(recorded.code),
        technical: technicalLine(recorded.code.slice(PANEL_DOWN_PREFIX.length).toUpperCase()),
        salesNote: words.panelSalesStopped(true),
        since: recorded.firstSeenAt,
      },
      logType: 'PANEL_STATE',
      buttons: [{ kind: 'PANEL', ref: panelId }],
    };
  }

  private async panelUp(
    scope: TenantContext,
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
    tx: TransactionScope,
  ): Promise<PresentedOpsEvent | null> {
    const { words, facts } = this.deps;
    const closed = await facts.conditionClosedBy(scope, recorded.id, tx);
    // A "recovered" with nothing it closed is the first successful check of a panel that was
    // never down: there is nothing to announce.
    if (closed === null) return null;
    const row = await this.panelOfRecovery(scope, input, tx);
    if (row === null) return null;
    const minutes = Math.max(
      0,
      Math.round((recorded.lastSeenAt.getTime() - closed.getTime()) / 60_000),
    );
    return {
      templateKey: 'ops.log.panel_up' as TemplateKey,
      values: { panelName: row.name, at: recorded.lastSeenAt, downtime: words.downtime(minutes) },
      logType: 'PANEL_STATE',
      buttons: [{ kind: 'PANEL', ref: row.id }],
    };
  }

  private async panelOfRecovery(
    scope: TenantContext,
    input: OperationalEventInput,
    tx: TransactionScope,
  ): Promise<{ readonly id: string; readonly name: string } | null> {
    // The recovery's dedupe key is `panel.health.recovered:<panel id>`.
    const key = input.dedupeKey ?? '';
    const panelId = key.startsWith('panel.health.recovered:')
      ? key.slice('panel.health.recovered:'.length)
      : null;
    if (panelId === null) return null;
    const name = await this.deps.facts.panelName(scope, panelId, tx);
    return name === null ? null : { id: panelId, name };
  }
}
