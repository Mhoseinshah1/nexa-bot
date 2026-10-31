import {
  JOB_LOOP_RECOVERED_CODE,
  JOB_LOOP_STALLED_CODE,
  PROCESS_RESTART_STORM_CODE,
  PROCESS_RESTART_STORM_ENDED_CODE,
  PAYMENT_LINK_FAILURE_KINDS,
  PAYMENT_LINK_CREATE_FAILED_CODE,
  money,
  opsErrorClassOf,
  toPersianDigits,
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
import { STARS_CHARGE_REFUNDED_CODE } from '../../payments/application/telegram-stars-payment.service.js';
import { identityOf, serviceUsernameValue, stalledReport, technicalLine } from './presenters.js';
import {
  PROVISIONING_DELIVERED_CODE,
  PROVISIONING_STALLED_CODE,
  REFUND_ANSWERS,
} from '../../provisioning/application/provisioner.service.js';
import type {
  OpsEventPresenter,
  PresentedOpsEvent,
} from '../../../control/notifications/application/ports.js';

const GATEWAY_CREATE_UNKNOWN = 'payments.gateway_create_unknown';
/** `CUSTOMER_SEND_FAILED_CODE` of the messenger, which the application layer does not import. */
const CUSTOMER_SEND_FAILED = 'telegram.customer_send_failed';
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

  /**
   * An event another message already answers is not posted a second time (R5C-2 C1):
   *
   * - `provisioning.stalled` that a refund answered — the refund's own report says so;
   * - `provisioning.stalled` whose outcome is UNKNOWN (`UNRECONCILED`) — `ProvisioningOutcomeUnknown`
   *   already posted L23/L24 for it;
   * - `provisioning.delivered` — the INFO line of a service the panel now holds. The purchase
   *   is the services topic's «🛒 خرید جدید» (L10/L11, from `ServiceProvisioned`), so a second
   *   generic English line under it was a duplicate. Since R10 B5 a service ADOPTED after a
   *   lost create answer emits `ServiceProvisioned` too (it was this installation's create),
   *   so its line is withheld as well; its context still says `adopted`.
   *
   * The event is still RECORDED (it closes the stalled condition); only the message is withheld.
   */
  suppresses(input: OperationalEventInput): boolean {
    if (input.code === PROVISIONING_STALLED_CODE) {
      return (
        input.context?.['answeredBy'] === REFUND_ANSWERS ||
        input.context?.['reason'] === 'UNRECONCILED'
      );
    }
    return input.code === PROVISIONING_DELIVERED_CODE;
  }

  title(code: string): string {
    return this.deps.words.eventTitle(code);
  }

  messageOf(code: string): string | null {
    return this.deps.words.eventMessage?.(code) ?? null;
  }

  severity(klass: string): string {
    return this.deps.words.severity(klass);
  }

  /**
   * R11 A7: an event whose context names a service (`serviceId`, as every service event's does)
   * shows that service's panel account name on the generic layout too — the id itself is never
   * printed. Null for an event about no service, or about one that is gone.
   */
  async serviceUsernameOf(
    scope: TenantContext,
    input: OperationalEventInput,
    tx: unknown,
  ): Promise<string | null> {
    const serviceId = safeIdentifier(input.context?.['serviceId']);
    if (serviceId === null) {
      /*
       * R12 F1 item 6: a refunded Stars charge names the ORDER it paid for, which is what is
       * known when it is recorded; the service's panel account is read through it (a purchase's
       * service or reservation, a renewal's service). Only for that code: no other event that
       * carries an order id grows a line it did not have.
       */
      const orderId =
        input.code === STARS_CHARGE_REFUNDED_CODE
          ? safeIdentifier(input.context?.['orderId'])
          : null;
      if (orderId === null) return null;
      return serviceUsernameValue(
        await this.deps.facts.serviceUsernameOfOrder(scope, orderId, tx as TransactionScope),
      );
    }
    const service = await this.deps.facts.service(scope, serviceId, tx as TransactionScope);
    return serviceUsernameValue(service?.providerUsername);
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
    if (recorded.code === PROVISIONING_STALLED_CODE) {
      return (
        (await this.provisioningReport(scope, input, recorded, scoped)) ??
        this.provisioningStalled(input, recorded)
      );
    }
    if (recorded.code === CUSTOMER_SEND_FAILED) {
      return this.customerSendFailed(scope, input, recorded, scoped);
    }
    if (recorded.code === JOB_LOOP_STALLED_CODE || recorded.code === JOB_LOOP_RECOVERED_CODE) {
      return this.loopStall(input, recorded);
    }
    if (
      recorded.code === PROCESS_RESTART_STORM_CODE ||
      recorded.code === PROCESS_RESTART_STORM_ENDED_CODE
    ) {
      return this.restartStorm(input, recorded);
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
      // R11 A7: a renewal or add-on order names the service's panel account; a new purchase
      // that never settled has no service yet, so the line is dropped.
      const serviceUsername = serviceUsernameValue(
        await facts.serviceUsernameOfOrder(scope, orderId, tx),
      );
      if (serviceUsername !== null) values['serviceUsername'] = serviceUsername;
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

  // --- v0.8.2 hotfix: the watchdog's messages ----------------------------------------------

  /**
   * `job.loop_stalled` / `job.loop_recovered` in Persian from the first line to the last.
   * The recorded message is an English log line and the generic layout printed it, with
   * `kind` / `processRole` / `state` beneath. The loop and the role are named from the event's
   * context through the shared label tables; the loop's own key stays on the one technical
   * line, as every other event's code does. A context that does not name a loop keeps the
   * generic layout.
   */
  private loopStall(
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
  ): PresentedOpsEvent | null {
    const { words } = this.deps;
    const loop = input.context?.['kind'];
    const role = input.context?.['processRole'];
    if (typeof loop !== 'string' || !/^[a-z0-9-]{1,64}$/.test(loop)) return null;
    const heading = `${words.eventTitle(recorded.code)} — ${words.loopStall.loopName(loop)}`;
    return {
      templateKey: 'ops.notification.operational_event' as TemplateKey,
      values: {
        severity: words.severity(opsErrorClassOf(recorded.code, recorded.severity)),
        heading,
        technical: technicalLine(recorded.code, loop),
        code: recorded.code,
        message: heading,
        occurrences: recorded.occurrenceCount,
        firstSeenAt: recorded.firstSeenAt,
        lastSeenAt: recorded.lastSeenAt,
        ...(typeof role === 'string'
          ? { details: `${words.loopStall.roleLabel}: ${words.loopStall.roleName(role)}` }
          : {}),
      },
    };
  }

  // --- R11 A3: a role that keeps restarting -------------------------------------------

  /**
   * `process.restart_storm` / `process.restart_storm_ended`: «سرویس … پی‌درپی ری‌استارت
   * می‌شود» with the role named in Persian, the count and the window beneath it. The role
   * and the numbers come from the event's context; a context that does not name a role (a
   * hand-recorded row) keeps the generic layout, as the loop-stall message does.
   */
  private restartStorm(
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
  ): PresentedOpsEvent | null {
    const { words } = this.deps;
    const role = input.context?.['processRole'];
    if (typeof role !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(role)) return null;
    const roleName = words.loopStall.roleName(role);
    const ended = recorded.code === PROCESS_RESTART_STORM_ENDED_CODE;
    const restarts = input.context?.['restarts'];
    const windowMinutes = input.context?.['windowMinutes'];
    const heading = ended
      ? words.restartStorm.endedHeading(roleName)
      : words.restartStorm.heading(roleName);
    const counted =
      !ended &&
      typeof restarts === 'number' &&
      Number.isInteger(restarts) &&
      typeof windowMinutes === 'number' &&
      Number.isInteger(windowMinutes);
    return {
      templateKey: 'ops.notification.operational_event' as TemplateKey,
      values: {
        severity: words.severity(opsErrorClassOf(recorded.code, recorded.severity)),
        heading,
        technical: technicalLine(recorded.code, role),
        code: recorded.code,
        message: heading,
        occurrences: recorded.occurrenceCount,
        firstSeenAt: recorded.firstSeenAt,
        lastSeenAt: recorded.lastSeenAt,
        details: [
          `${words.loopStall.roleLabel}: ${roleName}`,
          ...(counted ? [words.restartStorm.detail(String(restarts), String(windowMinutes))] : []),
        ].join('\n'),
      },
    };
  }

  // --- Round 5A item 1 ------------------------------------------------------------------

  /**
   * A customer message that did not go out, named by WHAT it was: the Persian title of the
   * event, then the Persian name of the notification kind, then the number of customers who
   * still have one of that kind undelivered. It rides the generic template (no new key), with
   * the same fields the generic layout fills, so the heading is Persian and the code is only
   * the short technical line beneath.
   *
   * A condition is one row per bot, so this is the kind that OPENED it; a later refusal of
   * another kind on the same bot is counted on the row and announced when the condition
   * reopens. The number is read when the message is made.
   */
  private async customerSendFailed(
    scope: TenantContext,
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
    tx: TransactionScope,
  ): Promise<PresentedOpsEvent | null> {
    const { words, facts } = this.deps;
    const context = input.context;
    if (context === undefined) return null;
    const kind =
      typeof context['notificationKind'] === 'string' ? context['notificationKind'] : null;
    const bot = safeIdentifier(context['botInstanceId']);
    const reason = typeof context['reason'] === 'string' ? context['reason'] : 'REFUSED';
    const kindName = words.notificationKindName(kind);
    const customers =
      kind === null || bot === null
        ? null
        : await facts.undeliveredCustomerCount(scope, bot, kind, tx);
    const rawCode = context['errorCode'];
    const code = typeof rawCode === 'string' ? sanitizedErrorCode(rawCode) : null;
    const details = [
      `${words.customerSend.kindLabel}: ${kindName}`,
      ...(customers === null || customers === 0
        ? []
        : [`${words.customerSend.customersLabel}: ${toPersianDigits(String(customers))}`]),
    ].join('\n');
    return {
      templateKey: 'ops.notification.operational_event' as TemplateKey,
      values: {
        severity: words.severity(opsErrorClassOf(recorded.code, recorded.severity)),
        heading: `${words.eventTitle(recorded.code)} — ${kindName}`,
        technical: technicalLine(words.customerSend.cause(reason), code),
        code: recorded.code,
        message: words.customerSend.cause(reason),
        occurrences: recorded.occurrenceCount,
        firstSeenAt: recorded.firstSeenAt,
        lastSeenAt: recorded.lastSeenAt,
        details,
      },
    };
  }

  /**
   * R5C-2 C1: `provisioning.stalled` as the error report it is. A paid service that could not
   * be created is L23 (customer, product, panel, amount, cause, technical line, what happened
   * to the customer, codes); any other operation is L24 under the R5A-2 title. Null when the
   * service, its customer or its order cannot be read, and the layout below is used instead.
   */
  private async provisioningReport(
    scope: TenantContext,
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
    tx: TransactionScope,
  ): Promise<PresentedOpsEvent | null> {
    const { facts, words } = this.deps;
    const serviceId = safeIdentifier(input.context?.['serviceId']);
    if (serviceId === null) return null;
    // R10 B5 (the v0.8.2-e rule): a stall is an operation THIS installation performed — the
    // import performs none — so a customer or a service the import wrote is no reason for the
    // generic layout. A PROVISION stall still reads its order's provenance below.
    const service = await facts.service(scope, serviceId, tx);
    if (service === null) return null;
    const customer = await facts.customer(scope, service.customerId, tx);
    if (customer === null) return null;
    // A stall that does not say which operation stalled is NOT a PROVISION: defaulting it
    // read the service's original order and reported its creation as failed, with that
    // order's amount. It keeps the generic layout (every producer now names its type).
    const rawType = input.context?.['operationType'];
    if (typeof rawType !== 'string') return null;
    const operationType = rawType;
    const reason = typeof input.context?.['reason'] === 'string' ? input.context['reason'] : null;
    const order =
      operationType === 'PROVISION' ? await facts.order(scope, service.orderId, tx) : null;
    if (operationType === 'PROVISION' && (order === null || order.source !== 'NEXA')) return null;
    const payment = order === null ? null : await facts.paymentOfOrder(scope, order.id, tx);
    const built = stalledReport({
      operationType,
      reason,
      service,
      order,
      customer,
      payment,
      at: recorded.lastSeenAt,
      words,
    });
    return {
      templateKey: built.templateKey,
      values: built.values,
      logType: built.logType,
      buttons: built.buttons,
    };
  }

  /**
   * R5A-2 item 6. `provisioning.stalled` is the code for every operation that stalls, but its
   * title says a service CREATE stalled. For an operation that is not a PROVISION the heading
   * names the real one, from the operation type in the event's context; the code is unchanged.
   * A context without a known non-PROVISION type answers null and keeps the generic layout.
   */
  private provisioningStalled(
    input: OperationalEventInput,
    recorded: RecordedOperationalEvent,
  ): PresentedOpsEvent | null {
    const { words } = this.deps;
    const type = input.context?.['operationType'];
    if (typeof type !== 'string' || type === 'PROVISION') return null;
    const heading = words.stalledOperationTitle(type);
    if (heading === null) return null;
    return {
      templateKey: 'ops.notification.operational_event' as TemplateKey,
      values: {
        severity: words.severity(opsErrorClassOf(recorded.code, recorded.severity)),
        heading,
        technical: technicalLine(recorded.code, type),
        code: recorded.code,
        message: heading,
        occurrences: recorded.occurrenceCount,
        firstSeenAt: recorded.firstSeenAt,
        lastSeenAt: recorded.lastSeenAt,
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
