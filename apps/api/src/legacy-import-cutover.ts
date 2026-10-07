import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { assertOutsideTransaction } from './infrastructure/transaction-boundary.js';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  LEGACY_CUTOVER_BINDING_FIELDS,
  LEGACY_CUTOVER_GATE_STEPS,
  LEGACY_CUTOVER_GATE_VERSION,
  LEGACY_TABLE_CLASSIFICATION,
  type ActorContext,
  type LegacyCutoverBindingField,
  type LegacyCutoverGateResult,
  type LegacyCutoverGateStep,
  type TenantContext,
} from '@nexa/contracts';
import {
  DSN_PASSWORD_REFUSAL,
  PASSWORD_FLAG_REFUSAL,
  hasUrlPassword,
  isPasswordFlag,
} from './legacy-import-argv.js';
import type { LegacyImporterService } from './modules/platform/legacy-importer/application/legacy-importer.service.js';
import {
  takeLegacyInventory,
  type LegacyInventory,
} from './modules/platform/legacy-importer/application/legacy-inventory.js';
import type { PanelMapping } from './modules/platform/legacy-importer/application/panel-mapping.js';
import {
  EVIDENCE_CLASSES,
  type EvidenceClass,
} from './modules/platform/legacy-importer/application/production-guard.js';
import type { LegacySourceConnector } from './modules/platform/legacy-importer/application/source-port.js';
import type { LegacySnapshot } from './modules/platform/legacy-importer/application/source-snapshot.js';
import {
  LegacyCutoverRefused,
  completeBinding,
  type CutoverExpectation,
} from './modules/platform/legacy-cutover/domain/cutover-rules.js';
import type { LegacyCutoverStopSalesFacts } from './modules/platform/legacy-cutover/application/ports.js';

/**
 * Mirza migration PR6 — the cutover on the command line (`docs/legacy-migration/cutover-
 * runbook.md` §Cutover gate):
 *
 * - the import's `--expected-*` flags and `--cutover-gate` (`cutoverExpectationOf`);
 * - the FRESH read of every fingerprint an approval binds, taken by read-only sessions bound
 *   to the source (`freshCutoverFingerprints`), used both by a gated import and by the gate;
 * - `legacy-import cutover-gate`, which proves, IN ORDER, every step of
 *   `LEGACY_CUTOVER_GATE_STEPS` and stops at the first that fails. It writes nothing:
 *   reconcile and report are read-only, and so is every other step.
 */

export class CutoverUsageError extends Error {}

/** The flag that carries each bound value, as the runbook and the import name them. */
export const CUTOVER_EXPECTED_FLAGS: Readonly<Record<LegacyCutoverBindingField, string>> = {
  sourceFingerprint: '--expected-fingerprint',
  panelMapFingerprint: '--expected-panel-map-fingerprint',
  inventoryFingerprint: '--expected-inventory-fingerprint',
  productsFingerprint: '--expected-products-fingerprint',
  invoiceArchiveFingerprint: '--expected-invoice-archive-fingerprint',
  freezeProofSha256: '--expected-freeze-proof-sha256',
  finalDumpSha256: '--expected-final-dump-sha256',
};

/**
 * PR1's freeze checker, pinned by its SHA-256: the gate runs exactly that script, so a
 * stand-in that prints "EQUAL" is refused. `tests/unit/legacy-cutover-gate.test.ts` fails
 * when the script changes without this value.
 */
export const LEGACY_FREEZE_CHECKER_SHA256 =
  '3e56477c9fd87409147f4942a08838408fb7e5c71e16af0ba22829e333b04e16';

