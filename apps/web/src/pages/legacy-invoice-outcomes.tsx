import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LegacyServiceCandidateView, LegacyServiceOutcome } from '@nexa/contracts';
import { fetchLegacyServiceCandidates } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { keepPageWhileTurning } from '../ui/paging';
import { queryState } from '../view-state';
import {
  Badge,
  CursorPager,
  DataTable,
  Empty,
  Ltr,
  SearchInput,
  StateSwitch,
  type Column,
} from '../ui/kit';
import { LEGACY_SERVICE_OUTCOME_LABELS, legacyServiceRefusalLabel } from './legacy-service-labels';

/**
 * The import report on the one-click page: where each OLD invoice ended (Round 5C-2 D3).
 *
 * Read-only, keyset-paged, searched by the old invoice id. It draws the importer's own
 * recorded outcome per invoice (`legacy_service_candidates`, the data the retired
 * «سرویس‌های ربات قبلی» page used to show) and decides nothing: no adopt, keep or reopen
 * control exists here. An outcome is one of three things to an operator:
 *
 * - منتقل شد - the invoice became a NEXA service;
 * - روی پنل نیست - no panel is recorded for it, or the panel holds no such account;
 * - آرشیو شد - every other outcome: it stays history, and the reason says why.
 */

export type InvoiceGroup = 'MIGRATED' | 'ARCHIVED' | 'NOT_ON_PANEL';

const GROUPS: Readonly<Partial<Record<LegacyServiceOutcome, InvoiceGroup>>> = {
  ADOPTED: 'MIGRATED',
  ALREADY_ADOPTED: 'MIGRATED',
  PROVIDER_MISSING: 'NOT_ON_PANEL',
  NO_PANEL: 'NOT_ON_PANEL',
};

export function invoiceGroupOf(outcome: LegacyServiceOutcome): InvoiceGroup {
  return GROUPS[outcome] ?? 'ARCHIVED';
}

const GROUP_LABELS: Readonly<Record<InvoiceGroup, WebKey>> = {
  MIGRATED: 'web.lio_group_migrated',
  ARCHIVED: 'web.lio_group_archived',
  NOT_ON_PANEL: 'web.lio_group_not_on_panel',
};

const GROUP_TONES: Readonly<Record<InvoiceGroup, 'ok' | 'neutral' | 'warn'>> = {
  MIGRATED: 'ok',
  ARCHIVED: 'neutral',
  NOT_ON_PANEL: 'warn',
};

/** The reason in words: the outcome's label, and the importer's raw blocker when it adds one. */
export function invoiceReason(row: LegacyServiceCandidateView): string {
  const outcome = t(LEGACY_SERVICE_OUTCOME_LABELS[row.outcome]);
  if (row.blocker === null || row.blocker === row.outcome) return outcome;
  return `${outcome} - ${legacyServiceRefusalLabel(row.blocker)}`;
}

const SEARCH_DELAY_MS = 300;

export function LegacyInvoiceOutcomes() {
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState('');
  const [trail, setTrail] = useState<readonly (string | undefined)[]>([]);
  const [after, setAfter] = useState<string | undefined>(undefined);

  // The search applies once typing pauses, and always starts from the first page.
  useEffect(() => {
    const handle = setTimeout(() => {
      setTerm((current) => {
        if (current !== typed) {
          setTrail([]);
          setAfter(undefined);
        }
        return typed;
      });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(handle);
  }, [typed]);

  const list = useQuery(
    keepPageWhileTurning({
      queryKey: ['legacy-invoice-outcomes', term, after ?? null],
      queryFn: () =>
        fetchLegacyServiceCandidates({
          ...(term === '' ? {} : { invoiceId: term }),
          ...(after === undefined ? {} : { after }),
        }),
    }),
  );
  const rows = list.data?.candidates ?? [];

  const columns: readonly Column<LegacyServiceCandidateView>[] = [
    {
      key: 'invoice',
      header: t('web.lio_col_invoice'),
      render: (row) => <Ltr>{row.invoiceKey}</Ltr>,
    },
    {
      key: 'outcome',
      header: t('web.lio_col_outcome'),
      render: (row) => {
        const group = invoiceGroupOf(row.outcome);
        return (
          <Badge tone={GROUP_TONES[group]} dot>
            {t(GROUP_LABELS[group])}
          </Badge>
        );
      },
    },
    {
      key: 'reason',
      header: t('web.lio_col_reason'),
      wrap: true,
      render: (row) => invoiceReason(row),
    },
  ];

  return (
    <div className="stack">
      <h3 className="card-subtitle">{t('web.lio_title')}</h3>
      <p className="muted small">{t('web.lio_hint')}</p>
      <SearchInput
        value={typed}
        onChange={setTyped}
        label={t('web.lio_search')}
        placeholder={t('web.lio_search_placeholder')}
        dir="ltr"
      />
      <StateSwitch
        query={list}
        denied={false}
        isEmpty={queryState(list) === 'ready' && rows.length === 0}
        empty={<Empty title={t('web.lio_empty')} icon="search" />}
      >
        <DataTable
          columns={columns}
          rows={[...rows]}
          rowKey={(row) => row.id}
          caption={t('web.lio_title')}
          dense
        />
        <CursorPager
          order="oldest-first"
          shown={rows.length}
          hasPrevious={trail.length > 0}
          hasNext={(list.data?.nextCursor ?? null) !== null}
          onPrevious={() => {
            setAfter(trail[trail.length - 1]);
            setTrail(trail.slice(0, -1));
          }}
          onNext={() => {
            const next = list.data?.nextCursor ?? null;
            if (next === null) return;
            setTrail([...trail, after]);
            setAfter(next);
          }}
        />
      </StateSwitch>
    </div>
  );
}
