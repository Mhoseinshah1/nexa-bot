import type { LegacyHistoryRecordType } from '@nexa/contracts';
import { EXTRA_LIVE_STATE_FLAGS, LIVE_STATE_FLAGS } from './record-map.js';

/**
 * Mirza `.nxpkg` importer — what an archived history record shows a reader WITHOUT
 * `legacy.invoices.pii.view` (the legacy archives' personal-data key).
 *
 * An ALLOWLIST, per record type: only the paths named below survive, and each only if its
 * value has the shape its kind promises (a code, a decimal amount, a count, a flag, an
 * instant). Everything else — a Telegram id at any depth, a username, free text an admin or a
 * customer wrote, a `*.raw` source value, a fork's raw columns, an invoice or source key, and
 * any field the converter adds tomorrow — is DROPPED, and its path listed in `redacted`. A new
 * field reaches a non-PII reader only by being added here, deliberately.
 *
 * A reader WITH the key gets the record exactly as packaged; that page is audited by the read
 * service. This module never sees that path.
 */

/**
 * - `code`: a converter or Mirza vocabulary token (`SUCCEEDED`, `syn-a`, `mirza.x.v1`):
 *   starts with a letter, no spaces, and no run of six digits (never an id in disguise).
 * - `amount`: an integer as a decimal string (minor units, bytes) — never a JS number.
 * - `count`: a finite integer.
 * - `flag`: a boolean.
 * - `instant`: an ISO date-time (offset optional: the converter's local wall times) or Unix
 *   seconds within 2000..2100.
 * - `key`: the record's `legacy:` idempotency key, kept only when it is a plain token with no
 *   run of six digits (the converter embeds Telegram ids and invoice keys in some).
 * `null` passes every kind: an absent value says nothing about anyone.
 */
export type PublicFieldKind = 'code' | 'amount' | 'count' | 'flag' | 'instant' | 'key';

/** Dotted paths; `[]` is every array element, `*` any object key that is itself a `code`. */
type FieldList = Readonly<Record<string, PublicFieldKind>>;

const CODE = /^[A-Za-z][A-Za-z0-9_.+:/-]{0,159}$/;
const SIX_DIGITS = /\d{6,}/;
const KEY = /^legacy:[A-Za-z0-9_.+:/-]{1,504}$/;
const AMOUNT = /^-?\d{1,40}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?$/;
const UNIX_MIN = 946_684_800;
const UNIX_MAX = 4_102_444_800;

/** Every record: its identity, provenance table and the live-state flags (all false). */
const COMMON: FieldList = {
  record_type: 'code',
  schema: 'code',
  idempotency_key: 'key',
  source_table: 'code',
  'provenance.source_table': 'code',
  ...Object.fromEntries(
    [...LIVE_STATE_FLAGS, ...EXTRA_LIVE_STATE_FLAGS].map((flag) => [flag, 'flag' as const]),
  ),
};

/** `customer`/`owner`/… on agent, engagement and support records: decision and validity only. */
const person = (key: string): FieldList => ({
  [`${key}.decision`]: 'code',
  [`${key}.valid`]: 'flag',
});
/** `customer` on payment and wallet records. */
const relation = (key: string): FieldList => ({
  [`${key}.customer_decision`]: 'code',
  [`${key}.relation`]: 'code',
});
const money = (key: string, minor = 'amount_minor'): FieldList => ({
  [`${key}.${minor}`]: 'amount',
  [`${key}.currency`]: 'code',
});
const invoiceRelation: FieldList = {
  'invoice_relation.candidates': 'count',
  'invoice_relation.matched_by': 'code',
  'invoice_relation.reason': 'code',
  'invoice_relation.state': 'code',
};
const localTime = (key: string): FieldList => ({
  [`${key}.local`]: 'instant',
  [`${key}.parse_note`]: 'code',
  [`${key}.time_zone`]: 'code',
});
const agentOwned: FieldList = {
  ...person('owner'),
  owner_relation_basis: 'code',
  semantics: 'code',
};
const supportThread: FieldList = {
  nexa_view: 'code',
  order_basis: 'code',
  sent_at: 'instant',
  sent_at_note: 'code',
  seq: 'count',
  text_class: 'code',
  thread_size: 'count',
};

/**
 * The public projection of each record type, from the converter's records
 * (`mirza2nexa/modules/*.py`; the synthetic fixture package walks every type in the tests).
 */