export function sha256OfText(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// --- the fresh read --------------------------------------------------------------------------

export interface FreshCutoverFingerprints {
  readonly inventory: LegacyInventory;
  readonly products: { readonly fingerprint: string; readonly synthetic: boolean };
  readonly invoiceArchive: { readonly fingerprint: string; readonly synthetic: boolean };
}

/**
 * Every read set an approval binds, read NOW by read-only sessions each bound to `source`
 * (a session whose v1 fingerprint differs is refused before it reads a table). Digest only:
 * nothing is written anywhere.
 */
export async function freshCutoverFingerprints(
  importer: Pick<LegacyImporterService, 'readProducts' | 'readInvoiceArchive'>,
  connector: LegacySourceConnector,
  source: string,
  context: {
    readonly scope: TenantContext;
    readonly actor: ActorContext;
    readonly productionLikeTarget: boolean;
  },
): Promise<FreshCutoverFingerprints> {
  const inventory = await takeLegacyInventory(
    connector,
    source,
    Object.keys(LEGACY_TABLE_CLASSIFICATION),
  );
  const products = await importer.readProducts({
    ...context,
    connector,
    expectedFingerprint: source,
    expectedProductsFingerprint: null,
  });
  const invoices = await importer.readInvoiceArchive({
    ...context,
    connector,
    expectedFingerprint: source,
    expectedInvoiceArchiveFingerprint: null,
  });
  return {
    inventory,
    products: { fingerprint: products.fingerprint, synthetic: products.synthetic },
    invoiceArchive: { fingerprint: invoices.fingerprint, synthetic: invoices.synthetic },
  };
}

/** What differs between the fresh read and the expectation: field names, never values. */
export function freshMismatches(
  fresh: FreshCutoverFingerprints,
  expectation: CutoverExpectation,
): readonly LegacyCutoverBindingField[] {
  const out: LegacyCutoverBindingField[] = [];
  if (fresh.inventory.fingerprint !== expectation.inventoryFingerprint) {
    out.push('inventoryFingerprint');
  }
  if (fresh.products.fingerprint !== expectation.productsFingerprint)
    out.push('productsFingerprint');
  if (fresh.invoiceArchive.fingerprint !== expectation.invoiceArchiveFingerprint) {
    out.push('invoiceArchiveFingerprint');
  }
  return out;
}

/**
 * A gated import's fresh-read rule: every table classified and every read set exactly the
 * approved one. Throws `LegacyCutoverRefused` (exit 65, nothing written) otherwise.
 */
export function assertFreshMatches(
  fresh: FreshCutoverFingerprints,
  expectation: CutoverExpectation,
): void {
  if (fresh.inventory.verdict !== 'COMPLETE') {
    const unclassified = fresh.inventory.tables.filter((t) => t.class === 'UNCLASSIFIED').length;
    throw new LegacyCutoverRefused(
      'TABLES_UNCLASSIFIED',
      `the fresh inventory is ${fresh.inventory.verdict} (${String(unclassified)} UNCLASSIFIED table(s)): ` +
        'every legacy table must be classified in a reviewed commit before the cutover. Nothing was written.',
    );
  }
  const differ = freshMismatches(fresh, expectation);
  if (differ.length > 0) {
    throw new LegacyCutoverRefused(
      'APPROVAL_MISSING',
      `the source read now differs from the approved ${differ.map((f) => CUTOVER_EXPECTED_FLAGS[f]).join(', ')}: ` +
        'a changed fingerprint voids the approval. Nothing was written.',
    );
  }
}

/** Refused before the source is opened when a gated import was not given every value. */
export function assertExpectationComplete(expectation: CutoverExpectation): void {
  const complete = completeBinding(expectation);
  if (!complete.ok) {
    throw new LegacyCutoverRefused(
      'EXPECTATION_INCOMPLETE',
      `the cutover gate needs every approved value; missing: ${complete.missing.map((f) => CUTOVER_EXPECTED_FLAGS[f]).join(', ')}. Nothing was read or written.`,
    );
  }
}

// --- the stop-sales and freeze steps (pure, tested) -------------------------------------------

/** Step 1: an ACTIVE MAINTENANCE stop-sales incident; every active panel drained, every gateway off. */
export function stopSalesHolds(facts: LegacyCutoverStopSalesFacts): {
  readonly holds: boolean;
  readonly detail: string;
} {
  const holds =
    facts.activeStopSalesIncidents >= 1 &&
    facts.activePanelsNotDrained === 0 &&
    facts.gatewaysActive === 0;
  return {
    holds,
    detail:
      `active stop_sales MAINTENANCE incidents=${String(facts.activeStopSalesIncidents)}; ` +
      `active panels not drained=${String(facts.activePanelsNotDrained)} of ${String(facts.activePanels)}; ` +
      `gateways still ACTIVE=${String(facts.gatewaysActive)} of ${String(facts.gateways)}`,
  };
}

export interface FreezeCheckerRun {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Runs PR1's checker: `bash CHECKER FROZEN RESTORED`, no shell, no interpolation. */
export function runFreezeChecker(
  checker: string,
  frozen: string,
  restored: string,
): Promise<FreezeCheckerRun> {
  // A subprocess never runs inside a database transaction (the boundary's rule).
  assertOutsideTransaction('The freeze checker subprocess');
  return new Promise((done) => {
    execFile(
      'bash',
      [checker, frozen, restored],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const code =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : 1;
        done({ exitCode: code, stdout: String(stdout) });
      },
    );
  });
}

/**
 * Step 2: the checker is PR1's (by SHA-256), it exited 0 and printed EQUAL, and the frozen
 * proof file is the one the owner approved (by SHA-256).
 */
export function freezeProofHolds(input: {
  readonly checkerSha256: string;
  readonly run: FreezeCheckerRun | null;
  readonly frozenSha256: string;
  readonly expectedFreezeProofSha256: string | null;
}): { readonly holds: boolean; readonly detail: string } {
  if (input.checkerSha256 !== LEGACY_FREEZE_CHECKER_SHA256) {
    return {
      holds: false,
      detail: `the checker is not scripts/legacy-freeze-checksum-verify.sh of this release (sha256 ${input.checkerSha256})`,
    };
  }
  if (input.run === null || input.run.exitCode !== 0 || !/^EQUAL: /mu.test(input.run.stdout)) {
    return {
      holds: false,
      detail: `the checker did not find the frozen and restored proofs EQUAL (exit ${String(input.run?.exitCode ?? 'not run')})`,
    };
  }
  if (input.frozenSha256 !== input.expectedFreezeProofSha256) {
    return {
      holds: false,
      detail: `the frozen proof file's sha256 is ${input.frozenSha256}, not the approved ${String(input.expectedFreezeProofSha256)}`,
    };
  }
  return { holds: true, detail: `EQUAL; frozen proof sha256 ${input.frozenSha256}` };
}

/**
 * Step 3: the final dump FILE is the approved one. The hash is of the bytes the gate was
 * pointed at, streamed — never the approved value echoed back.
 */
export function finalDumpHolds(input: {
  readonly dumpSha256: string;
  readonly expectedFinalDumpSha256: string | null;
}): { readonly holds: boolean; readonly detail: string } {
  if (input.dumpSha256 !== input.expectedFinalDumpSha256) {
    return {
      holds: false,
      detail: `the final dump's sha256 is ${input.dumpSha256}, not the approved ${String(input.expectedFinalDumpSha256)}`,
    };
  }
  return { holds: true, detail: `final dump sha256 ${input.dumpSha256}, as approved` };
}

/** SHA-256 of a file, streamed (a final dump is too large to read whole). Lowercase hex. */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', fail)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => done(hash.digest('hex')));
  });
}

