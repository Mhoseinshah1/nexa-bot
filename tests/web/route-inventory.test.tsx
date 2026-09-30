import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { PERMISSION_KEYS } from '@nexa/contracts';
import {
  App,
  GROUP_ORDER,
  NAV,
  ROUTE_PATTERNS,
  navPermitted,
  resolve,
  type NavEntry,
} from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { navigate } from '../../apps/web/src/router';
import { renderPage, stubApi } from './harness';

/**
 * The route inventory (brief §18): every route the Web Admin serves resolves
 * to a real page, and every top-level route is in exactly one navigation group.
 */

const REPO_ROOT = join(import.meta.dirname, '../..');
const SAMPLE_ID = '01a05e35-c9ad-7e93-bef3-1ed9b55292c8';
const ALL = [...PERMISSION_KEYS];
const OWNER = ['owner'];

const concrete = (pattern: string) => pattern.replace(/:[a-zA-Z]+/g, SAMPLE_ID);
const at = (path: string, permissions: readonly string[] = ALL, roles = OWNER) =>
  resolve({ path, query: new URLSearchParams() }, permissions, roles);
const componentName = (element: ReactElement): string => {
  const type = element.type as { name?: string } | string;
  return typeof type === 'string' ? type : (type.name ?? '');
};

describe('every route the shell serves', () => {
  it.each(ROUTE_PATTERNS.map((pattern) => [pattern]))(
    '%s resolves to a real page component, not the 404',
    (pattern) => {
      const resolved = at(concrete(pattern));
      const name = componentName(resolved.element as ReactElement);
      expect(name, `${pattern} rendered ${name}`).toMatch(/Page$/);
      expect(name).not.toBe('NotFound');
      expect(resolved.title).not.toBe(t('web.not_found_title'));
      expect(resolved.crumbs.length).toBeGreaterThan(0);
    },
  );

  it('includes every detail route the owner named', () => {
    for (const pattern of [
      '/users/:id',
      '/services/:id',
      '/orders/:id',
      '/payments/:id',
      '/panels/:id',
      '/products/:id',
      '/broadcasts/:id',
      '/bulk-operations/:id',
      '/tickets/:id',
      '/campaigns/:id',
    ]) {
      expect(ROUTE_PATTERNS, pattern).toContain(pattern);
    }
  });

  /**
   * The inventory and `resolve` are two declarations, so they are held together
   * by reading `resolve`'s own literals: a route served there and missing here
   * would never be walked above, and one listed here and served nowhere would
   * fail above only by luck of a matching prefix.
   */
  it('lists exactly the routes resolve serves', () => {
    const source = readFileSync(join(REPO_ROOT, 'apps/web/src/app.tsx'), 'utf8');
    const body = source.slice(source.indexOf('export function resolve('));
    const served = [
      ...[...body.matchAll(/route\.path === '([^']+)'/g)].map((m) => m[1]),
      ...[...body.matchAll(/match\('([^']+)'/g)].map((m) => m[1]),
    ];
    expect([...served].sort()).toEqual([...ROUTE_PATTERNS].sort());
    expect(new Set(ROUTE_PATTERNS).size).toBe(ROUTE_PATTERNS.length);
  });

  it('serves the 404 for what it does not serve', () => {
    for (const path of ['/nowhere', `/users/${SAMPLE_ID}/extra`, '/panels-archive']) {
      expect(at(path).title, path).toBe(t('web.not_found_title'));
    }
  });

  it('has a route for every navigation entry', () => {
    for (const entry of NAV) expect(ROUTE_PATTERNS, entry.path).toContain(entry.path);
  });
});

describe('the navigation groups', () => {
  /** The least an actor needs for the entry to be drawn, per its own declaration. */
  const minimal = (entry: NavEntry): { permissions: string[]; roles: string[] } => {
    const first =
      entry.permission === null
        ? []
        : typeof entry.permission === 'string'
          ? [entry.permission]
          : [entry.permission[0] as string];
    return { permissions: first, roles: entry.ownerOnly === true ? OWNER : [] };
  };

  it('puts every entry in exactly one known group, and draws it for an actor holding its permission', () => {
    const ids = new Set<string>();
    for (const entry of NAV) {
      expect(ids.has(entry.id), `duplicate entry ${entry.id}`).toBe(false);
      ids.add(entry.id);
      expect(
        GROUP_ORDER.filter((group) => group === entry.group),
        entry.id,
      ).toHaveLength(1);
      const { permissions, roles } = minimal(entry);
      expect(navPermitted(entry, permissions, roles), entry.id).toBe(true);
    }
    // No group is declared and left empty.
    for (const group of GROUP_ORDER) {
      expect(
        NAV.some((entry) => entry.group === group),
        group,
      ).toBe(true);
    }
  });

  it('keeps every permission gate: without the permission, no link', () => {
    for (const entry of NAV) {
      if (entry.permission === null) continue;
      expect(navPermitted(entry, [], OWNER), entry.id).toBe(false);
    }
    const reports = NAV.find((entry) => entry.id === 'reports') as NavEntry;
    // Owner-only: the permission alone is not enough.
    expect(navPermitted(reports, ['reports.view'], [])).toBe(false);
  });

  it('draws each entry once, inside the group it declares, in the rendered shell', async () => {
    stubApi([
      {
        url: '/auth/session',
        body: {
          admin: {
            id: SAMPLE_ID,
            username: 'owner',
            displayName: 'مدیر اصلی',
            status: 'ACTIVE',
            telegramUserId: null,
            roleKeys: OWNER,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: '2026-09-06T08:00:00.000Z',
          },
          permissions: ALL,
          expiresAt: '2026-09-07T08:00:00.000Z',
        },
      },
    ]);
    renderPage(<App />);
    const nav = await screen.findByRole('navigation', { name: t('web.nav_label') });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(NAV.length);
    for (const entry of NAV) {
      const matching = links.filter((link) => link.getAttribute('href') === entry.path);
      expect(matching, entry.path).toHaveLength(1);
      const group = (matching[0] as HTMLElement).closest('[role="group"]');
      expect(group?.getAttribute('aria-label'), entry.path).toBe(t(entry.group));
    }
  });

  /*
   * Reachable, not merely listed: the least actor the sidebar draws an entry
   * for gets the same page the owner gets — not the 404, and not some other
   * component standing in for it.
   */
  it('opens each entry on its own page for the least actor it is drawn for', () => {
    for (const entry of NAV) {
      const { permissions, roles } = minimal(entry);
      const owner = componentName(at(entry.path).element as ReactElement);
      const least = at(entry.path, permissions, roles);
      expect(componentName(least.element as ReactElement), entry.path).toBe(owner);
      expect(least.title, entry.path).not.toBe(t('web.not_found_title'));
      // …and a page that lets them in: a link to a refusal is not reachable.
      const props = (least.element as ReactElement<{ denied?: boolean }>).props;
      expect(props.denied ?? false, `${entry.path} is refused to the actor it is drawn for`).toBe(
        false,
      );
    }
  });

  it('lands on each page when its sidebar link is followed', async () => {
    stubApi([
      {
        url: '/auth/session',
        body: {
          admin: {
            id: SAMPLE_ID,
            username: 'owner',
            displayName: 'مدیر اصلی',
            status: 'ACTIVE',
            telegramUserId: null,
            roleKeys: OWNER,
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: '2026-09-06T08:00:00.000Z',
          },
          permissions: ALL,
          expiresAt: '2026-09-07T08:00:00.000Z',
        },
      },
    ]);
    act(() => navigate('/', { replace: true, force: true }));
    renderPage(<App />);
    const nav = await screen.findByRole('navigation', { name: t('web.nav_label') });
    for (const entry of NAV) {
      const link = within(nav)
        .getAllByRole('link')
        .find((candidate) => candidate.getAttribute('href') === entry.path) as HTMLElement;
      act(() => {
        fireEvent.click(link);
      });
      expect(window.location.pathname, entry.path).toBe(entry.path);
      expect(link.getAttribute('aria-current'), entry.path).toBe('page');
      expect(screen.queryByText(t('web.not_found_title')), entry.path).toBeNull();
    }
    act(() => navigate('/', { replace: true, force: true }));
  });
});
