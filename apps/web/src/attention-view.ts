import {
  COUNTER_CAP,
  CUSTOMER_WORKSPACE_COUNT_CAP,
  type CustomerWorkspaceResponse,
  type NavCountersResponse,
  type PaymentAttentionResponse,
  type SystemDiagnosticsResponse,
} from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';

/**
 * What waits for a person, as a list of rows that each say how many and where they are
 * handled (roadmap B6 on the dashboard, B5 on Customer 360).
 *
 * Pure, so a test can hold the rules rather than the pixels:
 *
 *   - every count is a SERVER total — a sidebar counter, a diagnostics count, a payment
 *     queue count or a workspace count — never a length of a page of rows (lead D2);
 *   - a count the server withheld (`null`: the viewer may not open the page it links to)
 *     or a source that was not asked is no row at all, never a zero;
 *   - a zero is no row either: the list is what to act on, and "0" is noise;
 *   - a capped count (`COUNTER_CAP`) is a floor, and says so;
 *   - every row links to the page that ACTS on it, filtered to what was counted where that
 *     page can filter (the predicate behind the count is the page's own filter).
 *
 * The order is urgency, fixed, so the loudest thing is always first: a lost outcome or a
 * stuck job before money waiting on an operator, before a customer waiting on support.
 */
export type AttentionTone = 'danger' | 'warn' | 'info';

export interface AttentionItem {
  readonly key: string;
  readonly label: WebKey;
  readonly count: number;
  /** The count reached its cap: "this many or more". */
  readonly atLeast: boolean;
  readonly tone: AttentionTone;
  readonly href: string;
}

export interface AttentionSources {
  /** `GET /nav-counters`: each counter null unless the viewer holds its page's permission. */
  readonly counters?: NavCountersResponse['counters'] | undefined;
  /** `GET /system/diagnostics` (`opslog.view`): asked only when held. */
  readonly diagnostics?: SystemDiagnosticsResponse | undefined;
  /** `GET /payment-operations/attention` (`payments.view`): asked only when held. */
  readonly payments?: PaymentAttentionResponse | undefined;
}

const DIAGNOSTICS_HREF = '/system?section=diagnostics';

/** The dashboard's attention queue (B6). */
export function dashboardAttentionItems(sources: AttentionSources): AttentionItem[] {
  const items: AttentionItem[] = [];
  const add = (
    key: string,
    label: WebKey,
    count: number | null | undefined,
    tone: AttentionTone,
    href: string,
    cap: number | null,
  ) => {
    if (count === null || count === undefined || count <= 0) return;
    items.push({ key, label, count, atLeast: cap !== null && count >= cap, tone, href });
  };
  const c = sources.counters;
  const d = sources.diagnostics;
  const p = sources.payments;

  // Stalled work (opslog.view). The four diagnostics reasons are disjoint (one CASE), so a
  // sum of two of them is an exact count of operations, never a double count.
  if (d !== undefined) {
    const counts = d.provisioning.counts;
    add(
      'stuckOperations',
      'web.dash_attn_stuck_operations',
      counts.LEASE_EXPIRED + counts.UNANNOUNCED,
      'danger',
      DIAGNOSTICS_HREF,
      null,
    );
    add(
      'unknownOperations',
      'web.dash_attn_unknown_operations',
      counts.UNKNOWN_OUTCOME,
      'danger',
      DIAGNOSTICS_HREF,
      null,
    );
    add(
      'outboxExhausted',
      'web.dash_attn_outbox_exhausted',
      d.outbox.exhausted,
      'danger',
      DIAGNOSTICS_HREF,
      null,
    );
  }
  add(
    'unreconciledServices',
    'web.dash_attn_unreconciled',
    c?.unreconciledServices,
    'danger',
    '/services?state=UNRECONCILED',
    COUNTER_CAP,
  );
  add(
    'unhealthyPanels',
    'web.dash_attn_panels',
    c?.unhealthyPanels,
    'danger',
    '/panel-health',
    COUNTER_CAP,
  );
  // Money waiting on an operator: an UNKNOWN has no outcome until reconciled; the
  // reconcilable ones are the UNKNOWNs whose recorded evidence already decides them.
  add(
    'paymentsUnknown',
    'web.dash_attn_payments_unknown',
    c?.paymentsUnknown,
    'warn',
    '/payments?queue=UNKNOWN',
    COUNTER_CAP,
  );
  add(
    'paymentsReconcilable',
    'web.dash_attn_payments_reconcilable',
    p?.totals.NEEDS_RECONCILIATION,
    'warn',
    '/payments?queue=NEEDS_RECONCILIATION',
    null,
  );
  add(
    'refundRequests',
    'web.dash_attn_refund_requests',
    c?.refundRequestsAwaiting,
    'warn',
    '/services',
    COUNTER_CAP,
  );
  // People waiting on support.
  add(
    'businessHandoffs',
    'web.dash_attn_handoffs',
    c?.businessHandoffs,
    'warn',
    '/business-chats?state=HANDOFF_REQUIRED',
    COUNTER_CAP,
  );
  add(
    'ticketsAwaitingSupport',
    'web.dash_attn_tickets',
    c?.ticketsAwaitingSupport,
    'info',
    // Review N1: the list filtered by the SAME predicate the count uses.
    '/tickets?awaiting=support',
    COUNTER_CAP,
  );
  add(
    'openConditions',
    'web.dash_attn_conditions',
    c?.openConditions,
    'warn',
    '/alerts',
    COUNTER_CAP,
  );
  return items;
}

