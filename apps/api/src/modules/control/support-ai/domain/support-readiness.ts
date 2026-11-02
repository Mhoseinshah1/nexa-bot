import type {
  BusinessConnectionStatus,
  SupportAiConfigResponse,
  SupportReadinessResponse,
} from '@nexa/contracts';

/**
 * Phase 4 PR-5 — the readiness card's rules, pure. The server states what it SEES; it never
 * reads a customer's data and never decides on the owner's behalf. Each check is OK or WARN
 * with a code; the page owns the sentence and the one-line fix.
 */
export interface SupportReadinessFacts {
  readonly config: Pick<
    SupportAiConfigResponse['config'],
    'mode' | 'primary' | 'autoTopics' | 'visionEnabled'
  >;
  readonly credentials: SupportAiConfigResponse['credentials'];
  readonly capabilities: SupportAiConfigResponse['capabilities'];
  /** The tenant's Business connections (superseded ones included; they are ignored here). */
  readonly connections: readonly { readonly status: BusinessConnectionStatus }[];
  /** `support.accounts`, as stored. */
  readonly supportHandles: readonly string[];
  /** The Telegram usernames of the owners of the ACTIVE connections, where the bot knows one. */
  readonly connectedUsernames: readonly string[];
  /** The `assistant` role's latest life (`process_runs`); null when it never started. */
  readonly assistant: {
    readonly startedAt: Date;
    readonly stableAt: Date | null;
    readonly stoppedAt: Date | null;
    readonly restarts: number;
  } | null;
  /** `support.assistant.stalled` is open. */
  readonly assistantStalled: boolean;
  /** The model the primary provider's last capability test ran on; null when never recorded. */
  readonly testedModel?: string | null;
  /** Approved and enabled knowledge articles. */
  readonly approvedKnowledge: number;
}

type Line = SupportReadinessResponse['checks'][number];

export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@/u, '').toLowerCase();
}

export function supportReadiness(facts: SupportReadinessFacts): SupportReadinessResponse {
  const line = (
    check: Line['check'],
    status: Line['status'],
    detail: Line['detail'],
    extra: Partial<Pick<Line, 'count' | 'handles'>> = {},
  ): Line => ({ check, status, detail, count: extra.count ?? null, handles: extra.handles ?? [] });
  const primary = facts.config.primary;
  const credential =
    primary === null ? null : facts.credentials.find((row) => row.provider === primary.provider);
  const capabilities = primary === null ? null : facts.capabilities[primary.provider];
  const checks: Line[] = [];

  // 1. A Business connection that may reply.
  const live = facts.connections.filter((connection) => connection.status !== 'SUPERSEDED');
  const connection = live.some((row) => row.status === 'ACTIVE')
    ? line('BUSINESS_CONNECTION', 'OK', 'CONNECTED')
    : live.length === 0
      ? line('BUSINESS_CONNECTION', 'WARN', 'NO_CONNECTION')
      : live.some((row) => row.status === 'RIGHTS_INSUFFICIENT')
        ? line('BUSINESS_CONNECTION', 'WARN', 'CANNOT_REPLY')
        : line('BUSINESS_CONNECTION', 'WARN', 'CONNECTION_DISABLED');
  checks.push(connection);

  // 2. The handle customers are told to write to is the connected account.
  const handles = facts.supportHandles.map(normalizeHandle).filter((handle) => handle !== '');
  const known = facts.connectedUsernames.map(normalizeHandle).filter((handle) => handle !== '');
  checks.push(
    handles.length === 0
      ? line('SUPPORT_HANDLE', 'WARN', 'HANDLE_MISSING')
      : known.length === 0
        ? line('SUPPORT_HANDLE', 'WARN', 'HANDLE_UNVERIFIED', {
            handles: facts.supportHandles.slice(),
          })
        : known.some((username) => handles.includes(username))
          ? line('SUPPORT_HANDLE', 'OK', 'HANDLE_MATCHES', {
              handles: facts.supportHandles.slice(),
            })
          : line('SUPPORT_HANDLE', 'WARN', 'HANDLE_MISMATCH', {
              handles: facts.supportHandles.slice(),
            }),
  );

  // 3. A provider key that works.
  checks.push(
    primary === null
      ? line('PROVIDER_KEY', 'WARN', 'NO_PRIMARY')
      : credential === null || credential === undefined || !credential.configured
        ? line('PROVIDER_KEY', 'WARN', 'NO_KEY')
        : credential.rejectedAt !== null
          ? line('PROVIDER_KEY', 'WARN', 'KEY_REJECTED')
          : credential.breaker === 'OPEN'
            ? line('PROVIDER_KEY', 'WARN', 'BREAKER_OPEN')
            : line('PROVIDER_KEY', 'OK', 'KEY_OK'),
  );

  // 4. The model answers in the strict decision shape (the capability test).
  checks.push(
    capabilities === null || credential === null || credential === undefined
      ? line('STRUCTURED_OUTPUT', 'WARN', 'NOT_TESTED')
      : !capabilities.structuredOutput
        ? line('STRUCTURED_OUTPUT', 'WARN', 'UNSUPPORTED')
        : // A test of another model (or one from before the model was recorded) says nothing
          // about the model the chain will call.
          credential.lastTestOutcome === null ||
            primary === null ||
            facts.testedModel !== primary.model
          ? line('STRUCTURED_OUTPUT', 'WARN', 'NOT_TESTED')
          : credential.lastTestOutcome === 'OK'
            ? line('STRUCTURED_OUTPUT', 'OK', 'TEST_PASSED')
            : line('STRUCTURED_OUTPUT', 'WARN', 'TEST_FAILED'),
  );

  // 5. The assistant role is running.
  const role = facts.assistant;
  checks.push(
    role === null
      ? line('ASSISTANT_ROLE', 'WARN', 'NEVER_STARTED')
      : facts.assistantStalled
        ? line('ASSISTANT_ROLE', 'WARN', 'STALLED')
        : role.stoppedAt !== null && role.stoppedAt.getTime() >= role.startedAt.getTime()
          ? line('ASSISTANT_ROLE', 'WARN', 'STOPPED')
          : role.stableAt === null && role.restarts > 0
            ? line('ASSISTANT_ROLE', 'WARN', 'RESTARTING')
            : line('ASSISTANT_ROLE', 'OK', 'RUNNING'),
  );

  // 6. Topics the AI may answer on its own.
  const topics = facts.config.autoTopics.length;
  checks.push(
    topics > 0
      ? line('TOPICS', 'OK', 'TOPICS_SELECTED', { count: topics })
      : line('TOPICS', 'WARN', 'NO_TOPICS', { count: 0 }),
  );

  // 7. Approved knowledge.
  checks.push(
    facts.approvedKnowledge > 0
      ? line('KNOWLEDGE', 'OK', 'KNOWLEDGE_READY', { count: facts.approvedKnowledge })
      : line('KNOWLEDGE', 'WARN', 'NO_KNOWLEDGE', { count: 0 }),
  );

  // 8. Vision. Off is a choice (images go to a person), not a fault; on needs a model that sees.
  checks.push(
    !facts.config.visionEnabled
      ? line('VISION', 'OK', 'VISION_OFF')
      : capabilities?.vision === true
        ? line('VISION', 'OK', 'VISION_ON')
        : line('VISION', 'WARN', 'VISION_UNSUPPORTED'),
  );

  return { checks };
}
