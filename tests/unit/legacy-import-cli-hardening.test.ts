import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_UID,
  LEGACY_IMPORT_DEFAULT_INVENTORY_PAGE_SIZE,
  REPORT_NOT_WRITTEN_EXIT,
  ReportNotWritten,
  UsageError,
  emit,
  exitCodeForError,
  importerOptions,
  parseArgs,
  withInvocation,
  type ReportIo,
} from '../../apps/api/src/legacy-import.cli';
import {
  LEGACY_REPORT_FORMAT,
  reportMarkdown,
  type LegacyImportReport,
} from '../../apps/api/src/modules/platform/legacy-importer/application/report';
import {
  INVENTORY_DEFAULT_PAGE_SIZE,
  INVENTORY_MAX_PAGE_SIZE,
  effectiveInventoryPageSize,
} from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel-inventory';

/**
 * Hardening batch 2026-10-07, §3 and §4 (`docs/legacy-migration/importer.md` §1).
 *
 * §3: the legacy-import CLI walks RickPanel with the reader's MAXIMUM page size unless the
 * operator types one — the real rehearsal went BLOCKED/TOTAL_CHANGED at 50 rows (~500
 * reads) and READY_FOR_DRY_RUN at 200 (~130). The library default stays 50.
 *
 * §4: a report that was computed but could not be written to `--out` is a precise,
 * distinct failure (exit 73) that names the path and errno and never reads as an audit
 * failure. The integration suite proves the page size reaches the provider and that a
 * TOTAL_CHANGED walk still blocks.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BASE = [
  'audit',
  '--tenant',
  TENANT,
  '--source',
  'env:LEGACY_DSN',
  '--target',
  'env:NEXA_TARGET',
  '--panel-map',
  'map.json',
];

describe('§3 --inventory-page-size: CLI default is the reader maximum', () => {
  it('omitted: 200, the reader maximum, recorded as the CLI default', () => {
    const args = parseArgs(BASE);
    expect(args.inventoryPageSize).toBe(200);
    expect(args.inventoryPageSize).toBe(INVENTORY_MAX_PAGE_SIZE);
    expect(LEGACY_IMPORT_DEFAULT_INVENTORY_PAGE_SIZE).toBe(INVENTORY_MAX_PAGE_SIZE);
    expect(args.inventoryPageSizeSource).toBe('CLI_DEFAULT');
    // The CLI always hands the container an explicit size: never the library default.
    expect(importerOptions(args)).toEqual({ inventoryPageSize: 200 });
  });

  it('the library default is unchanged for every other caller', () => {
    expect(INVENTORY_DEFAULT_PAGE_SIZE).toBe(50);
    expect(effectiveInventoryPageSize()).toBe(50);
    expect(effectiveInventoryPageSize(500)).toBe(INVENTORY_MAX_PAGE_SIZE);
    expect(effectiveInventoryPageSize(0)).toBe(1);
  });

  it('an explicit value overrides, including a smaller one, and is recorded as the operator’s', () => {
    for (const size of [1, 3, 50, 199, 200]) {
      const args = parseArgs([...BASE, '--inventory-page-size', String(size)]);
      expect(args.inventoryPageSize).toBe(size);
      expect(args.inventoryPageSizeSource).toBe('OPERATOR');
      expect(importerOptions(args)).toEqual({ inventoryPageSize: size });
    }
  });

  for (const bad of [
    '0',
    '201',
    '-1',
    'abc',
    '50abc',
    '1e2',
    '2.5',
    '',
    ' 50',
    '0050',
    '9999999999',
  ]) {
    it(`refuses ${JSON.stringify(bad)} with the bound taken from the reader`, () => {
      const run = () => parseArgs([...BASE, '--inventory-page-size', bad]);
      expect(run).toThrow(UsageError);
      expect(run).toThrow(`between 1 and ${String(INVENTORY_MAX_PAGE_SIZE)}`);
    });
  }

  it('the effective size and its origin land in the report metadata, JSON and markdown', () => {
    const defaulted = withInvocation(report(), parseArgs(BASE));
    expect(defaulted.invocation).toEqual({
      inventoryPageSize: 200,
      inventoryPageSizeSource: 'CLI_DEFAULT',
    });
    expect(reportMarkdown(defaulted)).toContain('| inventory page size | 200 (CLI_DEFAULT) |');
    const typed = withInvocation(report(), parseArgs([...BASE, '--inventory-page-size', '50']));
    expect(reportMarkdown(typed)).toContain('| inventory page size | 50 (OPERATOR) |');
    // A report built by any other caller carries no invocation row.
    expect(reportMarkdown(report())).not.toContain('inventory page size');
  });
});

function report(verdict: string | null = 'READY_FOR_DRY_RUN'): LegacyImportReport {
  return {
    format: LEGACY_REPORT_FORMAT,
    mode: 'AUDIT',
    synthetic: false,
    generatedAt: '2026-10-07T10:00:00.000Z',
    durationMs: 1,
    tenantId: TENANT,
    codeVersion: null,
    sections: { blockers: [] },
    verdict,
  };
}

function errno(code: string, message = `${code}: a driver message`): Error {
  return Object.assign(new Error(message), { code });
}

/** An io that records stdout/stderr and fails the named step with the named errno. */
function failingIo(
  fail: { readonly at: 'mkdir' | 'json' | 'md'; readonly error: Error },
  uid: number | null = IMAGE_UID,
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const files: string[] = [];
  const io: ReportIo = {
    stdout: (t) => void stdout.push(t),
    stderr: (t) => void stderr.push(t),
    mkdir: async () => {
      if (fail.at === 'mkdir') throw fail.error;
    },
    writeFile: async (path) => {
      if (path.endsWith(`.${fail.at}`)) throw fail.error;
      files.push(path);
    },
    uid,
  };
  return { io, stdout, stderr, files };
}

