import { useId, useState, type ReactNode } from 'react';
import {
  PERMISSIONS,
  PERMISSION_DOMAINS,
  isPermissionKey,
  prerequisiteOf,
  type RiskLevel,
} from '@nexa/contracts';
import { t, type WebKey } from '../i18n/web.fa';
import { PERMISSION_DOMAIN_LABELS, PERMISSION_LABELS } from '../rbac-labels';
import { formatNumber } from '../format';
import { Icon } from './icons';
import { Badge, Ltr } from './kit';

/**
 * The permission catalogue (W1.7) — the roles page, the role create/edit drawer and the
 * effective-permission preview draw permissions through this one component.
 *
 * One collapsible card per domain in a 2–3 column grid, with a count and «N بحرانی»; rows show
 * a view/change icon and the risk badge, critical permissions first, the raw key in `title`
 * and small LTR. Search, «فقط بحرانی‌ها», «باز کردن همه / بستن همه»; cards start collapsed
 * when there are more than 24 permissions (a search or the critical filter opens every card
 * that has a match). A «فهرست / جدول مقایسه» toggle draws a matrix (roles as columns,
 * permissions as rows) when `matrix` is given.
 *
 * In `edit` mode the rows are checkboxes (`<idPrefix>-perm-<key with dashes>`) and each card
 * has «انتخاب همه / هیچ‌کدام». The component decides NOTHING about what may be granted: every
 * toggle goes to the page, which keeps its rules (auto-added requirements, dependent removal,
 * typed confirmation for critical changes, refusal to grant what the actor does not hold). A
 * row `isLocked` names is disabled and never toggled, neither alone nor by a card's buttons.
 */
export interface PermissionMatrixColumn {
  readonly key: string;
  readonly label: string;
  readonly has: (permission: string) => boolean;
}

export interface PermissionCatalogProps {
  /** The permission keys to draw (any subset of the contract's `PERMISSIONS`). */
  keys: readonly string[];
  mode: 'view' | 'edit';
  /** Edit mode: what is checked. */
  selected?: ReadonlySet<string>;
  /** Edit mode: one row toggled; the page applies its rules. */
  onToggle?: (key: string, next: boolean) => void;
  /**
   * Edit mode: «انتخاب همه» (`true`) / «هیچ‌کدام» (`false`) for one card's keys. Only the keys
   * that would change and are not locked are passed. Absent → the card draws no such buttons.
   */
  onToggleMany?: (keys: readonly string[], next: boolean) => void;
  /** Edit mode: a row the actor may not change (e.g. a permission they do not hold). */
  isLocked?: (key: string) => boolean;
  /**
   * Extra note under a row (e.g. «لازمهٔ …، خودکار افزوده شد»).
   */
  noteFor?: (key: string) => ReactNode;
  /** Extra badges after a row's name (e.g. the via-grant badge in the effective preview). */
  badgeFor?: (key: string) => ReactNode;
  /**
   * When present, the «جدول مقایسه» view is offered.
   */
  matrix?: readonly PermissionMatrixColumn[];
  /** DOM id prefix, so two catalogues on one page do not collide. Default `rbac`. */
  idPrefix?: string;
  /** Which of the two views opens first (`matrix` needs `matrix`); `list` by default. */
  initialView?: 'list' | 'matrix';
}

/** Cards start collapsed above this many permissions. */
export const PERMISSION_CATALOG_COLLAPSE_ABOVE = 24;

const RISK_TONE: Record<RiskLevel, 'neutral' | 'info' | 'warn' | 'danger'> = {
  LOW: 'neutral',
  MEDIUM: 'info',
  HIGH: 'warn',
  CRITICAL: 'danger',
};
const RISK_LABEL: Record<RiskLevel, WebKey> = {
  LOW: 'web.rbac_risk_low',
  MEDIUM: 'web.rbac_risk_medium',
  HIGH: 'web.rbac_risk_high',
  CRITICAL: 'web.rbac_risk_critical',
};
const RISK_OF = new Map<string, RiskLevel>(PERMISSIONS.map((one) => [one.key, one.riskLevel]));
const ORDER = new Map<string, number>(PERMISSIONS.map((one, index) => [one.key, index]));

