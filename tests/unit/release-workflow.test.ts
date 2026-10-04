import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The release workflow, as production supply-chain code.
 *
 * A pull request cannot run this file, and a tag runs it exactly once, so the
 * only place its invariants can be checked before they matter is here.
 */
describe('the release workflow', () => {
  const path = join(__dirname, '../../.github/workflows/release.yml');
  const raw = readFileSync(path, 'utf8');
  const workflow = parse(raw) as {
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        needs?: string | string[];
        permissions?: Record<string, string>;
        steps: {
          name?: string;
          uses?: string;
          with?: Record<string, unknown>;
          run?: string;
          env?: Record<string, string>;
        }[];
      }
    >;
  };
  const needsOf = (job: string): string[] => {
    const needs = workflow.jobs[job]?.needs;
    return needs === undefined ? [] : Array.isArray(needs) ? needs : [needs];
  };

  it('publishes only after the gate job', () => {
    // The gate proves the exact source commit passed CI and that the version
    // has never been published. Without `needs`, the jobs run in parallel and
    // the image is pushed while the gate is still deciding.
    expect(needsOf('publish')).toContain('gate');
    expect(Object.keys(workflow.jobs)).toContain('gate');
  });

  it('gives only the publish job permission to write packages', () => {
    // Declared empty at the top so nothing inherits by accident.
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.publish?.permissions?.packages).toBe('write');
    expect(workflow.jobs.gate?.permissions?.packages).toBe('read');
    expect(workflow.jobs.verify?.permissions?.packages).toBe('read');
    // The gate reads workflow runs; that is the whole reason it exists.
    expect(workflow.jobs.gate?.permissions?.actions).toBe('read');
  });

  it('requires a SUCCESSFUL run of the authoritative workflow for the exact SHA', () => {
    // The decision itself lives in scripts/release-ci-gate.mjs and is tested
    // rule by rule in release-ci-gate.test.ts (and end to end, against a fake
    // gh, in tests/deploy/release-ci-gate.test.sh). What THIS file pins is
    // that the workflow actually calls it, with the resolved SHA, before any
    // later step can run.
    const steps = workflow.jobs.gate?.steps ?? [];
    const index = steps.findIndex(
      (s) => s.name === 'Require CI to have passed for this exact commit',
    );
    expect(index, 'the CI gate step is gone').toBeGreaterThan(-1);
    const step = steps[index];
    expect(step?.run?.trim()).toBe('bash scripts/release-ci-gate.sh "$REPO" "$SHA"');
    expect(step?.env?.SHA, 'the gate is not asked about the resolved commit').toBe(
      '${{ steps.source.outputs.sha }}',
    );
    // A step that may fail without failing the job is decoration.
    expect(step).not.toHaveProperty('continue-on-error');
    expect(step).not.toHaveProperty('if');
    // It runs before the registry check and the login, so nothing downstream
    // of a refused gate even starts.
    const login = steps.findIndex((s) => s.uses?.startsWith('docker/login-action'));
    expect(index).toBeLessThan(login);
  });

  it('runs the gate logic from the workflow commit, never from the tag being judged', () => {
    // For workflow_dispatch the requested tag may point anywhere. If the gate
    // script came from that checkout, a commit could vouch for itself.
    const steps = workflow.jobs.gate?.steps ?? [];
    const checkouts = steps.filter((s) => s.uses?.startsWith('actions/checkout'));
    const own = checkouts.find((s) => s.with?.ref === '${{ github.workflow_sha }}');
    expect(own, 'the gate does not check out its own workflow commit').toBeDefined();
    expect(own?.with?.path, 'the workflow commit must be the working directory').toBeUndefined();
    const tagged = checkouts.find((s) =>
      String(s.with?.ref ?? '').startsWith('refs/tags/${{ steps.request.outputs.tag }}'),
    );
    expect(tagged?.with?.path, 'the tagged source must be checked out beside, not over').toBe(
      'source',
    );
    const resolve = steps.find((s) => s.name === 'Resolve the tag to an immutable commit');
    expect(resolve?.run).toContain("git -C source rev-parse 'HEAD^{commit}'");
    // The tag is validated before anything is checked out under it.
    const validate = steps.findIndex((s) => s.name === 'Validate the requested tag');
    expect(validate).toBeGreaterThan(-1);
    expect(steps[validate]?.run).toContain('release-ci-gate.mjs --validate-tag "$REQUESTED"');
    expect(validate).toBeLessThan(steps.indexOf(tagged!));
  });

  it('resolves the tag to a commit ONCE and pins every later job to it', () => {
    // A tag is a mutable pointer. If each job resolves it separately, the job
    // that checked CI and the job that builds can legitimately see different
    // commits — and only one of them passed.
    for (const job of ['publish', 'verify']) {
      const steps = workflow.jobs[job]?.steps ?? [];
      const checkout = steps.find((s) => s.uses?.startsWith('actions/checkout'));
      expect(checkout?.with?.ref, `${job} re-resolves the tag`).toBe(
        '${{ needs.gate.outputs.sha }}',
      );
    }
    expect(needsOf('verify')).toContain('gate');
  });

  it('refuses to republish a version that already exists', () => {
    const gate = workflow.jobs.gate?.steps.map((s) => s.run ?? '').join('\n') ?? '';
    expect(gate).toContain('already exists in the registry');
    expect(gate).toMatch(/docker manifest inspect/);
    // No escape hatch: the way to publish different bytes is a new version.
    // Asserted on the workflow's declared INPUTS, which is where a bypass
    // would actually have to live — the prose above may name the thing it
    // refuses to provide.
    const inputs = (
      parse(raw) as { on: { workflow_dispatch?: { inputs?: Record<string, unknown> } } }
    ).on.workflow_dispatch?.inputs;
    expect(Object.keys(inputs ?? {})).toEqual(['tag']);
  });

  it('treats an unresolved registry lookup as a stop, not as absence', () => {
    const gate = workflow.jobs.gate?.steps.map((s) => s.run ?? '').join('\n') ?? '';

    // `docker manifest inspect` exits non-zero for a missing manifest AND for
    // a registry that is down, a token that has expired, and a response it
    // cannot parse. The one-liner it replaced read all of those as "never
    // published", which publishes over an immutable version the moment the
    // registry comes back.
    expect(gate, 'a bare `if docker manifest inspect` reads any failure as absence').not.toMatch(
      /if docker manifest inspect[^\n]*then/,
    );

    // Absence has to be a positive determination by the registry.
    expect(gate).toContain('MANIFEST_UNKNOWN');
    const classification = gate.slice(gate.indexOf('status=$?'));
    expect(classification, 'the lookup output is captured but never classified').toContain(
      'could not determine whether',
    );
    // And the unclassified case must actually stop.
    const fallthrough = classification.slice(classification.indexOf('could not determine whether'));
    expect(fallthrough).toContain('exit 1');
  });

  it('serialises on the VERSION, so two trigger paths cannot publish it at once', () => {
    // `github.ref` is refs/tags/v1.0.0 for a tag push and refs/heads/main for a
    // workflow_dispatch launched from main, so keying on it put the two paths
    // in different groups. Both gates would then ask "has this version been
    // published?" before either publish job pushed, both would see no, and one
    // version would end up with two digests.
    const concurrency = (parse(raw) as { concurrency: { group: string } }).concurrency;
    expect(concurrency.group).toContain('github.event.inputs.tag');
    expect(concurrency.group).toContain('github.ref_name');
    expect(concurrency.group, 'keyed on the full ref, which differs per trigger').not.toMatch(
      /github\.ref\s*}}/,
    );
  });

  it('builds every architecture the installer accepts', () => {
    const build = workflow.jobs.publish?.steps.find((s) => s.name === 'Build and push');
    expect(build?.with?.platforms).toBe('linux/amd64,linux/arm64');
    // Emulation has to be set up or the arm64 build silently is not one.
    expect(
      workflow.jobs.publish?.steps.some((s) => s.uses?.startsWith('docker/setup-qemu-action')),
      'no QEMU setup, so arm64 cannot be built',
    ).toBe(true);
  });

  it('keeps the installer and the published architectures in step', () => {
    // Two lists of the same fact, in two languages. This is the test that
    // notices when one of them moves.
    const installer = readFileSync(join(__dirname, '../../deploy/install.sh'), 'utf8');
    const declared = /SUPPORTED_ARCH=\(([^)]*)\)/.exec(installer)?.[1] ?? '';
    const accepted = [...declared.matchAll(/"([^"]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
    expect(accepted.length, 'the installer no longer declares SUPPORTED_ARCH').toBeGreaterThan(0);

    const dockerNames: Record<string, string> = { x86_64: 'amd64', aarch64: 'arm64' };
    const build = workflow.jobs.publish?.steps.find((s) => s.name === 'Build and push');
    const platforms = String(build?.with?.platforms ?? '');
    for (const arch of accepted) {
      const docker = dockerNames[arch];
      expect(docker, `no Docker platform name known for ${arch}`).toBeTruthy();
      expect(platforms, `the installer accepts ${arch} but no image is built for it`).toContain(
        `linux/${docker}`,
      );
    }

    // And the published manifest is CHECKED at release time, not merely
    // printed. Asserting on the architecture names alone was satisfied by the
    // prose comment in the same run block, so deleting the entire enforcement
    // loop left this green.
    const verify = workflow.jobs.verify?.steps.map((s) => s.run ?? '').join('\n') ?? '';
    expect(verify).toContain('published architectures');
    expect(verify, 'the manifest is read but nothing is enforced').toMatch(
      /for required in [^\n]*amd64[^\n]*arm64/,
    );
    expect(verify, 'a missing architecture does not fail the release').toMatch(
      /the published manifest has no %s image/,
    );
    // The loop must be able to fail.
    const loop = verify.slice(verify.indexOf('for required in'));
    expect(loop).toContain('exit 1');
  });

  it('pins every third-party action to an immutable commit', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.uses) continue;
        expect(step.uses, `${name}: ${step.uses} is not pinned to a SHA`).toMatch(/@[0-9a-f]{40}$/);
      }
    }
  });
});

