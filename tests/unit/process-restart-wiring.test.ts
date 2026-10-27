import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROCESS_ROLE_LABELS_FA } from '@nexa/i18n';

/**
 * R11 A3: the crash-loop watch is only worth what its wiring is. Every process role the
 * deployment SUPERVISES (a compose service whose `command` is a `dist/main*.js` entrypoint,
 * restarted by Docker when it dies) starts the watch right after the installation's tenant
 * is known, and stops it from its shutdown path — read from the sources, so a role added to
 * the compose file without the watch fails here by name.
 */

const root = join(__dirname, '../..');
const compose = readFileSync(join(root, 'deploy/compose.yml'), 'utf8');
const src = join(root, 'apps/api/src');

/** `dist/main.worker.js` -> `worker`; `dist/main.js` -> `api`. */
const supervisedRoles = [...compose.matchAll(/command: \['node', 'dist\/main(?:\.(\w+))?\.js'\]/g)]
  .map((match) => match[1] ?? 'api')
  .sort();

const entrypoint = (role: string): string =>
  readFileSync(join(src, role === 'api' ? 'main.ts' : `main.${role}.ts`), 'utf8');

describe('every supervised role watches itself for a crash loop', () => {
  it('finds the roles in the compose file, so the cases below cannot pass vacuously', () => {
    expect(supervisedRoles).toEqual([
      'api',
      'assistant',
      'monitor',
      'provisioner',
      'recovery',
      'worker',
    ]);
  });

  it.each(supervisedRoles)(
    '%s starts the watch under its own name and stops it on shutdown',
    (role) => {
      const source = entrypoint(role);
      expect(source).toContain(
        `const restartWatch = await startProcessRestartWatch(container, '${role}');`,
      );
      // The stop sits inside the shutdown coordinator's `close`, before the container is closed.
      const close = source.slice(source.indexOf('close: async () => {'));
      expect(close).toContain('await restartWatch.stop();');
      expect(close.indexOf('await restartWatch.stop();')).toBeLessThan(
        close.indexOf('await container.shutdown();'),
      );
    },
  );

  it.each(supervisedRoles)('%s starts it only once the installation tenant is resolved', (role) => {
    const source = entrypoint(role);
    const watch = source.indexOf('startProcessRestartWatch(container');
    // The api resolves its tenant inside createApiApp; every other role calls it itself.
    const tenant = Math.max(
      source.indexOf('await resolveInstallationTenant(container);'),
      source.indexOf('await createApiApp('),
    );
    expect(tenant).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(tenant);
  });

  it.each(supervisedRoles)('%s has a Persian name and a name the table accepts', (role) => {
    expect(PROCESS_ROLE_LABELS_FA[role], role).toMatch(/^[؀-ۿ‌ ]+$/);
    expect(role).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
});