// --- the gate --------------------------------------------------------------------------------

export interface GateStepOutcome {
  readonly step: LegacyCutoverGateStep;
  readonly result: LegacyCutoverGateResult;
  readonly detail: string;
}

export interface CutoverGateReport {
  readonly version: typeof LEGACY_CUTOVER_GATE_VERSION;
  readonly evidenceClass: EvidenceClass;
  readonly generatedAt: string;
  readonly sourceFingerprint: string | null;
  readonly steps: readonly GateStepOutcome[];
  readonly verdict: 'CUTOVER_READY' | 'REFUSED';
  readonly failedStep: LegacyCutoverGateStep | null;
}

/**
 * The ordered checklist. Each check runs only when every one before it passed; the first
 * failure stops the gate and every later step is NOT_REACHED. Pure over its probes.
 */
export async function runGateSteps(
  probes: Readonly<
    Record<
      LegacyCutoverGateStep,
      () => Promise<{ readonly holds: boolean; readonly detail: string }>
    >
  >,
): Promise<{
  readonly steps: readonly GateStepOutcome[];
  readonly failedStep: LegacyCutoverGateStep | null;
}> {
  const steps: GateStepOutcome[] = [];
  let failedStep: LegacyCutoverGateStep | null = null;
  for (const step of LEGACY_CUTOVER_GATE_STEPS) {
    if (failedStep !== null) {
      steps.push({ step, result: 'NOT_REACHED', detail: `not checked: ${failedStep} failed` });
      continue;
    }
    let outcome: { readonly holds: boolean; readonly detail: string };
    try {
      outcome = await probes[step]();
    } catch (error) {
      outcome = { holds: false, detail: refusalDetail(error) };
    }
    steps.push({ step, result: outcome.holds ? 'PASS' : 'FAIL', detail: outcome.detail });
    if (!outcome.holds) failedStep = step;
  }
  return { steps, failedStep };
}

