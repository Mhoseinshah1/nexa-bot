import { z } from 'zod';
import {
  OPERATIONAL_SEVERITIES,
  type ActorContext,
  type PermissionKey,
  type ScopeContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OperationalEventReader, OperationalEventRow } from './ports.js';

export const OPSLOG_VIEW: PermissionKey = 'opslog.view';

export const opsLogQuerySchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  /**
   * The cursor: the `lastSeenAt` of the oldest row already shown, and its id.
   *
   * Both, because `last_seen_at` is not unique — a `Clock.now()` is captured
   * once per transaction, so distinct conditions share one microsecond — and a
   * strict comparison on it alone skips the rest of a group that straddles the
   * page boundary.
   */
  before: z.date().optional(),
  beforeId: z.string().max(64).optional(),
  severities: z.array(z.enum(OPERATIONAL_SEVERITIES)).optional(),
  code: z.string().max(200).optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  open: z.boolean().optional(),
});
export type OpsLogQuery = z.infer<typeof opsLogQuerySchema>;

/**
 * Reading the operational log.
 *
 * Phase 0 built the table and nothing that reads it, so an operator's only route
 * to an operational event was a database client. This is the other half.
 *
 * There is no acknowledgement and no "mark as seen". Monitoring products usually
 * have one; nothing here has asked for one, and a flag nobody sets makes "open"
 * mean two different things.
 */
export class OpsLogService {
  constructor(
    private readonly guard: PermissionGuard,
    private readonly reader: OperationalEventReader,
  ) {}

  async list(
    scope: ScopeContext,
    actor: ActorContext,
    input: unknown = {},
  ): Promise<OperationalEventRow[]> {
    await this.guard.check(scope, actor, OPSLOG_VIEW);
    const query = opsLogQuerySchema.parse(input);
    return this.reader.list(scope, query);
  }
}