describe('§4 --out: a report computed but not written', () => {
  let consoleError: { mock: { calls: unknown[][] }; mockRestore(): void };
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOENT']) {
    it(`${code} on the directory: printed first, then refused precisely, exit 73`, async () => {
      const { io, stdout } = failingIo({ at: 'mkdir', error: errno(code) });
      const failure = await emit(report(), '/results', 'json', io).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ReportNotWritten);
      // The report reached stdout before any file was attempted: nothing is lost.
      expect(stdout.join('')).toContain('"verdict": "READY_FOR_DRY_RUN"');
      const typed = failure as ReportNotWritten;
      expect(typed.path).toBe('/results');
      expect(typed.code).toBe(code);

      expect(exitCodeForError(failure)).toBe(REPORT_NOT_WRITTEN_EXIT);
      expect(REPORT_NOT_WRITTEN_EXIT).toBe(73);
      const printed = consoleError.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('REPORT NOT WRITTEN (exit 73)');
      expect(printed).toContain('AUDIT report WAS computed');
      expect(printed).toContain('verdict READY_FOR_DRY_RUN');
      expect(printed).toContain('path:  /results');
      expect(printed).toContain(`error: ${code}`);
      expect(printed).toContain('not a failure of the source, the target or the audit');
      // The container-safe remedies: host-side redirect, or a uid-1000 directory.
      expect(printed).toContain('> /host/writable/audit.json');
      expect(printed).toContain('-o 1000 -g 1000');
      expect(printed).toContain('must not be run as root');
      // Never the driver's own message: only the errno code.
      expect(printed).not.toContain('a driver message');
    });
  }

  it('a failure on the second file names that file and what was already written', async () => {
    const { io } = failingIo({ at: 'md', error: errno('ENOSPC') });
    const failure = (await emit(report('BLOCKED'), '/results', 'md', io).catch(
      (e: unknown) => e,
    )) as ReportNotWritten;
    expect(failure).toBeInstanceOf(ReportNotWritten);
    expect(failure.path).toMatch(/^\/results\/legacy-import-audit-.*\.md$/u);
    expect(failure.written).toHaveLength(1);
    expect(failure.message).toContain('verdict BLOCKED');
    expect(failure.message).toContain('already written: /results/legacy-import-audit-');
    expect(failure.message).toContain('ENOSPC (no space left on the device)');
  });

  it('an error without a well-formed errno code is UNKNOWN, never its message', async () => {
    const { io } = failingIo({ at: 'json', error: errno('postgres://u:hunter2@x', 'hunter2') });
    const failure = (await emit(report(), '/results', 'json', io).catch(
      (e: unknown) => e,
    )) as ReportNotWritten;
    expect(failure.code).toBe('UNKNOWN');
    expect(failure.message).not.toContain('hunter2');
  });

  it('a mode without a verdict says so rather than inventing one', async () => {
    const { io } = failingIo({ at: 'mkdir', error: errno('EACCES') }, null);
    const failure = (await emit(report(null), '/results', 'json', io).catch(
      (e: unknown) => e,
    )) as ReportNotWritten;
    expect(failure.message).toContain('verdict (none for this mode)');
    expect(failure.message).toContain('this process could not write there');
  });

  it('a real filesystem refusal (a file where the directory should be) takes the same path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-out-'));
    try {
      await writeFile(join(dir, 'occupied'), 'x');
      const out = join(dir, 'occupied', 'results');
      const stdout: string[] = [];
      const failure = (await emit(report(), out, 'json', {
        stdout: (t) => void stdout.push(t),
        stderr: () => {},
        mkdir: (path) =>
          import('node:fs/promises').then((fs) => fs.mkdir(path, { recursive: true })),
        writeFile: (path, data) =>
          import('node:fs/promises').then((fs) => fs.writeFile(path, data, { mode: 0o600 })),
        uid: null,
      }).catch((e: unknown) => e)) as ReportNotWritten;
      expect(failure).toBeInstanceOf(ReportNotWritten);
      expect(failure.path).toBe(out);
      expect(['ENOTDIR', 'EEXIST']).toContain(failure.code);
      expect(stdout.join('')).toContain('READY_FOR_DRY_RUN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a writable --out still writes both files and says where', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'legacy-out-'));
    try {
      const stderr: string[] = [];
      const fs = await import('node:fs/promises');
      await emit(report(), join(dir, 'r'), 'json', {
        stdout: () => {},
        stderr: (t) => void stderr.push(t),
        mkdir: (path) => fs.mkdir(path, { recursive: true }),
        writeFile: (path, data) => fs.writeFile(path, data, { mode: 0o600 }),
        uid: null,
      });
      expect((await readdir(join(dir, 'r'))).sort()).toEqual([
        'legacy-import-audit-2026-10-07T10-00-00-000Z.json',
        'legacy-import-audit-2026-10-07T10-00-00-000Z.md',
      ]);
      expect(stderr.join('')).toContain('report written to');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an ordinary error is still exit 1, never mistaken for a persistence failure', () => {
    expect(exitCodeForError(errno('EACCES'))).toBe(1);
  });
});