export const HISTORY_PUBLIC_FIELDS: Readonly<Record<LegacyHistoryRecordType, FieldList>> = {
  payment: {
    ...money('amount'),
    'amount.parse_note': 'code',
    ...relation('customer'),
    'method.direction': 'code',
    'method.normalized': 'code',
    'order.order_ref_shared_with_other_rows': 'flag',
    'order.relation': 'code',
    'order.relation_proven': 'flag',
    'purpose.normalized': 'code',
    'receipt_trace.meaning': 'code',
    'receipt_trace.redacted': 'flag',
    'receipt_trace.shared_with_other_successful_payments': 'flag',
    'rejection_note.semantics': 'code',
    'status.outcome': 'code',
    'status.reason': 'code',
    'times.created.format': 'code',
    'times.created.local': 'instant',
    'times.created.note': 'code',
    'times.created.unix': 'instant',
    'times.updated.format': 'code',
    'times.updated.local': 'instant',
    'times.updated.note': 'code',
    'times.updated.unix': 'instant',
  },
  wallet_transaction: {
    ...money('amount', 'value_minor'),
    'amount.parse_note': 'code',
    ...money('balance_after', 'value_minor'),
    'balance_after.parse_note': 'code',
    ...money('balance_before', 'value_minor'),
    'balance_before.parse_note': 'code',
    amount_convention_observed: 'code',
    arithmetic: 'code',
    chain: 'code',
    'created_at.format': 'code',
    'created_at.format_evidence': 'code',
    'created_at.local': 'instant',
    'created_at.note': 'code',
    'created_at.unix': 'instant',
    ...relation('customer'),
    duplicate_suspect: 'flag',
    'ref_id.ref_relation': 'code',
    'source.normalized': 'code',
    'type.normalized': 'code',
  },
  wallet_history_check: {
    chain_gaps: 'count',
    ...relation('customer'),
    delta_snapshot_minus_history_minor: 'amount',
    ...money('history_last_balance_after'),
    inconsistent_rows: 'count',
    ...money('snapshot_balance'),
    'snapshot_balance.note': 'code',
    snapshot_is_the_opening_figure: 'flag',
    transactions: 'count',
    verdict: 'code',
  },
  wallet_difference: {
    ...relation('customer'),
    cause: 'code',
    certainty: 'code',
    proposed_action: 'code',
    'features.snapshot_minor': 'amount',
    'features.history_last_balance_after_minor': 'amount',
    'features.delta_snapshot_minus_history_minor': 'amount',
    'features.delta_sign': 'code',
    'features.abs_delta_minor': 'amount',
    'features.transactions': 'count',
    'features.groups.*.*.count': 'count',
    'features.groups.*.*.sum_minor': 'amount',
    'features.groups.*.*.unparsed_amounts': 'count',
    'features.sum_after_all_groups_minor': 'amount',
    'features.evidence_sources_complete': 'flag',
    'evidence_refs[].table': 'code',
    'evidence_refs[].role': 'code',
    evidence_refs_not_listed: 'count',
    snapshot_is_the_opening_figure: 'flag',
    opening_balance_changed: 'flag',
  },
  service_operation: {
    ...money('amount'),
    'amount.applied': 'flag',
    'amount.parse_note': 'code',
    'amount.semantics': 'code',
    'details.format': 'code',
    ...invoiceRelation,
    'operation_type.meaning_proven': 'flag',
    'operation_type.normalized': 'code',
    'owner.customer_decision': 'code',
    'owner.role': 'code',
    owner_relation: 'code',
    ownership_reason: 'code',
    'review_codes[]': 'code',
    'status.normalized': 'code',
    ...localTime('time'),
  },
  service_cancellation_request: {
    ...invoiceRelation,
    'owner.customer_decision': 'code',
    owner_relation: 'code',
    ownership_reason: 'code',
    refund_amount: 'amount',
    refund_amount_note: 'code',
    'review_codes[]': 'code',
    'status.normalized': 'code',
  },
  manual_config_inventory: {
    code_panel: 'code',
    config_content: 'code',
    ...invoiceRelation,
    requires_manual_transfer: 'flag',
    'review_codes[]': 'code',
    'status.normalized': 'code',
  },
  service_ownership: {
    already_in_review_queue_as: 'code',
    confirmable_only_by: 'code',
    core_service_decision: 'code',
    'current_owner_candidate.basis': 'code',
    'current_owner_candidate.customer_decision': 'code',
    'current_owner_candidate.in_user_table': 'flag',
    'current_owner_candidate.rule': 'code',
    'info_codes[]': 'code',
    live_service_candidate: 'flag',
    manual_review_reason: 'code',
    needs_manual_review: 'flag',
    'original_owner.basis': 'code',
    'original_owner.rule': 'code',
    'original_owner.source_table': 'code',
    ownership_confidence: 'code',
    ownership_decision: 'code',
    'ownership_evidence[].in_user_table': 'flag',
    'ownership_evidence[].reason': 'code',
    'ownership_evidence[].relation': 'code',
    'ownership_evidence[].role': 'code',
    'ownership_evidence[].rule': 'code',
    'ownership_evidence[].source_table': 'code',
    ownership_evidence_total: 'count',
    'reason_codes[]': 'code',
    review_scope: 'code',
    'transfer_evidence[].from_in_user_table': 'flag',
    'transfer_evidence[].to_in_user_table': 'flag',
    'transfer_evidence[].link_ok': 'flag',
    'transfer_evidence[].rule': 'code',
    'transfer_evidence[].seq': 'count',
    'transfer_evidence[].source_table': 'code',
    ...localTime('transfer_evidence[].time'),
  },
  panel_registry: {
    code_panel: 'code',
    credentials_in_package: 'flag',
    credentials_required_separately: 'flag',
    hidden_from_users_count: 'count',
    'invoice_links.by_code_panel': 'count',
    'invoice_links.by_service_location_name': 'count',
    'invoice_links.live_by_code_panel': 'count',
    manual_stock_rows: 'count',
    mapping_state: 'code',
    'panel_type.normalized': 'code',
    'product_links.by_location_name': 'count',
    'review_codes[]': 'code',
    'secret_columns_dropped[]': 'code',
    'status.normalized': 'code',
  },
  panel_target: {
    code_panel: 'code',
    credentials_in_package: 'flag',
    mapping_state: 'code',
    'source_panel_type.normalized': 'code',
  },
  panel_mapping_template: {
    code_panel: 'code',
    'code_panels_seen_with_location[].code_panel': 'code',
    'code_panels_seen_with_location[].invoices': 'count',
    code_unique_in_registry: 'flag',
    credentials: 'code',
    credentials_in_package: 'flag',
    decision: 'code',
    identity_kind: 'code',
    'invoices_by_code_panel.*': 'count',
    'invoices_by_service_location_name.*': 'count',
    'live_core_decisions.*.*': 'count',
    location_ordinal: 'count',
    map_format: 'code',
    'panel_type.normalized': 'code',
    'service_locations_seen_with_code[].invoices': 'count',
    suggested_map_section: 'code',
  },
  category_catalogue: {
    'product_links.exact': 'count',
    'product_links.normalized': 'count',
    'review_codes[]': 'code',
    review_state: 'code',
  },
  product_mapping_proposal: {
    'blocking_reasons[]': 'code',
    code_product: 'code',
    'conversions.agent_tier.normalized': 'code',
    'conversions.agent_tier.proposed_audience': 'code',
    'conversions.category.matches_category_table': 'flag',
    'conversions.duration.note': 'code',
    'conversions.duration.proposed_duration_days': 'count',
    'conversions.duration.unit': 'code',
    'conversions.hidden_on_panels.parse_note': 'code',
    'conversions.hidden_on_panels.raw_present': 'flag',
    'conversions.hidden_on_panels.unresolved': 'count',
    'conversions.note_present': 'flag',
    'conversions.one_buy_status.normalized': 'code',
    'conversions.panel_scope.kind': 'code',
    'conversions.panel_scope.state': 'code',
    ...money('conversions.price'),
    'conversions.price.parse_note': 'code',
    'conversions.price.use': 'code',
    'conversions.sale_status.read': 'flag',
    'conversions.traffic.factor_bytes': 'count',
    'conversions.traffic.note': 'code',
    'conversions.traffic.proposed_traffic_bytes': 'amount',
    'conversions.traffic.unit': 'code',
    'invoices_by_class.*': 'count',
    'owner_decisions_required[]': 'code',
    proposal_status: 'code',
    'proposed_nexa_catalog.audience': 'code',
    'proposed_nexa_catalog.status': 'code',
    'proposed_nexa_catalog.specification.durationDays': 'count',
    'proposed_nexa_catalog.specification.trafficBytes': 'amount',
    sellable: 'flag',
  },
  agent_profile: {
    ...person('customer'),
    agent_manage_relation_basis: 'code',
    'agent_manage[].source_table': 'code',
    limits_and_credit: 'code',
    status: 'code',
    tier: 'code',
    tier_label: 'code',
  },
  agent_price_level: {
    ...agentOwned,
    level_index: 'count',
    level_order_basis: 'code',
    levels_for_owner: 'count',
    price_semantics: 'code',
  },
  agent_invoice: {
    ...agentOwned,
    'invoice_ref.basis': 'code',
    'invoice_ref.exists_in_invoice_table': 'flag',
  },
  agent_log: agentOwned,
  agent_usage: agentOwned,
  agent_request: {
    ...person('requester'),
    granted_tier: 'code',
    owner_relation_basis: 'code',
    requested_at: 'instant',
    requested_at_note: 'code',
    status: 'code',
  },
  agent_state: {
    ...person('customer'),
    ...money('credit_debt.balance'),
    'credit_debt.balance_parse': 'code',
    'credit_debt.credit_granted': 'flag',
    'credit_debt.overdraft_limit_staged': 'flag',
    'credit_debt.position': 'code',
    'credit_debt.values': 'code',
    'current_status.agent_expiry_note': 'code',
    'current_status.mirza_tier_active_at_backup': 'flag',
    'current_status.nexa_status': 'code',
    'history.agent_invoice': 'count',
    'history.agent_log': 'count',
    'history.agent_manage': 'count',
    'history.agent_requests': 'count',
    'history.agent_usage_snapshot': 'count',
    'history.archive_only': 'flag',
    'history.custom_service_tier_prices': 'count',
    'history.total': 'count',
    'limits.applies_limits': 'flag',
    'limits.staged.*': 'flag',
    'owner_decisions[]': 'code',
    'pricing.custom_price_levels': 'count',
    'pricing.has_custom_prices': 'flag',
    'pricing.percent_discount_staged': 'flag',
    role_active: 'flag',
    'role_proposal.decision': 'code',
    'role_proposal.legacy_tier': 'code',
    'role_proposal.legacy_tier_label': 'code',
    'role_proposal.proposed': 'code',
    'role_proposal.role_active': 'flag',
  },
  discount: {
    code_plaintext_exported: 'flag',
    code_staged: 'flag',
    consumed_rows: 'count',
    ...money('credit_amount'),
    credit_amount_parse: 'code',
    expires_at: 'instant',
    expires_at_note: 'code',
    kind: 'code',
    lifecycle_as_of: 'instant',
    lifecycle_as_of_basis: 'code',
    lifecycle_reason: 'code',
    lifecycle_state: 'code',
    limit_total: 'count',
    outstanding_basis: 'code',
    ...money('outstanding_gift_value'),
    owner_decision: 'code',
    percent: 'count',
    remaining_uses: 'count',
    'scope.type': 'code',
    state: 'code',
    usage_link: 'code',
    used_count: 'count',
  },
  discount_usage: {
    ...person('customer'),
    code_match: 'code',
    'code_matches[]': 'code',
    match_basis: 'code',
    relation_basis: 'code',
  },
  referral: {
    ...person('referee'),
    ...person('referrer'),
    attributed_at: 'instant',
    attributed_at_note: 'code',
    referrer_gift_paid: 'flag',
    relation_valid: 'flag',
  },
  wheel_result: {
    ...person('customer'),
    ...money('prize'),
    prize_already_in_legacy_balance: 'flag',
    prize_parse: 'code',
    spun_at: 'instant',
    spun_at_note: 'code',
    won: 'flag',
  },
  ad_campaign: { semantics: 'code' },
  program_setting: { semantics: 'code' },
  support_department: { mapping_state: 'code' },
  support_message: {
    ...person('customer'),
    ...supportThread,
    message_state: 'code',
    nexa_status_proposal: 'code',
    thread_basis: 'code',
    thread_state: 'code',
    thread_state_basis: 'code',
  },
  ticket: {
    ...person('customer'),
    nexa_view: 'code',
    owner_decision: 'code',
    owner_relation_basis: 'code',
    status: 'code',
    status_basis: 'code',
    text_class: 'code',
  },
  ticket_message: {
    ...supportThread,
    'ticket_ref.basis': 'code',
    'ticket_ref.ticket_exists': 'flag',
    time_column: 'code',
  },
  archive_row: { class: 'code' },
  configuration_row: { class: 'code' },
};

