/**
 * Database schema — backup and recovery: backup runs, archive passwords, restores, installation keys, process runs.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  BACKUP_ARCHIVE_FORMATS,
  BACKUP_ARCHIVE_SCOPES,
  BACKUP_DELIVERY_REASONS,
  BACKUP_DELIVERY_STATES,
  BACKUP_RUN_STATES,
  BACKUP_STAGES,
  BACKUP_TRIGGERS,
  RECOVERY_ACTIVE_DESTRUCTIVE_STATES,
  RECOVERY_FAILURE_CODES,
  RECOVERY_SOURCES,
  INSTALLATION_KEY_SOURCES,
  RECOVERY_STAGES,
  RECOVERY_STATES,
  SECRET_PURPOSES,
  TENANT_RESTORE_ACTIVE_STATES,
  TENANT_RESTORE_MODES,
  TENANT_RESTORE_STAGES,
  TENANT_RESTORE_STATES,
} from '@nexa/contracts';
import { enumCheck, nullableEnumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';
import { admins } from './identity.js';

/**
 * One row per backup run, and the row IS the installation's backup lock.
 *
 * INSTALLATION-scoped, so there is deliberately no `tenant_id`. A dump is of
 * the whole database; giving it a tenant column would invite a per-tenant
 * backup that this pipeline does not produce and cannot restore.
 *
 * The exclusivity is `backup_runs_single_active_idx`, a partial unique index on
 * a constant over `state = 'RUNNING'`. One RUNNING row can exist in the whole
 * table, enforced by PostgreSQL rather than by any process — which is the only
 * form of "one at a time" that survives two worker replicas, which is the
 * normal case on every rolling update. An in-memory flag would have bounded
 * exactly one process, and a `pg_advisory_xact_lock` would have to be held for
 * the length of a dump inside a transaction that `idle_in_transaction_session_
 * timeout` is configured to kill.
 *
 * A lock nothing can release is a lock that outlives its owner's crash, so the
 * claim is a LEASE: `lease_owner` names the process, `lease_heartbeat_at` is
 * refreshed while it works, and a run whose heartbeat has gone stale may be
 * taken over — by transitioning it to FAILED, never by silently adopting it,
 * because its temporary files belong to a process that may still be writing.
 *
 * Nothing here holds key material. `checksum` is a digest of the plaintext
 * dump, which is not a secret and is what makes the artifact verifiable later.
 * `delivery_detail` and `failure_message` carry redacted operator-facing text;
 * the bot token they could otherwise leak lives in the URL path of the Telegram
 * call and never reaches this table.
 */
