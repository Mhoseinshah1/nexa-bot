import {
  formatPersianChange,
  formatPersianInteger,
  formatPersianPercent,
  money,
  toPersianDigits,
  type CurrencyCode,
  type OpsLogButton,
  type TemplateKey,
  type TemplateValue,
} from '@nexa/contracts';
import { formatMoneyText, type Built } from './presenters.js';
import type { OpsLogWords } from './ports.js';

/**
 * Round 4 PR-D — the nightly reports (L27, L28, L29 and the cleanup line L30).
 *
 * Every number here is read from the LEDGER and the ORDERS over one half-open Tehran day
 * `[start, end)` that the time resolver produced (`docs/conventions.md`: no module computes
 * its own date range). Nothing is carried in memory between ticks and nothing is estimated:
 * a figure that cannot be read is absent from the message, never zero and never NaN.
 *
 * Definitions, stated once because a report is only as honest as its words:
 *
 *  - an order COUNTS on the day it was settled (`settled_at`), whatever happened to it
 *    afterwards — a refund is a second movement and is its own deduction line below;
 *  - SALES are gross: new purchases, renewals, extra traffic and extra time together, so the
 *    summary's figure and the financial report's «ناخالص» are the same number;
 *  - NET is gross less refunds, referral commissions and top-up gifts: refunds are the refunds
 *    COMPLETED in the day on every channel (wallet, bank, provider), counted once each from
 *    the refunds themselves; commissions are the day's commission credits less the day's
 *    commission reversals, never below zero; gifts are the day's top-up gift credits;
 *  - a trial is counted, never summed (it moved no money).
 */
export interface Tally {
  readonly count: number;
  readonly sum: bigint;
}

export interface PanelDayFact {
  readonly name: string;
  readonly orders: number;
  readonly sum: bigint;
  readonly soldBytes: bigint;
  /** The panel's stored health state (`HEALTHY`, …), or `UNCHECKED`. */
  readonly health: string;
  readonly used: number;
  readonly capacity: number | null;
}

export interface TopReseller {
  /** The reseller's numeric Telegram id: the «id» of the line. */
  readonly telegramId: string;
  readonly username: string | null;
  readonly name: string;
  readonly sum: bigint;
  /** Distinct orders of the day. */
  readonly count: number;
}

export const TOP_RESELLERS_MAX = 5;

export interface NightlyReportData {
  readonly day: Date;
  readonly currency: CurrencyCode;
  readonly newPurchases: Tally;
  readonly firstPurchases: number;
  readonly renewals: Tally;
  readonly traffic: Tally;
  readonly time: Tally;
  /** Paid orders that are none of the four (extra devices, a location change). */
  readonly other: Tally;
  /** The same categories on the previous day, for the change. */
  readonly previousGross: bigint;
  /** The Tehran hour of day (0-23) with the most sales, or null when nothing was sold. */
  readonly bestHour: number | null;
  readonly newCustomers: number;
  readonly activeCustomers: number;
  readonly trials: number;
  readonly activeServices: number;
  /** R9 C2: customers with at least one ACTIVE service when the report is made. */
  readonly customersWithService: number;
  /** R9 C2: every other NEXA customer; the two add up to all of them. */
  readonly customersWithoutService: number;
  readonly errors: number;
  readonly failedPayments: number;
  readonly openTickets: number;
  /** Unfinished payments that expired in the day: the automatic cleanup's one line (L30). */
  readonly expiredPayments: number;
  readonly refunds: Tally;
  readonly commissions: Tally;
  readonly giftSum: bigint;
  /** Confirmed order payments by method/gateway key. */
  readonly methods: readonly { readonly key: string; readonly sum: bigint }[];
  readonly panels: readonly PanelDayFact[];
  readonly resellers: {
    readonly active: number;
    readonly salesSum: bigint;
    readonly top: {
      readonly username: string | null;
      readonly name: string;
      readonly sum: bigint;
    } | null;
    /** R9 C2: the day's top resellers by sales, best first, at most five; empty when none sold. */
    readonly topList: readonly TopReseller[];
  };
}