// --- the projection ------------------------------------------------------------------------

interface Node {
  kind?: PublicFieldKind;
  readonly children: Map<string, Node>;
  /** Any key that is itself a `code`. */
  star?: Node;
  /** Every element of an array. */
  element?: Node;
}

const newNode = (): Node => ({ children: new Map() });

function compile(fields: FieldList): Node {
  const root = newNode();
  for (const [path, kind] of Object.entries(fields)) {
    let node = root;
    for (const raw of path.split('.')) {
      const isArray = raw.endsWith('[]');
      const name = isArray ? raw.slice(0, -2) : raw;
      if (name === '*') {
        node.star ??= newNode();
        node = node.star;
      } else {
        let child = node.children.get(name);
        if (child === undefined) {
          child = newNode();
          node.children.set(name, child);
        }
        node = child;
      }
      if (isArray) {
        node.element ??= newNode();
        node = node.element;
      }
    }
    node.kind = kind;
  }
  return root;
}

const TREES: ReadonlyMap<LegacyHistoryRecordType, Node> = new Map(
  (Object.keys(HISTORY_PUBLIC_FIELDS) as LegacyHistoryRecordType[]).map((type) => [
    type,
    compile({ ...COMMON, ...HISTORY_PUBLIC_FIELDS[type] }),
  ]),
);

