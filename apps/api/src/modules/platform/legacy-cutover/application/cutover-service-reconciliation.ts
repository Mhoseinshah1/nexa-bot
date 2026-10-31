import type { LegacyServiceOutcome } from '@nexa/contracts';
import { isAdoptedOutcome } from '../../legacy-service-review/domain/candidate-rules.js';

/**
 * The cutover's SERVICE reconciliation: every Mirza service the package's own snapshot carries
 * against what the import left in NEXA, invoice by invoice. Pure; no I/O. The balance half is
 * `cutover-reconciliation.ts`; the rehearsal (`cutover-rehearse.cli.ts`) prints both.
 *
 * The Mirza side is `serviceCandidateInvoices(snapshot)` — the one list the importer itself
 * decides from (every live invoice, and every other invoice that was ever paid for). The NEXA
 * side is `legacy_service_candidates` (the ONE outcome the import recorded for each invoice)
 * and the tenant's `services`, each of which names the Mirza invoice it came from
 * (`source = 'MIRZA'`, `source_ref = 'invoice:<id_invoice>'`).
 *
 * An invoice the import ADOPTED is matched when exactly its adopted service exists, is not
 * terminated, and belongs to the invoice's own Mirza user. An invoice the import did not
 * adopt is HELD, counted by its outcome and never a match: with the rehearsal's empty
 * stand-in inventory every live one is `PROVIDER_MISSING` — the expected result of a
 * rehearsal without the real panel, not a failure. A held invoice may be kept as a
 * TERMINATED history service (counted), never as a live one. Each held class is signed off
 * by name, exactly as a held balance row is.
 *
 * A DIFFERENCE is something the import must never produce:
 *
 * - `SERVICE_NOT_DECIDED` — a Mirza invoice with no recorded outcome at all (dropped silently);
 * - `SERVICE_ADOPTED_MISSING` — an outcome says adopted, and its live NEXA service is not there;
 * - `SERVICE_DUPLICATED` — more than one NEXA service names the same Mirza invoice;
 * - `SERVICE_LIVE_WHILE_HELD` — an invoice held for review has a NEXA service that is not
 *   terminated (a service nobody approved);
 * - `SERVICE_OWNER_DIFFERS` — a NEXA service belongs to a customer who is not its invoice's
 *   Mirza user;
 * - `SERVICE_NOT_IN_MIRZA` — a NEXA service that names no invoice of this package (right after
 *   the import there is no other way for one to exist);
 * - `CANDIDATE_NOT_IN_MIRZA` — a recorded outcome for an invoice the package does not carry.
 *
 * Differences name the invoice by its 1-based position among the package's candidates and
 * the NEXA service by its id — never a Telegram id, a panel username or a link.
 */

export interface MirzaServiceInvoice {
  /** `invoice.id_invoice` as read. */
  readonly invoiceKey: string;
  /** `invoice.id_user` (a Telegram id): compared, never printed. */
  readonly ownerTelegramId: string | null;
}

export interface NexaServiceCandidate {
  readonly invoiceKey: string;
  readonly outcome: LegacyServiceOutcome;
  readonly serviceId: string | null;
}

export interface NexaServiceRow {
  readonly serviceId: string;
  readonly state: string;
  readonly source: string | null;
  readonly sourceRef: string | null;
  /** The owning customer's Telegram id: compared, never printed. */
  readonly ownerTelegramId: string | null;
}

/** The Mirza invoice a service names, or null. */
export function mirzaInvoiceOf(
  service: Pick<NexaServiceRow, 'source' | 'sourceRef'>,
): string | null {
  if (service.source !== 'MIRZA' || service.sourceRef === null) return null;
  return service.sourceRef.startsWith('invoice:')
    ? service.sourceRef.slice('invoice:'.length)
    : null;
}

export const SERVICE_DIFFERENCE_KINDS = [
  'SERVICE_NOT_DECIDED',
  'SERVICE_ADOPTED_MISSING',
  'SERVICE_DUPLICATED',
  'SERVICE_LIVE_WHILE_HELD',
  'SERVICE_OWNER_DIFFERS',
  'SERVICE_NOT_IN_MIRZA',
  'CANDIDATE_NOT_IN_MIRZA',
] as const;
export type ServiceDifferenceKind = (typeof SERVICE_DIFFERENCE_KINDS)[number];

export interface ServiceDifference {
  readonly kind: ServiceDifferenceKind;
  /** 1-based position of the invoice among the package's service candidates, or null. */
  readonly mirzaInvoice: number | null;
  readonly serviceId: string | null;
}

export type ServiceVerdict = 'RECONCILED' | 'RECONCILED_WITH_HELD' | 'DIFFERENCES';

export interface ServiceReconciliation {
  readonly verdict: ServiceVerdict;
  /** Distinct Mirza service candidates in the package. */
  readonly mirzaServices: number;
  readonly nexaServices: number;
  /** Adopted, present, live, alone, and owned by the invoice's own Mirza user. */
  readonly matched: number;
  /** Not adopted, by outcome (sorted by outcome). Never a match. */
  readonly held: readonly { readonly outcome: string; readonly invoices: number }[];
  readonly heldTotal: number;
  /** Held invoices kept as a TERMINATED history service. */
  readonly heldAsHistory: number;
  readonly differenceCounts: Readonly<Record<ServiceDifferenceKind, number>>;
  readonly differences: readonly ServiceDifference[];
}