function riskOf(key: string): RiskLevel {
  return RISK_OF.get(key) ?? 'LOW';
}
/** A catalogued key's Persian name; anything else is shown as itself, never dropped. */
export function permissionLabel(key: string): string {
  return isPermissionKey(key) ? t(PERMISSION_LABELS[key]) : key;
}
function domainOf(key: string): string {
  return key.split('.')[0] ?? key;
}
function domainLabel(domain: string): string {
  const known = (PERMISSION_DOMAIN_LABELS as Readonly<Record<string, WebKey>>)[domain];
  return known === undefined ? domain : t(known);
}
/** A read (`*.view`) or a change. */
function isView(key: string): boolean {
  return key.endsWith('.view');
}

interface Section {
  readonly domain: string;
  readonly keys: readonly string[];
}

/** Domains in catalogue order (unknown ones after), critical first inside each. */
export function permissionSections(keys: readonly string[]): Section[] {
  const byDomain = new Map<string, string[]>();
  for (const key of keys) {
    const domain = domainOf(key);
    byDomain.set(domain, [...(byDomain.get(domain) ?? []), key]);
  }
  const known = PERMISSION_DOMAINS.filter((domain) => byDomain.has(domain));
  const unknown = [...byDomain.keys()].filter((domain) => !known.includes(domain as never)).sort();
  return [...known, ...unknown].map((domain) => ({
    domain,
    keys: [...(byDomain.get(domain) ?? [])].sort((a, b) => {
      const critical = Number(riskOf(b) === 'CRITICAL') - Number(riskOf(a) === 'CRITICAL');
      if (critical !== 0) return critical;
      return (ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) - (ORDER.get(b) ?? Number.MAX_SAFE_INTEGER);
    }),
  }));
}

