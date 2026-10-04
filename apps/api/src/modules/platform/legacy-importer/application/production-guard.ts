import { sha256Hex } from './source-snapshot.js';

/**
 * Migration P7 — the hard production guard (`docs/legacy-migration/importer.md` §Guard).
 *
 * The CLI never defaults a target, and on top of that it REFUSES every mode against a
 * target that looks like production unless two independent things are both present:
 *
 * 1. the flag `--allow-production-target`, typed on the command line, and
 * 2. the environment variable `NEXA_LEGACY_IMPORT_TARGET_ACK` set to the 16-hex
 *    acknowledgement of THIS target and THIS tenant — printed by the refusal itself.
 *
 * The acknowledgement is bound to host, port, database and tenant (as ADR-0028 binds a
 * restore confirmation to one archive's checksum), so an acknowledgement exported for a
 * staging rehearsal cannot arm a run against production, and one left in a shell profile
 * cannot arm a run against a different tenant. A flag alone is a habit; an environment
 * variable alone is a leftover; both, bound to the target, is a decision.
 *
 * "Looks like production" is decided conservatively — production-like unless every sign
 * says otherwise:
 *
 * - the process runs with `NODE_ENV=production`, or
 * - the database name carries none of the non-production words below as a whole
 *   `_`/`-`-separated token (`nexa` is production-like; `nexa_staging` is not).
 *
 * A synthetic fixture source is refused against a production-like target ALWAYS, with or
 * without the acknowledgement: there is no reason to write SYNTHETIC rows anywhere real.
 */

export const NON_PRODUCTION_DATABASE_TOKENS: readonly string[] = [
  'staging',
  'stage',
  'rehearsal',
  'test',
  'dev',
  'scratch',
  'sandbox',
  'p4',
];

export const TARGET_ACK_ENV = 'NEXA_LEGACY_IMPORT_TARGET_ACK';
export const ALLOW_PRODUCTION_FLAG = '--allow-production-target';

export interface TargetIdentity {
  readonly host: string;
  readonly port: string;
  readonly database: string;
}

export interface TargetClassification {
  readonly productionLike: boolean;
  readonly reasons: readonly string[];
}

export function classifyTarget(
  target: TargetIdentity,
  env: { readonly NODE_ENV?: string | undefined },
): TargetClassification {
  const reasons: string[] = [];
  if (env.NODE_ENV === 'production') reasons.push('NODE_ENV is production');
  const tokens = target.database.toLowerCase().split(/[_-]+/u);
  if (!tokens.some((t) => NON_PRODUCTION_DATABASE_TOKENS.includes(t))) {
    reasons.push(
      `database "${target.database}" carries no non-production word (${NON_PRODUCTION_DATABASE_TOKENS.join(', ')})`,
    );
  }
  return { productionLike: reasons.length > 0, reasons };
}

/** The acknowledgement for one target and tenant. A digest: safe to print, not a secret. */
export function targetAcknowledgement(target: TargetIdentity, tenantId: string): string {
  return sha256Hex(
    `legacy-import-target:v1:${target.host.toLowerCase()}:${target.port}/${target.database}:${tenantId}`,
  ).slice(0, 16);
}

export type GuardVerdict =
  | { readonly allowed: true; readonly productionLike: boolean }
  | { readonly allowed: false; readonly message: string };

export function evaluateProductionGuard(input: {
  readonly target: TargetIdentity;
  readonly tenantId: string;
  readonly env: {
    readonly NODE_ENV?: string | undefined;
    readonly [TARGET_ACK_ENV]?: string | undefined;
  };
  readonly allowProductionFlag: boolean;
  readonly syntheticSource: boolean;
}): GuardVerdict {
  const classification = classifyTarget(input.target, input.env);
  if (!classification.productionLike) return { allowed: true, productionLike: false };

  const why = classification.reasons.map((r) => `  - ${r}`).join('\n');
  if (input.syntheticSource) {
    return {
      allowed: false,
      message:
        `Refused: the target looks like production and the source is a SYNTHETIC fixture.\n${why}\n` +
        'A synthetic dataset is never imported into a production-like database, acknowledged or not.',
    };
  }
  const expected = targetAcknowledgement(input.target, input.tenantId);
  const ack = input.env[TARGET_ACK_ENV];
  if (input.allowProductionFlag && ack === expected) return { allowed: true, productionLike: true };

  const missing = [
    input.allowProductionFlag ? null : `the flag ${ALLOW_PRODUCTION_FLAG}`,
    ack === expected
      ? null
      : ack === undefined || ack === ''
        ? `${TARGET_ACK_ENV}=${expected} in the environment`
        : `${TARGET_ACK_ENV} names a different target or tenant (expected ${expected})`,
  ].filter((m): m is string => m !== null);
  return {
    allowed: false,
    message:
      `Refused: the target ${input.target.host}:${input.target.port}/${input.target.database} looks like production.\n${why}\n` +
      `To run against it anyway, BOTH are required:\n${missing.map((m) => `  - ${m}`).join('\n')}\n` +
      'Production import is an owner-approval step of the cutover runbook; do not arm this for a rehearsal.',
  };
}

// --- evidence class ----------------------------------------------------------------------

export const EVIDENCE_CLASSES = ['synthetic', 'staging', 'production'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

export type EvidenceClassVerdict =
  | { readonly ok: true; readonly evidenceClass: EvidenceClass }
  | { readonly ok: false; readonly message: string };

/**
 * What a run's report may call itself, decided after the source's marker has been read, so
 * a mislabel is impossible (the label is what the owner's production gate reads):
 *
 * - A source carrying the SYNTHETIC marker is `synthetic`, always. An explicit claim of
 *   `staging` or `production` is refused, and so is a production-like target outright —
 *   the guard's fixture rule, extended to a synthetic dataset loaded into a real engine.
 * - A source without the marker is never `synthetic`: claiming it is refused (it would let
 *   a real run pass as a rehearsal of code).
 * - `production` is refused on a target that does not look like production; `staging` is
 *   allowed on one that does (a staging server runs `NODE_ENV=production`, acknowledged).
 * - With no claim, a real source is labelled by its target: production-like → `production`.
 *   `import`, `resume` and `report` require the claim (`--evidence-class`).
 */
export function decideEvidenceClass(input: {
  readonly claim: EvidenceClass | null;
  readonly syntheticSource: boolean;
  readonly productionLikeTarget: boolean;
}): EvidenceClassVerdict {
  if (input.syntheticSource) {
    if (input.productionLikeTarget) {
      return {
        ok: false,
        message:
          'Refused: the source carries the SYNTHETIC marker and the target looks like production. ' +
          'A synthetic dataset is never run against a production-like database.',
      };
    }
    if (input.claim !== null && input.claim !== 'synthetic') {
      return {
        ok: false,
        message: `Refused: --evidence-class ${input.claim} on a source carrying the SYNTHETIC marker. Its evidence class is synthetic.`,
      };
    }
    return { ok: true, evidenceClass: 'synthetic' };
  }
  if (input.claim === 'synthetic') {
    return {
      ok: false,
      message: 'Refused: --evidence-class synthetic on a source without the SYNTHETIC marker.',
    };
  }
  if (input.claim === 'production' && !input.productionLikeTarget) {
    return {
      ok: false,
      message:
        'Refused: --evidence-class production on a target that does not look like production.',
    };
  }
  return {
    ok: true,
    evidenceClass: input.claim ?? (input.productionLikeTarget ? 'production' : 'staging'),
  };
}
