import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { productCode, productCodeNumberFromSearch, publicCodeFromSearch } from '@nexa/contracts';
import { fetchGlobalSearch, fetchInfo } from './api/client';
import {
  GLOBAL_SEARCH_DEBOUNCE_MS,
  GLOBAL_SEARCH_MIN_CHARS,
  searchGroupLabel,
  searchHitPath,
  searchHitStateLabel,
  useDebouncedValue,
} from './global-search';
import { t, type WebKey } from './i18n/web.fa';
import { navigate, useLinkHandler } from './router';
import type { ThemeChoice } from './theme';
import { Icon, type IconName } from './ui/icons';
import { Menu, confirmDialogOpen, useFocusTrap } from './ui/kit';
import { formatNumber } from './format';
import { GROUP_ORDER, NAV_STANDALONE_GROUP, isCurrent, navGroupOf, type NavEntry } from './nav';
import type { NavCounter, NavCounters } from './nav-counters';
import { roleLabel } from './rbac-labels';

/**
 * The pieces of the signed-in shell: the sidebar, the topbar and the command
 * search. `app.tsx` composes them around the route table; nothing here knows
 * which page is showing beyond the path it is given.
 */

/* ---------------------------------------------------------- build identity --- */

/**
 * The build the server reports (`GET /health/info`, session-only). Read once
 * per session and never refetched on a timer: a deploy restarts the API and a
 * reload picks up the new build, and a failure simply draws no identity — the
 * shell never guesses a version.
 */
