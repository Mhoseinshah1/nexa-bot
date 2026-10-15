import type {
  LegacyInventoryPanelDiagnostics,
  LegacyInventoryWalkDiagnostics,
  LegacyMigrationDryRunReport,
  RickpanelChainBreak,
  RickpanelGapFreeFailure,
  RickpanelUnresolvedCause,
} from '@nexa/contracts';
import { formatNumber } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, Disclosure, KV, Ltr, Num } from '../ui/kit';

/**
 * WHY a production RickPanel read left needed names unresolved — the dry run's
 * `providerDiagnostics`, in the operator's words (`docs/rickpanel-inventory.md` §Diagnostics).
 *
 * A live dry run once left every needed name of a panel UNRESOLVED and the page could only say
 * how many. This shows, per panel, why each unresolved name stayed so and, per walk, which
 * gap-free condition failed first and on which page — each with what to do about it. Numbers
 * and closed codes only: the report carries no name, row or address, and nothing here draws a
 * control or changes whether the confirmation is offered (that is the contract rule's alone).
 * An older report without the field shows nothing.
 */

/** Why one needed name stayed unresolved: the cause and its remedy, in one sentence each. */
const CAUSE: Record<RickpanelUnresolvedCause, WebKey> = {
  NO_DECISION_WALK: 'web.mrz_diag_cause_no_decision_walk',
  LAST_NOT_DECISIVE: 'web.mrz_diag_cause_last_not_decisive',
  BACKUP_TWO_SPELLINGS: 'web.mrz_diag_cause_backup_two_spellings',
  MULTI_CREATED_AT: 'web.mrz_diag_cause_multi_created_at',
  UNCONFIRMED: 'web.mrz_diag_cause_unconfirmed',
  REAPPEARED: 'web.mrz_diag_cause_reappeared',
};

/** Each gap-free condition, by how it failed. */
const FAILURE: Record<RickpanelGapFreeFailure, WebKey> = {
  NO_OVERLAP: 'web.mrz_diag_failure_no_overlap',
  NO_TOTAL: 'web.mrz_diag_failure_no_total',
  CREATED_ORDER: 'web.mrz_diag_failure_created_order',
  UNCHAINED: 'web.mrz_diag_failure_unchained',
  SHORT_BEFORE_END: 'web.mrz_diag_failure_short_before_end',
  NOT_ENDED_AT_TOTAL: 'web.mrz_diag_failure_not_ended_at_total',
};

/** How a page boundary failed to chain. */
const BREAK: Record<RickpanelChainBreak, WebKey> = {
  NO_COMMON_ROW: 'web.mrz_diag_break_no_common_row',
  COMMON_ORDER_DIFFERS: 'web.mrz_diag_break_common_order_differs',
  INSERT_AHEAD_MISSED: 'web.mrz_diag_break_insert_ahead_missed',
  DUPLICATE_IN_PAGE: 'web.mrz_diag_break_duplicate_in_page',
  REPEAT_OUTSIDE_OVERLAP: 'web.mrz_diag_break_repeat_outside_overlap',
  PAGE_LONGER_THAN_CAP: 'web.mrz_diag_break_page_longer_than_cap',
};

const fill = (key: WebKey, values: Record<string, number | string>) =>
  Object.entries(values).reduce(
    (text, [name, value]) =>
      text.replace(`{${name}}`, typeof value === 'number' ? formatNumber(value) : value),
    t(key),
  );

const yesNo = (value: boolean | null) =>
  value === null ? '—' : value ? t('web.lmg_yes') : t('web.lmg_no');

export function InventoryDiagnostics({
  report,
  bindings,
}: {
  report: Pick<LegacyMigrationDryRunReport, 'providerDiagnostics'> | null | undefined;
  /** code_panel → NEXA panel id, to name a panel by its legacy code rather than its id. */
  bindings?: readonly { readonly codePanel: string; readonly panelId: string }[] | null;
}) {
  const panels = report?.providerDiagnostics ?? [];
  if (panels.length === 0) return null;
  const codeOf = (panelId: string) =>
    (bindings ?? []).filter((b) => b.panelId === panelId).map((b) => b.codePanel);
  return (
    <section className="stack" aria-label={t('web.mrz_diag_title')}>
      <h4 className="card-subtitle">{t('web.mrz_diag_title')}</h4>
      <p className="muted small">{t('web.mrz_diag_intro')}</p>
      {panels.map((panel) => (
        <PanelDiagnostics key={panel.panelId} panel={panel} codes={codeOf(panel.panelId)} />
      ))}
    </section>
  );
}

