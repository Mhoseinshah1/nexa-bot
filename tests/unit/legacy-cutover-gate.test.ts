import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_CUTOVER_GATE_STEPS } from '@nexa/contracts';
import {
  CutoverUsageError,
  LEGACY_FREEZE_CHECKER_SHA256,
  cutoverGateExitCode,
  cutoverGateText,
  finalDumpHolds,
  freezeProofHolds,
  parseCutoverGateArgs,
  runFreezeChecker,
  runGateSteps,
  sha256OfFile,
  stopSalesHolds,
} from '../../apps/api/src/legacy-import-cutover';
import { parseArgs } from '../../apps/api/src/legacy-import.cli';

/**
 * Mirza migration PR6 — `legacy-import cutover-gate`: its order, its stop-sales and freeze
 * steps, and its command line. The steps against a database are in
 * tests/integration/legacy-cutover.test.ts.
 */

const H = (c: string) => c.repeat(64);
const CHECKER = 'scripts/legacy-freeze-checksum-verify.sh';

describe('the gate runs its steps in order and stops at the first failure', () => {
  const pass = () => Promise.resolve({ holds: true, detail: 'ok' });
  const probes = () =>
    Object.fromEntries(LEGACY_CUTOVER_GATE_STEPS.map((s) => [s, pass])) as Record<
      (typeof LEGACY_CUTOVER_GATE_STEPS)[number],
      typeof pass
    >;

  it('all steps pass: CUTOVER_READY', async () => {
    const { steps, failedStep } = await runGateSteps(probes());
    expect(failedStep).toBeNull();
    expect(steps.map((s) => s.step)).toEqual([...LEGACY_CUTOVER_GATE_STEPS]);
    expect(steps.every((s) => s.result === 'PASS')).toBe(true);
  });

  it('each step, failing, stops the gate there; nothing after it is even asked', async () => {
    for (const [i, failing] of LEGACY_CUTOVER_GATE_STEPS.entries()) {
      const asked: string[] = [];
      const p = probes();
      for (const step of LEGACY_CUTOVER_GATE_STEPS) {
        p[step] = () => {
          asked.push(step);
          return Promise.resolve({ holds: step !== failing, detail: step });
        };
      }
      const { steps, failedStep } = await runGateSteps(p);
      expect(failedStep).toBe(failing);
      expect(asked).toEqual(LEGACY_CUTOVER_GATE_STEPS.slice(0, i + 1));
      expect(steps.slice(i + 1).every((s) => s.result === 'NOT_REACHED')).toBe(true);
      const report = {
        version: 'nexa-legacy-cutover-gate/v1' as const,
        evidenceClass: 'staging' as const,
        generatedAt: '2026-10-07T00:00:00.000Z',
        sourceFingerprint: null,
        steps,
        verdict: 'REFUSED' as const,
        failedStep,
      };
      expect(cutoverGateExitCode(report)).toBe(3);
    }
  });

  it('a probe that throws is a FAIL with its code, never a pass', async () => {
    const p = probes();
    p.IMPORT_COMPLETED = () =>
      Promise.reject(
        Object.assign(new Error('Run x is RUNNING'), { code: 'legacy_import.run_conflict' }),
      );
    const { steps, failedStep } = await runGateSteps(p);
    expect(failedStep).toBe('IMPORT_COMPLETED');
    expect(steps.find((s) => s.step === 'IMPORT_COMPLETED')?.detail).toBe(
      'legacy_import.run_conflict: Run x is RUNNING',
    );
  });

  it('the markdown is inert and says SYNTHETIC first', () => {
    const text = cutoverGateText(
      {
        version: 'nexa-legacy-cutover-gate/v1',
        evidenceClass: 'synthetic',
        generatedAt: '2026-10-07T00:00:00.000Z',
        sourceFingerprint: H('a'),
        steps: [{ step: 'STOP_SALES_ACTIVE', result: 'FAIL', detail: 'a | b\n# c' }],
        verdict: 'REFUSED',
        failedStep: 'STOP_SALES_ACTIVE',
      },
      'md',
    );
    expect(text).toContain('SYNTHETIC SOURCE — NOT EVIDENCE');
    expect(text).toContain('| a \\| b # c |');
  });
});