/**
 * pnpm is provisioned before anything needs it, in every job of every workflow.
 *
 * v0.4.4's release stopped in the gate job, at actions/setup-node, with
 * "Unable to locate executable file: pnpm": #168 gave that job a checkout of
 * the workflow commit at the workspace root, and setup-node v5 — given no
 * `cache:` input — reads `packageManager` from that package.json, sees pnpm,
 * and restores a pnpm cache by running `pnpm store path`. No step had
 * installed pnpm. The publish and verify jobs were skipped and CI had been
 * green, so nothing before the tag could have shown it; this can.
 */
describe('pnpm provisioning in every workflow', () => {
  type Step = {
    name?: string;
    uses?: string;
    with?: Record<string, unknown>;
    run?: string;
  };
  const root = join(__dirname, '../..');
  const directory = join(root, '.github/workflows');
  const files = readdirSync(directory).filter((f) => /\.ya?ml$/.test(f));
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };

  const action = (step: Step): string => step.uses?.split('@')[0] ?? '';
  const isProvisioning = (step: Step): boolean => action(step) === 'pnpm/action-setup';
  const isRootCheckout = (step: Step): boolean =>
    action(step) === 'actions/checkout' && step.with?.path === undefined;

  /** Why this step cannot run without pnpm on PATH, or null if it can. */
  const needsPnpm = (step: Step): string | null => {
    if (action(step) === 'actions/setup-node') {
      const cache = step.with?.cache;
      if (cache === 'pnpm') return 'setup-node with `cache: pnpm`';
      // setup-node v5: with no `cache:` input, the cache is chosen from
      // `packageManager` — pnpm here — unless `package-manager-cache` is off.
      const automatic = step.with?.['package-manager-cache'];
      if ((cache === undefined || cache === '') && automatic !== false && automatic !== 'false') {
        return 'setup-node with the automatic packageManager (pnpm) cache';
      }
      return null;
    }
    if (step.run === undefined) return null;
    const code = step.run
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    return /(^|[\s;&|(`])pnpm(\s|$)/m.test(code) ? 'a run step that calls pnpm' : null;
  };

  it('reads the pinned pnpm version from the root manifest', () => {
    // The one place the version lives. pnpm/action-setup reads it from here.
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('is checked against the workflows that exist', () => {
    // A rename must not make the checks below vacuous.
    expect(files).toEqual(expect.arrayContaining(['ci.yml', 'exhaustive.yml', 'release.yml']));
  });

  for (const file of files) {
    const workflow = parse(readFileSync(join(directory, file), 'utf8')) as {
      env?: Record<string, unknown>;
      jobs: Record<string, { steps?: Step[] }>;
    };

    it(`${file}: every step that needs pnpm comes after a step that installs it`, () => {
      for (const [job, { steps = [] }] of Object.entries(workflow.jobs)) {
        const provisioned = steps.findIndex(isProvisioning);
        steps.forEach((step, index) => {
          const reason = needsPnpm(step);
          if (reason === null) return;
          const label = step.name ?? step.uses ?? step.run?.split('\n')[0];
          const where = `${file} job "${job}" step ${index + 1} (${label}) is ${reason}`;
          expect(provisioned, `${where}, but no step in the job installs pnpm`).toBeGreaterThan(-1);
          expect(provisioned, `${where}, and runs before pnpm/action-setup`).toBeLessThan(index);
        });
      }
    });

    it(`${file}: pnpm/action-setup takes its version from packageManager`, () => {
      for (const [job, { steps = [] }] of Object.entries(workflow.jobs)) {
        steps.forEach((step, index) => {
          if (!isProvisioning(step)) return;
          // A `version:` input is a second copy of the pin. Equal, it is
          // redundant; different, the action refuses to run. Either way the
          // repository's own field is the answer.
          expect(step.with?.version, `${file} job "${job}" pins pnpm in the workflow`).toBe(
            undefined,
          );
          expect(step.with?.package_json_file ?? 'package.json').toBe('package.json');
          // It reads package.json from the workspace root, so the root
          // checkout has to be there first.
          const checkout = steps.findIndex(isRootCheckout);
          expect(
            checkout,
            `${file} job "${job}": nothing is checked out at the root`,
          ).toBeGreaterThan(-1);
          expect(checkout).toBeLessThan(index);
        });
      }
      expect(
        workflow.env ?? {},
        `${file} keeps a second copy of the pnpm version`,
      ).not.toHaveProperty('PNPM_VERSION');
    });
  }
});