/** Whether `value` has the shape `kind` promises. */
export function fitsKind(kind: PublicFieldKind, value: unknown): boolean {
  if (value === null) return true;
  switch (kind) {
    case 'code':
      return typeof value === 'string' && CODE.test(value) && !SIX_DIGITS.test(value);
    case 'amount':
      return typeof value === 'string' && AMOUNT.test(value);
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'flag':
      return typeof value === 'boolean';
    case 'instant':
      return (
        (typeof value === 'string' && INSTANT.test(value)) ||
        (typeof value === 'number' &&
          Number.isInteger(value) &&
          value >= UNIX_MIN &&
          value <= UNIX_MAX)
      );
    case 'key':
      return typeof value === 'string' && KEY.test(value) && !SIX_DIGITS.test(value);
  }
}

/** The kind the public projection of `type` gives a concrete dotted path (`a[].b`), if any. */
export function publicFieldKind(
  type: LegacyHistoryRecordType,
  path: string,
): PublicFieldKind | null {
  let node: Node | undefined = TREES.get(type);
  for (const raw of path.split('.')) {
    if (node === undefined) return null;
    const isArray = raw.endsWith('[]');
    const name = isArray ? raw.slice(0, -2) : raw;
    node = node.children.get(name) ?? (fitsKind('code', name) ? node.star : undefined);
    if (isArray) node = node?.element;
  }
  return node?.kind ?? null;
}

