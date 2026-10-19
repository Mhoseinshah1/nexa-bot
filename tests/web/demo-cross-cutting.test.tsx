import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CodeValue, LIST_PAGE_SIZE, Ltr, usePagedRows } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';
import { fireEvent } from '@testing-library/react';

const REPO_ROOT = join(__dirname, '..', '..');

/**
 * The cross-page rules of the approved Web Admin demo that live in the kit and
 * the shell (W1.8, W5). The per-page rules are tested with their pages.
 */
describe('Persian text in a technical-value box (W5)', () => {
  it('draws Persian right-to-left in the UI font, and a technical value left-to-right', () => {
    const { container } = render(
      <>
        <Ltr>{'درخواست نامعتبر است.'}</Ltr>
        <Ltr>{'panel.capability_unsupported'}</Ltr>
        <CodeValue value={'کد نامعتبر'} copy={false} />
        <CodeValue value={'https://example.test/x'} copy={false} />
      </>,
    );
    const spans = container.querySelectorAll(':scope > span');
    expect(spans[0]).toHaveClass('fa-in-ltr');
    expect(spans[0]).not.toHaveClass('mono');
    expect(spans[1]).toHaveClass('ltr');
    expect(spans[1]).toHaveClass('mono');
    const codes = container.querySelectorAll('code');
    expect(codes[0]).toHaveClass('fa-in-ltr');
    expect(codes[1]).not.toHaveClass('fa-in-ltr');
  });

  it('styles that class right-to-left in the UI font', () => {
    const css = readFileSync(join(REPO_ROOT, 'apps/web/src/styles/base.css'), 'utf8');
    const rule = /\.fa-in-ltr,\s*\.code\.fa-in-ltr\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/direction:\s*rtl/);
    expect(rule).toMatch(/font-family:\s*var\(--font-ui\)/);
    expect(rule).toMatch(/unicode-bidi:\s*isolate/);
  });
});

describe('the top bar menu (W5)', () => {
  it('sits in its own layer above the page and is drawn solid', () => {
    const css = readFileSync(join(REPO_ROOT, 'apps/web/src/styles/shell.css'), 'utf8');
    const topbar = /\n\.topbar \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(topbar).toMatch(/position:\s*relative/);
    expect(topbar).toMatch(/z-index:\s*35/);
    const menu = /\.topbar \.menu \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(menu).toMatch(/background:\s*var\(--bg-1\)/);
    expect(menu).toMatch(/backdrop-filter:\s*none/);
  });
});

describe('ten rows per page (W1.8)', () => {
  it('is ten', () => {
    expect(LIST_PAGE_SIZE).toBe(10);
  });

  function Paged({ rows, resetKey }: { rows: readonly number[]; resetKey?: string }) {
    const paged = usePagedRows(rows, resetKey);
    return (
      <>
        <ul>
          {paged.rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
        {paged.pager}
      </>
    );
  }

  it('pages an in-memory list ten at a time with «قبلی / بعدی», back to page one on a new filter', () => {
    const rows = Array.from({ length: 23 }, (_, index) => index + 1);
    const { rerender } = render(<Paged rows={rows} resetKey="a" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    const previous = screen.getByRole('button', { name: t('web.page_previous') });
    const next = screen.getByRole('button', { name: t('web.page_next') });
    expect(previous).toBeDisabled();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['21', '22', '23']);
    expect(next).toBeDisabled();
    rerender(<Paged rows={rows} resetKey="b" />);
    expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('1');
  });

  it('draws no pager for ten rows or fewer', () => {
    render(<Paged rows={[1, 2, 3]} />);
    expect(screen.queryByRole('button', { name: t('web.page_next') })).toBeNull();
  });

  function Whole({ rows }: { rows: readonly number[] }) {
    const paged = usePagedRows(rows, '', { wholeCollection: true });
    return (
      <>
        <ul>
          {paged.rows.map((row) => (
            <li key={row}>{row}</li>
          ))}
        </ul>
        {paged.pager}
      </>
    );
  }

  it('counts a whole collection the server answered as the demo does: «۱–۱۰ از ۲۹ · صفحه ۱ از ۳»', () => {
    const rows = Array.from({ length: 29 }, (_, index) => index + 1);
    render(<Whole rows={rows} />);
    const said = () =>
      (screen.getByTestId('counted-pager-info').textContent ?? '').replace(/[۰-۹]/g, (d) =>
        String(d.charCodeAt(0) - 0x6f0),
      );
    expect(said()).toMatch(/1–10 از 29 · .* 1 از 3/);
    fireEvent.click(screen.getByRole('button', { name: t('web.page_next_aria') }));
    fireEvent.click(screen.getByRole('button', { name: t('web.page_next_aria') }));
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
    expect(said()).toMatch(/21–29 از 29 · .* 3 از 3/);
    expect(screen.getByRole('button', { name: t('web.page_next_aria') })).toBeDisabled();
  });

  it('draws no counted pager for ten rows or fewer', () => {
    render(<Whole rows={[1, 2, 3]} />);
    expect(screen.queryByTestId('counted-pager-info')).toBeNull();
  });
});
