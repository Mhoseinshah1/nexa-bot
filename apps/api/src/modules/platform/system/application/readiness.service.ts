import type { Clock, DependencyStatus, Logger } from '@nexa/contracts';

/**
 * What the database says about the schema THIS release was built for.
 *
 * Declared here rather than imported from the migrator so the policy — which
 * of these states is ready — lives in the application layer with the rest of
 * the readiness rules. Infrastructure answers the question; it does not decide
 * what the answer means.
 */
export type SchemaReadiness =
  /** Every expected migration applied, with the content this release ships. */
  | { readonly state: 'CURRENT'; readonly applied: number }
  /**
   * Every expected migration applied, and more besides — the shape a rollback
   * leaves, because a release's migrations only add (ADR-0022).
   */
  | { readonly state: 'AHEAD'; readonly expected: number; readonly extra: number }
  /** Nothing has ever been applied. */
  | { readonly state: 'NONE' }
  /** A strict prefix: the release's migration has not run, or died part-way. */
  | {
      readonly state: 'BEHIND';
      readonly applied: number;
      readonly expected: number;
      readonly next: string;
    }
  /** A history this release cannot account for. */
  | { readonly state: 'DIVERGED'; readonly reason: string };

/**
 * Whether one dependency's state makes this process NOT READY.
 *
 * Exported, and a free function rather than a line inside the aggregation, for
 * one reason: `required !== false` is a rule with a direction, and as a lambda
 * inside `run` it could not be tested with a dependency that omits the flag —
 * every probe in this file states one, so `=== true` would behave identically
 * and the mutation would survive. Here it can be called with the shape an older
 * or newer probe actually produces.
 *
 * `!== false`, not `=== true`: ABSENT MEANS REQUIRED. A probe that forgot to say
 * must count, because the safe reading of "unknown" is "this matters". With
 * `=== true` a dependency added without the flag would be silently optional —
 * down while the process reports ready, which is the defect item F exists to
 * remove, pointing the other way.
 */
export function blocksReadiness(dependency: DependencyStatus): boolean {
  return dependency.status === 'down' && dependency.required !== false;
}

/**
 * The dependencies readiness asks about, as questions rather than as handles.
 *
 * This is the port the fix for C16 exists to create. The readiness computation
 * used to live in `surfaces/web/readiness.probe.ts` holding the concrete
 * database handle, the Redis handle and the outbox relay: a surface reaching
 * past the application layer into infrastructure, which is the dependency
 * direction this codebase inverts everywhere else. An earlier pass moved the
 * SQL out and left the handles, which satisfied a boundary check that looked
 * for statements and changed nothing about the direction.
 *
 * Every method takes the deadline it must respect rather than a timeout it may
 * interpret: one absolute instant is computed per probe and handed down, so a
 * checkout granted late gets only the time that is left.
 */
export interface ReadinessProbes {
  /** A round trip to PostgreSQL. Throws if it cannot make one. */
  database(deadlineAt: number): Promise<void>;
  /** Whether the cache answered. Never throws — a blip must not crash a probe. */
  cache(): Promise<boolean>;
  /** The schema, compared against this release's own journal. */
  schema(deadlineAt: number): Promise<SchemaReadiness>;
  /** How far behind the outbox is, in milliseconds. */
  outboxLagMs(deadlineAt: number): Promise<number>;
}

export interface ReadinessDeps {
  readonly probes: ReadinessProbes;
  readonly logger: Logger;
  /**
   * The wall clock, through the port like everywhere else in this layer.
   *
   * The deadlines below are absolute instants handed to infrastructure, so this
   * has to be the same clock the pool's own deadline arithmetic uses — which it
   * is: `SystemClock` in every process, and the readiness suite drives the real
   * container.
   */
  readonly clock: Clock;
  /** Above this, the outbox is reported down. */
  readonly maxOutboxLagMs: number;
}

/**
 * Whether this process can serve traffic, and why not.
 *
 * One computation, two audiences. The anonymous `/health/ready` reports only
 * the verdict, because the thing asking is a load balancer with no
 * credentials; the authenticated `system/readiness` reports the reasons to an
 * administrator who has signed in. Two independent readiness computations
 * would be worse than one in the wrong place: they would eventually disagree,
 * and the disagreement would be an outage nobody could explain.
 */
export class ReadinessService {
  constructor(private readonly deps: ReadinessDeps) {}

  async run(): Promise<{ degraded: boolean; dependencies: DependencyStatus[] }> {
    const dependencies = await Promise.all([
      this.checkDatabase(),
      this.checkCache(),
      this.checkSchema(),
      this.checkOutboxLag(),
    ]);
    return { degraded: dependencies.some(blocksReadiness), dependencies };
  }

  /**
   * How long any one dependency may take to answer before it counts as down.
   *
   * A readiness endpoint that can hang is not a readiness endpoint. The Redis
   * client is configured with `maxRetriesPerRequest: null`, which means a
   * command issued while the connection is down waits for ever rather than
   * rejecting — correct for a queue, fatal for a probe. `/health/ready` is
   * polled by a load balancer that has no timeout of its own, so the bound has
   * to be here.
   *
   * For the database it is enforced by PostgreSQL, as a `statement_timeout` on
   * the probe's own checkout. The timer below is the bound for Redis and the
   * backstop for everything else; it is NOT what stops a database query. A
   * `Promise.race` that "wins" against a query leaves that query running on a
   * connection nobody can release, and a probe polled every few seconds
   * against a stalled database fills the pool with exactly those.
   */
  static readonly PROBE_TIMEOUT_MS = 3_000;

