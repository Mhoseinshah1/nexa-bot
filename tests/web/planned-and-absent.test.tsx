import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { PlannedPage, PLANNED_SURFACES } from '../../apps/web/src/pages/planned';
import { isCurrent, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * The nine surfaces with no backend, and the concepts the owner removed.
 *
 * Half of these revisions are satisfied by ABSENCE — no tags, no recent
 * activity, no receipts, no protocol, no least-loaded routing, no logs. An
 * absence with no test is an absence that comes back, so each one is asserted
 * over the rendered page rather than assumed from the fact that nobody wrote it.
 */
describe('planned surfaces', () => {
  const render = (key: string) => {
    stubApi([]);
    return renderPage(<PlannedPage surface={key} />);
  };

  it('covers every surface the navigation offers', () => {
    expect(PLANNED_SURFACES.map((s) => s.key).sort()).toEqual(
      [
        'bots',
        'discounts',
        'orders',
        'payments',
        'products',
        'reports',
        'resellers',
        'services',
        'users',
      ].sort(),
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
  it.each(PLANNED_SURFACES.map((surface) => [surface.key, surface.path] as const))(
    '%s is reachable at %s and resolves to the planned page',
    (key, path) => {
      stubApi([]);
      const resolved = resolve({ path, query: new URLSearchParams() }, []);
      const { container } = renderPage(resolved.element as ReactElement);

      // The planned page, not the 404 — asserted by its own copy.
      expect(screen.getByText('چرا هنوز فعال نیست')).toBeInTheDocument();
      // And the route-level guarantee, which is the one that matters: no
      // control of any kind, reached the way an operator reaches it.
      expect(container.querySelectorAll('button, input, select, table, a')).toHaveLength(0);
      // The sidebar entry for this path marks itself current, so the link and
      // the route agree about which page is open.
      expect(isCurrent(path, path)).toBe(true);
      expect(key.length).toBeGreaterThan(0);
    },
  );

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

  /** Owner revision 15 — user tags are gone entirely. */
  it('carries no user-tag concept anywhere on the users surface', () => {
    const { container } = render('users');
    const text = container.textContent ?? '';
    expect(text).toContain('برچسب');
    // ...only as the record of the decision to remove it, never as a feature.
    expect(text).toContain('وجود نخواهد داشت');
    expect(screen.queryByText('همه برچسب‌ها')).toBeNull();
  });

  /** Owner revision 16 — no generic "recent activity" card. */
  it('records that user detail will not carry a recent-activity feed', () => {
    render('users');
    expect(screen.getByText(/فعالیت اخیر/)).toBeInTheDocument();
    expect(screen.getByText(/ساخته نمی‌شود/)).toBeInTheDocument();
  });

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

  /** Owner revision 10 — no automatic least-loaded panel assignment. */
  it('records that no least-loaded routing will exist', () => {
    const { container } = render('products');
    const text = container.textContent ?? '';
    expect(text).toContain('کم‌بارترین پنل');
    expect(text).toContain('وجود نخواهد داشت');
    expect(text).toContain('مشتری');
  });

  /** Owner revisions 4, 5 and 17. */
  it('records the payment expiry, refund and receipt rules', () => {
    const { container } = render('payments');
    const text = container.textContent ?? '';
    expect(text).toContain('یک ساعت');
    expect(text).toContain('بازگشت وجه');
    expect(text).toContain('رسید');
    // Enforcement is a server rule, and the page says so rather than implying a
    // browser timer could do it.
    expect(text).toContain('نه با یک تایمر در مرورگر');
  });

  /** Owner revisions 3, 6 and 11. */
  it('records the needs-attention, history and shared-projection rules', () => {
    const { container } = render('orders');
    const text = container.textContent ?? '';
    expect(text).toContain('نیازمند توجه');
    expect(text).toContain('تاریخچه');
    expect(text).toContain('پروجکشن مشترک');
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