const DASHBOARD: readonly OpsLogButton[] = [{ kind: 'DASHBOARD' }];

/** Gross sales: the four categories a customer pays for. */
export function grossOf(
  data: Pick<NightlyReportData, 'newPurchases' | 'renewals' | 'traffic' | 'time' | 'other'>,
): bigint {
  return (
    data.newPurchases.sum + data.renewals.sum + data.traffic.sum + data.time.sum + data.other.sum
  );
}

/** Net income: gross less the refunds, commissions and top-up gifts of the day. */
export function netOf(data: NightlyReportData): bigint {
  return grossOf(data) - data.refunds.sum - data.commissions.sum - data.giftSum;
}

/** `۱۸ تا ۱۹`, from a Tehran hour; null for none. */
export function bestHourText(hour: number | null): string | null {
  if (hour === null) return null;
  return toPersianDigits(`${String(hour)} تا ${String((hour + 1) % 24)}`);
}

/** The methods' shares of the day's confirmed order payments, largest first, by whole percent. */
export function methodSplit(
  methods: NightlyReportData['methods'],
  words: OpsLogWords,
): string | null {
  const total = methods.reduce((sum, method) => sum + method.sum, 0n);
  if (total <= 0n) return null;
  return [...methods]
    .filter((method) => method.sum > 0n)
    .sort((a, b) => (a.sum === b.sum ? a.key.localeCompare(b.key) : a.sum > b.sum ? -1 : 1))
    .map((method) => {
      const percent = formatPersianPercent(method.sum, total) ?? '';
      // Whole percents read better in a one-line split than one decimal.
      const whole = percent.replace(/٫[۰-۹]٪$/u, '٪');
      return `${words.reportMethod(method.key)} ${whole}`;
    })
    .join(' · ');
}

function gigabytes(bytes: bigint): string {
  const GIB = 1024n ** 3n;
  return formatPersianInteger((bytes + GIB / 2n) / GIB);
}

function panelsBlock(data: NightlyReportData, words: OpsLogWords): string {
  const sold = data.panels.filter((panel) => panel.orders > 0);
  if (sold.length === 0) return `🖥 ${words.reportNoActivity}`;
  return sold
    .map((panel) => {
      const head = `${panel.name}: ${formatPersianInteger(panel.orders)} ${words.reportUnit('orders')} · ${formatMoneyText(money(panel.sum, data.currency))} · ${gigabytes(panel.soldBytes)} ${words.reportUnit('gb')}`;
      const capacity =
        panel.capacity === null
          ? `${formatPersianInteger(panel.used)}`
          : `${formatPersianInteger(panel.used)} از ${formatPersianInteger(panel.capacity)}`;
      return `${head}\n   سلامت: ${words.reportHealth(panel.health)} · ظرفیت: ${capacity}`;
    })
    .join('\n');
}

function resellersBlock(data: NightlyReportData, words: OpsLogWords): string {
  const { resellers } = data;
  if (resellers.active === 0 && resellers.salesSum === 0n) {
    return `🧑‍💼 ${words.reportResellers}: ${words.reportNoActivity}`;
  }
  const head = `🧑‍💼 ${words.reportResellers}: ${formatPersianInteger(resellers.active)} فعال · فروش ${formatMoneyText(money(resellers.salesSum, data.currency))}`;
  if (resellers.top === null) return head;
  const who = resellers.top.username === null ? resellers.top.name : `@${resellers.top.username}`;
  return `${head}\n   برترین: ${who} — ${formatMoneyText(money(resellers.top.sum, data.currency))}`;
}

/**
 * R9 C2: the day's top resellers — a heading and up to five lines, `۱. @user · 123 · ۵۰٬۰۰۰ تومان
 * · ۳ سفارش` — or null when no reseller sold, so the block is left out of the message.
 */