export const backupRuns = pgTable(
  'backup_runs',
  {
    /** UUIDv7. This is the backup id in the manifest and in the caption. */
    id: uuid('id').primaryKey(),
    trigger: text('trigger').notNull(),
    state: text('state').notNull(),
    /** The stage in flight, or — once terminal — the stage the run ended in. */
    stage: text('stage').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    finishedAt: timestamptz('finished_at'),

    /**
     * Who holds the lease and when they last proved it.
     *
     * `lease_owner` is a process identity, not a credential: role plus PID plus
     * a random suffix, so two replicas of the same role are distinguishable.
     */
    leaseOwner: text('lease_owner').notNull(),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at').notNull(),

    /** Bytes of the plaintext dump, and of the encrypted archive. */
    dumpBytes: bigint('dump_bytes', { mode: 'bigint' }),
    archiveBytes: bigint('archive_bytes', { mode: 'bigint' }),
    /** SHA-256 of the plaintext dump, lowercase hex. Not a secret. */
    checksum: text('checksum'),
    /**
     * When a real pg_restore into a real empty scratch database succeeded.
     *
     * Null on any run that did not get that far, which is what makes
     * "verified" a fact rather than an inference from `state`.
     */
    verifiedAt: timestamptz('verified_at'),

    /**
     * What we know about the Telegram delivery. See BACKUP_DELIVERY_STATES.
     *
     * `OUTCOME_UNKNOWN` is durable and nothing resends on it automatically.
     */
    deliveryState: text('delivery_state').notNull(),
    deliveryAttemptedAt: timestamptz('delivery_attempted_at'),
    /** Redacted operator-facing detail. Never a token, never a chat payload. */
    deliveryDetail: text('delivery_detail'),
    /**
     * NEXA-BACKUP-DELIVERY: WHY the delivery ended where it did, as a code from
     * `BACKUP_DELIVERY_REASONS` — what the Web Admin renders, since the detail stays out of
     * every response. `LOCAL_ONLY_*` is a run kept on this server by design. Null when
     * delivered, and on every run before this column.
     */
    deliveryReason: text('delivery_reason'),
    /**
     * NEXA-BACKUP-DELIVERY: the lease of a RE-delivery of this finished run's undelivered
     * parts («ارسال دوبارهٔ بخش‌های نرسیده», the legacy compaction's retry). A conditional
     * claim (`redelivery_lease_until` null or past), so two presses, or a press and the
     * compaction, never send the same part at once. Not the run's own lease: that one guards
     * a RUNNING run, and a re-delivery only ever touches a finished one.
     */
    redeliveryOwner: text('redelivery_owner'),
    redeliveryLeaseUntil: timestamptz('redelivery_lease_until'),

    /** Set on FAILED. The stage is in `stage`; this says what went wrong. */
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),

    /**
     * Whether cleanup completed, and what was left behind if not.
     *
     * A column rather than a log line because a cleanup failure means plaintext
     * dump bytes are still on disk, or a scratch database still exists. Both
     * are things an operator must be told about explicitly; neither is visible
     * from a run that otherwise reports success.
     */
    cleanupOk: boolean('cleanup_ok').notNull(),
    cleanupDetail: text('cleanup_detail'),

    /**
     * When archive retention removed this run's directory from `BACKUP_WORK_DIR`.
     *
     * Null while the directory may still be on disk. It is what makes the two
     * retentions coherent: the ROW purge (ADR-0027) removes only rows whose
     * files the FILE retention has already removed, so a purged row can never
     * orphan an archive, and the Web Admin can say "pruned by retention" rather
     * than "missing".
     */
    archivePrunedAt: timestamptz('archive_pruned_at'),

    /**
     * E4 (Round 4 PR-E). The container (`NXB` or `SEVEN_ZIP`; NULL on a run before this
     * column, which is `NXB`), how many ≤ 45 MiB parts it was delivered in, which stored
     * backup password sealed a 7-Zip archive (an id, never the password), and the summary
     * message's outcome for a split archive. Each part's own outcome is a
     * `backup_run_parts` row.
     */
    archiveFormat: text('archive_format'),
    partCount: integer('part_count'),
    archiveSealId: uuid('archive_seal_id'),
    summaryDeliveryState: text('summary_delivery_state'),
    /**
     * Round 5B: how long each stage took, in milliseconds, by stage name
     * (`{"DUMP": 41200, "ENCRYPT": 96000, …}`). Written once, when the run finishes, from the
     * pipeline's own clock; a stage the run never reached has no key. NULL on a run from
     * before this column, and on a run reclaimed as abandoned (no process was left to time it).
     */
    phaseDurationsMs: jsonb('phase_durations_ms'),
    /**
     * Phase 6B (ADR-0039 § 5): what the run archives — the whole database (`INSTALLATION`,
     * every row before this column) or ONE hosted tenant's rows (`TENANT`, the logical tenant
     * archive), and which tenant. Not `tenant_id`: the row is the INSTALLATION's record of an
     * archive it took (no tenant policy applies to it), and `subject_tenant_id` names what was
     * archived, never whose row this is. Both scopes share the single-active index below.
     */
    archiveScope: text('archive_scope').notNull().default('INSTALLATION'),
    subjectTenantId: uuid('subject_tenant_id').references(() => tenants.id),
  },
  (table) => [
    check('backup_runs_trigger_check', enumCheck('trigger', BACKUP_TRIGGERS)),
    check('backup_runs_archive_scope_check', enumCheck('archive_scope', BACKUP_ARCHIVE_SCOPES)),
    check(
      'backup_runs_subject_tenant_check',
      sql`(archive_scope = 'TENANT') = (subject_tenant_id IS NOT NULL)`,
    ),
    check('backup_runs_archive_format_check', enumCheck('archive_format', BACKUP_ARCHIVE_FORMATS)),
    check(
      'backup_runs_summary_delivery_state_check',
      enumCheck('summary_delivery_state', BACKUP_DELIVERY_STATES),
    ),
    check('backup_runs_part_count_check', sql`part_count IS NULL OR part_count > 0`),
    check('backup_runs_state_check', enumCheck('state', BACKUP_RUN_STATES)),
    check('backup_runs_stage_check', enumCheck('stage', BACKUP_STAGES)),
    check('backup_runs_delivery_state_check', enumCheck('delivery_state', BACKUP_DELIVERY_STATES)),
    check(
      'backup_runs_delivery_reason_check',
      nullableEnumCheck('delivery_reason', BACKUP_DELIVERY_REASONS),
    ),
    /**
     * A terminal run has an end; a RUNNING one does not.
     *
     * Both directions, because only one of them is the interesting failure: a
     * RUNNING row with `finished_at` set is a run something forgot to close,
     * and it would hold the installation's lock until its lease expired.
     */
    check('backup_runs_finished_at_check', sql`(state = 'RUNNING') = (finished_at IS NULL)`),
    /**
     * The installation-wide backup lock, enforced by the database.
     *
     * A partial unique index over a constant: at most one row may have
     * `state = 'RUNNING'`, whatever process inserted it. A second starter's
     * INSERT raises a unique violation, which the repository turns into a
     * truthful BUSY rather than a second dump.
     */
    uniqueIndex('backup_runs_single_active_idx')
      .on(sql`(true)`)
      .where(sql`state = 'RUNNING'`),
    /** The operator's list, and the scheduler's "when did we last succeed". */
    index('backup_runs_started_at_idx').on(table.startedAt),
    /** A hosted tenant's archives, newest first (retention, the owner's list). */
    index('backup_runs_subject_tenant_idx')
      .on(table.subjectTenantId, table.startedAt)
      .where(sql`subject_tenant_id IS NOT NULL`),
  ],
);