/** A refusal's code and message — the messages here carry fingerprints and counts only. */
function refusalDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && !error.message.startsWith(code)
      ? `${code}: ${error.message}`
      : error.message;
  }
  return 'unknown error';
}

export interface CutoverGateArgs {
  readonly tenant: string;
  readonly source: string;
  readonly sourcePasswordEnv: string | null;
  readonly target: string;
  readonly panelMap: string;
  readonly evidenceClass: EvidenceClass;
  readonly expectation: CutoverExpectation;
  readonly freezeProof: string;
  readonly freezeProofRestored: string;
  readonly freezeChecker: string;
  readonly finalDump: string;
  readonly format: 'md' | 'json';
  readonly allowProductionTarget: boolean;
}

export const CUTOVER_GATE_USAGE = [
  'usage: legacy-import cutover-gate --tenant TENANT --source SOURCE --target TARGET',
  '                                  --panel-map FILE --evidence-class staging|production|synthetic',
  '                                  --expected-fingerprint HEX --expected-panel-map-fingerprint HEX',
  '                                  --expected-inventory-fingerprint HEX',
  '                                  --expected-products-fingerprint HEX',
  '                                  --expected-invoice-archive-fingerprint HEX',
  '                                  --expected-freeze-proof-sha256 HEX --expected-final-dump-sha256 HEX',
  '                                  --freeze-proof FROZEN.tsv --freeze-proof-restored RESTORED.tsv',
  '                                  --freeze-checker PATH/legacy-freeze-checksum-verify.sh',
  '                                  --final-dump FINAL.dump',
  '                                  [--format md|json] [--source-password-env NAME]',
  '                                  [--allow-production-target]',
  '',
  "  Proves, in order, and stops at the first failure: NEXA stop_sales is active; PR1's",
  '  freeze checker found the frozen and the restored proof EQUAL (and the frozen file is the',
  '  approved one); the final dump file hashes to the approved SHA-256; a fresh read gives',
  '  every approved fingerprint; no legacy table is',
  '  UNCLASSIFIED; an unrevoked owner approval matches every value; no earlier import is',
  '  superseded unacknowledged; the import ran (COMPLETED, this source and map); reconcile is',
  '  RECONCILED; the final report v2 holds; stop_sales is STILL active. Writes nothing.',
  '  Exit 0 CUTOVER_READY, 3 REFUSED.',
].join('\n');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/u;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function parseCutoverGateArgs(argv: readonly string[]): CutoverGateArgs {
  const valueFlags = new Set([
    '--tenant',
    '--source',
    '--source-password-env',
    '--target',
    '--panel-map',
    '--evidence-class',
    '--freeze-proof',
    '--freeze-proof-restored',
    '--freeze-checker',
    '--final-dump',
    '--format',
    ...Object.values(CUTOVER_EXPECTED_FLAGS),
  ]);
  const values = new Map<string, string>();
  let allowProductionTarget = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (isPasswordFlag(arg)) throw new CutoverUsageError(PASSWORD_FLAG_REFUSAL);
    if (arg === '--allow-production-target') {
      allowProductionTarget = true;
      continue;
    }
    if (!valueFlags.has(arg)) {
      throw new CutoverUsageError(`Unknown argument ${arg}.\n\n${CUTOVER_GATE_USAGE}`);
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CutoverUsageError(`${arg} needs a value.`);
    }
    if (values.has(arg)) throw new CutoverUsageError(`${arg} is given twice.`);
    values.set(arg, next);
    i += 1;
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new CutoverUsageError(
        `${flag} is required. There is no default.\n\n${CUTOVER_GATE_USAGE}`,
      );
    }
    return value;
  };
  const tenant = required('--tenant');
  if (!UUID.test(tenant) && !SLUG.test(tenant)) {
    throw new CutoverUsageError('--tenant must be a lowercase tenant uuid or slug.');
  }
  const source = required('--source');
  const target = required('--target');
  if (hasUrlPassword(source) || hasUrlPassword(target)) {
    throw new CutoverUsageError(DSN_PASSWORD_REFUSAL);
  }
  for (const spec of [source, target]) {
    if (spec.startsWith('env:') && !ENV_NAME.test(spec.slice(4))) {
      throw new CutoverUsageError(`${spec} does not name an environment variable.`);
    }
  }
  if (!/^(env:|mysql:\/\/|mariadb:\/\/|fixture:)/u.test(source)) {
    throw new CutoverUsageError('--source must be env:NAME, mysql://… or fixture:PATH.');
  }
  if (!/^(env:|postgres:\/\/|postgresql:\/\/)/u.test(target) && !DATABASE_NAME.test(target)) {
    throw new CutoverUsageError('--target must be env:NAME, postgres://… or a database name.');
  }
  const sourcePasswordEnv = values.get('--source-password-env') ?? null;
  if (
    sourcePasswordEnv !== null &&
    (!ENV_NAME.test(sourcePasswordEnv) || !/^(mysql|mariadb):\/\//u.test(source))
  ) {
    throw new CutoverUsageError(
      '--source-password-env names a variable and applies to a literal mysql:// source only.',
    );
  }
  const evidenceClass = required('--evidence-class');
  if (!(EVIDENCE_CLASSES as readonly string[]).includes(evidenceClass)) {
    throw new CutoverUsageError(`--evidence-class must be one of ${EVIDENCE_CLASSES.join(', ')}.`);
  }
  const expectation = Object.fromEntries(
    LEGACY_CUTOVER_BINDING_FIELDS.map((field) => {
      const flag = CUTOVER_EXPECTED_FLAGS[field];
      const value = required(flag);
      if (!SHA256_HEX.test(value)) {
        throw new CutoverUsageError(`${flag} is a SHA-256 as 64 lowercase hex characters.`);
      }
      return [field, value];
    }),
  ) as Record<LegacyCutoverBindingField, string>;
  const format = values.get('--format') ?? 'md';
  if (format !== 'md' && format !== 'json')
    throw new CutoverUsageError('--format must be md or json.');
  return {
    tenant,
    source,
    sourcePasswordEnv,
    target,
    panelMap: required('--panel-map'),
    evidenceClass: evidenceClass as EvidenceClass,
    expectation,
    freezeProof: required('--freeze-proof'),
    freezeProofRestored: required('--freeze-proof-restored'),
    freezeChecker: required('--freeze-checker'),
    finalDump: required('--final-dump'),
    format,
    allowProductionTarget,
  };
}

