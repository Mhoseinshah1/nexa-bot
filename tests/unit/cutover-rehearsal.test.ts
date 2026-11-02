import { afterEach, describe, expect, it } from 'vitest';
import { TargetRefused, UsageError } from '../../apps/api/src/cutover-reconcile.cli';
import { standinAddress } from '../../apps/api/src/cutover-rehearse-import';
import {
  parsePanelInventory,
  parseRehearseArgs,
  rehearsalTarget,
} from '../../apps/api/src/cutover-rehearse.cli';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import {
  REHEARSAL_FORCED_SETTINGS,
  defaultRehearsalDatabase,
  messagingProblems,
  outcomeLines,
  quietProblems,
  rehearsalEnvironment,
  rehearsalExitCode,
  rehearsalOutcome,
  stepLines,
  type RehearsalQuiet,
  type RehearsalStep,
} from '../../apps/api/src/modules/platform/legacy-cutover/application/cutover-rehearsal';
import type { CutoverReconciliation } from '../../apps/api/src/modules/platform/legacy-cutover/application/cutover-reconciliation';
import {
  SERVICE_DIFFERENCE_KINDS,
  mirzaInvoiceOf,
  reconcileServices,
  serviceReportText,
  type NexaServiceRow,
  type ServiceReconciliation,
} from '../../apps/api/src/modules/platform/legacy-cutover/application/cutover-service-reconciliation';
import { RehearsalOutboundGuard } from '../../apps/api/src/modules/platform/legacy-cutover/infrastructure/rehearsal-outbound-guard';

/**
 * The cutover rehearsal's rules (`cutover-rehearse.cli.ts`, `docs/cutover/12-rehearsal.md`):
 * the target it refuses, the channels it closes for itself, the outbound wall, the service
 * reconciliation and the go/no-go. The run itself is `tests/integration/cutover-rehearsal.test.ts`.
 * SYNTHETIC values only.
 */

const liveAt = (name: string) => `postgres://nexa:secret@postgres:5432/${name}`;
const LIVE = liveAt('nexa');
const KEK = Buffer.alloc(32, 7).toString('base64');

const baseArgs = [
  '--package',
  '/cutover/final.nxpkg',
  '--package-key-env',
  'NXPKG_KEY',
  '--owner-telegram-id',
  '900000001',
];