/**
 * One part of a backup's archive and its OWN delivery outcome (Round 4 PR-E, E4).
 *
 * A part is a byte range of the run's one verified archive (`[start, end)`, ≤ 45 MiB),
 * delivered as its own Telegram document. Its row is written NOT_ATTEMPTED before the
 * first send and updated the moment its answer is known, so a process that dies
 * mid-delivery leaves every part's truth behind.
 *
 * `telegram_message_id` is the whole point of the table: the local copy is removed only
 * when EVERY part of the run has one (`deliveredCopyPruneCandidates`). A part answered
 * `ok` without a message id keeps the local copy — the safe reading.
 *
 * Installation-wide like `backup_runs` (no tenant): a backup is of the whole database.
 * Cascades with its run, so the run-row purge (ADR-0027) takes its parts with it.
 */
export const backupRunParts = pgTable(
  'backup_run_parts',
  {
    backupId: uuid('backup_id')
      .notNull()
      .references(() => backupRuns.id, { onDelete: 'cascade' }),
    partNumber: integer('part_number').notNull(),
    /** What Telegram shows: `….7z` for a single part, `….7z.001`… otherwise. Not a path. */
    filename: text('filename').notNull(),
    rangeStart: bigint('range_start', { mode: 'bigint' }).notNull(),
    bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
    /** SHA-256 of the part's bytes, lowercase hex. Not a secret. */
    sha256: text('sha256').notNull(),
    deliveryState: text('delivery_state').notNull(),
    deliveryAttemptedAt: timestamptz('delivery_attempted_at'),
    telegramMessageId: bigint('telegram_message_id', { mode: 'bigint' }),
    /** Redacted operator-facing detail. Never a token. */
    deliveryDetail: text('delivery_detail'),
    /** NEXA-BACKUP-DELIVERY: why this part is where it is (`BACKUP_DELIVERY_REASONS`). */
    deliveryReason: text('delivery_reason'),
    /** How many times this part was sent, automatic resends and re-deliveries included. */
    deliveryAttempts: integer('delivery_attempts').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.backupId, table.partNumber] }),
    check(
      'backup_run_parts_delivery_state_check',
      enumCheck('delivery_state', BACKUP_DELIVERY_STATES),
    ),
    check(
      'backup_run_parts_delivery_reason_check',
      nullableEnumCheck('delivery_reason', BACKUP_DELIVERY_REASONS),
    ),
    check('backup_run_parts_delivery_attempts_check', sql`delivery_attempts >= 0`),
    check('backup_run_parts_part_number_check', sql`part_number > 0`),
    check('backup_run_parts_bytes_check', sql`bytes >= 0 AND range_start >= 0`),
    /** A message id is a delivered part, and only a delivered part has one. */
    check(
      'backup_run_parts_message_id_check',
      sql`telegram_message_id IS NULL OR delivery_state = 'SUCCEEDED'`,
    ),
  ],
);

/**
 * The owner-set backup password (Round 4 PR-E, E4), sealed with `SecretCipher`
 * (purpose `backup.archive_password`, entity = this row's id).
 *
 * Never returned once stored. A replacement SUPERSEDES the current row rather than
 * deleting it: the archives a password sealed must still open on this server, so every
 * stored password is tried (newest first) when one of them is opened. The partial unique
 * index makes "the current password" one row per tenant whatever writes race.
 */