/** What the gate needs from the importer, the cutover service and the source. */
export interface CutoverGateDeps {
  readonly importer: Pick<
    LegacyImporterService,
    'readProducts' | 'readInvoiceArchive' | 'reconcile' | 'finalReport' | 'cutoverDecision'
  >;
  readonly stopSalesFacts: () => Promise<LegacyCutoverStopSalesFacts>;
  readonly connector: LegacySourceConnector;
  /** Reads the v1 snapshot in its own read-only session. */
  readonly readSnapshot: () => Promise<LegacySnapshot>;
  readonly runChecker: typeof runFreezeChecker;
  readonly readBytes: (path: string) => Promise<Buffer>;
  /** Streams a file through SHA-256 (`sha256OfFile`). */
  readonly hashFile: (path: string) => Promise<string>;
  readonly now: () => Date;
}

/** `legacy-import cutover-gate`: every step, in order. Writes nothing. */
export async function runCutoverGate(
  deps: CutoverGateDeps,
  args: CutoverGateArgs,
  context: {
    readonly scope: TenantContext;
    readonly actor: ActorContext;
    readonly mapping: PanelMapping;
    readonly productionLikeTarget: boolean;
  },
): Promise<CutoverGateReport> {
  const { expectation } = args;
  let snapshot: LegacySnapshot | null = null;
  let fresh: FreshCutoverFingerprints | null = null;
  const base = {
    scope: context.scope,
    actor: context.actor,
    mapping: context.mapping,
    productionLikeTarget: context.productionLikeTarget,
  };
  // Reconcile throws (RUN_CONFLICT / RUN_NOT_FOUND) when the run is not a finished import of
  // this source and map: IMPORT_COMPLETED fails with that reason, and RECONCILED is not read.
  let lastReconcile: string | null = null;
  const { steps, failedStep } = await runGateSteps({
    STOP_SALES_ACTIVE: async () => stopSalesHolds(await deps.stopSalesFacts()),
    FREEZE_PROOF_VERIFIED: async () => {
      const [checker, frozen] = await Promise.all([
        deps.readBytes(args.freezeChecker),
        deps.readBytes(args.freezeProof),
      ]);
      const checkerSha256 = sha256OfText(checker);
      const run =
        checkerSha256 === LEGACY_FREEZE_CHECKER_SHA256
          ? await deps.runChecker(args.freezeChecker, args.freezeProof, args.freezeProofRestored)
          : null;
      return freezeProofHolds({
        checkerSha256,
        run,
        frozenSha256: sha256OfText(frozen),
        expectedFreezeProofSha256: expectation.freezeProofSha256,
      });
    },
    FINAL_DUMP_VERIFIED: async () =>
      finalDumpHolds({
        dumpSha256: await deps.hashFile(args.finalDump),
        expectedFinalDumpSha256: expectation.finalDumpSha256,
      }),
    FRESH_FINGERPRINTS: async () => {
      snapshot = await deps.readSnapshot();
      const source = snapshot.fingerprint;
      if (source !== expectation.sourceFingerprint) {
        return {
          holds: false,
          detail: `the source fingerprint is ${source}, not the approved ${String(expectation.sourceFingerprint)}`,
        };
      }
      if (context.mapping.fingerprint !== expectation.panelMapFingerprint) {
        return {
          holds: false,
          detail: `the panel mapping fingerprint is ${context.mapping.fingerprint}, not the approved ${String(expectation.panelMapFingerprint)}`,
        };
      }
      fresh = await freshCutoverFingerprints(deps.importer, deps.connector, source, context);
      const differ = freshMismatches(fresh, expectation);
      return differ.length === 0
        ? {
            holds: true,
            detail: `source ${source}; inventory, products and invoice-archive as approved`,
          }
        : {
            holds: false,
            detail: `the fresh read differs from ${differ.map((f) => CUTOVER_EXPECTED_FLAGS[f]).join(', ')}`,
          };
    },
    TABLES_CLASSIFIED: () => {
      const inventory = (fresh as FreshCutoverFingerprints | null)?.inventory;
      if (inventory === undefined)
        return Promise.resolve({ holds: false, detail: 'no fresh inventory' });
      const unclassified = inventory.tables.filter((t) => t.class === 'UNCLASSIFIED').length;
      return Promise.resolve({
        holds: inventory.verdict === 'COMPLETE',
        detail: `inventory ${inventory.verdict}; UNCLASSIFIED tables: ${String(unclassified)}`,
      });
    },
    APPROVAL_MATCHES: async () => {
      const decision = await deps.importer.cutoverDecision({
        ...base,
        snapshot: snapshot as unknown as LegacySnapshot,
        cutoverGate: { expectation },
      });
      if (decision.ok || decision.code === 'SOURCE_SUPERSEDED') {
        return { holds: true, detail: 'an unrevoked owner approval matches every value' };
      }
      return { holds: false, detail: `${decision.code}: ${decision.message}` };
    },
    SOURCE_NOT_SUPERSEDED: async () => {
      const decision = await deps.importer.cutoverDecision({
        ...base,
        snapshot: snapshot as unknown as LegacySnapshot,
        cutoverGate: { expectation },
      });
      if (decision.ok) {
        return {
          holds: true,
          detail:
            decision.supersededSources.length === 0
              ? 'no earlier import of another source'
              : `re-run over ${decision.supersededSources.join(', ')}, acknowledged`,
        };
      }
      return { holds: false, detail: `${decision.code}: ${decision.message}` };
    },
    IMPORT_COMPLETED: async () => {
      const reconciled = await deps.importer.reconcile({
        ...base,
        snapshot: snapshot as unknown as LegacySnapshot,
      });
      lastReconcile = reconciled.verdict;
      return {
        holds: true,
        detail: 'the latest APPLY run is COMPLETED, from this source and panel map',
      };
    },
    RECONCILED: () =>
      Promise.resolve({
        holds: lastReconcile === 'RECONCILED',
        detail: `reconcile: ${String(lastReconcile)}`,
      }),
    REPORT_V2_HOLDS: async () => {
      const report = await deps.importer.finalReport({
        ...base,
        snapshot: snapshot as unknown as LegacySnapshot,
        evidenceClass: args.evidenceClass,
        inventory: (fresh as FreshCutoverFingerprints | null)?.inventory ?? null,
      });
      const v2 = report.finalV2 as
        | {
            readonly verdict: {
              readonly holds: boolean;
              readonly failedSections: readonly string[];
              readonly failedInvariants: readonly string[];
            };
          }
        | undefined;
      if (v2 === undefined) return { holds: false, detail: 'no v2 report' };
      return {
        holds: v2.verdict.holds,
        detail: v2.verdict.holds
          ? 'every section and every invariant holds'
          : `failed sections: ${v2.verdict.failedSections.join(', ') || '—'}; failed invariants: ${v2.verdict.failedInvariants.join(', ') || '—'}`,
      };
    },
    // Sampled again, LAST: an operator may have resumed sales while the steps above ran.
    STOP_SALES_STILL_ACTIVE: async () => {
      const again = stopSalesHolds(await deps.stopSalesFacts());
      return {
        holds: again.holds,
        detail: again.holds
          ? `still stopped at the end of the gate: ${again.detail}`
          : `sales are no longer stopped: ${again.detail}`,
      };
    },
  });
  return {
    version: LEGACY_CUTOVER_GATE_VERSION,
    evidenceClass: args.evidenceClass,
    generatedAt: deps.now().toISOString(),
    sourceFingerprint: (snapshot as LegacySnapshot | null)?.fingerprint ?? null,
    steps,
    verdict: failedStep === null ? 'CUTOVER_READY' : 'REFUSED',
    failedStep,
  };
}