function useBuildInfo() {
  return useQuery({
    queryKey: ['info'],
    queryFn: fetchInfo,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/* ----------------------------------------------------------------- sidebar --- */

/**
 * What a CLOSED group's header shows: its children's counters, summed, so a waiting ticket or
 * a payment to review is not hidden by folding the group away. The most severe tone wins, and
 * a sum including a capped count is itself a floor.
 */
export function sumCounters(
  members: readonly NavEntry[],
  counters: NavCounters,
): NavCounter | undefined {
  const present = members
    .map((entry) => counters[entry.id])
    .filter((counter): counter is NavCounter => counter !== undefined && counter.count > 0);
  if (present.length === 0) return undefined;
  const tones = present.map((counter) => counter.tone);
  const tone = tones.includes('danger') ? 'danger' : tones.includes('warn') ? 'warn' : undefined;
  return {
    count: present.reduce((sum, counter) => sum + counter.count, 0),
    ...(tone === undefined ? {} : { tone }),
    ...(present.some((counter) => counter.atLeast === true) ? { atLeast: true as const } : {}),
  };
}

const THEME_ORDER: readonly ThemeChoice[] = ['system', 'dark', 'light'];
const THEME_LABEL: Readonly<Record<ThemeChoice, WebKey>> = {
  system: 'web.theme_system',
  dark: 'web.theme_dark',
  light: 'web.theme_light',
};
const THEME_ICON: Readonly<Record<ThemeChoice, IconName>> = {
  system: 'monitor',
  dark: 'moon',
  light: 'sun',
};

export function Sidebar({
  entries,
  currentPath,
  collapsed,
  onToggle,
  counters,
  theme,
  onTheme,
  onIntent,
  drawer = false,
  onDismiss,
}: {
  entries: readonly NavEntry[];
  currentPath: string;
  collapsed: boolean;
  onToggle: () => void;
  /**
   * The sidebar is open as a DRAWER over the page (a narrow screen): focus
   * moves into it, Tab stays in it, and Escape dismisses it — the controls
   * behind the scrim are not reachable while it covers them.
   */
  drawer?: boolean;
  onDismiss?: () => void;
  counters: NavCounters;
  theme: ThemeChoice;
  onTheme: (next: ThemeChoice) => void;
  /**
   * The operator is pointing at, or has focused, a link: the moment a page's first
   * screen can be asked for before the click lands (`nav-prefetch.ts`).
   */
  onIntent?: (path: string) => void;
}) {
  const onLink = useLinkHandler();
  const info = useBuildInfo();
  const describedBy = useId();
  const { next: nextTheme, label: themeLabel, icon: themeIcon } = themeToggle(theme);
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, drawer, () => onDismiss?.());

  /*
   * The single-open accordion. Local state, seeded from the group that OWNS the current
   * route, so a deep link renders with its group open on the first paint. Every navigation
   * re-opens the owning group (and so closes any other) — keyed on the PATH, not the owning
   * group: an operator who opened another group, or closed this one, and then moved to a
   * sibling page in the same group must still see the page they are on highlighted. The
   * owning group is also re-checked when it changes for the same path (permissions arriving).
   * Nothing is persisted: the route already says which group matters.
   */
  const owner = navGroupOf(entries, currentPath);
  const [open, setOpen] = useState<WebKey | null>(owner);
  const [seen, setSeen] = useState({ path: currentPath, owner });
  if (currentPath !== seen.path || owner !== seen.owner) {
    setSeen({ path: currentPath, owner });
    if (owner !== null) setOpen(owner);
  }

  const link = (entry: NavEntry) => {
    const counter = counters[entry.id];
    const countId = `${describedBy}-${entry.id}`;
    return (
      <a
        key={entry.id}
        href={entry.path}
        onClick={onLink}
        onPointerEnter={() => onIntent?.(entry.path)}
        onFocus={() => onIntent?.(entry.path)}
        aria-current={isCurrent(entry.path, currentPath) ? 'page' : undefined}
        title={collapsed ? t(entry.label) : undefined}
        {...(counter === undefined ? {} : { 'aria-describedby': countId })}
      >
        <Icon name={entry.icon} size={15} className="ico" />
        <span className="lbl">{t(entry.label)}</span>
        {counter !== undefined && (
          /*
            The count is the link's description (aria-describedby)
            and, sitting inside the link, also follows the label in
            its name — so what is read there must be true: a capped
            count says "or more" in both, never an exact figure.
          */
          <span
            className={`cnt${counter.tone === undefined ? '' : ` ${counter.tone}`}`}
            id={countId}
          >
            {counter.atLeast === true ? (
              /*
                At the server's cap the number is a floor: drawn with a
                plus, and described as "or more" rather than as a total.
              */
              <>
                <span aria-hidden="true">
                  {t('web.nav_counter_at_least').replace('{count}', formatNumber(counter.count))}
                </span>
                <span className="visually-hidden">
                  {t('web.nav_counter_at_least_spoken').replace(
                    '{count}',
                    formatNumber(counter.count),
                  )}
                </span>
              </>
            ) : (
              formatNumber(counter.count)
            )}
          </span>
        )}
      </a>
    );
  };

  return (
    <aside className="sidebar" id="app-sidebar" ref={ref}>
      {/*
        The brand block, as the reference draws it: the N tile, the letter-spaced wordmark and
        the console's subtitle. The installation this console is connected to is no longer a card of its
        own here: it is a line in the owner pill's menu (`Topbar`), at the demo's density.
      */}
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span className="brand-text">
          <strong className="wordmark" title={t('web.title')}>
            {t('web.brand_wordmark')}
          </strong>
          <span>{t('web.subtitle')}</span>
        </span>
      </div>

      <nav className="nav" aria-label={t('web.nav_label')}>
        {GROUP_ORDER.map((group) => {
          const members = entries.filter((entry) => entry.group === group);
          // Permission filtering happened before this point (`entries`): a group with no
          // link the actor may see is not drawn at all, header included.
          if (members.length === 0) return null;
          if (group === NAV_STANDALONE_GROUP) {
            return (
              <div
                className="nav-group nav-standalone"
                key={group}
                role="group"
                aria-label={t(group)}
              >
                {members.map(link)}
              </div>
            );
          }
          if (collapsed) {
            // The icon rail has no room for a header's label, so it keeps every icon with a
            // divider between groups; the accordion is the labelled sidebar's.
            return (
              <div className="nav-group" key={group} role="group" aria-label={t(group)}>
                <div className="nav-group-label" aria-hidden="true">
                  {t(group)}
                </div>
                {members.map(link)}
              </div>
            );
          }
          const expanded = open === group;
          const panelId = `${describedBy}-group-${group}`;
          const total = expanded ? undefined : sumCounters(members, counters);
          return (
            <div
              className={`nav-group nav-section${expanded ? ' open' : ''}`}
              key={group}
              role="group"
              aria-label={t(group)}
            >
              <button
                type="button"
                className="nav-group-head"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setOpen(expanded ? null : group)}
              >
                <span className="lbl">{t(group)}</span>
                {total !== undefined && (
                  /*
                    A closed group with something waiting shows the reference's amber dot, read
                    from the same counters its links carry (no counter, no dot). The sum is
                    still HEARD in the header's name, a capped one as a floor.
                  */
                  <>
                    <span className="gdot" aria-hidden="true" data-testid="nav-group-dot" />
                    <span className="visually-hidden">
                      {total.atLeast === true
                        ? t('web.nav_counter_at_least_spoken').replace(
                            '{count}',
                            formatNumber(total.count),
                          )
                        : formatNumber(total.count)}
                    </span>
                  </>
                )}
                <Icon name="chevron" size={12} className="chev" />
              </button>
              {/* Always in the DOM, so `aria-controls` names a real element; `hidden` keeps a
                  closed group's links out of the tab order and the accessibility tree. */}
              <div className="nav-group-items" id={panelId} hidden={!expanded}>
                {expanded && members.map(link)}
              </div>
            </div>
          );
        })}
      </nav>

      {/* The reference's footer: the build line, then compact mode and the theme. */}
      <div className="sidebar-foot">
        {info.data !== undefined && (
          <span className="build-id" title={`${t('web.build_identity')} — ${info.data.buildTime}`}>
            <span className="ltr mono">{`v${info.data.version} · ${info.data.commit.slice(0, 7)}`}</span>
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={t('web.toggle_sidebar')}
          title={t('web.toggle_sidebar')}
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          onClick={onToggle}
        >
          <Icon name="sidebar" size={15} />
        </button>
        <button
          type="button"
          className="btn ghost icon sm"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={() => onTheme(nextTheme)}
        >
          <Icon name={themeIcon} size={15} />
        </button>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------- bottom nav --- */

/**
 * The phone's bottom navigation (the Liquid Glass capsule): four destinations
 * and the menu. Shown by CSS at phone widths only. A destination is drawn only
 * when the permission-filtered `entries` the sidebar receives contain its path —
 * nothing here decides a permission — and its badge is the sidebar's counter
 * for the same entry. The order is the demo's, overview at the inline start.
 */
export const BOTTOM_NAV: readonly { path: string; label: WebKey }[] = [
  { path: '/', label: 'web.nav_overview' },
  { path: '/business-chats', label: 'web.bottom_nav_chats' },
  { path: '/payments', label: 'web.bottom_nav_payments' },
  { path: '/users', label: 'web.nav_users' },
];

export function BottomNav({
  entries,
  currentPath,
  counters,
  collapsed,
  onOpenMenu,
}: {
  entries: readonly NavEntry[];
  currentPath: string;
  counters: NavCounters;
  /** Whether the sidebar drawer is closed — the menu button's `aria-expanded`, as the topbar's. */
  collapsed: boolean;
  onOpenMenu: () => void;
}) {
  const onLink = useLinkHandler();
  const describedBy = useId();
  return (
    <nav className="bottom-nav" aria-label={t('web.bottom_nav_label')}>
      {BOTTOM_NAV.map((item) => {
        const entry = entries.find((candidate) => candidate.path === item.path);
        if (entry === undefined) return null;
        // The sidebar's own rule: a counter present is drawn (the server omits zeros).
        const shown = counters[entry.id];
        const countId = `${describedBy}-${entry.id}`;
        return (
          <a
            key={entry.id}
            href={entry.path}
            onClick={onLink}
            aria-current={isCurrent(entry.path, currentPath) ? 'page' : undefined}
            {...(shown === undefined ? {} : { 'aria-describedby': countId })}
          >
            <span className="bn-ico">
              <Icon name={entry.icon} size={19} />
              {shown !== undefined && (
                <span
                  className={`cnt${shown.tone === undefined ? '' : ` ${shown.tone}`}`}
                  id={countId}
                >
                  {shown.atLeast === true ? (
                    <>
                      <span aria-hidden="true">
                        {t('web.nav_counter_at_least').replace(
                          '{count}',
                          formatNumber(shown.count),
                        )}
                      </span>
                      <span className="visually-hidden">
                        {t('web.nav_counter_at_least_spoken').replace(
                          '{count}',
                          formatNumber(shown.count),
                        )}
                      </span>
                    </>
                  ) : (
                    formatNumber(shown.count)
                  )}
                </span>
              )}
            </span>
            <span className="lbl">{t(item.label)}</span>
          </a>
        );
      })}
      {/* Named by its visible label, so it is not a second «open menu» beside the topbar's. */}
      <button
        type="button"
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        onClick={onOpenMenu}
      >
        <span className="bn-ico">
          <Icon name="menu" size={19} />
        </span>
        <span className="lbl">{t('web.bottom_nav_menu')}</span>
      </button>
    </nav>
  );
}

/* ------------------------------------------------------------------ topbar --- */

/** The theme toggle, shared by the topbar and the sidebar's footer: one cycle, one label. */
export function themeToggle(theme: ThemeChoice) {
  return {
    next: THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? 'system',
    label: `${t('web.theme')}: ${t(THEME_LABEL[theme])}`,
    icon: THEME_ICON[theme],
  } as const;
}

/**
 * The top bar, as the reference composes it (demo parity A1 / X11): the search pill on the
 * sidebar's side, wide, with its Ctrl K hint; at the other end, from the edge inward, the owner
 * pill, the theme, the notification bell, help and the menu — every one a round glass
 * button. The page's title is not here: it is the page header's (`PageHead`).
 */
export function Topbar({
  collapsed,
  onMenu,
  onSearch,
  admin,
  onSignOut,
  theme,
  onTheme,
  bell,
}: {
  collapsed: boolean;
  /** The ≡ button: folds the sidebar to its rail at a desk, opens it as a drawer below that. */
  onMenu: () => void;
  onSearch: () => void;
  admin: { displayName: string; roleKeys: readonly string[] };
  onSignOut: () => void;
  theme: ThemeChoice;
  onTheme: (next: ThemeChoice) => void;
  /** Phase B3: the notification bell. */
  bell?: React.ReactNode;
}) {
  const info = useBuildInfo();
  const initial = Array.from(admin.displayName.trim())[0] ?? '·';
  // C1: each role by its Persian name; an unknown key is shown as itself, never blank.
  const roles = admin.roleKeys.map((key) => roleLabel(key)).join(t('web.list_separator')) || '—';
  const roleKeys = admin.roleKeys.join(', ');
  const toggle = themeToggle(theme);
  return (
    <header className="topbar">
      <button
        type="button"
        className="search-trigger"
        onClick={onSearch}
        aria-keyshortcuts="Control+K"
        aria-label={t('web.search_label')}
      >
        <Icon name="search" size={14} />
        <span>{t('web.search_open')}</span>
        <kbd>Ctrl K</kbd>
      </button>

      <span className="spacer" />

      <button
        type="button"
        className="btn ghost icon menu-toggle"
        aria-label={t('web.open_menu')}
        title={t('web.open_menu')}
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        onClick={onMenu}
      >
        <Icon name="menu" />
      </button>

      <Menu
        label={t('web.help')}
        triggerClassName="btn ghost icon help-trigger"
        trigger={
          <span className="help-glyph" aria-hidden="true">
            ?
          </span>
        }
        items={[
          { key: 'keys', heading: t('web.help_shortcuts') },
          { key: 'search', label: t('web.help_search'), icon: 'search', onSelect: onSearch },
        ]}
      />

      {bell}

      <button
        type="button"
        className="btn ghost icon theme-trigger"
        aria-label={toggle.label}
        title={toggle.label}
        onClick={() => onTheme(toggle.next)}
      >
        <Icon name={toggle.icon} />
      </button>

      <Menu
        label={t('web.user_menu')}
        triggerClassName="btn ghost user-trigger"
        trigger={
          <>
            <span className="avatar" aria-hidden="true">
              {initial}
            </span>
            {/* Seen: the role (A1). The name is in the menu's heading, and read here. */}
            <span className="visually-hidden">{admin.displayName}</span>
            <span className="who-name" title={roleKeys}>
              {roles}
            </span>
            <Icon name="chevron" size={13} className="who-chev" />
          </>
        }
        items={[
          { key: 'who', heading: `${admin.displayName} · ${roles}` },
          /*
            The installation this console is connected to, compact (demo parity A3). No contract
            carries a store or tenant display name, so the title is the product's own name and
            the line beside it the environment and service the server reports
            (`GET /health/info`) — never the host. The session carries one tenant and no way to
            switch, so this is a line, not a choice.
          */
          {
            key: 'identity',
            heading: (
              <span className="identity" aria-label={t('web.identity_label')} role="group">
                <i className={`dot ${info.data === undefined ? '' : 'ok'}`} aria-hidden="true" />
                <span className="identity-name">{t('web.title')}</span>
                {info.data !== undefined && (
                  <span className="identity-env">
                    <span className="ltr">{`${info.data.environment} · ${info.data.name}`}</span>
                  </span>
                )}
              </span>
            ),
          },
          { key: 'sep', separator: true },
          // Phase D2: the administrator's own account and its security section.
          {
            key: 'account',
            label: t('web.account_title'),
            icon: 'shield',
            onSelect: () => navigate('/account'),
          },
          {
            key: 'sign-out',
            label: t('web.sign_out'),
            icon: 'logout',
            onSelect: onSignOut,
            danger: true,
          },
        ]}
      />
    </header>
  );
}

/* ---------------------------------------------------------- command search --- */

/**
 * Round 4, PR-C: the command search also takes a short public code. An 8-character code may
 * be an order's, a service's, a payment's or a ticket's — the alphabet does not say which —
 * so it is offered as a search of each of those lists the operator can open; `P-102` is
 * offered as a search of the products. Still navigation only: the list's own search, under
 * the list's own permission, finds the record. Nothing is fetched here, and a list the
 * sidebar does not draw for this operator is not offered.
 */
const CODE_SEARCH_TARGETS: readonly {
  readonly path: string;
  readonly param: string;
  readonly label: WebKey;
}[] = [
  { path: '/orders', param: 'q', label: 'web.search_code_orders' },
  { path: '/payments', param: 'q', label: 'web.search_code_payments' },
  { path: '/services', param: 'q', label: 'web.search_code_services' },
  { path: '/tickets', param: 'customer', label: 'web.search_code_tickets' },
];

export function codeSearchEntries(query: string, entries: readonly NavEntry[]): NavEntry[] {
  const code = publicCodeFromSearch(query);
  if (code !== null) {
    return CODE_SEARCH_TARGETS.flatMap((target) => {
      const entry = entries.find((one) => one.path === target.path);
      if (entry === undefined) return [];
      return [
        {
          ...entry,
          id: `code:${target.path}`,
          path: `${target.path}?${new URLSearchParams({ [target.param]: code }).toString()}`,
          label: target.label,
        },
      ];
    });
  }
  const productNumber = productCodeNumberFromSearch(query);
  const products = entries.find((one) => one.path === '/products');
  if (productNumber === null || products === undefined) return [];
  return [
    {
      ...products,
      id: 'code:/products',
      path: `/products?${new URLSearchParams({ title: productCode(productNumber) }).toString()}`,
      label: 'web.search_code_products',
    },
  ];
}

/**
 * Ctrl+K: the top-bar search. It does two things for one string.
 *
 * PAGES: client-side over the SAME entries the sidebar draws — exactly the links the operator
 * already has, never a page the navigation hides.
 *
 * RECORDS (R11 A1): customers, orders and services, from `GET /search`. The server returns only
 * the kinds this operator may read (each kind's own list permission); a kind that is absent is
 * not drawn and nothing here derives a permission. The request starts at two characters, after
 * a short pause, and a failure only says the record search did not run — the pages still work.
 */
export function CommandSearch({
  entries,
  onClose,
}: {
  entries: readonly NavEntry[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  useFocusTrap(ref, true, onClose, input);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return entries;
    return [
      // PR-C: a short public code goes straight to the lists it can name.
      ...codeSearchEntries(query, entries),
      ...entries.filter(
        (entry) =>
          t(entry.label).toLowerCase().includes(needle) ||
          t(entry.group).toLowerCase().includes(needle) ||
          entry.path.toLowerCase().includes(needle),
      ),
    ];
  }, [entries, query]);

  const settled = useDebouncedValue(query.trim(), GLOBAL_SEARCH_DEBOUNCE_MS);
  const searchable = settled.length >= GLOBAL_SEARCH_MIN_CHARS;
  const records = useQuery({
    queryKey: ['global-search', settled],
    queryFn: () => fetchGlobalSearch(settled),
    enabled: searchable,
    staleTime: 15_000,
    retry: false,
  });
  // Only an answer for the text that is still in the box is drawn.
  const groups = searchable && query.trim() === settled ? (records.data?.groups ?? []) : [];
  const recordOptions = groups.flatMap((group) =>
    group.hits.map((hit) => ({ kind: group.kind, hit, path: searchHitPath(group.kind, hit.id) })),
  );
  const optionCount = results.length + recordOptions.length;

  const goTo = (path: string) => {
    onClose();
    navigate(path);
  };
  const go = (entry: NavEntry | undefined) => {
    if (entry === undefined) return;
    goTo(entry.path);
  };
  const goActive = () => {
    const record = recordOptions[active - results.length];
    if (active < results.length) go(results[active]);
    else if (record !== undefined) goTo(record.path);
  };

  const optionId = (index: number) => `${listId}-${index}`;

  return (
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('web.search_label')}
      >
        <div className="in">
          <Icon name="search" />
          <input
            ref={input}
            role="combobox"
            dir="rtl"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={t('web.search_label')}
            {...(optionCount > 0 ? { 'aria-activedescendant': optionId(active) } : {})}
            placeholder={t('web.search_placeholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((at) => Math.min(optionCount - 1, at + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((at) => Math.max(0, at - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                goActive();
              }
            }}
          />
          <kbd className="ltr">Esc</kbd>
        </div>
        {optionCount === 0 && !(searchable && records.isFetching) ? (
          <p className="none">{t('web.search_none')}</p>
        ) : (
          <ul className="list" id={listId} role="listbox" aria-label={t('web.search_pages')}>
            {results.map((entry, index) => (
              <li key={entry.id} role="presentation">
                <a
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  href={entry.path}
                  tabIndex={-1}
                  onMouseEnter={() => setActive(index)}
                  onClick={(event) => {
                    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey)
                      return;
                    event.preventDefault();
                    go(entry);
                  }}
                >
                  <Icon name={entry.icon} />
                  {t(entry.label)}
                  <span className="sub">{t(entry.group)}</span>
                </a>
              </li>
            ))}
            {groups.map((group) => (
              <Fragment key={group.kind}>
                <li role="presentation" className="head" data-search-group={group.kind}>
                  {searchGroupLabel(group.kind)}
                </li>
                {group.hits.map((hit) => {
                  const index =
                    results.length +
                    recordOptions.findIndex(
                      (one) => one.kind === group.kind && one.hit.id === hit.id,
                    );
                  const path = searchHitPath(group.kind, hit.id);
                  const state = searchHitStateLabel(group.kind, hit);
                  return (
                    <li key={`${group.kind}:${hit.id}`} role="presentation">
                      <a
                        id={optionId(index)}
                        role="option"
                        aria-selected={index === active}
                        href={path}
                        tabIndex={-1}
                        onMouseEnter={() => setActive(index)}
                        onClick={(event) => {
                          if (
                            event.button !== 0 ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey
                          )
                            return;
                          event.preventDefault();
                          goTo(path);
                        }}
                      >
                        <span className="hit-title">
                          <bdi>{hit.title}</bdi>
                        </span>
                        {hit.subtitle !== null && (
                          <span className="sub hit-sub">
                            <bdi>{hit.subtitle}</bdi>
                          </span>
                        )}
                        {state !== null && <span className="sub hit-state">{state}</span>}
                      </a>
                    </li>
                  );
                })}
                {group.hasMore && (
                  <li role="presentation" className="head">
                    {t('web.search_more')}
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        )}
        {searchable && records.isFetching && (
          <p className="none" role="status">
            {t('web.search_loading')}
          </p>
        )}
        {searchable && records.isError && (
          <p className="none" role="status">
            {t('web.search_failed')}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Ctrl+K / Cmd+K opens the command search from anywhere in the shell — except
 * over a confirmation. Two focus traps would fight over the same keyboard: the
 * confirmation pulls focus out of the search input, and one Escape would both
 * close the search and cancel the question the operator was being asked.
 */
export function useCommandShortcut(open: () => void): void {
  const latest = useRef(open);
  useEffect(() => {
    latest.current = open;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (confirmDialogOpen()) return;
        latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