describe('cutover rehearsal: arguments', () => {
  it('reads every flag; nothing defaults that decides what is read or where it goes', () => {
    const args = parseRehearseArgs([
      ...baseArgs,
      '--database',
      'nexa_cutover_rehearsal_1',
      '--keep-database',
      '--panel-inventory',
      '/cutover/inventory.json',
      '--json',
    ]);
    expect(args).toMatchObject({
      packagePath: '/cutover/final.nxpkg',
      packageKeyEnv: 'NXPKG_KEY',
      packagePassphraseEnv: null,
      ownerTelegramId: '900000001',
      database: 'nexa_cutover_rehearsal_1',
      keepDatabase: true,
      panelInventory: '/cutover/inventory.json',
      json: true,
      listDifferences: false,
    });
    expect(parseRehearseArgs(baseArgs)).toMatchObject({ database: null, keepDatabase: false });
  });

  it('refuses a missing package, both or neither secret, a bad owner id, a bad name', () => {
    expect(() => parseRehearseArgs(baseArgs.slice(2))).toThrow(UsageError);
    expect(() => parseRehearseArgs([...baseArgs, '--package-passphrase-env', 'P'])).toThrow(
      /exactly one/u,
    );
    expect(() => parseRehearseArgs(['--package', 'x', '--owner-telegram-id', '900000001'])).toThrow(
      /exactly one/u,
    );
    expect(() =>
      parseRehearseArgs([...baseArgs.slice(0, 4), '--owner-telegram-id', '@owner']),
    ).toThrow(/numeric Telegram id/u);
    expect(() => parseRehearseArgs([...baseArgs, '--database', 'Nexa-Live'])).toThrow(/lowercase/u);
    expect(() => parseRehearseArgs([...baseArgs, '--database', 'a;drop'])).toThrow(UsageError);
  });

  it('never echoes an unknown argument (it may have been a key)', () => {
    let message = '';
    try {
      parseRehearseArgs([...baseArgs, '--key', 'NXPKG-SECRET-TEXT']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('unknown argument');
    expect(message).not.toContain('NXPKG-SECRET-TEXT');
  });

  it('reads the stand-in inventory as {code_panel: [accounts]}', () => {
    const inventory = parsePanelInventory('{"rp1":[{"username":"a"}],"rp2":[]}');
    expect([...inventory.keys()]).toEqual(['rp1', 'rp2']);
    expect(() => parsePanelInventory('[]')).toThrow(UsageError);
    expect(() => parsePanelInventory('{"rp1":{}}')).toThrow(UsageError);
    expect(() => parsePanelInventory('not json')).toThrow(UsageError);
  });
});

describe('cutover rehearsal: the target is a NEW database, never the live one', () => {
  it('refuses the live database DATABASE_URL names, even under a non-production name', () => {
    expect(() => rehearsalTarget(liveAt('nexa_staging'), 'nexa_staging')).toThrow(TargetRefused);
    expect(() => rehearsalTarget(liveAt('nexa_rehearsal_live'), 'nexa_rehearsal_live')).toThrow(
      /is the live database/u,
    );
  });

  it('refuses a production-like name and the system databases', () => {
    expect(() => rehearsalTarget(LIVE, 'nexa')).toThrow(TargetRefused);
    expect(() => rehearsalTarget(LIVE, 'nexa_copy')).toThrow(/production/u);
    expect(() => rehearsalTarget(liveAt('nexa_test'), 'postgres')).toThrow(TargetRefused);
  });

  it('keeps the server and credentials, replaces only the name; the maintenance URL is /postgres', () => {
    const target = rehearsalTarget(LIVE, 'nexa_cutover_rehearsal_20261027t101500');
    expect(target.url).toBe(
      'postgres://nexa:secret@postgres:5432/nexa_cutover_rehearsal_20261027t101500',
    );
    expect(target.maintenanceUrl).toBe('postgres://nexa:secret@postgres:5432/postgres');
    expect(target.live).toBe('nexa');
  });

  it('refuses when there is no DATABASE_URL to take the server from', () => {
    expect(() => rehearsalTarget(undefined, 'nexa_cutover_rehearsal_x')).toThrow(UsageError);
  });

  it('names its default database after the UTC time, and that name passes the rules', () => {
    const name = defaultRehearsalDatabase(new Date('2026-10-27T10:15:00.123Z'));
    expect(name).toBe('nexa_cutover_rehearsal_20261027t101500');
    expect(() => parseRehearseArgs([...baseArgs, '--database', name])).not.toThrow();
    expect(rehearsalTarget(LIVE, name).url).toContain(name);
  });
});

describe('cutover rehearsal: its own channels are closed, whatever nexa.env says', () => {
  const live = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgres://u:p@localhost:5432/nexa',
    REDIS_URL: 'redis://localhost:6379',
    SECRETS_KEK: KEK,
    SECRETS_KEK_ID: 'dev-1',
    TRUSTED_PROXY_IPS: '127.0.0.1,::1',
    // A live installation's: everything on.
    NOTIFICATION_DISPATCH_ENABLED: 'true',
    TELEGRAM_WEBHOOK_ENABLED: 'true',
    TELEGRAM_WEBHOOK_SECRET: 'a-webhook-secret-of-some-length',
    BACKUP_TELEGRAM_BOT_TOKEN: '123:abc',
    BACKUP_TELEGRAM_CHAT_ID: '-100123',
    BACKUP_SCHEDULE_ENABLED: 'true',
    PROVISIONER_ENABLED: 'true',
    PANEL_MONITOR_ENABLED: 'true',
    LEGACY_MIGRATION_ENABLED: 'false',
    BACKUP_WORK_DIR: '/var/lib/nexa/backups',
  } satisfies NodeJS.ProcessEnv;

  it('the loaded rehearsal configuration has every messaging channel off', () => {
    const config = loadConfig(
      rehearsalEnvironment(live, {
        databaseUrl: 'postgres://u:p@localhost:5432/nexa_cutover_rehearsal_x',
        workDir: '/tmp/rehearsal',
      }),
    );
    expect(messagingProblems(config)).toEqual([]);
    expect(config.NOTIFICATION_DISPATCH_ENABLED).toBe(false);
    expect(config.TELEGRAM_WEBHOOK_ENABLED).toBe(false);
    expect(config.BACKUP_TELEGRAM_BOT_TOKEN).toBe('');
    expect(config.LEGACY_MIGRATION_ENABLED).toBe(true);
    // Its archives and uploads stay in its own directory, never a live volume.
    expect(config.BACKUP_WORK_DIR).toBe('/tmp/rehearsal/backups');
    expect(config.RECOVERY_WORK_DIR).toBe('/tmp/rehearsal/recovery');
    expect(config.LEGACY_MIGRATION_WORK_DIR).toBe('/tmp/rehearsal/legacy-migration');
    expect(config.DATABASE_URL).toContain('/nexa_cutover_rehearsal_x');
  });

  it('the live configuration itself would be refused, channel by channel', () => {
    const problems = messagingProblems(loadConfig(live));
    expect(problems).toEqual([
      'notification dispatch is on',
      'the Telegram webhook is on',
      'backup delivery to Telegram is configured',
      'the backup schedule is on',
      'the provisioner is on',
      'the panel monitor is on',
    ]);
  });

  it('forces exactly the channels it documents, and turns none of them on', () => {
    expect(REHEARSAL_FORCED_SETTINGS).toEqual({
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
    });
  });
});

describe('cutover rehearsal: the outbound wall', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  it('refuses every fetch while installed, counts Telegram apart, and restores fetch after', async () => {
    const guard = new RehearsalOutboundGuard(['telegram.org']);
    guard.install();
    await expect(fetch('https://api.telegram.org/bot1:x/sendMessage')).rejects.toThrow(
      /sends nothing/u,
    );
    await expect(fetch(new URL('https://example.com/'))).rejects.toBeInstanceOf(TypeError);
    expect(guard.counts()).toEqual({ refused: 2, telegram: 1 });
    guard.uninstall();
    expect(globalThis.fetch).toBe(original);
  });
});