export function topResellersBlock(data: NightlyReportData, words: OpsLogWords): string | null {
  const top = data.resellers.topList.slice(0, TOP_RESELLERS_MAX);
  if (top.length === 0) return null;
  const lines = top.map((reseller, index) => {
    const who = reseller.username === null ? reseller.name : `@${reseller.username}`;
    return `${formatPersianInteger(index + 1)}. ${who} · ${reseller.telegramId} · ${formatMoneyText(money(reseller.sum, data.currency))} · ${formatPersianInteger(reseller.count)} ${words.reportUnit('orders')}`;
  });
  return `${words.reportTopResellers}\n${lines.join('\n')}`;
}

/** The three nightly messages, from one day's data. */
export function nightlyReports(data: NightlyReportData, words: OpsLogWords): readonly Built[] {
  const gross = grossOf(data);
  const net = netOf(data);

  const summary: Record<string, TemplateValue> = {
    day: data.day,
    sales: money(gross, data.currency),
    newPurchases: data.newPurchases.count,
    firstPurchases: data.firstPurchases,
    renewals: data.renewals.count,
    newCustomers: data.newCustomers,
    activeCustomers: data.activeCustomers,
    customersWithService: data.customersWithService,
    customersWithoutService: data.customersWithoutService,
    trials: data.trials,
    activeServices: data.activeServices,
    errors: data.errors,
    failedPayments: data.failedPayments,
    openTickets: data.openTickets,
  };
  const change = formatPersianChange(gross, data.previousGross);
  // The report is of a COMPLETED day, posted the morning after; it is compared with the
  // day before IT, which is no longer "yesterday" to the reader.
  if (change !== null) summary['salesChange'] = `(${change} نسبت به روز قبل)`;
  const hour = bestHourText(data.bestHour);
  if (hour !== null) summary['bestHour'] = hour;
  // L30: the automatic cleanup is never a message of its own, only this line.
  if (data.expiredPayments > 0) {
    summary['cleanup'] = words.cleanupLine(formatPersianInteger(data.expiredPayments));
  }

  const financial: Record<string, TemplateValue> = {
    day: data.day,
    newOrdersSum: money(data.newPurchases.sum, data.currency),
    renewalsSum: money(data.renewals.sum, data.currency),
    trafficCount: data.traffic.count,
    trafficSum: money(data.traffic.sum, data.currency),
    timeCount: data.time.count,
    timeSum: money(data.time.sum, data.currency),
    gross: money(gross, data.currency),
    refundsCount: data.refunds.count,
    refundsSum: money(data.refunds.sum, data.currency),
    commissionCount: data.commissions.count,
    commissionSum: money(data.commissions.sum, data.currency),
    giftSum: money(data.giftSum, data.currency),
    net: money(net, data.currency),
  };
  if (data.other.count > 0) {
    financial['otherCount'] = data.other.count;
    financial['otherSum'] = money(data.other.sum, data.currency);
  }
  const split = methodSplit(data.methods, words);
  if (split !== null) financial['methods'] = split;

  const panels: Record<string, TemplateValue> = {
    day: data.day,
    panelsBlock: panelsBlock(data, words),
    resellersBlock: resellersBlock(data, words),
  };
  const topBlock = topResellersBlock(data, words);
  if (topBlock !== null) panels['topResellers'] = topBlock;

  return [
    {
      logType: 'REPORT_SUMMARY',
      templateKey: 'ops.log.report_summary' as TemplateKey,
      values: summary,
      buttons: DASHBOARD,
    },
    {
      logType: 'REPORT_FINANCIAL',
      templateKey: 'ops.log.report_financial' as TemplateKey,
      values: financial,
      buttons: [],
    },
    {
      logType: 'REPORT_PANELS',
      templateKey: 'ops.log.report_panels' as TemplateKey,
      values: panels,
      buttons: [],
    },
  ];
}