export function cutoverGateExitCode(report: CutoverGateReport): number {
  return report.verdict === 'CUTOVER_READY' ? 0 : 3;
}

/** Inert text for a markdown cell: details carry hashes and counts, but stay inert anyway. */
function cell(text: string): string {
  return text.replace(/[|\\`*_[\]<>\r\n]/gu, (c) => (c === '\n' || c === '\r' ? ' ' : `\\${c}`));
}

export function cutoverGateText(report: CutoverGateReport, format: 'md' | 'json'): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const out = [
    `# Legacy cutover gate — ${report.verdict}`,
    '',
    ...(report.evidenceClass === 'synthetic'
      ? ['> **SYNTHETIC SOURCE — NOT EVIDENCE.** A fixture proves the code, never a cutover.', '']
      : []),
    '| field | value |',
    '| --- | --- |',
    `| version | ${report.version} |`,
    `| evidence class | ${report.evidenceClass} |`,
    `| generated at (UTC) | ${report.generatedAt} |`,
    `| source fingerprint | ${report.sourceFingerprint ?? '—'} |`,
    `| failed step | ${report.failedStep ?? '—'} |`,
    '',
    '| # | step | result | detail |',
    '| --- | --- | --- | --- |',
    ...report.steps.map(
      (s, i) => `| ${String(i + 1)} | ${s.step} | ${s.result} | ${cell(s.detail)} |`,
    ),
    '',
  ];
  return `${out.join('\n')}\n`;
}

/** The import's expectation from its flags (null where a flag was not given). */
export function cutoverExpectationOf(args: {
  readonly expectedFingerprint: string | null;
  readonly expectedPanelMapFingerprint: string | null;
  readonly expectedInventoryFingerprint: string | null;
  readonly expectedProductsFingerprint: string | null;
  readonly expectedInvoiceArchiveFingerprint: string | null;
  readonly expectedFreezeProofSha256: string | null;
  readonly expectedFinalDumpSha256: string | null;
}): CutoverExpectation {
  return {
    sourceFingerprint: args.expectedFingerprint,
    panelMapFingerprint: args.expectedPanelMapFingerprint,
    inventoryFingerprint: args.expectedInventoryFingerprint,
    productsFingerprint: args.expectedProductsFingerprint,
    invoiceArchiveFingerprint: args.expectedInvoiceArchiveFingerprint,
    freezeProofSha256: args.expectedFreezeProofSha256,
    finalDumpSha256: args.expectedFinalDumpSha256,
  };
}

export const readBytes = (path: string): Promise<Buffer> => readFile(path);