describe('cutover rehearsal: where the stand-ins listen', () => {
  const config = {
    PANEL_HTTP_ALLOW_LOOPBACK: false,
    NEXA_DATA_SUBNET: '172.29.1.0/24',
    PANEL_HTTP_DENIED_SUBNETS: [],
    DATABASE_URL: 'postgres://nexa:p@postgres:5432/nexa_cutover_rehearsal_x',
    REDIS_URL: 'redis://redis:6379',
  };
  const iface = (address: string, internal = false) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  });

  it('in production: the first private address outside the data network, never loopback', () => {
    expect(
      standinAddress(config, {
        lo: [iface('127.0.0.1', true)],
        eth0: [iface('172.29.1.5')],
        eth1: [iface('172.29.0.7')],
      }),
    ).toBe('172.29.0.7');
    expect(standinAddress(config, { eth0: [iface('172.29.1.5')] })).toBeNull();
  });

  it('where loopback is allowed: a loopback address the database does not own', () => {
    expect(
      standinAddress({
        ...config,
        PANEL_HTTP_ALLOW_LOOPBACK: true,
        DATABASE_URL: 'postgres://nexa:p@127.0.0.1:5432/x',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    ).toBe('127.0.0.2');
  });
});

describe('cutover rehearsal: the service reconciliation', () => {
  const TG = (n: number) => String(500_000_000 + n);
  const svc = (
    n: number,
    invoice: string | null,
    owner: number,
    state = 'ACTIVE',
  ): NexaServiceRow => ({
    serviceId: `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`,
    state,
    source: invoice === null ? 'NEXA' : 'MIRZA',
    sourceRef: invoice === null ? null : `invoice:${invoice}`,
    ownerTelegramId: TG(owner),
  });
  const mirza = [
    { invoiceKey: 'a1', ownerTelegramId: TG(1) },
    { invoiceKey: 'a2', ownerTelegramId: TG(2) },
    { invoiceKey: 'r3', ownerTelegramId: TG(3) },
  ];
  const clean = () => ({
    mirza,
    candidates: [
      { invoiceKey: 'a1', outcome: 'ADOPTED' as const, serviceId: svc(1, 'a1', 1).serviceId },
      { invoiceKey: 'a2', outcome: 'ADOPTED' as const, serviceId: svc(2, 'a2', 2).serviceId },
      { invoiceKey: 'r3', outcome: 'PROVIDER_MISSING' as const, serviceId: null },
    ],
    services: [svc(1, 'a1', 1), svc(2, 'a2', 2), svc(3, 'r3', 3, 'TERMINATED')],
  });

  it('adopted and owned: matched; a held invoice is counted by outcome, history kept apart', () => {
    const r = reconcileServices(clean());
    expect(r).toMatchObject({
      verdict: 'RECONCILED_WITH_HELD',
      mirzaServices: 3,
      nexaServices: 3,
      matched: 2,
      held: [{ outcome: 'PROVIDER_MISSING', invoices: 1 }],
      heldTotal: 1,
      heldAsHistory: 1,
      differences: [],
    });
    const all = reconcileServices({
      ...clean(),
      mirza: mirza.slice(0, 2),
      candidates: clean().candidates.slice(0, 2),
      services: clean().services.slice(0, 2),
    });
    expect(all.verdict).toBe('RECONCILED');
  });

  it('names every kind of difference, by invoice position and service id only', () => {
    const base = clean();
    const kinds = (input: Parameters<typeof reconcileServices>[0]) =>
      reconcileServices(input).differences.map((d) => d.kind);
    expect(kinds({ ...base, candidates: base.candidates.slice(1) })).toEqual([
      'SERVICE_NOT_DECIDED',
    ]);
    expect(kinds({ ...base, services: [base.services[1]!, base.services[2]!] })).toEqual([
      'SERVICE_ADOPTED_MISSING',
    ]);
    expect(
      kinds({ ...base, services: [svc(1, 'a1', 1, 'TERMINATED'), ...base.services.slice(1)] }),
    ).toEqual(['SERVICE_ADOPTED_MISSING']);
    expect(kinds({ ...base, services: [...base.services, svc(9, 'a1', 1)] })).toEqual([
      'SERVICE_DUPLICATED',
    ]);
    expect(kinds({ ...base, services: [...base.services.slice(0, 2), svc(3, 'r3', 3)] })).toEqual([
      'SERVICE_LIVE_WHILE_HELD',
    ]);
    expect(kinds({ ...base, services: [svc(1, 'a1', 7), ...base.services.slice(1)] })).toEqual([
      'SERVICE_OWNER_DIFFERS',
    ]);
    expect(kinds({ ...base, services: [...base.services, svc(8, null, 1)] })).toEqual([
      'SERVICE_NOT_IN_MIRZA',
    ]);
    expect(kinds({ ...base, services: [...base.services, svc(8, 'zz', 1)] })).toEqual([
      'SERVICE_NOT_IN_MIRZA',
    ]);
    expect(
      kinds({
        ...base,
        candidates: [...base.candidates, { invoiceKey: 'zz', outcome: 'ORPHAN', serviceId: null }],
      }),
    ).toEqual(['CANDIDATE_NOT_IN_MIRZA']);
    const owner = reconcileServices({
      ...base,
      services: [svc(1, 'a1', 7), ...base.services.slice(1)],
    });
    expect(owner.verdict).toBe('DIFFERENCES');
    expect(owner.differences[0]).toEqual({
      kind: 'SERVICE_OWNER_DIFFERS',
      mirzaInvoice: 1,
      serviceId: svc(1, 'a1', 7).serviceId,
    });
    const text = serviceReportText(owner, { listDifferences: true });
    expect(text).not.toContain(TG(7));
    expect(text).not.toContain(TG(1));
    for (const kind of SERVICE_DIFFERENCE_KINDS) expect(text).toContain(`difference ${kind}:`);
  });

  it('reads the invoice a service names only from a MIRZA source', () => {
    expect(mirzaInvoiceOf({ source: 'MIRZA', sourceRef: 'invoice:d00' })).toBe('d00');
    expect(mirzaInvoiceOf({ source: 'NEXA', sourceRef: 'invoice:d00' })).toBeNull();
    expect(mirzaInvoiceOf({ source: 'MIRZA', sourceRef: 'order:1' })).toBeNull();
  });
});

