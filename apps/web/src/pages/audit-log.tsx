import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ACTOR_TYPES,
  AUDIT_RESULTS,
  AUDIT_SECURITY_FILTERS,
  type ActorType,
  type AuditLogEntry,
  type AuditResult,
  type AuditSecurityFilter,
} from '@nexa/contracts';
import { auditLogExportUrl, fetchAuditLog, type AuditLogFilters } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, setQuery, useLinkHandler, type Route } from '../router';
import { NAV_PREFETCH_FRESH_MS, type PageQuery } from '../nav-prefetch';
import { mayRequest } from '../view-state';
import { dayEnd, dayStart } from './tickets';
import {
  Badge,
  Card,
  ChipDivider,
  CursorPager,
  DataTable,
  Disclosure,
  Empty,
  Field,
  FilterBar,
  FilterChip,
  FilterChips,
  Ltr,
  PageHead,
  StateSwitch,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * The audit log (Phase D1, program §16, `docs/audit-log.md`).
 *
 * A READER. It filters, pages and exports what `audit_logs` already holds and adds nothing to
 * a row: a row with no `before`/`after` shows none, and a row whose entity is not a customer,
 * order, payment or service links nowhere. Every filter lives in the URL, so a filtered view
 * is a link an operator can send, and Customer 360 opens this page already scoped to one
 * customer.
 *
 * Every filter is applied on the SERVER and the cursor is the server's: filtering a fetched
 * page in the browser would leave the cursor having walked past rows nobody saw — the reason
 * `/alerts` gives. The export is the same filter object, so the file holds exactly the rows
 * these pages show.
 */

const PAGE_SIZE = 50;

const SECURITY_LABELS: Readonly<Record<AuditSecurityFilter, WebKey>> = {
  DENIED: 'web.audit_security_denied',
  AUTH: 'web.audit_security_auth',
  CRITICAL: 'web.audit_security_critical',
};

const SECURITY_TONES: Readonly<Record<AuditSecurityFilter, Tone>> = {
  DENIED: 'warn',
  AUTH: 'info',
  CRITICAL: 'danger',
};

const RESULT_LABELS: Readonly<Record<AuditResult, WebKey>> = {
  SUCCESS: 'web.history_result_success',
  DENIED: 'web.history_result_denied',
  FAILED: 'web.history_result_failed',
};

const RESULT_TONES: Readonly<Record<AuditResult, Tone>> = {
  SUCCESS: 'ok',
  DENIED: 'warn',
  FAILED: 'danger',
};

const ACTOR_LABELS: Readonly<Record<ActorType, WebKey>> = {
  WEB_ADMIN: 'web.audit_actor_web_admin',
  TELEGRAM_ADMIN: 'web.audit_actor_telegram_admin',
  SYSTEM_JOB: 'web.audit_actor_system_job',
  CUSTOMER: 'web.audit_actor_customer',
  API: 'web.audit_actor_api',
  PROVIDER_SYNC: 'web.audit_actor_provider_sync',
};

/**
 * The entity types the picker offers, as the writers spell them. Not a closed set — the
 * server accepts any entity type, and a row's own entity is one click from its filter — but
 * these are the ones an operator asks about by name.
 */
const ENTITY_LABELS: Readonly<Record<string, WebKey>> = {
  Customer: 'web.audit_entity_customer',
  Wallet: 'web.audit_entity_wallet',
  Order: 'web.audit_entity_order',
  Payment: 'web.audit_entity_payment',
  Service: 'web.audit_entity_service',
  Refund: 'web.audit_entity_refund',
  Panel: 'web.audit_entity_panel',
  Product: 'web.audit_entity_product',
  Admin: 'web.audit_entity_admin',
  PaymentGateway: 'web.audit_entity_payment_gateway',
  PaymentAccount: 'web.audit_entity_payment_account',
  BotInstance: 'web.audit_entity_bot_instance',
  Setting: 'web.audit_entity_setting',
  Backup: 'web.audit_entity_backup',
  Recovery: 'web.audit_entity_recovery',
  Ticket: 'web.audit_entity_ticket',
  BulkOperation: 'web.audit_entity_bulk_operation',
  AuditLog: 'web.audit_entity_audit_log',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ACTION = /^[a-z0-9_.]+$/u;

function oneOf<T extends string>(values: readonly T[], raw: string | null): T | null {
  return raw !== null && (values as readonly string[]).includes(raw) ? (raw as T) : null;
}

/** The URL's filters, as the page applies them. Unreadable values are simply not applied. */
export function auditFiltersOf(query: URLSearchParams): AuditLogFilters {
  const text = (key: string) => (query.get(key) ?? '').trim();
  const actorType = oneOf(ACTOR_TYPES, query.get('actorType'));
  const result = oneOf(AUDIT_RESULTS, query.get('result'));
  const security = oneOf(AUDIT_SECURITY_FILTERS, query.get('security'));
  const action = text('action');
  const entityType = text('entityType');
  const entityId = text('entityId');
  const customerId = text('customerId');
  const from = dayStart(text('from'));
  const to = dayEnd(text('to'));
  return {
    ...(text('actor') === '' ? {} : { actor: text('actor') }),
    ...(actorType === null ? {} : { actorType }),
    ...(UUID.test(customerId) ? { customerId: customerId.toLowerCase() } : {}),
    ...(ACTION.test(action) ? { action } : {}),
    ...(entityType === '' ? {} : { entityType }),
    // An id alone names nothing; the server refuses it, so the page never sends it.
    ...(entityType !== '' && entityId !== '' ? { entityId } : {}),
    ...(result === null ? {} : { result }),
    ...(security === null ? {} : { security }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
  };
}

/**
 * One page of the log under the applied filters, built in ONE place for the page and for
 * the sidebar's prefetch (`nav-prefetch.ts`). The key carries the filters' signature, so
 * a page read under one filter is never served under another.
 */
export function auditLogQuery(
  filters: AuditLogFilters,
  cursor: string | undefined,
): PageQuery<Awaited<ReturnType<typeof fetchAuditLog>>> {
  return {
    queryKey: ['audit-log', JSON.stringify(filters), cursor ?? null],
    queryFn: () =>
      fetchAuditLog(filters, {
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    staleTime: NAV_PREFETCH_FRESH_MS,
  };
}

/** What `/audit-log` asks on arrival from the sidebar: no filter, the newest page. */
export function auditLogFirstScreen(): readonly PageQuery[] {
  return [auditLogQuery(auditFiltersOf(new URLSearchParams()), undefined)];
}

interface Draft {
  readonly actor: string;
  readonly action: string;
  readonly entityId: string;
  readonly customerId: string;
  readonly fromDay: string;
  readonly toDay: string;
}

export function AuditLogPage({
  route,
  denied,
  mayExport,
}: {
  route: Route;
  denied: boolean;
  mayExport: boolean;
}) {
  const onLink = useLinkHandler();
  const filters = auditFiltersOf(route.query);
  const signature = JSON.stringify(filters);

  // The typed fields FOLLOW the applied URL; see `/tickets` for why this is derived.
  const applied: Draft = {
    actor: route.query.get('actor') ?? '',
    action: route.query.get('action') ?? '',
    entityId: route.query.get('entityId') ?? '',
    customerId: route.query.get('customerId') ?? '',
    fromDay: route.query.get('from') ?? '',
    toDay: route.query.get('to') ?? '',
  };
  const appliedSignature = JSON.stringify(applied);
  const [draftState, setDraftState] = useState({ signature: appliedSignature, draft: applied });
  const draft = draftState.signature === appliedSignature ? draftState.draft : applied;
  const edit = (patch: Partial<Draft>) =>
    setDraftState({ signature: appliedSignature, draft: { ...draft, ...patch } });

  const entityType = route.query.get('entityType') ?? '';
  const problems = {
    action: draft.action.trim() !== '' && !ACTION.test(draft.action.trim()),
    customer: draft.customerId.trim() !== '' && !UUID.test(draft.customerId.trim()),
    entity: draft.entityId.trim() !== '' && entityType === '',
    dates:
      (draft.fromDay !== '' && dayStart(draft.fromDay) === null) ||
      (draft.toDay !== '' && dayEnd(draft.toDay) === null) ||
      (draft.fromDay !== '' && draft.toDay !== '' && draft.fromDay > draft.toDay),
  };
  const blocked = Object.values(problems).some(Boolean);

  // A cursor minted under one filter strands rows under another: the trail is keyed by it.
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature,
    cursors: [],
  });
  const cursors = trail.signature === signature ? trail.cursors : [];
  const cursor = cursors[cursors.length - 1];

  const log = useQuery({ ...auditLogQuery(filters, cursor), enabled: !denied });
  const rows = log.data?.entries ?? [];
  const nextCursor = log.data?.nextCursor ?? null;
  const filtering = signature !== '{}';
  const requestable = mayRequest(log, denied);

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    const value = (text: string) => (text.trim() === '' ? null : text.trim());
    setQueries(route, [
      ['actor', value(draft.actor)],
      ['action', value(draft.action)],
      ['entityId', value(draft.entityId)],
      ['customerId', value(draft.customerId)],
      ['from', value(draft.fromDay)],
      ['to', value(draft.toDay)],
    ]);
  };
  const clear = () =>
    setQueries(
      route,
      [
        'actor',
        'actorType',
        'action',
        'entityType',
        'entityId',
        'customerId',
        'result',
        'security',
        'from',
        'to',
      ].map((key) => [key, null] as const),
    );

  const columns: readonly Column<AuditLogEntry>[] = [
    {
      key: 'time',
      header: t('web.audit_col_time'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.occurredAt)}</span>,
    },
    {
      key: 'actor',
      header: t('web.audit_col_actor'),
      render: (row) => (
        <span className="cell-main">
          {row.actorId === null ? (
            <span>{row.actorLabel ?? t(ACTOR_LABELS[row.actorType])}</span>
          ) : (
            <button
              type="button"
              className="link"
              title={t('web.audit_filter_by_actor')}
              onClick={() => setQuery(route, 'actor', row.actorId)}
            >
              <bdi>{row.actorLabel ?? row.actorId}</bdi>
            </button>
          )}
          <span className="muted small">{t(ACTOR_LABELS[row.actorType])}</span>
        </span>
      ),
    },
    {
      key: 'action',
      header: t('web.audit_col_action'),
      wrap: true,
      render: (row) => (
        <span className="cell-main">
          <button
            type="button"
            className="link audit-code"
            title={t('web.audit_filter_by_action')}
            onClick={() => setQuery(route, 'action', row.action)}
          >
            <Ltr>{row.action}</Ltr>
          </button>
          {row.reason !== null && row.reason !== '' && (
            <span className="muted small">
              {t('web.audit_reason')} <bdi>{row.reason}</bdi>
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'entity',
      header: t('web.audit_col_entity'),
      wrap: true,
      render: (row) => <EntityCell row={row} route={route} onLink={onLink} />,
    },
    {
      key: 'result',
      header: t('web.audit_col_result'),
      render: (row) => (
        <span className="audit-badges">
          <Badge tone={RESULT_TONES[row.result]}>{t(RESULT_LABELS[row.result])}</Badge>
          {row.security
            .filter((slice) => slice !== 'DENIED')
            .map((slice) => (
              <Badge key={slice} tone={SECURITY_TONES[slice]}>
                {t(SECURITY_LABELS[slice])}
              </Badge>
            ))}
        </span>
      ),
    },
    {
      key: 'changes',
      header: t('web.audit_col_changes'),
      wrap: true,
      render: (row) => <ChangesCell row={row} />,
    },
  ];

  return (
    <>
      <PageHead
        title={t('web.audit_title')}
        subtitle={t('web.audit_intro')}
        {...(mayExport && !denied
          ? {
              actions: (
                <a
                  className="btn sm"
                  href={auditLogExportUrl(filters)}
                  download
                  title={t('web.audit_export_hint')}
                >
                  {t('web.audit_export_csv')}
                </a>
              ),
            }
          : {})}
      />

      <Card>
        <FilterBar hidden={!requestable}>
          <FilterChips label={t('web.audit_security_label')}>
            <FilterChip
              pressed={filters.security === undefined}
              onClick={() => setQuery(route, 'security', null)}
            >
              {t('web.audit_security_all')}
            </FilterChip>
            <ChipDivider />
            {AUDIT_SECURITY_FILTERS.map((slice) => (
              <FilterChip
                key={slice}
                pressed={filters.security === slice}
                onClick={() => setQuery(route, 'security', slice)}
              >
                {t(SECURITY_LABELS[slice])}
              </FilterChip>
            ))}
          </FilterChips>
        </FilterBar>

        <form className="toolbar audit-filters" onSubmit={apply} hidden={!requestable}>
          <Field
            label={t('web.audit_filter_actor')}
            hint={t('web.audit_filter_actor_hint')}
            htmlFor="audit-actor"
            compact
          >
            <input
              id="audit-actor"
              className="input sm"
              dir="ltr"
              value={draft.actor}
              onChange={(event) => edit({ actor: event.target.value })}
            />
          </Field>
          <Field label={t('web.audit_filter_actor_type')} htmlFor="audit-actor-type" compact>
            <select
              id="audit-actor-type"
              className="input sm"
              value={filters.actorType ?? ''}
              onChange={(event) => setQuery(route, 'actorType', event.target.value || null)}
            >
              <option value="">{t('web.audit_filter_all')}</option>
              {ACTOR_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(ACTOR_LABELS[type])}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('web.audit_filter_action')}
            hint={t('web.audit_filter_action_hint')}
            htmlFor="audit-action"
            compact
            {...(problems.action ? { error: t('web.audit_filter_action_invalid') } : {})}
          >
            <input
              id="audit-action"
              className="input sm"
              dir="ltr"
              value={draft.action}
              onChange={(event) => edit({ action: event.target.value })}
            />
          </Field>
          <Field label={t('web.audit_filter_entity_type')} htmlFor="audit-entity-type" compact>
            <select
              id="audit-entity-type"
              className="input sm"
              value={entityType}
              onChange={(event) => setQuery(route, 'entityType', event.target.value || null)}
            >
              <option value="">{t('web.audit_filter_all')}</option>
              {/* A type reached from a row's own link stays selectable even if unlisted. */}
              {entityType !== '' && ENTITY_LABELS[entityType] === undefined && (
                <option value={entityType}>{entityType}</option>
              )}
              {Object.entries(ENTITY_LABELS).map(([type, label]) => (
                <option key={type} value={type}>
                  {t(label)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('web.audit_filter_entity_id')}
            htmlFor="audit-entity-id"
            compact
            {...(problems.entity ? { error: t('web.audit_filter_entity_id_needs_type') } : {})}
          >
            <input
              id="audit-entity-id"
              className="input sm"
              dir="ltr"
              value={draft.entityId}
              onChange={(event) => edit({ entityId: event.target.value })}
            />
          </Field>
          <Field
            label={t('web.audit_filter_customer')}
            htmlFor="audit-customer"
            compact
            {...(problems.customer ? { error: t('web.audit_filter_customer_invalid') } : {})}
          >
            <input
              id="audit-customer"
              className="input sm"
              dir="ltr"
              value={draft.customerId}
              onChange={(event) => edit({ customerId: event.target.value })}
            />
          </Field>
          <Field label={t('web.audit_filter_result')} htmlFor="audit-result" compact>
            <select
              id="audit-result"
              className="input sm"
              value={filters.result ?? ''}
              onChange={(event) => setQuery(route, 'result', event.target.value || null)}
            >
              <option value="">{t('web.audit_filter_all')}</option>
              {AUDIT_RESULTS.map((result) => (
                <option key={result} value={result}>
                  {t(RESULT_LABELS[result])}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('web.audit_filter_from')} htmlFor="audit-from" compact>
            <input
              id="audit-from"
              className="input sm"
              type="date"
              value={draft.fromDay}
              onChange={(event) => edit({ fromDay: event.target.value })}
            />
          </Field>
          <Field
            label={t('web.audit_filter_to')}
            htmlFor="audit-to"
            compact
            {...(problems.dates ? { error: t('web.audit_filter_dates_invalid') } : {})}
          >
            <input
              id="audit-to"
              className="input sm"
              type="date"
              value={draft.toDay}
              onChange={(event) => edit({ toDay: event.target.value })}
            />
          </Field>
          <div className="audit-filter-actions">
            <button type="submit" className="btn primary sm" disabled={blocked}>
              {t('web.audit_apply')}
            </button>
            <button type="button" className="btn ghost sm" disabled={!filtering} onClick={clear}>
              {t('web.audit_clear')}
            </button>
          </div>
        </form>
        {requestable && <p className="muted small">{t('web.audit_no_secrets')}</p>}

        <StateSwitch
          query={log}
          denied={denied}
          isEmpty={rows.length === 0 && cursors.length === 0}
          empty={
            <Empty
              title={t(filtering ? 'web.audit_filter_empty' : 'web.audit_empty')}
              {...(filtering ? { hint: t('web.audit_empty_hint') } : {})}
              icon="inbox"
            />
          }
        >
          <DataTable
            caption={t('web.audit_title')}
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            dense
            rowClassName={(row) => (row.result === 'SUCCESS' ? undefined : 'audit-row-refused')}
          />
          <CursorPager
            shown={rows.length}
            hasPrevious={cursors.length > 0}
            hasNext={nextCursor !== null}
            onPrevious={() => setTrail({ signature, cursors: cursors.slice(0, -1) })}
            onNext={() =>
              nextCursor !== null && setTrail({ signature, cursors: [...cursors, nextCursor] })
            }
          />
        </StateSwitch>
      </Card>
    </>
  );
}

/**
 * The row's entity: its type, a link to it where the server says one exists, and a button
 * that narrows the log to it. The link targets are the server's (`links`), never built from
 * the entity type here — a link to an order the tenant does not have would be a dead end.
 */
function EntityCell({
  row,
  route,
  onLink,
}: {
  row: AuditLogEntry;
  route: Route;
  onLink: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}) {
  const label = ENTITY_LABELS[row.entityType];
  const targets: { key: string; href: string; label: WebKey }[] = [];
  const { links } = row;
  if (links.orderId !== null) {
    targets.push({ key: 'order', href: `/orders/${links.orderId}`, label: 'web.audit_link_order' });
  }
  if (links.paymentId !== null) {
    targets.push({
      key: 'payment',
      href: `/payments/${links.paymentId}`,
      label: 'web.audit_link_payment',
    });
  }
  if (links.serviceId !== null) {
    targets.push({
      key: 'service',
      href: `/services/${links.serviceId}`,
      label: 'web.audit_link_service',
    });
  }
  if (links.customerId !== null) {
    targets.push({
      key: 'customer',
      href: `/users/${links.customerId}`,
      label: 'web.audit_link_customer',
    });
  }
  return (
    <span className="cell-main">
      <span>
        {row.entityId === null ? (
          label === undefined ? (
            <Ltr>{row.entityType}</Ltr>
          ) : (
            t(label)
          )
        ) : (
          <button
            type="button"
            className="link"
            title={t('web.audit_filter_by_entity')}
            onClick={() =>
              setQueries(route, [
                ['entityType', row.entityType],
                ['entityId', row.entityId],
              ])
            }
          >
            {label === undefined ? <Ltr>{row.entityType}</Ltr> : t(label)}{' '}
            <Ltr>{row.entityId.slice(0, 8)}</Ltr>
          </button>
        )}
      </span>
      {targets.length > 0 && (
        <span className="audit-links">
          {targets.map((target) => (
            <a key={target.key} href={target.href} onClick={onLink}>
              {t(target.label)}
            </a>
          ))}
        </span>
      )}
    </span>
  );
}

/** Text for one recorded value: a string as itself, anything else as its JSON. */
function valueText(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * The fields a row RECORDED, side by side — only what the row holds. A row with neither
 * `before` nor `after` says so; nothing is reconstructed from the entity as it is today.
 */
export function recordedFieldsOf(
  row: Pick<AuditLogEntry, 'before' | 'after'>,
): readonly { field: string; before: unknown; after: unknown; changed: boolean }[] {
  const before = row.before ?? {};
  const after = row.after ?? {};
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return fields.map((field) => ({
    field,
    before: before[field],
    after: after[field],
    changed:
      row.before !== null &&
      row.after !== null &&
      JSON.stringify(before[field]) !== JSON.stringify(after[field]),
  }));
}

function ChangesCell({ row }: { row: AuditLogEntry }) {
  const fields = recordedFieldsOf(row);
  if (fields.length === 0) {
    return <span className="faint small">{t('web.audit_changes_none')}</span>;
  }
  return (
    <Disclosure
      size="sm"
      summary={t('web.audit_changes_fields').replace('{n}', String(fields.length))}
    >
      <table className="tbl dense audit-diff">
        <caption className="visually-hidden">{t('web.audit_changes_recorded')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('web.audit_field')}</th>
            {row.before !== null && <th scope="col">{t('web.audit_before')}</th>}
            {row.after !== null && <th scope="col">{t('web.audit_after')}</th>}
          </tr>
        </thead>
        <tbody>
          {fields.map((entry) => (
            <tr key={entry.field} className={entry.changed ? 'audit-diff-changed' : undefined}>
              <td>
                <Ltr>{entry.field}</Ltr>
              </td>
              {row.before !== null && (
                <td>
                  <Ltr>{valueText(entry.before)}</Ltr>
                </td>
              )}
              {row.after !== null && (
                <td>
                  <Ltr>{valueText(entry.after)}</Ltr>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        {t('web.audit_correlation')} <Ltr>{row.correlationId}</Ltr>
      </p>
    </Disclosure>
  );
}
