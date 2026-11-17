import { stdin, stderr } from 'node:process';
import { type ActorContext, type AdminSessionId, type TenantContext } from '@nexa/contracts';
import { newCorrelationId } from './infrastructure/logging/logger.js';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { Prompter } from './infrastructure/tty/prompt.js';
import { HostedWebhookRecoveryService } from './modules/platform/hosting/application/hosted-webhook-recovery.service.js';
import { DrizzleHostedRecoveryCandidates } from './modules/platform/hosting/infrastructure/drizzle-hosted-recovery-candidates.js';
import { DrizzleHostingRepository } from './modules/platform/hosting/infrastructure/drizzle-hosting.repository.js';

/** No argv/environment secrets and no unattended authorization bypass. */
export function requireHostedRecoveryTerminal(argv: readonly string[], isTty: boolean): void {
  if (argv.length !== 0 || !isTty) {
    throw new Error('Run botctl telegram register-hosted in a terminal, with no arguments.');
  }
}

type RecoveryContainer = Pick<
  Container,
  'auth' | 'tenants' | 'ids' | 'hostingSection' | 'setInstallationTenant'
>;
type RecoveryRunner = Pick<HostedWebhookRecoveryService, 'preview' | 'run'>;

/** Real password/sign-in factor and hosting-section proof; revoke this CLI's session on exit. */
export async function registerHostedInteractively(
  container: RecoveryContainer,
  recovery: RecoveryRunner,
  prompt: Pick<Prompter, 'line' | 'secret'>,
  write: (line: string) => void,
): Promise<number> {
  const tenant = await container.tenants.findPrimary();
  if (tenant?.kind !== 'PRIMARY') throw new Error('No primary installation.');
  container.setInstallationTenant(tenant.id, tenant.kind);
  const scope: TenantContext = { tenantId: tenant.id, botInstanceId: null };
  const anonymous: ActorContext = {
    type: 'API',
    id: null,
    label: null,
    surface: 'WEB',
    correlationId: newCorrelationId(container.ids.uuid()),
    userAgent: 'botctl telegram register-hosted',
  };
  const context = { ip: null, userAgent: 'botctl telegram register-hosted' };
  const signed = await container.auth.signIn(
    scope,
    anonymous,
    {
      username: await prompt.line('Installation owner username: '),
      password: await prompt.secret('Password: '),
    },
    context,
  );
  const result =
    signed.kind === 'SIGNED_IN'
      ? signed.result
      : await container.auth.completeSecondFactor(
          signed.challengeToken,
          anonymous,
          proof(await prompt.secret('Sign-in two-step code (or recovery code): ')),
          context,
        );
  const actor: ActorContext = {
    ...anonymous,
    type: 'WEB_ADMIN',
    id: result.admin.id,
    label: result.admin.username,
    sessionId: result.session.id,
  };
  let sectionOpened = false;
  try {
    const opened = await container.hostingSection.openSession(scope, actor, {
      proof: proof(await prompt.secret('Hosting-section two-step code (or recovery code): ')),
    });
    sectionOpened = true;
    const preview = await recovery.preview(scope, actor, opened.opened.token);
    write(
      `${String(preview.count)} hosted bots in this installation; inactive or expired bots will be skipped.`,
    );
    if (preview.count === 0) return 0;
    const confirmation = `REGISTER ${String(preview.count)}`;
    if (
      (await prompt.line(`Type ${confirmation} to check and register eligible hosted bots: `)) !==
      confirmation
    ) {
      write('Cancelled; no hosted webhook was contacted.');
      return 1;
    }
    const totals = await recovery.run(scope, actor, opened.opened.token, preview, (item) => {
      write(`${item.hostedTenantId} ${item.outcome}${item.code === null ? '' : ` ${item.code}`}`);
    });
    write(
      `Ready: ${String(totals.ready)}; skipped: ${String(totals.skipped)}; failed: ${String(totals.failed)}.`,
    );
    if (totals.failed > 0)
      write(
        'Fix the reported activation step and repeat this command. Queued updates are retained.',
      );
    return totals.failed === 0 ? 0 : 2;
  } finally {
    // Both attempts run even if one cleanup fails. Never print session tokens/errors.
    try {
      if (sectionOpened) await container.hostingSection.closeSession(scope, actor);
    } finally {
      await container.auth.logout(scope, actor, result.session.id as AdminSessionId);
    }
  }
}

function proof(value: string): { code: string } | { backupCode: string } {
  const clean = value.trim();
  return /^\d{6}$/.test(clean) ? { code: clean } : { backupCode: clean };
}

async function main(): Promise<void> {
  requireHostedRecoveryTerminal(process.argv.slice(2), stdin.isTTY === true);
  const container = createContainer(loadConfig(), 'worker');
  const prompt = new Prompter(stdin, stderr);
  try {
    // Restored credentials may still need the decrypt-only installation keyring.
    await container.installationKeyLoader.refresh();
    const recovery = new HostedWebhookRecoveryService({
      candidates: new DrizzleHostedRecoveryCandidates(container.database.db),
      hosting: new DrizzleHostingRepository(container.database.db),
      tenants: container.tenants,
      section: container.hostingSection,
      activation: container.hostedActivation,
      clock: container.clock,
      ids: container.ids,
    });
    process.exitCode = await registerHostedInteractively(container, recovery, prompt, (line) =>
      stderr.write(`${line}\n`),
    );
  } finally {
    prompt.close();
    await container.shutdown();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch(() => {
    // A free-form upstream error can contain credentials. Details stay off this CLI entirely.
    console.error(
      'Hosted recovery stopped. Check owner credentials, both two-step factors, and the activation checks. No secret details are printed.',
    );
    process.exitCode = 1;
  });
}
