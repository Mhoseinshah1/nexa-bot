import { z } from 'zod';
import {
  OPERATIONAL_SCOPES,
  OPERATIONAL_SEVERITIES,
  type ActorContext,
  type PermissionKey,
  type ScopeContext,
  uuidV7Schema,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { OperationalEventReader, OperationalEventRow } from './ports.js';

export const OPSLOG_VIEW: PermissionKey = 'opslog.view';

/** The page size the reader uses when a caller names none. */
export const OPS_LOG_PAGE_DEFAULT = 50;

/**
 * The page size a CALLER may ask for, parsed rather than coerced. 200 is the
 * wire maximum and this is where it is enforced.
 *
 * The service's own ceiling is one higher — see `opsLogQuerySchema.limit`
 * below — because the controller over-fetches one row past whatever this
 * accepts in order to decide `nextCursor`. Keeping the two ceilings equal is
 * what silently truncated the notification list at its maximum page size.
 */
export const opsLogPageSize = z.coerce.number().int().min(1).max(200);

/**
 * `open`, as an explicit true or false and nothing else.
 *
 * `query.open === 'true'` turned every other spelling — `tru`, `TRUE`, `1` —
 * into `false`, so a malformed filter answered 200 with the OPPOSITE of what
 * was asked for. A bad parameter is a 400.
 */
export const openFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

export const opsLogQuerySchema = z.object({
  limit: z.number().int().min(1).max(201).default(OPS_LOG_PAGE_DEFAULT),
  /**
   * The cursor: the `lastSeenAt` of the oldest row already shown, and its id.
   *
   * Both, because `last_seen_at` is not unique — a `Clock.now()` is captured
   * once per transaction, so distinct conditions share one microsecond — and a
   * strict comparison on it alone skips the rest of a group that straddles the
   * page boundary.
   */
  before: z.date().optional(),
  // An ID, not any short string: it is compared against a `uuid` column, so a
  // malformed cursor became a driver error and a 500 rather than a 400.
  beforeId: uuidV7Schema.optional(),
  severities: z.array(z.enum(OPERATIONAL_SEVERITIES)).optional(),
  // `min(1)`, so `?code=` is refused rather than silently meaning "no code
  // filter". An empty string is a filter the caller sent; answering it with
  // the unfiltered stream is the widening this schema exists to prevent.
  code: z.string().min(1).max(200).optional(),
  since: z.date().optional(),
  until: z.date().optional(),
  open: z.boolean().optional(),
  /**
   * `ALL` by default, so an existing caller keeps the whole stream.
   *
   * `MANAGEMENT` narrows to the codes that want a person's attention. It is a
   * query rather than a separate endpoint because it is the same read with the
   * same permission, the same cursor and the same shape — a second endpoint
   * would be a second place for the paging to be wrong.
   */
  scope: z.enum(OPERATIONAL_SCOPES).default('ALL'),
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