/** Customer 360's attention strip (B5), from the workspace summary. */
export function customerAttentionItems(
  customerId: string,
  workspace: CustomerWorkspaceResponse,
): AttentionItem[] {
  const q = encodeURIComponent(customerId);
  const items: AttentionItem[] = [];
  const add = (
    key: string,
    label: WebKey,
    count: number | null | undefined,
    tone: AttentionTone,
    href: string,
  ) => {
    if (count === null || count === undefined || count <= 0) return;
    items.push({
      key,
      label,
      count,
      atLeast: count >= CUSTOMER_WORKSPACE_COUNT_CAP,
      tone,
      href,
    });
  };
  add(
    'unreconciledServices',
    'web.c360ws_services_unreconciled',
    workspace.services?.unreconciled,
    'danger',
    `/services?q=${q}&state=UNRECONCILED`,
  );
  add(
    'paymentsUnknown',
    'web.c360ws_payments_unknown',
    workspace.payments?.unknown,
    'warn',
    `/payments?q=${q}&queue=UNKNOWN`,
  );
  // Review N2: one handoff opens that conversation; more open the inbox filtered to the
  // state (it has no customer filter, and it orders HANDOFF_REQUIRED first).
  const handoffs = workspace.businessHandoffs;
  const conversation = workspace.businessHandoffConversationId;
  add(
    'businessHandoffs',
    'web.c360ws_handoffs',
    handoffs,
    'warn',
    handoffs === 1 && conversation !== null
      ? `/business-chats/${encodeURIComponent(conversation)}`
      : '/business-chats?state=HANDOFF_REQUIRED',
  );
  add(
    'ticketsAwaitingSupport',
    'web.c360ws_tickets_awaiting',
    workspace.tickets?.awaitingSupport,
    'info',
    `/tickets?customer=${q}&awaiting=support`,
  );
  return items;
}

/*
 * The four sections that COUNT something for the attention card. `orders` adds no row (it is
 * the latest list), so withholding it changes nothing here and is never reported here.
 */
type CountingSection = 'tickets' | 'businessHandoffs' | 'payments' | 'services';
const COUNTING_SECTIONS: readonly CountingSection[] = [
  'tickets',
  'businessHandoffs',
  'payments',
  'services',
];

/** Whether the workspace withheld any COUNTING section from this viewer. */
export function workspaceWithheld(workspace: CustomerWorkspaceResponse): boolean {
  return COUNTING_SECTIONS.some((section) => workspace[section] === null);
}