export const backupArchivePasswords = pgTable(
  'backup_archive_passwords',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    passwordCiphertext: text('password_ciphertext').notNull(),
    passwordKeyId: text('password_key_id').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    createdByAdminId: uuid('created_by_admin_id').references(() => admins.id),
    supersededAt: timestamptz('superseded_at'),
  },
  (table) => [
    uniqueIndex('backup_archive_passwords_current_idx')
      .on(table.tenantId)
      .where(sql`superseded_at IS NULL`),
    index('backup_archive_passwords_tenant_created_idx').on(table.tenantId, table.createdAt),
  ],
);

/**
 * A recovery request: one attempt to make this installation be a backup again.
 *
 * Separate from `backup_runs` on purpose, and `docs/disaster-recovery-audit.md`
 * § MISSING-2 records the reasoning: a backup run is an artifact's history and a
 * recovery request is an operation against the installation, and the backup
 * lock is a partial unique index over `state = 'RUNNING'` that a recovery row
 * would contend with for no reason.
 *
 * `tenant_id NOT NULL` even though a backup covers every tenant. A backup is a
 * dump of the whole database, so "which tenant may act on it" has one
 * defensible answer — the tenant that IS the installation — and making that a
 * column rather than a convention is what turns cross-scope isolation into a
 * row-level predicate a test can guess against.
 */
