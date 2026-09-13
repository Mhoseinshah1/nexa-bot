import type { ReactElement } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { PlannedPage, PLANNED_SURFACES } from '../../apps/web/src/pages/planned';
import { NAV, isCurrent, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * The eight surfaces with no backend, and the concepts the owner removed.
 *
 * Half of these revisions are satisfied by ABSENCE — no receipts, no protocol,
 * no least-loaded routing, no logs. An absence with no test is an absence that
 * comes back, so each one is asserted over the rendered page rather than assumed
 * from the fact that nobody wrote it.
 *
 * `users` LEFT this file for `users.test.tsx`. Phase 4A built the surface, so the
 * two absences recorded on its planned page — no user tags, no recent-activity
 * feed — are now asserted against the REAL page, where they can actually come
 * back. Asserting them against a planned page that no route renders any more
 * would have been a green test for a screen nobody can reach.
 *
 * `orders` and `products` left for `products-and-orders.test.tsx` in Phase 4B, on the
 * same terms and for the same reason. Owner revisions 3, 6, 10 and 11 were recorded on
 * those two planned pages; they moved onto the live pages' scope cards, and the
 * assertions moved with them. Revision 6 — real order history is preserved — is no
 * longer only a record: every `line*` field on an order is a snapshot, so there is now
 * behaviour to assert as well as copy.
 */
describe('planned surfaces', () => {
  const render = (key: string) => {
    stubApi([]);
    return renderPage(<PlannedPage surface={key} />);
  };

  it('covers every surface the navigation offers', () => {
    expect(PLANNED_SURFACES.map((s) => s.key).sort()).toEqual(
      // `users` is deliberately absent: `/users` is a live surface. The list is
      // written out rather than derived, so activating or deactivating a surface
      // has to change this line too.
      // `payments` left this list in 4C, exactly as `products` and `orders` left it
      // in 4B: the surface is real, and a promoted page still listed here renders its
      // placeholder instead of itself.
      ['bots', 'discounts', 'reports', 'resellers', 'services'].sort(),
    );
  });

  /**
   * Per ROUTE, not per component key.
   *
   * Everything below renders `<PlannedPage surface={key} />` directly, which
   * cannot see the route table at all: a typo in one surface's `path` would
   * send its navigation link through `resolve` to `NotFound` while all
   * eighteen assertions stayed green. This walks the paths the shell actually
   * serves.
   */
  it.each(PLANNED_SURFACES.map((surface) => surface.key))(
    '%s is reachable at the path its navigation entry links to',
    (key) => {
      stubApi([]);
      // The NAV path, NOT `PLANNED_SURFACES[].path`. The two are separate
      // declarations — NAV hardcodes `/users`, `resolve` looks the route up
      // from `PLANNED_SURFACES` — so a typo in either sends a working link to
      // `NotFound`. Reading the path from the table under test made the
      // mutation self-consistent and the test useless; this drives what an
      // operator clicks.
      const entry = NAV.find((candidate) => candidate.id === key);
      expect(entry, `no navigation entry for ${key}`).toBeDefined();

      const resolved = resolve({ path: entry!.path, query: new URLSearchParams() }, []);
      const { container } = renderPage(resolved.element as ReactElement);

      // The planned page, not the 404 — asserted by its own copy.
      expect(screen.getByText('چرا هنوز فعال نیست')).toBeInTheDocument();
      // And the route-level guarantee, reached the way an operator reaches it.
      expect(container.querySelectorAll('button, input, select, table, a')).toHaveLength(0);
      // The sidebar entry marks itself current at that path, so the link and
      // the route agree about which page is open.
      expect(isCurrent(entry!.path, entry!.path)).toBe(true);
    },
  );

  /**
   * T34 — the NEGATIVE cases, which are the only ones that can fail.
   *
   * `isCurrent(p, p)` proves identity and nothing else: a function that always
   * returned true, or the bare `currentPath.startsWith(entryPath)` this
   * replaced — which marks the dashboard current on every route, because every
   * path starts with `/` — both leave it green while several sidebar entries
   * expose `aria-current="page"` at once.
   */
  describe('the current-navigation rule', () => {
    it('marks exactly one entry current on any given path', () => {
      for (const entry of NAV) {
        const current = NAV.filter((candidate) => isCurrent(candidate.path, entry.path));
        expect(
          current.map((one) => one.path),
          entry.path,
        ).toEqual([entry.path]);
      }
    });

    it('does not mark the dashboard current on a nested route', () => {
      // The whole `startsWith` trap: every path begins with '/'.
      expect(isCurrent('/', '/panels')).toBe(false);
      expect(isCurrent('/', '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8')).toBe(false);
      expect(isCurrent('/', '/')).toBe(true);
    });

    it('marks a section current on its own detail routes and on nothing else', () => {
      expect(isCurrent('/panels', '/panels/01a05e35-c9ad-7e93-bef3-1ed9b55292c8')).toBe(true);
      // A sibling whose path merely SHARES a prefix is a different section.
      expect(isCurrent('/panels', '/panels-archive')).toBe(false);
      expect(isCurrent('/panels', '/settings')).toBe(false);
    });
  });

  it('serves the 404 for a path no entry claims', () => {
    stubApi([]);
    const resolved = resolve({ path: '/definitely-not-a-route', query: new URLSearchParams() }, []);
    const { container } = renderPage(resolved.element as ReactElement);
    expect(screen.queryByText('چرا هنوز فعال نیست')).toBeNull();
    expect(container.textContent).toBeTruthy();
  });

  /**
   * The rule that makes this page honest: it draws no control at all.
   *
   * Not a disabled button either. A disabled control says "this exists and you
   * lack permission", which is a different and equally false claim, and a
   * greyed table with sample rows says "here is your data".
   */
  it.each(PLANNED_SURFACES.map((surface) => surface.key))(
    '%s offers nothing to press, and no table of invented rows',
    (key) => {
      const { container } = render(key);
      expect(container.querySelectorAll('button')).toHaveLength(0);
      expect(container.querySelectorAll('input')).toHaveLength(0);
      expect(container.querySelectorAll('select')).toHaveLength(0);
      expect(container.querySelectorAll('table')).toHaveLength(0);
      expect(container.querySelectorAll('a')).toHaveLength(0);
    },
  );

  it.each(PLANNED_SURFACES.map((surface) => surface.key))(
    '%s says it is planned and says what is missing',
    (key) => {
      render(key);
      expect(screen.getAllByText('برنامه‌ریزی‌شده').length).toBeGreaterThan(0);
      expect(screen.getByText('چرا هنوز فعال نیست')).toBeInTheDocument();
    },
  );

  /**
   * Revisions 4, 5, 6, 11, 13, 14 and 17 — recorded, and each one named.
   *
   * These six are decisions about surfaces that have no backend, so there is
   * no behaviour to assert; the deliverable IS the record, on the page whoever
   * builds the surface will open. Until this block existed they were covered
   * only by the generic "says what is missing" case above, which passes for
   * any page carrying any sentence — so the ledger claimed six mandatory
   * revisions were delivered on the strength of an assertion that could not
   * tell whether they were there.
   */
  it.each<[string, RegExp, string]>([
    ['services', /created_at نزولی/, 'revision 13 — newest first, ordered by the server'],
    ['services', /فیلتر چندانتخابی/, 'revision 14 — plan filter replaces location'],
  ])('records on %s: %s', (surface, pattern) => {
    render(surface);
    expect(screen.getByText(pattern)).toBeInTheDocument();
  });

  /*
   * Revisions 4, 5 and 17 left this page with the placeholder, and none of them was
   * dropped.
   *
   * They were recorded as COPY on a surface that no longer exists, and copy on a
   * deleted page is a record nobody reads. Each is now in `docs/open-questions.md`,
   * which is where this repository keeps a deferral:
   *
   *   - revision 4 (one-hour payment validity) -> OQ-4C-01, with what 4C actually
   *     does about expiry and what still has no sweeper;
   *   - revision 5 (refund and fulfilment never combine impossibly) -> OQ-4C-02;
   *   - revision 17 (receipt review happens in Telegram, not the web panel) ->
   *     OQ-4C-03, which states the tension outright rather than resolving it: the
   *     frozen contracts are web-admin-shaped, and 4C follows them.
   *
   * Asserted against the DOCUMENT, so deleting one of those sections fails here.
   */
  it('keeps revisions 4, 5 and 17 recorded after the payments placeholder was promoted', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '..', '..', 'docs', 'open-questions.md'),
      'utf8',
    );
    expect(doc, 'revision 4 — payment expiry').toContain('OQ-4C-01');
    expect(doc).toContain('یک ساعت');
    expect(doc, 'revision 5 — refund as a state').toContain('OQ-4C-02');
    expect(doc, 'revision 17 — where receipt review happens').toContain('OQ-4C-03');
    expect(doc).toContain('بررسی رسید در تلگرام انجام می‌شود');
  });

  /** Owner revision 15 — user tags are gone entirely. */
  /** Owner revision 12 — protocol is not a normal service field. */
  it('records that protocol stays out of the normal services UI', () => {
    const { container } = render('services');
    const text = container.textContent ?? '';
    // The word appears exactly once, inside the sentence that excludes it. The
    // protocol NAMES are allowed there too — naming what is excluded is how the
    // rule stays legible — so the assertion is that the mention and the
    // exclusion are the same sentence, not that the word is absent.
    const sentence = text.split('.').find((part) => part.includes('پروتکل'));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('نمایش داده نمی‌شود');
    expect(sentence).toContain('لینک اشتراک');
    // And nothing on the page is a protocol FIELD: no label, no column, no
    // control of any kind. The per-surface assertion above proves the last part
    // for every surface; this names the one that matters here.
    expect(screen.queryByLabelText(/پروتکل/)).toBeNull();
    expect(container.querySelectorAll('th')).toHaveLength(0);
  });

  /** Owner revisions 13 and 14 — server ordering, and a plan filter. */
  it('records the ordering rule and the plan filter, and no location filter', () => {
    const { container } = render('services');
    const text = container.textContent ?? '';
    expect(text).toContain('created_at');
    expect(text).toContain('id');
    expect(text).toContain('پلن');
    expect(text).toContain('لوکیشن'); // only as the thing being removed
    expect(text).toContain('وجود نخواهد داشت');
  });

  /** Owner revision 20 — only a reseller sales bot, and not creatable. */
  it('records that the only future bot type is the reseller sales bot, disabled', () => {
    const { container } = render('bots');
    const text = container.textContent ?? '';
    expect(text).toContain('ربات فروش نماینده');
    expect(text).toContain('ربات اصلی');
    expect(text).toContain('وجود نخواهد داشت');
    // And there is nothing to press, which the shared assertion above already
    // proves for every surface including this one.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  /** Owner revision 25 — no general logs page. */
  it('records that the operational stream goes to Telegram rather than a logs page', () => {
    const { container } = render('reports');
    const text = container.textContent ?? '';
    expect(text).toContain('لاگ');
    expect(text).toContain('گروه گزارش تلگرام');
  });
});