  /**
   * The timer sits BEHIND the database's own deadline on purpose. When both
   * are due, PostgreSQL cancels the statement first and the probe learns of it
   * as `57014`; the timer then only ever fires for Redis, for a checkout still
   * waiting on the pool, or as the backstop nothing should reach.
   */
  private static readonly BACKSTOP_MS = ReadinessService.PROBE_TIMEOUT_MS + 500;

  private async timed(
    name: string,
    required: boolean,
    probe: (deadlineAt: number) => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<DependencyStatus> {
    const started = this.deps.clock.now().getTime();
    // ONE absolute deadline for everything this probe does, handed to every
    // question it asks. A checkout that waits on the pool and is granted a
    // connection late gets only the time that is left, or nothing — so no
    // query starts on behalf of an answer that has already gone out.
    const deadlineAt = started + ReadinessService.PROBE_TIMEOUT_MS;
    try {
      const result = await Promise.race([
        probe(deadlineAt),
        new Promise<{ ok: boolean; detail?: string }>((resolve) =>
          setTimeout(
            () => resolve({ ok: false, detail: 'timeout' }),
            ReadinessService.BACKSTOP_MS,
          ).unref?.(),
        ),
      ]);
      return {
        name,
        status: result.ok ? 'up' : 'down',
        required,
        latencyMs: this.deps.clock.now().getTime() - started,
        ...(result.detail ? { detail: result.detail } : {}),
      };
    } catch (error) {
      // A driver message would carry internal hostnames, ports, database and
      // role names. Even now that this detail only reaches an authenticated
      // administrator, the real message belongs in the log with its
      // correlation id rather than in an HTTP body that may be pasted into a
      // ticket. The response gets a fixed word.
      this.deps.logger.error(
        { dependency: name, err: error instanceof Error ? error.stack : String(error) },
        'Readiness probe failed',
      );
      return {
        name,
        status: 'down',
        required,
        latencyMs: this.deps.clock.now().getTime() - started,
        detail: classifyProbeFailure(error),
      };
    }
  }

  private checkDatabase(): Promise<DependencyStatus> {
    return this.timed('postgres', true, async (deadlineAt) => {
      await this.deps.probes.database(deadlineAt);
      return { ok: true };
    });
  }

  /**
   * Redis, reported and NOT required.
   *
   * Redis stores nothing in this system. `createRedis` is constructed, handed to
   * this probe, exported and closed — four references — and the only command
   * issued anywhere is `ping`. Every piece of admission, rate-limit and
   * idempotency state is in PostgreSQL on purpose, and `login_throttle` writes
   * down the reason: an attacker must not be able to clear their own counter by
   * waiting out a cache eviction or a restart.
   *
   * So a Redis outage used to make this process report NOT READY — failing the
   * API's container healthcheck, and able to roll a release back — for a
   * dependency that holds no state and that nothing reads. A self-inflicted
   * outage, recorded in `docs/hardening-audit.md` § F as an argument against
   * depending on Redis rather than for it.
   *
   * It is still PROBED and still reported down to an administrator, because the
   * detail is what the authenticated endpoint is for. What changed is that the
   * load balancer is no longer told this process cannot serve traffic it can
   * serve.
   *
   * **The trigger to flip this back** is the first thing that READS Redis. The
   * moment any state lives there, `required` becomes `true` in the same commit —
   * and that is a rule a reader has to apply, not a mechanism, which is why it is
   * written here beside the value rather than in a document.
   */
  private checkCache(): Promise<DependencyStatus> {
    // The Redis handle swallows its own connection errors so a blip degrades
    // readiness rather than crashing the process, which means this probe never
    // throws — it still has to say something when the answer is no.
    return this.timed('redis', false, async () => {
      const ok = await this.deps.probes.cache();
      return ok ? { ok } : { ok, detail: 'unreachable' };
    });
  }

  /**
   * The schema is the one this code was built for — not merely "some schema".
   *
   * A database behind the release (the deployment that starts before its
   * migration finishes, or a migration that died part-way through) is not
   * ready. A database AHEAD of the release — the shape a rollback leaves,
   * because migrations only add — is ready. A history this release cannot
   * account for is not.
   */
  private checkSchema(): Promise<DependencyStatus> {
    return this.timed('migrations', true, async (deadlineAt) => {
      const verdict = await this.deps.probes.schema(deadlineAt);
      switch (verdict.state) {
        case 'CURRENT':
          return { ok: true, detail: `${verdict.applied} applied` };
        case 'AHEAD':
          return {
            ok: true,
            detail: `${verdict.expected} applied, ${verdict.extra} newer than this release`,
          };
        case 'NONE':
          return { ok: false, detail: 'no migrations applied' };
        case 'BEHIND':
          return {
            ok: false,
            detail: `behind: ${verdict.applied} of ${verdict.expected} applied, next ${verdict.next}`,
          };
        case 'DIVERGED':
          return { ok: false, detail: `diverged: ${verdict.reason}` };
      }
    });
  }

  private checkOutboxLag(): Promise<DependencyStatus> {
    return this.timed('outbox', true, async (deadlineAt) => {
      const lag = await this.deps.probes.outboxLagMs(deadlineAt);
      return { ok: lag <= this.deps.maxOutboxLagMs, detail: `oldest unpublished ${lag}ms` };
    });
  }
}

/**
 * A closed vocabulary. Enough for an operator to know where to look, not enough
 * to describe the deployment to a stranger.
 */
function classifyProbeFailure(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // PostgreSQL's own wording for a statement it cancelled at our bound.
  if (message.includes('canceling statement') || message.includes('after its deadline')) {
    return 'timeout';
  }
  if (message.includes('econnrefused') || message.includes('enotfound')) return 'unreachable';
  if (message.includes('etimedout') || message.includes('timeout')) return 'timeout';
  if (message.includes('password') || message.includes('authentication')) return 'auth failed';
  if (message.includes('does not exist')) return 'missing';
  return 'unavailable';
}