describe('stop sales', () => {
  const facts = {
    activeStopSalesIncidents: 1,
    activePanels: 2,
    activePanelsNotDrained: 0,
    gateways: 3,
    gatewaysActive: 0,
  };
  it('holds only with an active stop-sales incident, every panel drained and every gateway off', () => {
    expect(stopSalesHolds(facts).holds).toBe(true);
    expect(stopSalesHolds({ ...facts, activeStopSalesIncidents: 0 }).holds).toBe(false);
    expect(stopSalesHolds({ ...facts, activePanelsNotDrained: 1 }).holds).toBe(false);
    expect(stopSalesHolds({ ...facts, gatewaysActive: 1 }).holds).toBe(false);
  });
});

describe('the freeze proof: PR1 checker, pinned', () => {
  it('the pinned SHA-256 is the checker in this tree (change one, change both, deliberately)', () => {
    expect(createHash('sha256').update(readFileSync(CHECKER)).digest('hex')).toBe(
      LEGACY_FREEZE_CHECKER_SHA256,
    );
  });

  const frozen = 'base_tables\n2\nTable\tChecksum\noldbot.invoice\t11\noldbot.user\t22\n';
  const restored = 'base_tables\n2\nTable\tChecksum\nrestored.invoice\t11\nrestored.user\t22\n';
  const sha = (t: string) => createHash('sha256').update(t).digest('hex');

  it('the real checker: EQUAL passes; a difference, an empty file or another frozen file fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-gate-'));
    const a = join(dir, 'a.tsv');
    const b = join(dir, 'b.tsv');
    writeFileSync(a, frozen);
    writeFileSync(b, restored);
    const equal = await runFreezeChecker(CHECKER, a, b);
    expect(equal.exitCode).toBe(0);
    const base = {
      checkerSha256: LEGACY_FREEZE_CHECKER_SHA256,
      frozenSha256: sha(frozen),
      frozenPath: a,
      restoredPath: b,
      restoredSha256: sha(restored),
    };
    expect(
      freezeProofHolds({ ...base, run: equal, expectedFreezeProofSha256: sha(frozen) }),
    ).toMatchObject({
      holds: true,
      detail: expect.stringContaining(`restored proof sha256 ${sha(restored)}`),
    });
    // aud6 F4: the frozen proof passed as its own restored copy is EQUAL by construction, and
    // refused, whatever spelling of the path is used.
    const self = await runFreezeChecker(CHECKER, a, a);
    expect(self.exitCode).toBe(0);
    for (const restoredPath of [a, join(dir, '.', 'a.tsv'), join(dir, 'x', '..', 'a.tsv')]) {
      expect(
        freezeProofHolds({
          ...base,
          run: self,
          restoredPath,
          restoredSha256: sha(frozen),
          expectedFreezeProofSha256: sha(frozen),
        }),
        restoredPath,
      ).toMatchObject({
        holds: false,
        detail: expect.stringContaining('is the frozen proof itself'),
      });
    }
    // Not the frozen file the owner approved.
    expect(freezeProofHolds({ ...base, run: equal, expectedFreezeProofSha256: H('9') }).holds).toBe(
      false,
    );
    writeFileSync(b, restored.replace('\t22', '\t23'));
    const differ = await runFreezeChecker(CHECKER, a, b);
    expect(differ.exitCode).toBe(1);
    expect(
      freezeProofHolds({ ...base, run: differ, expectedFreezeProofSha256: sha(frozen) }).holds,
    ).toBe(false);
    writeFileSync(b, '');
    const empty = await runFreezeChecker(CHECKER, a, b);
    expect(
      freezeProofHolds({ ...base, run: empty, expectedFreezeProofSha256: sha(frozen) }).holds,
    ).toBe(false);
  });

  it('a stand-in checker that prints EQUAL is refused by its SHA-256', () => {
    expect(
      freezeProofHolds({
        checkerSha256: H('0'),
        run: {
          exitCode: 0,
          stdout: 'EQUAL: every base table has the same checksum in both files\n',
        },
        frozenSha256: H('1'),
        expectedFreezeProofSha256: H('1'),
        frozenPath: '/x/a.tsv',
        restoredPath: '/x/b.tsv',
        restoredSha256: H('2'),
      }),
    ).toMatchObject({ holds: false });
    // Exit 0 without the EQUAL line (one file accepted, no comparison) is not a proof either.
    expect(
      freezeProofHolds({
        checkerSha256: LEGACY_FREEZE_CHECKER_SHA256,
        run: { exitCode: 0, stdout: 'accepted: a.tsv (2 base tables)\n' },
        frozenSha256: H('1'),
        expectedFreezeProofSha256: H('1'),
        frozenPath: '/x/a.tsv',
        restoredPath: '/x/b.tsv',
        restoredSha256: H('2'),
      }).holds,
    ).toBe(false);
  });
});

