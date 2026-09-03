import { readFileSync } from 'node:fs';
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
    const steps = workflow.jobs.gate?.steps ?? [];
    const gate = steps.map((s) => s.run ?? '').join('\n');
    // The workflow identity is supplied through `env:`, not spliced into the
    // script, so it has to be read from there.
    const env = steps.flatMap((s) => Object.values(s.env ?? {})).join('\n');
    expect(gate).toContain('head_sha=${SHA}');
    expect(env, 'the gate does not name the authoritative workflow').toContain(
      '.github/workflows/ci.yml',
    );
    expect(gate, 'the gate does not compare the run path').toMatch(/\[ "\$path" = "\$WORKFLOW" \]/);
    // Anything other than `success` — cancelled, skipped, stale, neutral,
    // timed_out — is not a pass, and a gate that accepts one is decoration.
    expect(gate).toMatch(/conclusion.*=.*"success"/);
    // Fails closed when nothing was found at all.
    expect(gate).toContain('no completed workflow run exists');
    // The returned run's own head_sha is compared, not just the query filter.
    expect(gate).toMatch(/\[ "\$head" = "\$SHA" \]/);
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
    const accepted = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
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

    // And the published manifest is checked at release time, not assumed.
    const verify = workflow.jobs.verify?.steps.map((s) => s.run ?? '').join('\n') ?? '';
    expect(verify).toContain('published architectures');
    for (const arch of accepted) expect(verify).toContain(dockerNames[arch]);
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
