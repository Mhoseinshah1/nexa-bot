import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchInfo } from './api/client';
import { t, type WebKey } from './i18n/web.fa';
import { navigate, useLinkHandler } from './router';
import type { ThemeChoice } from './theme';
import { Icon, type IconName } from './ui/icons';
import { Breadcrumbs, Menu, useFocusTrap, type Crumb } from './ui/kit';
import { formatNumber } from './format';
import { GROUP_ORDER, isCurrent, type NavEntry } from './nav';
import type { NavCounters } from './nav-counters';

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
}: {
  entries: readonly NavEntry[];
  currentPath: string;
  collapsed: boolean;
  onToggle: () => void;
  counters: NavCounters;
  theme: ThemeChoice;
  onTheme: (next: ThemeChoice) => void;
}) {
  const onLink = useLinkHandler();
  const info = useBuildInfo();
  const describedBy = useId();
  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? 'system';
  const themeLabel = `${t('web.theme')}: ${t(THEME_LABEL[theme])}`;

  return (
    <aside className="sidebar" id="app-sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          N
        </span>
        <span className="brand-text">
          <strong>{t('web.title')}</strong>
          <span>{t('web.subtitle')}</span>
        </span>
      </div>

      {/*
        The installation this console is connected to: the host the operator
        opened, and the environment and version the server reports. Identity
        only — the session carries one tenant and no way to switch, so nothing
        here is pressable and nothing pretends to be a picker.
      */}
      <div className="identity" aria-label={t('web.identity_label')} role="group">
        <i className={`dot ${info.data === undefined ? '' : 'ok'}`} aria-hidden="true" />
        <div className="identity-text">
          <div className="identity-name truncate">
            <span className="ltr">{window.location.host}</span>
          </div>
          {info.data !== undefined && (
            <div className="identity-env truncate">
              <span className="ltr">{`${info.data.environment} · ${info.data.name}`}</span>
            </div>
          )}
        </div>
      </div>

      <nav className="nav" aria-label={t('web.nav_label')}>
        {GROUP_ORDER.map((group) => {
          const members = entries.filter((entry) => entry.group === group);
          if (members.length === 0) return null;
          return (
            <div className="nav-group" key={group} role="group" aria-label={t(group)}>
              <div className="nav-group-label" aria-hidden="true">
                {t(group)}
              </div>
              {members.map((entry) => {
                const counter = counters[entry.id];
                const countId = `${describedBy}-${entry.id}`;
                return (
                  <a
                    key={entry.id}
                    href={entry.path}
                    onClick={onLink}
                    aria-current={isCurrent(entry.path, currentPath) ? 'page' : undefined}
                    title={collapsed ? t(entry.label) : undefined}
                    {...(counter === undefined ? {} : { 'aria-describedby': countId })}
                  >
                    <Icon name={entry.icon} size={17} className="ico" />
                    <span className="lbl">{t(entry.label)}</span>
                    {counter !== undefined && (
                      /*
                        Out of the link's NAME, so a link is always found by
                        its label alone, and read as its description instead.
                      */
                      <span
                        className={`cnt${counter.tone === undefined ? '' : ` ${counter.tone}`}`}
                        id={countId}
                      >
                        {formatNumber(counter.count)}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
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
          <Icon name={THEME_ICON[theme]} size={15} />
        </button>
        {info.data !== undefined && (
          <span className="build-id" title={`${t('web.build_identity')} — ${info.data.buildTime}`}>
            <span className="ltr mono">{`v${info.data.version} · ${info.data.commit.slice(0, 7)}`}</span>
          </span>
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ topbar --- */

export function Topbar({
  crumbs,
  collapsed,
  onOpenMenu,
  onSearch,
  admin,
  onSignOut,
}: {
  crumbs: readonly Crumb[];
  collapsed: boolean;
  onOpenMenu: () => void;
  onSearch: () => void;
  admin: { displayName: string; roleKeys: readonly string[] };
  onSignOut: () => void;
}) {
  const initial = Array.from(admin.displayName.trim())[0] ?? '·';
  const roles = admin.roleKeys.join(t('web.list_separator')) || '—';
  return (
    <header className="topbar">
      <button
        type="button"
        className="btn ghost icon menu-toggle"
        aria-label={t('web.open_menu')}
        aria-expanded={!collapsed}
        aria-controls="app-sidebar"
        onClick={onOpenMenu}
      >
        <Icon name="menu" />
      </button>

      <Breadcrumbs items={crumbs} />

      <span className="spacer" />

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

      <Menu
        label={t('web.user_menu')}
        triggerClassName="btn ghost user-trigger"
        trigger={
          <>
            <span className="avatar" aria-hidden="true">
              {initial}
            </span>
            <span className="who-name">
              {admin.displayName}
              <span className="faint"> · {roles}</span>
            </span>
            <Icon name="chevron" size={13} />
          </>
        }
        items={[
          { key: 'who', heading: `${admin.displayName} · ${roles}` },
          { key: 'sep', separator: true },
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
 * Ctrl+K: go to any page this operator may see, by typing part of its name.
 *
 * Client-side over the SAME entries the sidebar draws — so it offers exactly
 * the links the operator already has, never a page the navigation hides and
 * never a record it would have to fetch to find.
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
    return entries.filter(
      (entry) =>
        t(entry.label).toLowerCase().includes(needle) ||
        t(entry.group).toLowerCase().includes(needle) ||
        entry.path.toLowerCase().includes(needle),
    );
  }, [entries, query]);

  const go = (entry: NavEntry | undefined) => {
    if (entry === undefined) return;
    onClose();
    navigate(entry.path);
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
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-label={t('web.search_label')}
            {...(results.length > 0 ? { 'aria-activedescendant': optionId(active) } : {})}
            placeholder={t('web.search_placeholder')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((at) => Math.min(results.length - 1, at + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((at) => Math.max(0, at - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                go(results[active]);
              }
            }}
          />
          <kbd className="ltr">Esc</kbd>
        </div>
        {results.length === 0 ? (
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
          </ul>
        )}
      </div>
    </div>
  );
}

/** Ctrl+K / Cmd+K opens the command search from anywhere in the shell. */
export function useCommandShortcut(open: () => void): void {
  const latest = useRef(open);
  useEffect(() => {
    latest.current = open;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
