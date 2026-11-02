import type { CutoverReconciliation } from './cutover-reconciliation.js';
import type { ServiceReconciliation } from './cutover-service-reconciliation.js';

/**
 * The cutover REHEARSAL's rules, pure (`cutover-rehearse.cli.ts` runs them; `docs/cutover/
 * 12-rehearsal.md` is the page). The rehearsal runs the runbook's data steps — fresh target,
 * import, reconciliation — against a DISPOSABLE database it creates itself, and never the
 * steps that reach a customer or Telegram.
 */

/**
 * What the rehearsal's own process is configured with, whatever the installation's
 * `nexa.env` says. Every value here is a channel to a customer, to Telegram or to a panel
 * that the rehearsal must not open, or a directory it must not share with the live
 * installation:
 *
 * - `NOTIFICATION_DISPATCH_ENABLED=false` — no notification intent is ever dispatched;
 * - `TELEGRAM_WEBHOOK_ENABLED=false` and no backup delivery chat or token — nothing is
 *   registered with Telegram and no backup is sent there;
 * - `PROVISIONER_ENABLED`, `PANEL_MONITOR_ENABLED`, `BACKUP_SCHEDULE_ENABLED`,
 *   `RECOVERY_UPLOAD_ENABLED` off — no background role's loop has any work it may do;
 * - `LEGACY_MIGRATION_ENABLED=true` — the import executor is the thing being rehearsed;
 * - the three work directories under the rehearsal's own private directory, so no backup
 *   archive, recovery upload or package of the rehearsal lands in a live volume (and the
 *   live backup list never shows one).
 *
 * The process starts no loop at all: not the outbox relay, not the dispatcher, not the
 * webhook. These values are the second wall, and `messagingProblems` checks them.
 */
export const REHEARSAL_FORCED_SETTINGS = {
  NOTIFICATION_DISPATCH_ENABLED: 'false',
  TELEGRAM_WEBHOOK_ENABLED: 'false',
  BACKUP_TELEGRAM_BOT_TOKEN: '',
  BACKUP_TELEGRAM_CHAT_ID: '',
  BACKUP_SCHEDULE_ENABLED: 'false',
  PROVISIONER_ENABLED: 'false',
  PANEL_MONITOR_ENABLED: 'false',
  RECOVERY_UPLOAD_ENABLED: 'false',
  LEGACY_MIGRATION_ENABLED: 'true',
  LEGACY_MIGRATION_RETAIN_PACKAGE: 'false',
} as const;

/** The environment the rehearsal's configuration is loaded from. */
export function rehearsalEnvironment(
  base: NodeJS.ProcessEnv,
  input: { readonly databaseUrl: string; readonly workDir: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    ...REHEARSAL_FORCED_SETTINGS,
    DATABASE_URL: input.databaseUrl,
    // R12 F2: the rehearsal's stand-in panels listen on THIS one-off container's edge
    // address (`standinAddress`), and the URL policy refuses the edge network by default.
    // The rehearsal is disposable and isolated, and its own stand-in is the one panel it
    // calls, so its process does not carry the edge refusal. The data network still does.
    NEXA_EDGE_SUBNET: undefined,
    BACKUP_WORK_DIR: `${input.workDir}/backups`,
    RECOVERY_WORK_DIR: `${input.workDir}/recovery`,
    LEGACY_MIGRATION_WORK_DIR: `${input.workDir}/legacy-migration`,
  };
}

/** The loaded configuration's messaging channels, as the rehearsal requires them. */
export interface RehearsalMessagingConfig {
  readonly NOTIFICATION_DISPATCH_ENABLED: boolean;
  readonly TELEGRAM_WEBHOOK_ENABLED: boolean;
  readonly BACKUP_TELEGRAM_BOT_TOKEN: string;
  readonly BACKUP_TELEGRAM_CHAT_ID: string;
  readonly BACKUP_SCHEDULE_ENABLED: boolean;
  readonly PROVISIONER_ENABLED: boolean;
  readonly PANEL_MONITOR_ENABLED: boolean;
}

/** Each channel the loaded configuration still has open; empty is the only pass. */
export function messagingProblems(config: RehearsalMessagingConfig): string[] {
  const problems: string[] = [];
  if (config.NOTIFICATION_DISPATCH_ENABLED) problems.push('notification dispatch is on');
  if (config.TELEGRAM_WEBHOOK_ENABLED) problems.push('the Telegram webhook is on');
  if (config.BACKUP_TELEGRAM_BOT_TOKEN !== '' || config.BACKUP_TELEGRAM_CHAT_ID !== '') {
    problems.push('backup delivery to Telegram is configured');
  }
  if (config.BACKUP_SCHEDULE_ENABLED) problems.push('the backup schedule is on');
  if (config.PROVISIONER_ENABLED) problems.push('the provisioner is on');
  if (config.PANEL_MONITOR_ENABLED) problems.push('the panel monitor is on');
  return problems;
}

