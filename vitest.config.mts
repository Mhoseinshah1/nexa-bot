import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * The source is ESM and uses explicit `.js` specifiers, as Node requires. Vite
 * resolves from source, so it needs to map `./x.js` back to `./x.ts`.
 */
function tsExtensionResolver(): Plugin {
  return {
    name: 'nexa-ts-extension-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      const candidate = resolve(dirname(importer), source.replace(/\.js$/, '.ts'));
      return existsSync(candidate) ? candidate : null;
    },
  };
}

const shared = {
  globals: false,
  environment: 'node' as const,
  restoreMocks: true,
};

export default defineConfig({
  plugins: [tsExtensionResolver()],
  test: {
    projects: [
      {
        plugins: [tsExtensionResolver()],
        test: {
          ...shared,
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          // Unit tests are pure: no database, no Redis, no network. If one of
          // them needs a service, it belongs in the integration project.
          testTimeout: 10_000,
        },
      },
      {
        plugins: [tsExtensionResolver()],
        test: {
          ...shared,
          // The combinatorial enumeration. Deliberately NOT in `integration`:
          // 1 341 orderings, each with a full database reset. The suite runs
          // in about four minutes and took the whole CI integration job to
          // fourteen, so the cost of the search landed on every unrelated
          // change. Nightly and on demand instead — and nothing here is the
          // only cover for a known bug.
          name: 'exhaustive',
          include: ['tests/exhaustive/**/*.test.ts'],
          setupFiles: ['tests/integration/setup.ts'],
          fileParallelism: false,
          testTimeout: 1_800_000,
          hookTimeout: 60_000,
        },
      },
      {
        plugins: [tsExtensionResolver()],
        test: {
          ...shared,
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          setupFiles: ['tests/integration/setup.ts'],
          // Integration tests share one database; running files in parallel
          // would have them truncating each other's tables.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