export const recoveryRequests = pgTable(
  'recovery_requests',
  {
    /** UUIDv7. Appears in a URL, a confirmation binding and a journal file. */
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    source: text('source').notNull(),
    state: text('state').notNull(),
    stage: text('stage').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    finishedAt: timestamptz('finished_at'),

    /**
     * Who asked, captured as a label at the time.
     *
     * A label as well as an id, so the row still names somebody after a rename
     * or a deletion — the same rule the audit log follows, and for the same
     * reason: a recovery is read long after the fact.
     */
    requestedByAdminId: uuid('requested_by_admin_id'),
    requestedByLabel: text('requested_by_label'),
    correlationId: text('correlation_id'),

    /**
     * The lease, exactly as `backup_runs` holds one.
     *
     * A recovery outlives any request, and two executor replicas are the normal
     * case on a rolling update. A stale lease is taken over by FAILING the
     * abandoned request, never by adopting it: its candidate database and its
     * workspace belong to a process that may still be writing them.
     */
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at'),

    /**
     * Where the uploaded bytes live while this request is alive.
     *
     * A path on the installation's own disk, under `RECOVERY_WORK_DIR`, with a
     * random directory name. Recorded so a crashed executor's debris is
     * nameable; removed on every terminal path. Not a secret, and not derived
     * from anything a caller sent.
     */
    workspacePath: text('workspace_path'),
    /** Bytes received, and the digest of the ENCRYPTED container as received. */
    uploadBytes: bigint('upload_bytes', { mode: 'bigint' }),
    uploadSha256: text('upload_sha256'),
    /**
     * What the browser called the file. Recorded, and acted on NOWHERE.
     *
     * Not the path, not the format decision, not the content type. It exists so
     * an operator can recognise which file they sent, and it is bounded and
     * sanitised before storage because it is attacker-chosen text that gets
     * rendered.
     */
    clientFilename: text('client_filename'),

    /** From the manifest, once the archive has been authenticated. */
    backupId: uuid('backup_id'),
    artifactChecksum: text('artifact_checksum'),
    archiveKeyId: text('archive_key_id'),
    verifiedAt: timestamptz('verified_at'),
    /** The verification and restore-test facts, as recorded. */
    verification: jsonb('verification'),
    restoreTest: jsonb('restore_test'),

    /**
     * The confirmation BINDING. The phrase itself is never stored.
     *
     * The phrase is a constant, so storing it would prove nothing; what has to
     * be durable is what the confirmation was for. `confirmed_checksum` is
     * re-compared against the artifact at execution time, which is what makes a
     * confirmation for backup A unable to restore backup B.
     */
    confirmedAt: timestamptz('confirmed_at'),
    confirmedByAdminId: uuid('confirmed_by_admin_id'),
    confirmedSessionId: uuid('confirmed_session_id'),
    confirmedChecksum: text('confirmed_checksum'),
    confirmationExpiresAt: timestamptz('confirmation_expires_at'),

    /** The mandatory pre-restore backup of the installation being replaced. */
    preRestoreBackupId: uuid('pre_restore_backup_id'),

    /**
     * The candidate database, and the name the outgoing one was renamed to.
     *
     * `displaced_database` is the single most important field on this row after
     * a cutover: it is how an operator knows production is the new database and
     * where the old one still is. Not a secret — it is a database name on their
     * own server — and without it a manual rollback is guesswork.
     */
    candidateDatabase: text('candidate_database'),
    displacedDatabase: text('displaced_database'),
    cutoverAt: timestamptz('cutover_at'),

    /** A value from `RECOVERY_FAILURE_CODES`. Never a message. */
    failureCode: text('failure_code'),
  },
  (table) => [
    check('recovery_requests_source_check', enumCheck('source', RECOVERY_SOURCES)),
    check('recovery_requests_state_check', enumCheck('state', RECOVERY_STATES)),
    check('recovery_requests_stage_check', enumCheck('stage', RECOVERY_STAGES)),
    check(
      'recovery_requests_failure_code_check',
      nullableEnumCheck('failure_code', RECOVERY_FAILURE_CODES),
    ),
    /**
     * A terminal request has an end; a live one does not. Both directions.
     *
     * The interesting failure is the second: a live request with `finished_at`
     * set is a request something forgot to close, and while it is in a
     * quiescing state it is holding the installation's writes shut.
     */
    check(
      'recovery_requests_finished_at_check',
      sql`(state IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)`,
    ),
    /**
     * A cutover implies a displaced database. NOT the reverse.
     *
     * These two are how an operator learns which database is production, and the
     * dangerous direction is the one this refuses: `cutover_at` set with no
     * displaced name is a row saying production is the restored candidate and not
     * saying where the data it replaced went.
     *
     * The reverse IS representable, because it is a state the cutover genuinely
     * reaches. `ALTER DATABASE` cannot run in a transaction, so between the two
     * renames the outgoing database has MOVED and the candidate has not taken its
     * name — `CutoverError.outgoingRenamed`, journal phase `RENAMED_OUT`. A
     * recovery that ends there has a displaced database and no cutover, and both
     * reconstruction paths in `recovery-executor.ts` write exactly that row: the
     * failure path in `execute`, and `reconcileCutovers` for a journal nothing
     * recorded. The first version of this check made both of those rows
     * unrepresentable, so the reconstruction raised 23514 — which left the
     * recovery unrecorded, the journal uncleared, and every later tick throwing
     * in `reconcileCutovers` before it could claim anything at all.
     *
     * `purgeFinishedBefore` keeps a row with either field set, so the name of the
     * database holding the operator's previous data survives retention in both
     * shapes.
     */
    check(
      'recovery_requests_cutover_check',
      sql`cutover_at IS NULL OR displaced_database IS NOT NULL`,
    ),
    /**
     * A confirmation is all four fields or none of them.
     *
     * The binding is the security property, so a partial binding must not be
     * representable: a row with `confirmed_at` and no `confirmed_checksum`
     * would be a confirmation for anything.
     */
    /*
     * Phase 6B PR-4 (ADR-0039 § 8): a `MOVE` request is confirmed on the new server's root
     * shell by `botctl move import` with the typed bundle password — no administrator. Its
     * binding is the other three fields, all or none, and it never names an administrator.
     */
    check(
      'recovery_requests_confirmation_check',
      sql`CASE WHEN source = 'MOVE'
            THEN confirmed_by_admin_id IS NULL
             AND num_nonnulls(confirmed_at, confirmed_checksum, confirmation_expires_at) IN (0, 3)
            ELSE num_nonnulls(confirmed_at, confirmed_by_admin_id, confirmed_checksum, confirmation_expires_at) IN (0, 4)
          END`,
    ),
    /**
     * ONE destructive recovery at a time, enforced by PostgreSQL.
     *
     * A partial unique index over a constant, exactly like the backup lock. Two
     * executor replicas is the normal case on every rolling update and two
     * operators pressing at once is the normal case in an incident; neither has
     * to agree with the other about anything, because the second INSERT or
     * UPDATE raises a unique violation.
     *
     * The predicate is the DESTRUCTIVE state set, not the live one: an
     * artifact being verified or restore-tested changes nothing about the
     * installation, so several of those at once are fine and only the chain
     * past the confirmation is exclusive.
     */
    uniqueIndex('recovery_requests_single_destructive_idx')
      .on(sql`(true)`)
      .where(
        sql.raw(
          `state IN (${RECOVERY_ACTIVE_DESTRUCTIVE_STATES.map((state) => `'${state}'`).join(', ')})`,
        ),
      ),
    /**
     * The operator's list keyset: `(tenant_id, created_at, id)`, scope first.
     *
     * Declared HERE and not in `ONLINE_INDEXES`, unlike the panels and alerts
     * keysets, and the difference is the table rather than the index. Those build
     * concurrently because `botctl update` migrates while the outgoing release is
     * still serving, so an ordinary `CREATE INDEX` lands a SHARE lock on a live
     * table. This table is CREATED by the same migration: there is no live data
     * to lock and nothing else can see it yet, so the build is instant and
     * drizzle-kit's drift check can see the index — which the online ones
     * deliberately cannot.
     *
     * `id` is in the index because it is in the ORDER BY. A btree serves the
     * DESC scan of an ASC index backwards, so this one index covers both the
     * ordering and the `ROW(created_at, id) < ROW(...)` continuation.
     */
    index('recovery_requests_tenant_created_idx').on(table.tenantId, table.createdAt, table.id),
  ],
);