/** The default disposable database: `nexa_cutover_rehearsal_<UTC stamp>`. */
export function defaultRehearsalDatabase(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/u, '')
    .replace(/[-:]/gu, '')
    .replace('T', 't');
  return `nexa_cutover_rehearsal_${stamp}`;
}

// --- steps, verdict, report ---------------------------------------------------------------

export type RehearsalStepStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface RehearsalStep {
  /** The runbook page it stands for (`02`, `04`, …), or `--` for the rehearsal's own. */
  readonly page: string;
  readonly name: string;
  readonly status: RehearsalStepStatus;
  /** Aggregates, codes and names only. Never a Telegram id, a key, a token or an amount of one person. */
  readonly detail: string;
}

/** What the rehearsal saw leave, or try to leave, its own process. */
export interface RehearsalQuiet {
  readonly customerNotifications: number;
  readonly broadcastRecipients: number;
  readonly operatorNotificationsSent: number;
  readonly outboxPublished: number;
  readonly provisioningOperations: number;
  readonly botInstances: number;
  /** `fetch` calls the outbound guard refused (every one is a failure). */
  readonly outboundRefused: number;
  /** Of those, the ones addressed to Telegram. */
  readonly telegramRefused: number;
  /** Requests a read-only panel stand-in answered 405 (a write attempt). */
  readonly panelWritesRefused: number;
}

/** Each fact in `quiet` that breaks "nothing reached anyone"; empty is the only pass. */
export function quietProblems(q: RehearsalQuiet): string[] {
  const problems: string[] = [];
  const zero = (value: number, what: string): void => {
    if (value !== 0) problems.push(`${what} ${String(value)}`);
  };
  zero(q.customerNotifications, 'customer notifications');
  zero(q.broadcastRecipients, 'broadcast recipients');
  zero(q.operatorNotificationsSent, 'operator notifications sent');
  zero(q.outboxPublished, 'outbox messages published');
  zero(q.provisioningOperations, 'provisioning operations');
  zero(q.botInstances, 'bot instances');
  zero(q.outboundRefused, 'outbound requests attempted');
  zero(q.telegramRefused, 'Telegram calls attempted');
  zero(q.panelWritesRefused, 'panel write attempts');
  return problems;
}

export type RehearsalVerdict = 'GO' | 'GO_WITH_HELD' | 'NO_GO';

export interface RehearsalOutcome {
  readonly verdict: RehearsalVerdict;
  readonly reasons: readonly string[];
}

/**
 * GO only when every step passed and both reconciliations are exact; GO_WITH_HELD when the
 * only thing left is rows held for review (each class signed off by name, as at GO-3);
 * NO_GO on any failed step, any difference, or a reconciliation that never ran.
 */
export function rehearsalOutcome(input: {
  readonly steps: readonly RehearsalStep[];
  readonly balances: CutoverReconciliation | null;
  readonly services: ServiceReconciliation | null;
}): RehearsalOutcome {
  const reasons: string[] = [];
  for (const step of input.steps) {
    if (step.status === 'FAIL') reasons.push(`step ${step.name} failed`);
  }
  if (input.balances === null) reasons.push('the balance reconciliation did not run');
  else if (input.balances.verdict === 'DIFFERENCES') {
    reasons.push(`balances: ${String(input.balances.differences.length)} difference(s)`);
  }
  if (input.services === null) reasons.push('the service reconciliation did not run');
  else if (input.services.verdict === 'DIFFERENCES') {
    reasons.push(`services: ${String(input.services.differences.length)} difference(s)`);
  }
  if (reasons.length > 0) return { verdict: 'NO_GO', reasons };
  const held: string[] = [];
  if (input.balances?.verdict === 'RECONCILED_WITH_HELD') held.push('balances held for review');
  if (input.services?.verdict === 'RECONCILED_WITH_HELD') held.push('services held for review');
  return held.length > 0
    ? { verdict: 'GO_WITH_HELD', reasons: held }
    : { verdict: 'GO', reasons: [] };
}

/** 0 GO · 2 GO_WITH_HELD · 3 NO_GO — the same numbers `cutover-reconcile` uses. */
export function rehearsalExitCode(verdict: RehearsalVerdict): 0 | 2 | 3 {
  return verdict === 'GO' ? 0 : verdict === 'GO_WITH_HELD' ? 2 : 3;
}

export function stepLines(steps: readonly RehearsalStep[]): string {
  return `${steps
    .map((s) => `${s.status.padEnd(4)}  ${s.page.padEnd(2)}  ${s.name.padEnd(18)} ${s.detail}`)
    .join('\n')}\n`;
}

export function outcomeLines(outcome: RehearsalOutcome): string {
  const tail = outcome.reasons.length === 0 ? '' : ` (${outcome.reasons.join('; ')})`;
  return `go/no-go: ${outcome.verdict}${tail}\n`;
}
