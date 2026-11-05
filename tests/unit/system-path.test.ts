import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { SYSTEM_PATH_ALLOWLIST } from './system-path-allowlist';

/**
 * Every way into the SYSTEM path, pinned (ADR-0037).
 *
 * Row-level security binds a tenant only when the checkout knows one. A `@ScopeBound`
 * adapter method called with no `ScopeContext` and nothing bound runs as nexa_system,
 * under the reason `Class.method`; a `withSystemScope('…')` call does so under its
 * literal reason. Each is a read or write that crosses tenants, so each is a decision.
 * This lists them from the source and compares the list with the committed one: a new
 * unscoped adapter method, or a new explicit reason, fails here until somebody adds it
 * to `system-path-allowlist.ts` on purpose — and a removed one fails until the list
 * forgets it.
 *
 * "Unscoped" is read from the declaration: a public method none of whose parameters is
 * typed with a scope (`ScopeContext`, `TenantContext`, `SystemContext`, a step's
 * `…Context`, a `TransactionScope`, or an object type naming `scope`). A private helper is left out:
 * it runs under whatever the public method that called it bound.
 */

const ROOT = join(__dirname, '../../apps/api/src');
// `…Context` covers the step contexts (`MigrationContext`, …) that carry their `scope`.
const SCOPED_TYPE = /\b\w*Context\b|\bscope\s*[?:]/;
// A transaction carries its scope too, but only a REQUIRED one: `tx?` may be absent.
const TRANSACTION_TYPE = /\bTransactionScope\b/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

function isScopeBound(node: ts.ClassDeclaration): boolean {
  return (ts.getDecorators(node) ?? []).some((decorator) =>
    decorator.expression.getText().startsWith('ScopeBound('),
  );
}

function isPrivate(member: ts.MethodDeclaration): boolean {
  return (
    ts.isPrivateIdentifier(member.name) ||
    (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
  );
}

function systemPathEntries(): string[] {
  const entries = new Set<string>();
  for (const file of sourceFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('ScopeBound') && !text.includes('withSystemScope')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined && isScopeBound(node)) {
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || isPrivate(member)) continue;
          if (member.body === undefined) continue;
          const scoped = member.parameters.some((parameter) => {
            const type = parameter.type?.getText() ?? '';
            return (
              SCOPED_TYPE.test(type) ||
              (TRANSACTION_TYPE.test(type) && parameter.questionToken === undefined)
            );
          });
          if (!scoped) entries.add(`${node.name.text}.${member.name.getText()}`);
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.getText() === 'withSystemScope' &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        !relative(ROOT, file).endsWith('database-scope.ts')
      ) {
        entries.add(`reason: ${node.arguments[0].text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...entries].sort();
}

describe('the system path (ADR-0037)', () => {
  const found = systemPathEntries();

  it('finds the adapters at all — the scan is not vacuous', () => {
    expect(found.length).toBeGreaterThan(50);
    expect(found).toContain('reason: admin session lookup by token hash');
  });

  it('is exactly the committed allowlist: nothing new crosses tenants unannounced', () => {
    const allowed = [...SYSTEM_PATH_ALLOWLIST].sort();
    const added = found.filter((entry) => !allowed.includes(entry));
    const removed = allowed.filter((entry) => !found.includes(entry));
    expect(
      { added, removed },
      'a method reached the system path (or left it): review it, then update ' +
        'tests/unit/system-path-allowlist.ts',
    ).toEqual({ added: [], removed: [] });
  });
});