export function reconcileServices(input: {
  readonly mirza: readonly MirzaServiceInvoice[];
  readonly candidates: readonly NexaServiceCandidate[];
  readonly services: readonly NexaServiceRow[];
}): ServiceReconciliation {
  const differences: ServiceDifference[] = [];
  const diff = (
    kind: ServiceDifferenceKind,
    mirzaInvoice: number | null,
    serviceId: string | null,
  ): void => {
    differences.push({ kind, mirzaInvoice, serviceId });
  };

  // One entry per invoice key: the importer decides each key once.
  const mirza = new Map<string, { readonly position: number; readonly owner: string | null }>();
  input.mirza.forEach((invoice, index) => {
    if (!mirza.has(invoice.invoiceKey)) {
      mirza.set(invoice.invoiceKey, { position: index + 1, owner: invoice.ownerTelegramId });
    }
  });
  const candidates = new Map(input.candidates.map((c) => [c.invoiceKey, c]));
  const byInvoice = new Map<string, NexaServiceRow[]>();
  for (const service of input.services) {
    const key = mirzaInvoiceOf(service);
    if (key === null || !mirza.has(key)) {
      diff('SERVICE_NOT_IN_MIRZA', null, service.serviceId);
      continue;
    }
    byInvoice.set(key, [...(byInvoice.get(key) ?? []), service]);
  }

  const held = new Map<string, number>();
  let heldAsHistory = 0;
  let matched = 0;
  for (const [key, invoice] of mirza) {
    const rows = byInvoice.get(key) ?? [];
    let exact = true;
    for (const row of rows) {
      if (invoice.owner === null || row.ownerTelegramId !== invoice.owner) {
        diff('SERVICE_OWNER_DIFFERS', invoice.position, row.serviceId);
        exact = false;
      }
    }
    if (rows.length > 1) {
      diff('SERVICE_DUPLICATED', invoice.position, null);
      exact = false;
    }
    const candidate = candidates.get(key);
    if (candidate === undefined) {
      diff('SERVICE_NOT_DECIDED', invoice.position, null);
      continue;
    }
    if (!isAdoptedOutcome(candidate.outcome)) {
      held.set(candidate.outcome, (held.get(candidate.outcome) ?? 0) + 1);
      for (const row of rows) {
        if (row.state === 'TERMINATED') heldAsHistory += 1;
        else diff('SERVICE_LIVE_WHILE_HELD', invoice.position, row.serviceId);
      }
      continue;
    }
    const adopted = rows.find((row) => row.serviceId === candidate.serviceId);
    if (adopted === undefined || adopted.state === 'TERMINATED') {
      diff('SERVICE_ADOPTED_MISSING', invoice.position, candidate.serviceId);
      continue;
    }
    if (exact) matched += 1;
  }
  for (const candidate of input.candidates) {
    if (!mirza.has(candidate.invoiceKey)) diff('CANDIDATE_NOT_IN_MIRZA', null, candidate.serviceId);
  }

  const differenceCounts = Object.fromEntries(
    SERVICE_DIFFERENCE_KINDS.map((k) => [k, differences.filter((d) => d.kind === k).length]),
  ) as Record<ServiceDifferenceKind, number>;
  const heldRows = [...held.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([outcome, invoices]) => ({ outcome, invoices }));
  const heldTotal = heldRows.reduce((n, h) => n + h.invoices, 0);
  const verdict: ServiceVerdict =
    differences.length > 0 ? 'DIFFERENCES' : heldTotal > 0 ? 'RECONCILED_WITH_HELD' : 'RECONCILED';
  return {
    verdict,
    mirzaServices: mirza.size,
    nexaServices: input.services.length,
    matched,
    held: heldRows,
    heldTotal,
    heldAsHistory,
    differenceCounts,
    differences,
  };
}

/** The plain-text section: aggregates only, and the differences only when asked. */
export function serviceReportText(
  r: ServiceReconciliation,
  options: { readonly listDifferences: boolean },
): string {
  const lines = [
    'Cutover service reconciliation (read only; every Mirza service the package carries)',
    `verdict: ${r.verdict}`,
    `mirza services: ${String(r.mirzaServices)}; nexa services: ${String(r.nexaServices)}; matched exactly: ${String(r.matched)}; held ${String(r.heldTotal)} (kept as terminated history ${String(r.heldAsHistory)})`,
    ...r.held.map((h) => `  held ${h.outcome}: ${String(h.invoices)}`),
    ...SERVICE_DIFFERENCE_KINDS.map((k) => `difference ${k}: ${String(r.differenceCounts[k])}`),
  ];
  if (options.listDifferences) {
    lines.push('service differences (terminal only; never paste):');
    for (const d of r.differences) {
      lines.push(
        [
          `  ${d.kind}`,
          d.mirzaInvoice === null ? null : `mirza-invoice=${String(d.mirzaInvoice)}`,
          d.serviceId === null ? null : `service=${d.serviceId}`,
        ]
          .filter((p): p is string => p !== null)
          .join(' '),
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
