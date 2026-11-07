import { describe, expect, it } from 'vitest';
import { systemContext, type ScopeContext } from '@nexa/contracts';
import {
  boundDatabaseScope,
  ScopeBound,
  withDatabaseScope,
} from '../../apps/api/src/infrastructure/persistence/database-scope';

/**
 * Which scope a persistence adapter's checkout is bound to (ADR-0037).
 *
 * Row-level security takes its tenant from the session, and the session takes it from
 * the scope bound when the checkout is made. These cases pin the rule `@ScopeBound`
 * applies, by reading the binding from inside a method exactly where a statement would
 * check out its connection. The database half — that a binding becomes a role and a
 * tenant on the connection — is `tests/integration/row-level-security.test.ts`.
 */

const A: ScopeContext = {
  tenantId: '01900000-0000-7000-8000-00000000000a' as never,
  botInstanceId: null,
};
const B: ScopeContext = {
  tenantId: '01900000-0000-7000-8000-00000000000b' as never,
  botInstanceId: null,
};

class Adapter {
  async scoped(scope: ScopeContext, _id: string): Promise<ScopeContext | undefined> {
    void scope;
    return boundDatabaseScope();
  }
  async viaTransaction(tx: {
    tx: unknown;
    scope: ScopeContext;
  }): Promise<ScopeContext | undefined> {
    void tx;
    return boundDatabaseScope();
  }
  async unscoped(_id: string): Promise<ScopeContext | undefined> {
    return boundDatabaseScope();
  }
  async helperCalledFromScoped(scope: ScopeContext): Promise<ScopeContext | undefined> {
    void scope;
    return this.unscoped('x');
  }
  lazy(scope: ScopeContext): PromiseLike<ScopeContext | undefined> & { readonly built: true } {
    void scope;
    // A drizzle query: a thenable that does its work only when awaited.
    return {
      built: true,
      then(resolve, reject) {
        return Promise.resolve(boundDatabaseScope()).then(resolve, reject);
      },
    };
  }
}

class InstallationAdapter {
  async unscoped(): Promise<ScopeContext | undefined> {
    return boundDatabaseScope();
  }
}

// Applied as a call, which is what the decorator syntax compiles to: the test project's
// compiler does not enable legacy decorators, the application's does.
ScopeBound()(Adapter);
ScopeBound({ installation: true })(InstallationAdapter);

describe('@ScopeBound', () => {
  const adapter = new Adapter();

  it('binds a method to the scope it is called with', async () => {
    expect(await adapter.scoped(A, 'x')).toBe(A);
    // Even inside another binding: the argument is what the method's predicate reads.
    expect(await withDatabaseScope(B, () => adapter.scoped(A, 'x'))).toBe(A);
  });

  it('reads the scope out of a transaction scope argument', async () => {
    expect(await adapter.viaTransaction({ tx: {}, scope: B })).toBe(B);
  });

  it('lets a scopeless helper keep the binding of the scoped method that called it', async () => {
    expect(await adapter.helperCalledFromScoped(A)).toBe(A);
    expect(await withDatabaseScope(B, () => adapter.unscoped('x'))).toBe(B);
  });

  it('runs a scopeless call with nothing bound on the system path, named for the method', async () => {
    expect(await adapter.unscoped('x')).toEqual(systemContext('Adapter.unscoped'));
  });

  it('always runs an installation adapter’s scopeless call on the system path', async () => {
    const installation = new InstallationAdapter();
    expect(await withDatabaseScope(A, () => installation.unscoped())).toEqual(
      systemContext('InstallationAdapter.unscoped'),
    );
  });

  it('binds a RETURNED lazy query when it is awaited, and keeps it composable', async () => {
    const query = adapter.lazy(B);
    expect(query.built).toBe(true);
    expect(await withDatabaseScope(A, async () => await query)).toBe(B);
  });

  it('does not leak a binding to the caller after the method returns', async () => {
    await adapter.scoped(A, 'x');
    expect(boundDatabaseScope()).toBeUndefined();
  });
});