describe('cutover rehearsal: go / no-go', () => {
  const pass = (name: string): RehearsalStep => ({ page: '04', name, status: 'PASS', detail: '' });
  const balances = (verdict: CutoverReconciliation['verdict'], differences = 0) =>
    ({ verdict, differences: new Array(differences).fill({}) }) as unknown as CutoverReconciliation;
  const services = (verdict: ServiceReconciliation['verdict'], differences = 0) =>
    ({ verdict, differences: new Array(differences).fill({}) }) as unknown as ServiceReconciliation;

  it('GO only when every step passed and both reconciliations are exact', () => {
    const outcome = rehearsalOutcome({
      steps: [pass('import'), { ...pass('token-handover'), status: 'SKIP' }],
      balances: balances('RECONCILED'),
      services: services('RECONCILED'),
    });
    expect(outcome).toEqual({ verdict: 'GO', reasons: [] });
    expect(rehearsalExitCode('GO')).toBe(0);
  });

  it('GO_WITH_HELD when held rows are all that is left', () => {
    const outcome = rehearsalOutcome({
      steps: [pass('import')],
      balances: balances('RECONCILED_WITH_HELD'),
      services: services('RECONCILED_WITH_HELD'),
    });
    expect(outcome.verdict).toBe('GO_WITH_HELD');
    expect(rehearsalExitCode(outcome.verdict)).toBe(2);
  });

  it('NO_GO on a failed step, a difference, or a reconciliation that never ran', () => {
    expect(
      rehearsalOutcome({
        steps: [{ ...pass('import'), status: 'FAIL' }],
        balances: balances('RECONCILED'),
        services: services('RECONCILED'),
      }).reasons,
    ).toEqual(['step import failed']);
    expect(
      rehearsalOutcome({
        steps: [pass('import')],
        balances: balances('DIFFERENCES', 1),
        services: null,
      }),
    ).toEqual({
      verdict: 'NO_GO',
      reasons: ['balances: 1 difference(s)', 'the service reconciliation did not run'],
    });
    expect(rehearsalExitCode('NO_GO')).toBe(3);
    expect(outcomeLines({ verdict: 'NO_GO', reasons: ['x'] })).toBe('go/no-go: NO_GO (x)\n');
    expect(stepLines([pass('import')])).toBe('PASS  04  import             \n');
  });

  it('any send, any attempt, any panel write breaks the quiet check', () => {
    const quiet: RehearsalQuiet = {
      customerNotifications: 0,
      broadcastRecipients: 0,
      operatorNotificationsSent: 0,
      outboxPublished: 0,
      provisioningOperations: 0,
      botInstances: 0,
      outboundRefused: 0,
      telegramRefused: 0,
      panelWritesRefused: 0,
    };
    expect(quietProblems(quiet)).toEqual([]);
    for (const key of Object.keys(quiet) as (keyof RehearsalQuiet)[]) {
      expect(quietProblems({ ...quiet, [key]: 1 }), key).toHaveLength(1);
    }
  });
});