/**
 * NEXA-FIX-RESTORE-SECRETS §2.3, choice 2 («ادامه؛ این‌ها را دوباره وارد می‌کنم»): one
 * row per secret a restore CLEARED because this installation could not read it.
 *
 * Written by the recovery executor INTO THE CANDIDATE, before the renames, in the same
 * transaction as the clearing — so it arrives with the database that is served, and a
 * clearing that rolled back left no item. Append-only in practice: nothing updates or
 * deletes it. Whether an item still needs attention is NOT stored: the Web Admin strip
 * asks the entity's column at read time, so re-entering the value through its ordinary
 * page removes the item without any write path knowing this table exists.
 *
 * `entity_table`/`entity_id` name what the owner re-enters it on: the bot, the panel,
 * the gateway credential row, the support-AI credential row, the backup password row —
 * and for a two-factor secret the ADMIN, because its factor row is deleted and a new
 * enrolment mints a new id. Never a value, a ciphertext or a key id.
 */
export const secretReentryItems = pgTable(
  'secret_reentry_items',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    purpose: text('purpose').notNull(),
    entityTable: text('entity_table').notNull(),
    entityId: uuid('entity_id').notNull(),
    /**
     * The entity's NATURAL key where clearing deleted a row the owner re-creates under a
     * new id: a gateway credential's or a support-AI credential's provider. Null otherwise.
     */
    entityKey: text('entity_key'),
    /** The recovery that cleared it. Not a foreign key: that row is the outgoing install's. */
    recoveryRequestId: uuid('recovery_request_id').notNull(),
    clearedAt: timestamptz('cleared_at').notNull(),
  },
  (table) => [
    index('secret_reentry_items_tenant_cleared_idx').on(table.tenantId, table.clearedAt, table.id),
    check('secret_reentry_items_purpose_check', enumCheck('purpose', SECRET_PURPOSES)),
    check('secret_reentry_items_entity_table_check', sql`entity_table ~ '^[a-z_]{1,63}$'`),
    check(
      'secret_reentry_items_entity_key_check',
      sql`entity_key IS NULL OR char_length(entity_key) BETWEEN 1 AND 64`,
    ),
  ],
);

/**
 * Decrypt-only key-encryption keys imported from a Recovery Kit (ADR-0032), READ-ONLY since
 * the kit was removed (SFR A1): nothing inserts a row; the keyring still reads them because a
 * kit-assisted restore before v0.9.10 could leave live secrets sealed under one. A later
 * release drops the table once `botctl secrets rewrap` has moved every secret off them.
 *
 * INSTALLATION-WIDE, and the one table here with neither `tenant_id` nor a
 * tenant-bound encryption context, for a reason that is the whole point of it:
 * it must SURVIVE a restore. A restore replaces every tenant row with the
 * backup's, so a key bound to the current primary tenant would be bound to a
 * tenant that no longer exists the moment it was needed. The recovery executor
 * carries these rows into the restored candidate before the cutover, exactly as
 * it re-asserts its own request row afterwards.
 *
 * `wrapped_material` is the key, AES-256-GCM-wrapped under a CONFIGURED key
 * (`wrapped_under_key_id`) with the key id and the wrapping id as associated
 * data. Deliberately not named `*_ciphertext`: that suffix marks a
 * `SecretCipher` column, which this is not (see `installation-keyring.ts`), and
 * `secrets status|rewrap|retire-check` walk this table by name instead.
 *
 * Nothing here can make a key ENCRYPT. Which key encrypts is
 * `SECRETS_ACTIVE_KEY_ID`, and this table has no column that could say
 * otherwise.
 */