export function PermissionCatalog({
  keys,
  mode,
  selected,
  onToggle,
  onToggleMany,
  isLocked,
  noteFor,
  badgeFor,
  matrix,
  idPrefix = 'rbac',
  initialView = 'list',
}: PermissionCatalogProps) {
  const [search, setSearch] = useState('');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [view, setView] = useState<'list' | 'matrix'>(matrix === undefined ? 'list' : initialView);
  const startCollapsed = keys.length > PERMISSION_CATALOG_COLLAPSE_ABOVE;
  const [openCards, setOpenCards] = useState<ReadonlySet<string>>(() =>
    startCollapsed ? new Set() : new Set(keys.map(domainOf)),
  );
  const needle = search.trim().toLowerCase();
  const filtering = needle !== '' || criticalOnly;
  const matches = (key: string) =>
    (!criticalOnly || riskOf(key) === 'CRITICAL') &&
    (needle === '' ||
      key.toLowerCase().includes(needle) ||
      permissionLabel(key).toLowerCase().includes(needle) ||
      domainLabel(domainOf(key)).toLowerCase().includes(needle));
  const sections = permissionSections(keys)
    .map((section) => ({ ...section, shown: section.keys.filter(matches) }))
    .filter((section) => section.shown.length > 0);
  /*
   * A search or «فقط بحرانی‌ها» opens every matching card — but the header still folds one
   * (PR #285 review, A6): what the operator folded under THIS filter is held apart from the
   * unfiltered choice and forgotten when the filter changes, so a new search shows every
   * match again and clearing it returns the cards to how they were.
   */
  const filterSignature = `${criticalOnly ? '1' : '0'}|${needle}`;
  const [filterFolded, setFilterFolded] = useState<{
    signature: string;
    domains: ReadonlySet<string>;
  }>({ signature: '', domains: new Set() });
  const folded =
    filterFolded.signature === filterSignature ? filterFolded.domains : new Set<string>();
  const isOpen = (domain: string) => (filtering ? !folded.has(domain) : openCards.has(domain));
  const toggleCard = (domain: string) => {
    if (filtering) {
      const next = new Set(folded);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      setFilterFolded({ signature: filterSignature, domains: next });
      return;
    }
    setOpenCards((current) => {
      const next = new Set(current);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };
  const locked = (key: string) => isLocked?.(key) === true;
  const toolbarId = useId();

  return (
    <div className="perm-cat" data-view={view}>
      <div className="perm-cat-tools" role="group" aria-labelledby={toolbarId}>
        <span id={toolbarId} className="visually-hidden">
          {t('web.rbac_search')}
        </span>
        <input
          id={`${idPrefix}-search`}
          className="input sm perm-cat-search"
          type="search"
          aria-label={t('web.rbac_search')}
          placeholder={t('web.rbac_search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <button
          type="button"
          className={`chip${criticalOnly ? ' on' : ''}`}
          aria-pressed={criticalOnly}
          onClick={() => setCriticalOnly(!criticalOnly)}
        >
          {t('web.pc_critical_only')}
        </button>
        {view === 'list' && (
          <>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setOpenCards(new Set(keys.map(domainOf)));
                setFilterFolded({ signature: filterSignature, domains: new Set() });
              }}
            >
              {t('web.pc_expand_all')}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setOpenCards(new Set());
                setFilterFolded({
                  signature: filterSignature,
                  domains: new Set(keys.map(domainOf)),
                });
              }}
            >
              {t('web.pc_collapse_all')}
            </button>
          </>
        )}
        {matrix !== undefined && (
          <div className="btn-group segmented perm-cat-switch" role="group">
            <button
              type="button"
              className="btn sm"
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              {t('web.pc_view_list')}
            </button>
            <button
              type="button"
              className="btn sm"
              aria-pressed={view === 'matrix'}
              onClick={() => setView('matrix')}
            >
              {t('web.pc_view_matrix')}
            </button>
          </div>
        )}
      </div>

      {sections.length === 0 && <p className="muted small">{t('web.pc_no_match')}</p>}

      {view === 'matrix' && matrix !== undefined ? (
        <PermissionMatrixTable sections={sections} columns={matrix} />
      ) : (
        <div className="perm-cat-grid">
          {sections.map((section) => {
            const open = isOpen(section.domain);
            const critical = section.keys.filter((key) => riskOf(key) === 'CRITICAL').length;
            const held =
              selected === undefined
                ? null
                : section.keys.filter((key) => selected.has(key)).length;
            const bodyId = `${idPrefix}-domain-${section.domain}`;
            const changeable = section.shown.filter((key) => !locked(key));
            return (
              <section key={section.domain} className={`perm-card${open ? ' open' : ''}`}>
                <button
                  type="button"
                  className="perm-card-head"
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => toggleCard(section.domain)}
                >
                  <Icon name="chevron" size={12} className="perm-card-caret" />
                  <span className="perm-card-title">{domainLabel(section.domain)}</span>
                  <span className="perm-card-count num">
                    {mode === 'edit' && held !== null
                      ? `${formatNumber(held)}/${formatNumber(section.keys.length)}`
                      : formatNumber(section.keys.length)}
                  </span>
                  {critical > 0 && (
                    <Badge tone="danger">
                      {t('web.pc_critical_count').replace('{n}', formatNumber(critical))}
                    </Badge>
                  )}
                </button>
                {open && (
                  <div className="perm-card-body" id={bodyId}>
                    {mode === 'edit' && onToggleMany !== undefined && (
                      <div className="perm-card-bulk">
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={changeable.every((key) => selected?.has(key) === true)}
                          onClick={() =>
                            onToggleMany(
                              changeable.filter((key) => selected?.has(key) !== true),
                              true,
                            )
                          }
                        >
                          {t('web.pc_select_all')}
                        </button>
                        <button
                          type="button"
                          className="btn sm ghost"
                          disabled={changeable.every((key) => selected?.has(key) !== true)}
                          onClick={() =>
                            onToggleMany(
                              changeable.filter((key) => selected?.has(key) === true),
                              false,
                            )
                          }
                        >
                          {t('web.pc_select_none')}
                        </button>
                      </div>
                    )}
                    <ul className="perm-rows">
                      {section.shown.map((key) => (
                        <PermissionRow
                          key={key}
                          permission={key}
                          mode={mode}
                          checked={selected?.has(key) === true}
                          locked={locked(key)}
                          id={`${idPrefix}-perm-${key.replace(/\./g, '-')}`}
                          onToggle={onToggle}
                          note={noteFor?.(key)}
                          badge={badgeFor?.(key)}
                        />
                      ))}
                    </ul>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PermissionRow({
  permission,
  mode,
  checked,
  locked,
  id,
  onToggle,
  note,
  badge,
}: {
  permission: string;
  mode: 'view' | 'edit';
  checked: boolean;
  locked: boolean;
  id: string;
  onToggle: ((key: string, next: boolean) => void) | undefined;
  note: ReactNode;
  badge: ReactNode;
}) {
  const risk = riskOf(permission);
  const requires = mode === 'edit' ? prerequisiteOf(permission) : null;
  const text = (
    <span className="perm-row-text">
      <span className="perm-row-name">
        <Icon
          name={isView(permission) ? 'eye' : 'edit'}
          size={13}
          className="perm-row-kind"
          aria-label={isView(permission) ? t('web.pc_kind_view') : t('web.pc_kind_change')}
          role="img"
          aria-hidden={undefined}
        />
        <span>{permissionLabel(permission)}</span>
        {risk !== 'LOW' && <Badge tone={RISK_TONE[risk]}>{t(RISK_LABEL[risk])}</Badge>}
        {badge}
      </span>
      <span className="perm-row-key">
        <Ltr>{permission}</Ltr>
      </span>
      {requires !== null && (
        <span className="faint small">
          {t('web.rbac_requires').replace('{requires}', permissionLabel(requires))}
        </span>
      )}
      {note !== undefined && note !== null && note !== false && (
        <span className="small perm-row-note">{note}</span>
      )}
    </span>
  );
  if (mode === 'view') {
    return (
      <li className={`perm-row risk-${risk.toLowerCase()}`} title={permission}>
        {text}
      </li>
    );
  }
  return (
    <li className={`perm-row risk-${risk.toLowerCase()}${locked ? ' locked' : ''}`}>
      <label htmlFor={id} className="checkbox perm-row-check" title={permission}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={locked}
          onChange={(event) => {
            if (!locked) onToggle?.(permission, event.target.checked);
          }}
        />
        {text}
      </label>
    </li>
  );
}

function PermissionMatrixTable({
  sections,
  columns,
}: {
  sections: readonly (Section & { shown: readonly string[] })[];
  columns: readonly PermissionMatrixColumn[];
}) {
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="perm-matrix-wrap">
      <table className="perm-matrix">
        <thead>
          <tr>
            <th scope="col">{t('web.pc_matrix_permission')}</th>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        {sections.map((section) => {
          const open = !closed.has(section.domain);
          return (
            <tbody key={section.domain}>
              <tr className="perm-matrix-section">
                <th scope="rowgroup">
                  <button
                    type="button"
                    className="perm-matrix-toggle"
                    aria-expanded={open}
                    onClick={() =>
                      setClosed((current) => {
                        const next = new Set(current);
                        if (next.has(section.domain)) next.delete(section.domain);
                        else next.add(section.domain);
                        return next;
                      })
                    }
                  >
                    <Icon name="chevron" size={12} />
                    {domainLabel(section.domain)}
                  </button>
                </th>
                {columns.map((column) => (
                  <td key={column.key} className="num">
                    {formatNumber(section.shown.filter((key) => column.has(key)).length)}
                  </td>
                ))}
              </tr>
              {open &&
                section.shown.map((key) => (
                  <tr key={key}>
                    <th scope="row" title={key}>
                      {permissionLabel(key)}
                      {riskOf(key) === 'CRITICAL' && (
                        <Badge tone="danger">{t('web.rbac_risk_critical')}</Badge>
                      )}
                    </th>
                    {columns.map((column) => (
                      <td key={column.key} className="perm-matrix-cell">
                        {column.has(key) ? (
                          <span role="img" aria-label={t('web.pc_has')}>
                            <Icon name="check" size={14} />
                          </span>
                        ) : (
                          <span className="visually-hidden">{t('web.pc_lacks')}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
