// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Module boundary enforcement.
 *
 * The dependency direction is:
 *
 *   @nexa/contracts  -> nothing (zod only)
 *   modules/<ctx>/domain      -> contracts
 *   modules/<ctx>/application -> contracts, own domain, own ports
 *   infrastructure            -> contracts, module ports (implements them)
 *   surfaces                  -> contracts, module application services only
 *
 * See docs/adr/0002-module-boundaries.md.
 */

const FRAMEWORK_AND_IO = [
  '@nestjs/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'pg',
  'grammy',
  'grammy/*',
  'bullmq',
  'ioredis',
  'fastify',
  'pino',
  'pino-*',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/research/**',
      'apps/api/drizzle/**',
      'apps/web/dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Silent failure is the single most common defect class in the legacy system:
      // three unrelated subsystems reported success for writes that changed nothing.
      'no-empty': ['error', { allowEmptyCatch: false }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // ---------------------------------------------------------------------------
  // @nexa/contracts: the frozen specification. Declarations only.
  // It may not depend on anything in the workspace, and nothing framework-shaped.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nexa/*'],
              message:
                '@nexa/contracts is the root of the dependency graph. It may not import any workspace package.',
            },
            {
              group: FRAMEWORK_AND_IO,
              message:
                '@nexa/contracts holds declarations only. No framework or I/O imports (ADR-015).',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Domain and application layers own the abstractions. Infrastructure implements
  // them and depends inward. This is the dependency-inversion rule.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/api/src/modules/*/domain/**/*.ts', 'apps/api/src/modules/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FRAMEWORK_AND_IO,
              message:
                'Domain and application layers must not import frameworks or I/O libraries. Declare a port here and implement it in infrastructure/ (ADR: dependency inversion).',
            },
            {
              group: ['**/infrastructure/**', '**/surfaces/**'],
              message:
                'Dependencies point inward. Domain/application may not import infrastructure or surfaces.',
            },
          ],
        },
      ],
      // Time must come from the Clock port so it is deterministic in tests and
      // so no module invents its own "now" (23-do-not-copy C-15).
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            'Use the Clock port instead of new Date(). Domain and application code must not read the wall clock directly.',
        },
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: 'Use the Clock port instead of Date.now().',
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: 'Use the IdGenerator or a Random port instead of Math.random().',
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Surfaces are presentation. They may call application services and nothing else.
  // This is the single rule that prevents the legacy system's split brain
  // (four admin roles in one surface, seven in the other).
  // ---------------------------------------------------------------------------
  {
    files: ['apps/api/src/surfaces/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/domain/**', '**/persistence/**', '**/*.repository', '**/*.schema'],
              message:
                'Surfaces may not reach into domain entities, repositories or schema. Call an application service (ADR-017).',
            },
            {
              group: ['drizzle-orm', 'drizzle-orm/*', 'pg'],
              message: 'Surfaces contain no data access. Call an application service (ADR-017).',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Only the persistence layer may touch Drizzle.
  // ---------------------------------------------------------------------------
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: [
      'apps/api/src/infrastructure/persistence/**',
      'apps/api/src/modules/*/infrastructure/**',
      'apps/api/drizzle.config.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'drizzle-orm/node-postgres',
              message: 'Database access belongs in a persistence adapter, not here.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Tests and scripts relax the wall-clock and console rules.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.test.ts', '**/*.spec.ts', 'tests/**/*.ts', 'scripts/**/*.{ts,mjs}'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      'no-undef': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
      },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nexa/api', '@nexa/api/*'],
              message:
                'The web admin talks to the API over HTTP. It may import @nexa/contracts and @nexa/i18n only.',
            },
          ],
        },
      ],
    },
  },
);
