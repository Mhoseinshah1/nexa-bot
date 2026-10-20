import {
  CUSTOMER_NOTIFICATION_KIND_NAMES_FA,
  OPS_LOG_WORDS_FA as W,
  operationalEventLabelFa,
} from '@nexa/i18n';
import { toPersianDigits } from '@nexa/contracts';
import type { OpsLogWords } from '../application/ports.js';

const pick = <T extends Record<string, string>>(table: T, key: string, fallback: string): string =>
  Object.prototype.hasOwnProperty.call(table, key) ? (table[key] as string) : fallback;

/**
 * The Persian words the log builders use, bound from the shared catalogue
 * (`OPS_LOG_WORDS_FA`). Application code reaches them through the `OpsLogWords` port only.
 *
 * Every lookup has a fallback that is a Persian word too — never the raw English enum the
 * owner asked to be rid of, and never a throw: an unfamiliar code (a later release's) renders
 * as «نامشخص»-style text and the message still goes out.
 */
export const i18nOpsLogWords: OpsLogWords = {
  noName: W.noName,
  noUsername: W.noUsername,
  noTelegram: W.noTelegram,
  none: W.none,
  methodName(method, gatewayProvider) {
    if (method === 'GATEWAY' && gatewayProvider !== null) return this.gatewayName(gatewayProvider);
    return pick(W.paymentMethods, method, W.paymentMethods.GATEWAY);
  },
  gatewayName(provider) {
    if (provider === null) return W.paymentMethods.GATEWAY;
    return pick(W.gateways, provider, W.paymentMethods.GATEWAY);
  },
  evidenceName: (kind) =>
    kind === null ? W.none : pick(W.evidence, kind, W.evidence.GATEWAY_INQUIRY),
  paymentFailure: (cause) => pick(W.paymentFailure, cause, W.paymentFailure.GATEWAY_FAILED),
  refundChannel: (channel) => pick(W.refundChannels, channel, W.refundChannels.PROVIDER),
  refundFailure: (cause) => pick(W.refundFailure, cause, W.refundFailure.OPERATOR_FAILED),
  refundRequestOutcome: (outcome) =>
    pick(W.refundRequestOutcomes, outcome, W.refundRequestOutcomes.FAILED),
  cryptoKindTitle: (topup) => (topup ? W.cryptoKinds.topup : W.cryptoKinds.order),
  walletAdjustHeading: (direction) => W.walletAdjust[direction],
  badges({ firstPurchase, reseller }) {
    const parts = [
      ...(firstPurchase ? [W.badges.firstPurchase] : []),
      ...(reseller ? [W.badges.reseller] : []),
    ];
    return parts.length === 0 ? null : `${W.badges.separator}${parts.join(W.badges.separator)}`;
  },
  failedOperation: (type) => pick(W.operations, type, W.operations.OTHER),
  operationState: (state) => W.operationStates[state],
  byWhom: (kind) => W.byWhom[kind],
  providerFailure: (kind) =>
    kind === null
      ? W.providerFailures.UNKNOWN
      : pick(W.providerFailures, kind, W.providerFailures.UNKNOWN),
  refundReason(reason, failureKind) {
    if (reason !== null && Object.prototype.hasOwnProperty.call(W.refundReasons, reason)) {
      return W.refundReasons[reason as keyof typeof W.refundReasons];
    }
    if (failureKind !== null) return pick(W.providerFailures, failureKind, W.refundReasons.DEFAULT);
    return W.refundReasons.DEFAULT;
  },
  paymentLinkCause: (kind) => pick(W.paymentLinkCauses, kind, W.paymentLinkCauses.UNKNOWN),
  retry: (kind) => (kind === 'YES' ? W.retry.yes : kind === 'NO' ? W.retry.no : W.retry.unknown),
  impact: (kind) => pick(W.impact, kind, W.impact.notRefunded),
  serviceState: (state) => pick(W.serviceStates, state, W.serviceStates.NO_DATA),
  notificationKindName: (kind) =>
    kind === null
      ? W.customerSend.unknownKind
      : pick(CUSTOMER_NOTIFICATION_KIND_NAMES_FA, kind, W.customerSend.unknownKind),
  customerSend: {
    cause: (reason) => pick(W.customerSend.causes, reason, W.customerSend.causes.REFUSED),
    kindLabel: W.customerSend.kindLabel,
    customersLabel: W.customerSend.customersLabel,
  },
  reminderHeading: (kind) => pick(W.reminderHeadings, kind, W.reminderHeadings.USAGE_FIRST),
  timeLeft(days) {
    if (days === null) return W.time.unlimited;
    if (days <= 0) return W.time.expired;
    return toPersianDigits(`${String(days)} ${W.time.daysLeft}`);
  },
  panelSalesStopped: (stopped) => (stopped ? W.panel.salesStopped : W.panel.salesContinue),
  downtime(minutes) {
    const total = Math.max(0, Math.round(minutes));
    if (total < 60) return toPersianDigits(`${String(total)} ${W.panel.downFor.minutes}`);
    const hours = Math.floor(total / 60);
    const rest = total % 60;
    return toPersianDigits(
      rest === 0
        ? `${String(hours)} ${W.panel.downFor.hours}`
        : `${String(hours)} ${W.panel.downFor.hours} ${W.panel.downFor.and} ${String(rest)} ${W.panel.downFor.minutes}`,
    );
  },
  block: (kind) => W.block[kind],
  adminHeading: (kind) => W.admin[kind],
  noRole: W.admin.noRole,
  system: W.admin.system,
  resellerHeading: (change) => pick(W.reseller, change, W.reseller.TIER_CHANGED),
  resellerOrdinary: W.reseller.ordinary,
  stormHeading: W.storm.heading,
  // A code the map does not know is still not shown raw as the title: the code is the
  // technical line beneath it.
  eventTitle: (code) => operationalEventLabelFa(code) ?? W.unknownEvent,
  severity: (klass) =>
    ({
      SECURITY: '🛡 امنیتی',
      CRITICAL: '🔴 بحرانی',
      ERROR: '🚨 خطا',
      WARN: '⚠️ هشدار',
      INFO: 'ℹ️ اطلاع',
    })[klass] ?? '⚠️ هشدار',
  cleanupLine: (countText) => W.report.cleanup(countText),
  reportHealth: (state) => pick(W.report.health, state, W.report.health.UNCHECKED),
  reportMethod: (key) => pick(W.report.methods, key, key),
  reportUnit: (kind) => (kind === 'gb' ? W.report.gb : W.report.orders),
  reportNoActivity: W.report.noActivity,
  reportResellers: W.report.resellerLine,
};
