#!/usr/bin/env node
/**
 * `node scripts/web-shots/select-popup.mjs` — Round 4 B1 evidence: the options of a native
 * <select> in BOTH themes, in the real production build, in real Chromium.
 *
 * A closed select's popup is drawn by the browser outside the page, so a screenshot cannot see
 * it. The same <option> elements ARE drawn in the page when the select is a listbox, so this
 * opens `/panels/new`, turns the «ارائه‌دهنده» select into a six-row listbox, reads the COMPUTED
 * colours of a resting and of the selected (highlighted) option and of the select's
 * `color-scheme`, fails when either pair is below WCAG AA (4.5:1) or the scheme does not match
 * the theme, and saves a PNG per theme to `.web-shots/select-popup-<theme>.png`.
 *
 * Needs the Chromium of `/opt/pw-browsers` (see `harness.mjs`); not part of `pnpm verify`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, buildWeb, launchChrome, openPage, startServer } from './harness.mjs';

const build = !process.argv.includes('--no-build');
const out = join(ROOT, '.web-shots');

function channels(css) {
  const found = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (found === null) throw new Error(`not a colour: ${css}`);
  return [Number(found[1]), Number(found[2]), Number(found[3])];
}
function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(channels(a)), luminance(channels(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

if (build) buildWeb();
mkdirSync(out, { recursive: true });
const server = await startServer({});
const chrome = await launchChrome();
let failed = false;
try {
  for (const theme of ['dark', 'light']) {
    const page = await openPage(chrome.cdp, {
      url: `http://127.0.0.1:${server.port}/panels/new`,
      theme,
      width: 900,
      height: 700,
      collapsed: true,
      now: server.now,
      timeoutMs: 15_000,
    });
    await page.settle();
    const facts = await page.evaluate(`(() => {
      const select = document.querySelector('main select, .content select');
      if (!select) return null;
      select.size = Math.min(6, select.options.length);
      select.selectedIndex = 0;
      select.scrollIntoView({ block: 'center' });
      const resting = select.options[select.options.length - 1];
      const picked = select.options[0];
      const style = (el) => getComputedStyle(el);
      return {
        scheme: style(select).colorScheme,
        options: select.options.length,
        resting: { bg: style(resting).backgroundColor, fg: style(resting).color },
        selected: { bg: style(picked).backgroundColor, fg: style(picked).color },
      };
    })()`);
    if (facts === null) {
      console.log(`FAIL ${theme}: no <select> on /panels/new`);
      failed = true;
      await page.close();
      continue;
    }
    const restingRatio = contrast(facts.resting.fg, facts.resting.bg);
    const selectedRatio = contrast(facts.selected.fg, facts.selected.bg);
    const ok = facts.scheme === theme && restingRatio >= 4.5 && selectedRatio >= 4.5;
    failed ||= !ok;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${theme}: color-scheme=${facts.scheme} options=${facts.options} ` +
        `resting ${restingRatio.toFixed(2)}:1 (${facts.resting.fg} on ${facts.resting.bg}) ` +
        `selected ${selectedRatio.toFixed(2)}:1 (${facts.selected.fg} on ${facts.selected.bg})`,
    );
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(out, `select-popup-${theme}.png`), Buffer.from(data, 'base64'));
    await page.close();
  }
} finally {
  server.close();
  await chrome.close();
}
process.exit(failed ? 1 : 0);