export const installationKeys = pgTable(
  'installation_keys',
  {
    id: uuid('id').primaryKey(),
    /**
     * The key's label, unique across this table. MAY equal a configured key's id when
     * the bytes differ (another installation named its key alike): such a key is held
     * as a second decrypt-only candidate for that id, wrapped under the configured key
     * of the same name. The same id with the same bytes is never stored.
     */
    keyId: text('key_id').notNull(),
    /** `kekFingerprint` of the key. Safe to show; compared on every unwrap. */
    fingerprint: text('fingerprint').notNull(),
    /**
     * The wrapped key. NULL exactly when the row is a TOMBSTONE: removal erases
     * the bytes and keeps the row, so a restore of an older backup — which still
     * holds this key — cannot quietly bring it back (the executor carries the
     * tombstone into the candidate).
     */
    wrappedMaterial: text('wrapped_material'),
    /** Which CONFIGURED key wraps it — what `secrets retire-check` counts. NULL on a tombstone. */
    wrappedUnderKeyId: text('wrapped_under_key_id'),
    source: text('source').notNull(),
    /** The kit it arrived in. An identifier, never the kit. */
    kitId: uuid('kit_id'),
    importedAt: timestamptz('imported_at').notNull(),
    /** Captured as a label too, so the row still names somebody after a restore. */
    importedByAdminId: uuid('imported_by_admin_id'),
    importedByLabel: text('imported_by_label'),
    /** Set by removal; the row is then a tombstone. Cleared only by a later import. */
    removedAt: timestamptz('removed_at'),
    removedByLabel: text('removed_by_label'),
    /**
     * Set by the recovery executor on a row the CANDIDATE held and this
     * installation did not: a key that came back inside a restored backup rather
     * than through an import here. Shown in the list, and audited at the cutover.
     */
    restoredAt: timestamptz('restored_at'),
  },
  (table) => [
    uniqueIndex('installation_keys_key_id_idx').on(table.keyId),
    check('installation_keys_source_check', enumCheck('source', INSTALLATION_KEY_SOURCES)),
    check('installation_keys_key_id_check', sql`key_id ~ '^[A-Za-z0-9._-]{1,64}$'`),
    check('installation_keys_fingerprint_check', sql`fingerprint ~ '^[0-9a-f]{32}$'`),
    // `wrapped_under_key_id` may equal `key_id`: the configured key of that name
    // wraps an imported key that shares the name (the wrap's AAD binds both ids,
    // and the unwrap tries every held key under the wrapping id).
    check(
      'installation_keys_wrapped_under_check',
      sql`wrapped_under_key_id IS NULL OR wrapped_under_key_id ~ '^[A-Za-z0-9._-]{1,64}$'`,
    ),
    /** A live row has its wrap; a tombstone has neither half of it. Both directions. */
    check(
      'installation_keys_tombstone_check',
      sql`(removed_at IS NULL) = (wrapped_material IS NOT NULL) AND (wrapped_material IS NULL) = (wrapped_under_key_id IS NULL)`,
    ),
    index('installation_keys_wrapped_under_idx').on(table.wrappedUnderKeyId),
  ],
);

/**
 * R11 A3: the life of each process role, kept so a CRASH LOOP can be seen across lives.
 *
 * One row per role (`api`, `worker`, `monitor`, ...), overwritten by every boot of that role.
 * A process that is restarted within seconds cannot remember anything itself, and the
 * loop-stall watchdog gives no verdict in a process's first minute, so a role that dies young
 * was never reported. What survives the crash is this row: the next boot reads how the
 * previous life ended — it reached `stable_at` (lived a full minute), was stopped on purpose
 * (`stopped_at`, a SIGTERM that shut down cleanly), or did neither, which is a crash — and
 * counts the unbroken streak of crashed lives (`restarts`, since `restarts_since`).
 *
 * Installation-wide: a role is not a tenant's, and nothing here is money, a customer or a
 * secret. The announcement itself is an operational event (`process.restart_storm`), whose
 * own dedupe row is what stops a restarting process announcing twice.
 */
