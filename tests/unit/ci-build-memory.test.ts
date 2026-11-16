import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Step {
  name?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Workflow {
  env?: Record<string, string>;
  jobs: Record<string, { env?: Record<string, string>; steps: Step[] }>;
}
const root = join(__dirname, '../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8')) as Workflow;
const budget = '--max-old-space-size=4096';

describe('the measured Node compilation budget', () => {
  it('applies a working 4 GiB heap option only to build and typecheck steps', () => {
    expect(workflow.env?.NODE_OPTIONS).toBeUndefined();
    const configured: string[] = [];
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      expect(job.env?.NODE_OPTIONS, jobName).toBeUndefined();
      for (const step of job.steps) {
        if (jobName === 'static' && step.name === 'Typecheck') {
          expect(step.env?.NODE_OPTIONS).toBe(budget);
          expect(step.run).toContain('pnpm typecheck');
        } else if (jobName === 'build' && step.name === 'Build all workspaces') {
          expect(step.env?.NODE_OPTIONS).toBe(budget);
          expect(step.run).toContain('pnpm build');
        } else {
          expect(step.env?.NODE_OPTIONS, `${jobName}: ${step.name}`).toBeUndefined();
        }
        if (step.env?.NODE_OPTIONS) {
          configured.push(`${jobName}:${step.name}`);
          const limit = Number(
            execFileSync(
              process.execPath,
              [
                '-e',
                'console.log(require("node:v8").getHeapStatistics().heap_size_limit / 1024 ** 2)',
              ],
              { env: { ...process.env, NODE_OPTIONS: step.env.NODE_OPTIONS }, encoding: 'utf8' },
            ).trim(),
          );
          expect(limit).toBeGreaterThanOrEqual(4096);
          expect(limit).toBeLessThan(4352);
          expect(step.run).toContain('heapLimitMiB');
          expect(step.run).toContain('constrainedMemoryMiB');
        }
      }
    }
    expect(configured.sort()).toEqual(['build:Build all workspaces', 'static:Typecheck']);
  });

  it('limits the Docker override to the builder compilation command, never image ENV', () => {
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
    const instructions = dockerfile
      .replace(/\\\n/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    let stage = '';
    const overrides: string[] = [];
    for (const line of instructions) {
      if (/^FROM /i.test(line)) stage = line.match(/ AS (\w+)$/i)?.[1] ?? '';
      if (/NODE_OPTIONS|--max-old-space-size/.test(line)) {
        expect(stage).toBe('builder');
        expect(line).toBe(`RUN NODE_OPTIONS=${budget} pnpm build`);
        overrides.push(line);
      }
    }
    expect(overrides).toHaveLength(1);
    expect(instructions).toContain('FROM base AS system');
    expect(instructions).toContain('FROM system AS runtime');
  });
});