describe('the final dump: the FILE is hashed, never the approved value echoed back', () => {
  it('streams the file through SHA-256 and holds only when it is the approved hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexa-dump-'));
    const dump = join(dir, 'final.dump');
    // Larger than one stream chunk (64 KiB), so the streamed hash covers every chunk.
    const bytes = Buffer.alloc(200_000, 7);
    writeFileSync(dump, bytes);
    const approved = createHash('sha256').update(bytes).digest('hex');
    expect(await sha256OfFile(dump)).toBe(approved);
    expect(
      finalDumpHolds({ dumpSha256: await sha256OfFile(dump), expectedFinalDumpSha256: approved }),
    ).toMatchObject({ holds: true });
    writeFileSync(dump, Buffer.concat([bytes, Buffer.from('x')]));
    expect(
      finalDumpHolds({ dumpSha256: await sha256OfFile(dump), expectedFinalDumpSha256: approved })
        .holds,
    ).toBe(false);
    expect(finalDumpHolds({ dumpSha256: approved, expectedFinalDumpSha256: null }).holds).toBe(
      false,
    );
    await expect(sha256OfFile(join(dir, 'missing.dump'))).rejects.toThrow();
  });
});

describe('the command lines', () => {
  const gate = [
    '--tenant',
    'acme',
    '--source',
    'env:LEGACY_MYSQL_DSN',
    '--target',
    'nexa',
    '--panel-map',
    'map.json',
    '--evidence-class',
    'staging',
    '--expected-fingerprint',
    H('a'),
    '--expected-panel-map-fingerprint',
    H('b'),
    '--expected-inventory-fingerprint',
    H('c'),
    '--expected-products-fingerprint',
    H('d'),
    '--expected-invoice-archive-fingerprint',
    H('e'),
    '--expected-freeze-proof-sha256',
    H('f'),
    '--expected-final-dump-sha256',
    H('1'),
    '--freeze-proof',
    'step7.tsv',
    '--freeze-proof-restored',
    'step9.tsv',
    '--freeze-checker',
    CHECKER,
    '--final-dump',
    'final.dump',
  ];

  it('the gate needs every value; each is an exact lowercase SHA-256', () => {
    expect(parseCutoverGateArgs(gate).expectation.finalDumpSha256).toBe(H('1'));
    expect(parseCutoverGateArgs(gate).finalDump).toBe('final.dump');
    for (let i = 10; i < gate.length; i += 2) {
      const without = [...gate.slice(0, i), ...gate.slice(i + 2)];
      expect(() => parseCutoverGateArgs(without), gate[i]).toThrow(CutoverUsageError);
    }
    const upper = gate.map((v) => (v === H('e') ? H('E') : v));
    expect(() => parseCutoverGateArgs(upper)).toThrow(/64 lowercase hex/u);
    expect(() => parseCutoverGateArgs([...gate, '--password', 'x'])).toThrow(CutoverUsageError);
  });

  it('import takes the five new --expected-* flags and --cutover-gate; report takes --report-schema', () => {
    const base = [
      '--tenant',
      'acme',
      '--source',
      'env:X',
      '--target',
      'nexa',
      '--panel-map',
      'm.json',
    ];
    const imp = parseArgs([
      'import',
      ...base,
      '--evidence-class',
      'staging',
      '--cutover-gate',
      '--expected-inventory-fingerprint',
      H('c'),
      '--expected-final-dump-sha256',
      H('1'),
    ]);
    expect(imp).toMatchObject({
      cutoverGate: true,
      expectedInventoryFingerprint: H('c'),
      expectedFinalDumpSha256: H('1'),
      expectedProductsFingerprint: null,
    });
    expect(() => parseArgs(['audit', ...base, '--expected-products-fingerprint', H('d')])).toThrow(
      /import and resume only/u,
    );
    expect(parseArgs(['report', ...base, '--evidence-class', 'staging']).reportSchema).toBe(2);
    expect(
      parseArgs(['report', ...base, '--evidence-class', 'staging', '--report-schema', '1'])
        .reportSchema,
    ).toBe(1);
    expect(() =>
      parseArgs(['report', ...base, '--evidence-class', 'staging', '--report-schema', '3']),
    ).toThrow();
    expect(() => parseArgs(['audit', ...base, '--report-schema', '1'])).toThrow(/report only/u);
  });
});