export interface RedactedPayload {
  readonly payload: Record<string, unknown>;
  /** Dotted paths dropped (`[]` for any array element), sorted and de-duplicated. */
  readonly redacted: readonly string[];
}

/** The public projection of one record: the allowlist of `type`, nothing else. */
export function redactHistoryPayload(
  type: LegacyHistoryRecordType,
  payload: Record<string, unknown>,
): RedactedPayload {
  const paths = new Set<string>();
  const tree = TREES.get(type) ?? newNode();
  const out = projectObject(payload, tree, '', paths);
  return { payload: out, redacted: [...paths].sort() };
}

const DROP = Symbol('drop');

function projectObject(
  value: Record<string, unknown>,
  node: Node,
  path: string,
  paths: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    const next = node.children.get(key) ?? (fitsKind('code', key) ? node.star : undefined);
    const projected = next === undefined ? DROP : project(child, next, childPath, paths);
    if (projected === DROP) {
      // A null says nothing; only a dropped value is listed.
      if (child !== null) paths.add(childPath);
      continue;
    }
    out[key] = projected;
  }
  return out;
}

function project(value: unknown, node: Node, path: string, paths: Set<string>): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    const element = node.element;
    if (element === undefined) return DROP;
    const out: unknown[] = [];
    for (const item of value) {
      const projected = project(item, element, `${path}[]`, paths);
      if (projected === DROP) {
        if (item !== null) paths.add(`${path}[]`);
      } else {
        out.push(projected);
      }
    }
    return out;
  }
  if (typeof value === 'object') {
    if (node.children.size === 0 && node.star === undefined) return DROP;
    return projectObject(value as Record<string, unknown>, node, path, paths);
  }
  return node.kind !== undefined && fitsKind(node.kind, value) ? value : DROP;
}