export const processRuns = pgTable(
  'process_runs',
  {
    /** The process role's name, the primary key: the table holds the LATEST life of each. */
    role: text('role').primaryKey(),
    /** This life's id, so a late write from an older life cannot mark a newer one. */
    runId: uuid('run_id').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    /** Set when the life has stayed up `PROCESS_RUN_STABLE_AFTER_MS`; the streak ends there. */
    stableAt: timestamptz('stable_at'),
    /** Set by a clean shutdown (SIGTERM/SIGINT handled): an operator's stop, not a crash. */
    stoppedAt: timestamptz('stopped_at'),
    /** Crashed lives in the current unbroken streak, as of THIS boot. */
    restarts: integer('restarts').notNull().default(0),
    /** When the first crashed life of the streak began; null while `restarts` is 0. */
    restartsSince: timestamptz('restarts_since'),
  },
  () => [
    check('process_runs_role_check', sql`role ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    check(
      'process_runs_restarts_check',
      sql`restarts >= 0 AND (restarts = 0) = (restarts_since IS NULL)`,
    ),
  ],
);

/**
 * Phase 6B (ADR-0039 § 4): one restore of a TENANT archive into this installation.
 *
 * OWNED BY THE INSTALLATION TENANT (`tenant_id`): the owner's request to bring a hosted bot in,
 * and his record of how it went. `hosted_tenant_id` is the archive's tenant — no foreign key,
 * because until APPLYING commits that tenant does not exist here (and a refused restore never
 * creates it). The row is the restore's lock: one active per installation, by the partial
 * unique index. `dry_run` is the verified scratch's summary (counts per table, the archive's
 * head, the refusal checks passed) — counts and table names only, never a value.
 *
 * A restore never runs in the HTTP request that asks for it (ADR-0028, per tenant): the
 * request writes this row, and the restore engine advances it.
 */
export const tenantRestores = pgTable(
  'tenant_restores',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    hostedTenantId: uuid('hosted_tenant_id').notNull(),
    mode: text('mode').notNull(),
    state: text('state').notNull(),
    stage: text('stage').notNull(),
    /** SHA-256 of the uploaded archive file, lowercase hex: the confirmation is bound to it. */
    artifactSha256: text('artifact_sha256').notNull(),
    /** The archive's own id (its manifest's `archiveId`), once opened. */
    archiveId: text('archive_id'),
    dryRun: jsonb('dry_run'),
    requestedByAdminId: uuid('requested_by_admin_id').notNull(),
    confirmedAt: timestamptz('confirmed_at'),
    /**
     * Phase 6B PR-2: the owner confirmed this VERIFIED dry run in «میزبانی‌ها» (a fresh code). The
     * recovery role picks the row up from here and applies it — never the HTTP request.
     */
    confirmRequestedAt: timestamptz('confirm_requested_at'),
    /** REPLACE only: the verified PRE_REPLACE tenant archive of the rows being replaced. */
    preReplaceRunId: uuid('pre_replace_run_id').references(() => backupRuns.id),
    /**
     * REPLACE only (ADR-0039 § 4, § 10): the id of the ONE transaction that may delete this
     * tenant's append-only rows — the apply's own, written by it as it starts
     * (`pg_current_xact_id()`). `nexa_tenant_rewrite_allowed` answers true only inside that
     * transaction, for that tenant, while the row is APPLYING; once it ends the id never
     * recurs, so the authority dies with it.
     */
    rewriteXactId: bigint('rewrite_xact_id', { mode: 'bigint' }),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    /**
     * ADR-0025's lease (security review of PR #447, finding 3): the process working on the
     * request and when it last said so. A stale one is FAILED by the next restore, never
     * adopted. Null on rows written before the lease existed (their `updated_at` stands in).
     */
    leaseOwner: text('lease_owner'),
    leaseHeartbeatAt: timestamptz('lease_heartbeat_at'),
    createdAt: timestamptz('created_at').notNull(),
    updatedAt: timestamptz('updated_at').notNull(),
    finishedAt: timestamptz('finished_at'),
  },
  (table) => [
    check('tenant_restores_mode_check', enumCheck('mode', TENANT_RESTORE_MODES)),
    check('tenant_restores_state_check', enumCheck('state', TENANT_RESTORE_STATES)),
    check('tenant_restores_stage_check', enumCheck('stage', TENANT_RESTORE_STAGES)),
    check('tenant_restores_sha_check', sql`artifact_sha256 ~ '^[0-9a-f]{64}$'`),
    check('tenant_restores_not_self_check', sql`tenant_id <> hosted_tenant_id`),
    check(
      'tenant_restores_finished_check',
      sql`(state IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)`,
    ),
    check('tenant_restores_failure_check', sql`(state = 'FAILED') = (failure_code IS NOT NULL)`),
    uniqueIndex('tenant_restores_single_active_idx')
      .on(table.tenantId)
      .where(
        sql`state IN (${sql.raw(TENANT_RESTORE_ACTIVE_STATES.map((s) => `'${s}'`).join(', '))})`,
      ),
    index('tenant_restores_tenant_created_idx').on(table.tenantId, table.createdAt),
    foreignKey({
      name: 'tenant_restores_requested_by_fk',
      columns: [table.tenantId, table.requestedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);
