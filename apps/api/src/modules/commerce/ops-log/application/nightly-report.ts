import {
  formatPersianChange,
  formatPersianInteger,
  formatPersianPercent,
  money,
  toPersianDigits,
  DATA_COMPACTION_CLASS_TABLES,
  DATA_COMPACTION_CLASSES,
  type CurrencyCode,
  type DataCompactionClass,
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
  readonly errors: number;
  readonly failedPayments: number;
  readonly openTickets: number;
  /** Unfinished payments that expired in the day: the automatic cleanup's one line (L30). */
  readonly expiredPayments: number;
  /**
   * Round 9 C3: the data compaction's passes of the day, summed per class — part of the same
   * cleanup line (L30), never a message of its own. Absent or null: nothing to say.
   */
  readonly compaction?: CompactionDaySummary | null;
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
  };
}

/**
 * What the data compaction did on a day: the rows its APPLY passes removed, per class; or, when
 * none removed anything, what the day's last DRY_RUN pass counted (`applied: false`) — the
 * owner's prompt that APPLY would act. Null when both are nothing.
 */
export interface CompactionDaySummary {
  readonly applied: boolean;
  readonly classes: Readonly<Record<DataCompactionClass, number>>;
}

/** One recorded pass, as the reader hands it over: its mode and rows per table. */
export interface CompactionDayRun {
  readonly mode: 'DRY_RUN' | 'APPLY';
  readonly counts: Readonly<Record<string, number>>;
}

function perClass(counts: Readonly<Record<string, number>>): Record<DataCompactionClass, number> {
  const out = {} as Record<DataCompactionClass, number>;
  for (const cls of DATA_COMPACTION_CLASSES) {
    out[cls] = DATA_COMPACTION_CLASS_TABLES[cls].reduce(
      (sum, table) => sum + Math.max(0, Number(counts[table] ?? 0)),
      0,
    );
  }
  return out;
}

function totalOfClasses(classes: Readonly<Record<DataCompactionClass, number>>): number {
  return DATA_COMPACTION_CLASSES.reduce((sum, cls) => sum + classes[cls], 0);
}

/** The day's passes, oldest first, folded into the one summary the line prints. */
export function summarizeCompactionDay(
  runs: readonly CompactionDayRun[],
): CompactionDaySummary | null {
  const applied = {} as Record<DataCompactionClass, number>;
  for (const cls of DATA_COMPACTION_CLASSES) applied[cls] = 0;
  let lastDry: Record<DataCompactionClass, number> | null = null;
  for (const run of runs) {
    const classes = perClass(run.counts);
    if (run.mode === 'APPLY') {
      for (const cls of DATA_COMPACTION_CLASSES) applied[cls] += classes[cls];
    } else {
      lastDry = classes;
    }
  }
  if (totalOfClasses(applied) > 0) return { applied: true, classes: applied };
  if (lastDry !== null && totalOfClasses(lastDry) > 0) return { applied: false, classes: lastDry };
  return null;
}

/** `اعلان‌های عملیات ۱۲۰ · …`, classes with nothing omitted; null for nothing at all. */
export function compactionLine(
  summary: CompactionDaySummary | null | undefined,
  words: OpsLogWords,
): string | null {
  if (summary === null || summary === undefined) return null;
  const parts = DATA_COMPACTION_CLASSES.filter((cls) => summary.classes[cls] > 0).map(
    (cls) => `${words.compactionClass(cls)} ${formatPersianInteger(summary.classes[cls])}`,
  );
  if (parts.length === 0) return null;
  return words.compactionLine(summary.applied, parts.join(' · '));
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
  // L30: the automatic cleanup is never a message of its own, only this line — the expired
  // payments and (Round 9 C3) the data compaction, each on its own row of the one value.
  const cleanup = [
    data.expiredPayments > 0 ? words.cleanupLine(formatPersianInteger(data.expiredPayments)) : null,
    compactionLine(data.compaction, words),
  ].filter((line): line is string => line !== null);
  if (cleanup.length > 0) summary['cleanup'] = cleanup.join('\n');

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
