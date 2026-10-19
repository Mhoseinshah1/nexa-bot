import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanup } from '@testing-library/react';
import { SearchInput } from '../../apps/web/src/ui/kit';
import { ListSearchBox } from '../../apps/web/src/ui/list-search';
import { renderPage } from './harness';

/**
 * Round 4 B3: every search field is right-to-left with its text and placeholder on the START
 * (right) edge, whatever it holds. The cascade is checked on the real stylesheet loaded into
 * the document; the markup is checked on EVERY `type="search"` input in the source, so a new
 * search box added without `dir="rtl"` fails here.
 */

const WEB_SRC = join(__dirname, '..', '..', 'apps', 'web', 'src');
const KIT_CSS = readFileSync(join(WEB_SRC, 'styles', 'kit.css'), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/u.test(name) ? [full] : [];
  });
}

describe('search inputs are right-to-left', () => {
  it('every <input type="search"> and the command palette input carry dir="rtl"', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(WEB_SRC)) {
      const text = readFileSync(file, 'utf8');
      const tags = text.match(/<(?:input|Input)\b[^>]*?\/?>/gsu) ?? [];
      for (const tag of tags) {
        const isSearch = /type="search"/u.test(tag) || /role="combobox"/u.test(tag);
        if (!isSearch) continue;
        seen += 1;
        // A spread prop (`{...(dir === undefined ? {} : { dir })}`) is not a statement of intent.
        if (!/\bdir=("rtl"|\{dir \?\? 'rtl'\})/u.test(tag)) {
          offenders.push(`${relative(WEB_SRC, file)}: ${tag.slice(0, 60)}`);
        }
      }
    }
    expect(seen).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });

  it('the stylesheet gives every search input direction rtl and logical start alignment', () => {
    const style = document.createElement('style');
    style.textContent = KIT_CSS;
    document.head.appendChild(style);
    try {
      renderPage(
        <div>
          <SearchInput value="" onChange={() => undefined} label="جست‌وجو" placeholder="جست‌وجو…" />
          <ListSearchBox
            route={{ path: '/users', query: new URLSearchParams() }}
            id="rtl-list-search"
            hint="شناسه یا نام کاربری"
          />
          <div className="palette">
            <div className="in">
              <input aria-label="پالت" dir="rtl" />
            </div>
          </div>
        </div>,
      );
      const inputs = Array.from(
        document.querySelectorAll('input[type="search"], .palette .in input'),
      );
      expect(inputs.length).toBeGreaterThanOrEqual(3);
      for (const input of inputs) {
        const computed = getComputedStyle(input);
        expect(computed.direction, input.outerHTML.slice(0, 80)).toBe('rtl');
        expect(computed.textAlign, input.outerHTML.slice(0, 80)).toBe('start');
        expect(input.getAttribute('dir')).toBe('rtl');
      }
    } finally {
      style.remove();
      cleanup();
    }
  });
});
