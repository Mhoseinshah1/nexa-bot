/**
 * Every entry into the system path (ADR-0037), as `tests/unit/system-path.test.ts`
 * finds it: a `@ScopeBound` adapter's public method with no scope parameter (it runs as
 * nexa_system under the reason `Class.method` when nothing is bound, and an
 * `installation: true` adapter's always does), and every explicit `withSystemScope`
 * reason. Each one reads or writes across tenants.
 *
 * Adding a line here is the review: say in the commit why the method is cross-tenant by
 * nature (a token presented before any tenant is known, an installation-wide lock, a
 * sweep over every tenant), or give it a scope parameter instead.
 */
export const SYSTEM_PATH_ALLOWLIST: readonly string[] = [
  'DrizzleBackupPasswordStore.all',
  'DrizzleBackupPasswordStore.currentDecrypted',
  'DrizzleBackupRunRepository.active',
  'DrizzleBackupRunRepository.archivePruneCandidates',
  'DrizzleBackupRunRepository.byId',
  'DrizzleBackupRunRepository.countUnknownDeliveries',
  'DrizzleBackupRunRepository.databaseExists',
  'DrizzleBackupRunRepository.deliveredCopyPruneCandidates',
  'DrizzleBackupRunRepository.finish',
  'DrizzleBackupRunRepository.heartbeat',
  'DrizzleBackupRunRepository.lastSucceededAt',
  'DrizzleBackupRunRepository.latest',
  'DrizzleBackupRunRepository.latestVerified',
  'DrizzleBackupRunRepository.markArchivePruned',
  'DrizzleBackupRunRepository.orphanRunFacts',
  'DrizzleBackupRunRepository.page',
  'DrizzleBackupRunRepository.parts',
  'DrizzleBackupRunRepository.progress',
  'DrizzleBackupRunRepository.purgeFinishedBefore',
  'DrizzleBackupRunRepository.reclaimStale',
  'DrizzleBackupRunRepository.recordPartOutcome',
  'DrizzleBackupRunRepository.recordParts',
  'DrizzleBackupRunRepository.recordedLeftovers',
  'DrizzleBackupRunRepository.runningIds',
  'DrizzleBackupRunRepository.start',
  'DrizzleBackupRunRepository.withUnknownDelivery',
  'DrizzleBotCommandSyncRepository.activeBotsAcrossTenants',
  'DrizzleBotCommandSyncRepository.claimDue',
  'DrizzleBotInstanceRepository.findById',
  'DrizzleBotInstanceRepository.tokenReplacementHeld',
  'DrizzleCapacityLimitRepository.all',
  'DrizzleCapacityLimitRepository.find',
  'DrizzleCapacityLimitRepository.put',
  'DrizzleCapacityLimitRepository.storedFor',
  'DrizzleCapacityLimitRepository.storedForAll',
  'DrizzleDataCompactionRepository.advance',
  'DrizzleDataCompactionRepository.authorise',
  'DrizzleDataCompactionRepository.count',
  'DrizzleDataCompactionRepository.deleteBatch',
  'DrizzleDataCompactionRepository.failAbandoned',
  'DrizzleDataCompactionRepository.finish',
  'DrizzleDataCompactionRepository.latest',
  'DrizzleDataCompactionRepository.start',
  // Phase 6B PR-3: the installation owner's door to a hosted bot's export rows (ADR-0038
  // «Cross-tenant work»): another tenant's rows, so the system path under its own reason, with
  // the hosted tenant as the predicate of every statement.
  'reason: data-export: host checks the active export of a hosted bot',
  'reason: data-export: host finds an export of a hosted bot',
  'reason: data-export: host lists the exports of a hosted bot',
  'reason: data-export: host requests an export for a hosted bot',
  // Phase 6B PR-3 (ADR-0039, the open data export): the worker's sweeps across tenants. The
  // claim takes the oldest requested export of ANY tenant (the queue is the installation's, one
  // at a time), the abandoned-work sweep and the 24 h deadline sweep and the removal list of
  // expired files read the same rows; each export is then worked on bound to its own tenant.
  'DrizzleDataExportRepository.claimNext',
  'DrizzleDataExportRepository.expireDue',
  'DrizzleDataExportRepository.failAbandoned',
  'DrizzleDataExportRepository.pendingRemoval',
  'DrizzleDataExportRepository.statesOf',
  'DrizzleDirectMessageRepository.purgeFileContentBefore',
  'DrizzleGatewayInvoiceRepository.providerOrderIdTaken',
  // Phase 6B «ورود به پنل»: an entered session's liveness, asked by the token lookup's caller
  // before any tenant but the session's is known — the owner's section and Web Admin sessions
  // (one row each, by id) are the INSTALLATION's.
  'DrizzleHostingEnterRepository.ownerOf',
  'DrizzleHostingEnterRepository.sectionFacts',
  'DrizzleHeavyJobQueueRepository.enqueue',
  'DrizzleHeavyJobQueueRepository.finish',
  'DrizzleHeavyJobQueueRepository.heartbeat',
  'DrizzleHeavyJobQueueRepository.purgeFinished',
  'DrizzleHeavyJobQueueRepository.tryStart',
  // Phase 6B PR-2 (ADR-0039 § 7): ONE hosted tenant's archive runs. `backup_runs` carries no
  // tenant (ADR-0037's list), so these are installation reads by nature; every statement names
  // the subject tenant and `archive_scope = 'TENANT'`.
  'DrizzleHostedArchiveRuns.byId',
  'DrizzleHostedArchiveRuns.lastAttemptAt',
  'DrizzleHostedArchiveRuns.lastVerifiedAt',
  'DrizzleHostedArchiveRuns.markPruned',
  'DrizzleHostedArchiveRuns.pruneCandidates',
  'DrizzleHostedArchiveRuns.recent',
  'DrizzleHostedDomainDirectory.certificateAllowed',
  'DrizzleHostedDomainDirectory.findLinkByHash',
  'DrizzleHostedDomainDirectory.resolveHost',
  'DrizzleIncidentRepository.tenantsWithDue',
  'DrizzleInstallationKeyRepository.all',
  'DrizzleInstallationKeyRepository.countsByWrappingKey',
  'DrizzleInstallationKeyRepository.rewrap',
  'DrizzleInstallationKeyRepository.secretCountsByKeyId',
  'DrizzleLegacyCompactionRepository.advance',
  'DrizzleLegacyCompactionRepository.analyze',
  'DrizzleLegacyCompactionRepository.authorise',
  'DrizzleLegacyCompactionRepository.automaticCandidates',
  'DrizzleLegacyCompactionRepository.awaitingDestinationOpen',
  'DrizzleLegacyCompactionRepository.beginArchiving',
  'DrizzleLegacyCompactionRepository.claim',
  'DrizzleLegacyCompactionRepository.clearBatch',
  'DrizzleLegacyCompactionRepository.completedExists',
  'DrizzleLegacyCompactionRepository.create',
  'DrizzleLegacyCompactionRepository.dedupBatch',
  'DrizzleLegacyCompactionRepository.deleteDropBatch',
  'DrizzleLegacyCompactionRepository.heartbeat',
  'DrizzleLegacyCompactionRepository.importReadiness',
  'DrizzleLegacyCompactionRepository.latest',
  'DrizzleLegacyCompactionRepository.measure',
  'DrizzleLegacyCompactionRepository.stripBatch',
  'DrizzleLegacyCompactionRepository.vacuum',
  'DrizzleLegacyImporterRepository.resolveTenantId',
  'DrizzleLegacyNxpkgImportRepository.active',
  'DrizzleLegacyNxpkgImportRepository.applyingImportId',
  'DrizzleLegacyNxpkgImportRepository.byIdUnscoped',
  'DrizzleLegacyNxpkgImportRepository.claim',
  'DrizzleLegacyNxpkgImportRepository.committedImportId',
  'DrizzleLegacyNxpkgImportRepository.expireIdleKeys',
  'DrizzleLegacyNxpkgImportRepository.heartbeat',
  'DrizzleLegacyNxpkgImportRepository.insert',
  'DrizzleLegacyNxpkgImportRepository.latestCompletedOf',
  'DrizzleLegacyNxpkgImportRepository.page',
  'DrizzleLegacyNxpkgImportRepository.patch',
  'DrizzleLegacyNxpkgImportRepository.reclaimStale',
  'DrizzleLegacyNxpkgImportRepository.recordMemoryPeak',
  'DrizzleLegacyNxpkgImportRepository.release',
  'DrizzleLegacyNxpkgImportRepository.supersedeBefore',
  'DrizzleLegacyNxpkgImportRepository.transition',
  'DrizzleLoginChallengeRepository.findByTokenHash',
  'DrizzleLoginChallengeRepository.purgeExpiredBefore',
  'DrizzleLoginThrottleRepository.purgeExpired',
  'DrizzleMiniAppSessionRepository.findById',
  'DrizzleNotificationRepository.activeTenants',
  'DrizzleNotificationRepository.claimDue',
  'DrizzleNotificationRepository.failExhausted',
  'DrizzleNotificationRepository.recordAttempt',
  'DrizzleNotificationRepository.releaseClaim',
  'DrizzleOperationalConditionReader.openTenantConditions',
  'DrizzleOperationalConditionReader.systemConditionIsOpen',
  'DrizzleOperationalConditionReader.tenantConditionIsOpen',
  'DrizzlePanelMonitorRepository.activePanelCount',
  'DrizzlePanelMonitorRepository.claimTenants',
  'DrizzlePanelMonitorRepository.dueForTenants',
  'DrizzlePanelMonitorRepository.overBudgetTenants',
  'DrizzlePanelMonitorRepository.reconcileSchedules',
  'DrizzlePanelMonitorRepository.refreshTenantBounds',
  'DrizzlePaymentAttentionReader.statement',
  'DrizzleProcessRunStore.transact',
  'DrizzleReadinessProbes.cache',
  'DrizzleReadinessProbes.database',
  'DrizzleReadinessProbes.outboxLagMs',
  'DrizzleReadinessProbes.schema',
  'DrizzleRecoveryRequestRepository.backupIdsInUse',
  'DrizzleRecoveryRequestRepository.byId',
  'DrizzleRecoveryRequestRepository.byIdUnscoped',
  'DrizzleRecoveryRequestRepository.claimConfirmed',
  'DrizzleRecoveryRequestRepository.claimOwn',
  'DrizzleRecoveryRequestRepository.create',
  'DrizzleRecoveryRequestRepository.heartbeat',
  'DrizzleRecoveryRequestRepository.installationLock',
  'DrizzleRecoveryRequestRepository.latestCutoverAt',
  'DrizzleRecoveryRequestRepository.page',
  'DrizzleRecoveryRequestRepository.progress',
  'DrizzleRecoveryRequestRepository.progressUnowned',
  'DrizzleRecoveryRequestRepository.purgeFinishedBefore',
  'DrizzleRecoveryRequestRepository.reassert',
  'DrizzleRecoveryRequestRepository.reclaimStale',
  'DrizzleRecoveryRequestRepository.releaseKeptUpload',
  'DrizzleRecoveryRequestRepository.transition',
  'DrizzleSessionRepository.findByTokenHash',
  'DrizzleSessionRepository.purgeExpiredBefore',
  'DrizzleSessionRepository.revoke',
  'DrizzleSessionRepository.touch',
  'DrizzleTenantRepository.activeTenantIds',
  'DrizzleTenantRepository.allTenantIds',
  'DrizzleTenantRepository.findById',
  'DrizzleTenantRepository.findBySlug',
  'DrizzleTenantRepository.findPrimary',
  // Phase 6B replace: holding a hosted bot still for its replace and returning it to its
  // register's status are installation work on a hosted tenant's row (each also names its
  // own literal reason below); the reconcile after a crash spans every hosted bot.
  'DrizzleTenantReplaceHold.hold',
  'DrizzleTenantReplaceHold.release',
  'DrizzleTicketRepository.purgeReplyFileContentBefore',
  'OutboxRelay.isFresh',
  'OutboxRelay.isHealthy',
  'OutboxRelay.lagMs',
  'OutboxRelay.lagMsWithin',
  'OutboxRelay.processBatch',
  'OutboxRelay.start',
  'OutboxRelay.stop',
  'reason: admin login challenge lookup by token hash',
  'reason: admin session lookup by token hash',
  'reason: bot instance lookup by id',
  'reason: capacity limits: every tenant',
  'reason: capacity limits: one tenant',
  'reason: capacity limits: the owner sets a tenant',
  'reason: customer notification text retention',
  'reason: customer prune: dependents in every tenant',
  // Phase 6A PR-3, the creator panel: the installation owner's reads and writes across the
  // hosted tenants he created (ADR-0038), and the installation-wide backup time. Activation
  // (PR-4) adds: the Host->tenant directory reads made before any tenant is bound (activation
  // link by token hash, certificate question, request host), the bot-identity check across
  // every tenant, and the three writes a transaction bound to one tenant makes to ANOTHER
  // tenant's row (bind a bot, spend a link, mark the owner activated), each on one row.
  'reason: hosting: activation link by token hash',
  'reason: hosting: bind the bot of a hosted tenant',
  'reason: hosting: bot identity held by another tenant',
  'reason: hosting: close a hosted tenant for purge',
  // Phase 6B PR-2: the hosted owner's own backup page reads whether the HOST left its backups
  // on — one row of the installation's policy table, named by the hosted tenant's id.
  'reason: hosting: hosted backup policy for the hosted owner view',
  'reason: hosting: last successful installation backup',
  'reason: hosting: mark the hosted owner activated',
  'reason: hosting: may a certificate be issued for a host',
  'reason: hosting: provision a hosted tenant',
  'reason: hosting: purge preview counts of a hosted tenant',
  'reason: hosting: resolve a request host to its hosted tenant',
  'reason: hosting: set a hosted tenant status',
  'reason: hosting: slug taken in any tenant',
  'reason: hosting: spend an activation link',
  'reason: hosting: the hosted bot list, every hosted tenant',
  // Phase 6B PR-5, «ورود به پنل» (ADR-0039 § 9): the owner's transaction writes the hosted
  // tenant's HOST principal; the hosted tenant's transaction spends the installation's token row
  // (one row, by its hash and audience); every request of an entered session reads the owner's
  // section and Web Admin sessions (one row each, by id); closing a section revokes the hosted
  // sessions entered from it (one owner's); and the entered session's audit row is written into
  // the INSTALLATION's log from the hosted tenant's transaction (D5).
  'reason: audit: host owner acting in a hosted tenant',
  'reason: hosting: ensure the host principal of a hosted tenant',
  'reason: hosting: entered session liveness',
  'reason: hosting: open an entered session in a hosted tenant',
  'reason: hosting: revoke entered sessions with the section',
  'reason: idempotency retention: interactive keys',
  // Phase 6B PR-4 (ADR-0039 § 8): the server move. The bundle names every hosted bot's
  // Telegram identity (the hosted tenants' own bot rows); `move import` refuses a target that
  // already runs a business in ANY tenant; and each hosted member is checked once to be a
  // HOSTED child of the restored installation before its rows are read bound to it.
  'reason: move: bind a hosted tenant to verify it after import',
  'reason: move: list hosted tenants for the bundle',
  'reason: move: refuse an import into a running business',
  'reason: outbox retention: published messages',
  'reason: restore-exclusion',
  // Phase 6B PR-1 (ADR-0039): the tenant archive. Binding a hosted tenant from installation
  // work is checked once on the system path (HOSTED child of this installation, no children);
  // the restore's dry run reads ACROSS tenants for the keys no two tenants may share (tenant
  // id, slug, bot, domain, the GLOBAL unique keys); and its one transaction writes the new
  // tenant row and the owner's register, the only rows of it that are not the restored
  // tenant's own (those are written bound to it, under RLS).
  'reason: tenant archive: bind a hosted tenant for export',
  'reason: tenant archive: create the restored tenant and its register',
  'reason: tenant archive: global key collisions before restore',
  // Phase 6B, replace (ADR-0039 § 4, § 10): restoring a hosted archive over the SAME hosted
  // bot. Installation work on a hosted tenant's rows: the dry run reads the bot it writes over
  // (a HOSTED child of this installation, never PURGED); an ACTIVE bot is held still (its
  // tenant STOPPED) for the PRE_REPLACE archive and the replace, and returned to the status its
  // register state holds after it (or after a crash, by the next admitted restore); and the
  // replace's ONE transaction runs under its own reason, which the append-only guards compare
  // verbatim before they admit a DELETE of that tenant's rows (the deletes of unguarded tables
  // and every insert are bound to the tenant, under RLS).
  "reason: tenant archive: replace a hosted tenant's rows",
  'reason: tenant archive: the hosted bot a replace writes over',
  'reason: tenant archive: hold a hosted bot still for its replace',
  'reason: tenant archive: return a hosted bot to its register status',
];