function PanelDiagnostics({
  panel,
  codes,
}: {
  panel: LegacyInventoryPanelDiagnostics;
  codes: readonly string[];
}) {
  const anyFailure = (kind: RickpanelGapFreeFailure) =>
    panel.walks.some((w) => w.failures.includes(kind));
  return (
    <Disclosure
      variant="boxed"
      summary={
        <span>
          <Ltr>{codes.length > 0 ? codes.join(', ') : panel.panelId}</Ltr>{' '}
          {fill('web.mrz_diag_panel_summary', {
            unresolved: panel.unresolved,
            needed: panel.needed,
          })}
        </span>
      }
    >
      <div className="stack">
        <KV
          items={[
            [t('web.mrz_diag_reason'), <Ltr key="r">{panel.reason}</Ltr>],
            [
              t('web.mrz_diag_decision_walk'),
              panel.decisionWalk === null
                ? t('web.mrz_diag_decision_none')
                : fill('web.mrz_diag_walk_title', { n: panel.decisionWalk + 1 }),
            ],
          ]}
        />
        {panel.unresolvedByCause.length > 0 && (
          <>
            <h5 className="card-subtitle">{t('web.mrz_diag_causes_title')}</h5>
            <ul className="stack">
              {panel.unresolvedByCause.map((c) => (
                <li key={c.code}>
                  <Num value={c.count} /> — {t(CAUSE[c.code])}
                </li>
              ))}
            </ul>
          </>
        )}
        {(anyFailure('CREATED_ORDER') || anyFailure('NO_TOTAL') || anyFailure('UNCHAINED')) && (
          <Banner tone="warn" title={t('web.mrz_diag_probe_title')}>
            <p>{t('web.mrz_diag_probe_body')}</p>
          </Banner>
        )}
        <h5 className="card-subtitle">{t('web.mrz_diag_walks_title')}</h5>
        {panel.walks.map((walk, index) => (
          <WalkDiagnostics key={index} walk={walk} index={index} />
        ))}
      </div>
    </Disclosure>
  );
}

function WalkDiagnostics({ walk, index }: { walk: LegacyInventoryWalkDiagnostics; index: number }) {
  return (
    <div className="stack">
      <h6 className="card-subtitle">{fill('web.mrz_diag_walk_title', { n: index + 1 })}</h6>
      <KV
        items={[
          [t('web.mrz_diag_gap_free'), yesNo(walk.gapFree)],
          [t('web.mrz_diag_decisive'), yesNo(walk.decisive)],
          [t('web.mrz_diag_same_order'), yesNo(walk.sameOrderAsPrevious)],
          [
            t('web.mrz_diag_first_failure'),
            walk.firstFailure === null
              ? t('web.lmg_none')
              : fill('web.mrz_diag_first_failure_at', {
                  page: walk.firstFailure.pageIndex + 1,
                  what: t(FAILURE[walk.firstFailure.kind]),
                }),
          ],
          [t('web.mrz_diag_pages'), <Num key="p" value={walk.pages} />],
          [t('web.mrz_diag_rows'), <Num key="r" value={walk.rowsFetched} />],
          [t('web.mrz_diag_duration_ms'), <Num key="d" value={walk.durationMs} />],
          [t('web.mrz_diag_overlap'), <Num key="o" value={walk.overlapApplied} />],
          [
            t('web.mrz_diag_learned_limit'),
            walk.learnedLimit === null ? '—' : <Num key="l" value={walk.learnedLimit} />,
          ],
          [
            t('web.mrz_diag_total_first_last'),
            walk.reportedTotalFirst === null
              ? t('web.mrz_diag_total_absent')
              : `${formatNumber(walk.reportedTotalFirst)} → ${formatNumber(walk.reportedTotalLast ?? 0)}`,
          ],
          [t('web.mrz_diag_total_change'), <Num key="c" value={walk.reportedTotalMaxChange} />],
          [
            t('web.mrz_diag_end_minus_total'),
            walk.endedOffsetMinusTotal === null ? (
              '—'
            ) : (
              <Num key="e" value={walk.endedOffsetMinusTotal} signed />
            ),
          ],
          [t('web.mrz_diag_created_without'), <Num key="w" value={walk.createdAt.rowsWithout} />],
          [
            t('web.mrz_diag_created_unparsable'),
            <Num key="u" value={walk.createdAt.rowsUnparsable} />,
          ],
          [t('web.mrz_diag_created_inversions'), <Num key="i" value={walk.createdAt.inversions} />],
          [
            t('web.mrz_diag_created_max_inversion_ms'),
            <Num key="m" value={walk.createdAt.maxInversionMs} />,
          ],
          [
            t('web.mrz_diag_created_formats'),
            walk.createdAt.formats.length === 0 ? (
              t('web.lmg_none')
            ) : (
              <Ltr key="f">
                {walk.createdAt.formats.map((f) => `${f.code}: ${String(f.count)}`).join(' · ')}
              </Ltr>
            ),
          ],
        ]}
      />
      {walk.failures.length > 0 && (
        <ul className="stack">
          {walk.failures.map((kind) => (
            <li key={kind}>{t(FAILURE[kind])}</li>
          ))}
        </ul>
      )}
      {walk.chainBreaks.length > 0 && (
        <ul className="stack">
          {walk.chainBreaks.map((b) => (
            <li key={b.code}>
              <Num value={b.count} /> — {t(BREAK[b.code])}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
