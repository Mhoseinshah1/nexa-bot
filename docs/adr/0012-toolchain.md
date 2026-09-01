# ADR-0012 — TypeScript 6, ESM, Node 22, NestJS 12

**Status:** Accepted.

## TypeScript pinned to exactly 6.0.2

TypeScript 7.0.2 is the current release. We pin `6.0.2` via `pnpm.overrides`.

`@nestjs/cli` 12 pins `typescript ~6.0.2`, and TypeScript 7 is the native-port
compiler line, which the decorator-metadata emit NestJS depends on is the
riskiest surface around. Forcing 7 at the root while Nest pins 6 resolves two
TypeScript copies in one workspace — the classic cause of "the editor and CI
disagree".

Strict mode, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

**Revisit when** the Nest CLI peer range moves to 7.

## ESM, not CommonJS

An earlier draft of this plan chose CommonJS for the API on the grounds that
decorators and `reflect-metadata` are better behaved there. That was wrong for
this stack: **NestJS 12 ships as ESM only**, and the CommonJS build fails at
`tsc` with TS1479 on every `@nestjs/*` import.

So: `"type": "module"` in every TypeScript package, `module`/`moduleResolution`
set to `node16`, and explicit `.js` specifiers on relative imports as Node
requires. Vitest resolves those back to `.ts` through a small plugin in
`vitest.config.mts`.

The cost is the `.js` extension on relative imports, which reads oddly in a
`.ts` file. The alternative — a bundler in the build path — buys nothing here
and hides resolution errors until runtime.

## Node 22

`@nestjs/core` 12 requires Node ≥ 20. Node 22 is the current LTS line and is
what the CI image and the cloud development environment provide.

## Internal packages have a real build step

`@nexa/contracts` and `@nexa/i18n` compile to `dist` and expose their
declarations from there. Source-only internal packages with `exports` pointing
at `.ts` would push their compilation into every consumer, and `tsc` in a
NestJS app is not a bundler. `pnpm -r` runs the build in topological order.

## Other choices

| Choice                        | Why                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Fastify over Express          | Faster, and `inject` lets tests drive the app without binding a port                                          |
| pino                          | Structured logs with path-based redaction of secret-shaped fields                                             |
| Zod 4                         | One schema library shared by contracts, the API boundary and the web client                                   |
| Vitest 4                      | Native ESM, workspace projects for the unit/integration split                                                 |
| pnpm workspaces, no Turborepo | Four workspaces with no per-package build graph to speak of; `pnpm -r` is sufficient and one dependency fewer |
