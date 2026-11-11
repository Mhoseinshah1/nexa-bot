import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IDENTITY_ERROR_CODES,
  IMPERSONATION_DENIED_PERMISSIONS,
  INSTALLATION_ONLY_PERMISSIONS,
  isNexaError,
  type ActorContext,
  type CorrelationId,
  type SecretPurpose,
} from '@nexa/contracts';
import { SECRET_COLUMNS } from '../../apps/api/src/infrastructure/crypto/secret-registry';
import {
  refuseImpersonatedAccountChange,
  refuseImpersonatedSecretWrite,
} from '../../apps/api/src/modules/platform/identity/application/impersonation';

/**
 * Phase 6B «ورود به پنل» (ADR-0039 § 9 refinement 3): an entered session — the installation
 * owner acting inside a hosted tenant — never seals a new secret value. A permission cannot
 * say it (the bot token is under `settings.edit`), so each secret's WRITER refuses itself.
 *
 * This test is what keeps that true for the next secret: it walks `SECRET_COLUMNS` (the
 * registry the build already forces every `_ciphertext` column into) and every `.encrypt(`
 * call site in the API, and fails when a purpose has no writer that refuses, or when a new
 * file seals something without being listed below with its refusing writer or an exemption.
 */

const ROOT = join(__dirname, '..', '..');
const API = join(ROOT, 'apps', 'api', 'src');

/** Each purpose → the service whose public entry refuses an entered session before sealing. */
const WRITERS: Readonly<Record<SecretPurpose, string>> = {
  'bot_instance.token': 'modules/platform/tenancy/application/bot-management.service.ts',
  'panel.username': 'modules/platform/panels/application/panel.service.ts',
  'panel.password': 'modules/platform/panels/application/panel.service.ts',
  'panel.api_token': 'modules/platform/panels/application/panel.service.ts',
  'payment_gateway.api_key': 'modules/commerce/payments/application/payment-gateway.service.ts',
  'payment_gateway.webhook_secret':
    'modules/commerce/payments/application/payment-gateway.service.ts',
  'payment_gateway.verify_key': 'modules/commerce/payments/application/payment-gateway.service.ts',
  'payment_gateway.refund_card':
    'modules/commerce/payments/application/gateway-receipt-capture.service.ts',
  'admin.totp_secret': 'modules/platform/identity/application/account-security.service.ts',
  'support_ai_provider.api_key':
    'modules/control/support-ai/application/support-ai-config.service.ts',
  'legacy_migration.package_key':
    'modules/platform/legacy-migration/application/legacy-migration.service.ts',
  'backup.archive_password': 'modules/platform/backup/application/backup-password.service.ts',
  'gift_card.batch_export': 'modules/commerce/gift-cards/application/gift-card-admin.service.ts',
  'hosting.totp_secret': 'modules/platform/hosting/application/hosting-section.service.ts',
  'hosting.archive_password': 'modules/platform/hosting/application/hosted-backup.service.ts',
  'hosting.reseller_bot_token':
    'modules/commerce/reseller-bots/application/reseller-bot-request.service.ts',
  'hosting.reseller_activation_link':
    'modules/commerce/reseller-bots/application/reseller-bot-request.service.ts',
};

/**
 * Every file that calls `.encrypt(`, and why its seal is covered: the writer service above
 * that reaches it, or why no entered session can reach it at all.
 */
const ENCRYPT_SITES: Readonly<Record<string, string>> = {
  'modules/platform/identity/application/account-security.service.ts': 'writer: admin.totp_secret',
  'modules/platform/tenancy/infrastructure/drizzle-bot-management.repository.ts':
    'reached from bot-management.service.ts replaceToken (refuses)',
  'modules/platform/tenancy/infrastructure/drizzle-tenant.repository.ts':
    'createFromBootstrap: the botctl bootstrap and the owner’s hosted activation, both with no entered actor',
  'modules/platform/legacy-migration/application/legacy-migration.service.ts':
    'writer: legacy_migration.package_key',
  'modules/platform/panels/infrastructure/drizzle-panel-credentials.ts':
    'reached from panel.service.ts create / setCredentials (refuse)',
  'modules/platform/hosting/application/hosting-section.service.ts': 'writer: hosting.totp_secret',
  'modules/platform/hosting/application/hosted-backup.service.ts':
    'writer: hosting.archive_password',
  'modules/platform/hosting/application/tenant-restore-admin.service.ts':
    'writer: hosting.archive_password (dry run seals the upload password; refuses)',
  'modules/platform/backup/application/backup-password.service.ts':
    'writer: backup.archive_password',
  'modules/platform/backup/infrastructure/tenant-archive-secrets.ts':
    'rewraps EXISTING values on a tenant restore (installation-only)',
  'modules/control/support-ai/infrastructure/drizzle-support-ai.repository.ts':
    'reached from support-ai-config.service.ts setCredential (refuses)',
  'modules/commerce/payments/infrastructure/drizzle-gateway-credentials.ts':
    'reached from payment-gateway.service.ts setCredential / setWebhookSecret / setVerifyKey (refuse)',
  'modules/commerce/payments/infrastructure/refund-card-sealer.ts':
    'reached from gateway-receipt-capture.service.ts requestRefund (refuses)',
  'modules/commerce/gift-cards/infrastructure/secret-cipher-gift-card-sealer.ts':
    'reached from gift-card-admin.service.ts create (refuses)',
  'modules/platform/opslog/application/unreadable-secret-reporter.ts':
    'a decorator passing through to the cipher; its callers are the writers above',
  'infrastructure/persistence/seed.ts': 'development seed, no actor',
  'infrastructure/crypto/secret-trial.ts': 'key rotation trial: re-encrypts existing values',
  'secrets.cli.ts': 'botctl secrets rewrap: re-encrypts existing values, no web actor',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

const entered: ActorContext = {
  type: 'WEB_ADMIN',
  id: '01900000-0000-7000-8000-000000000001',
  label: 'host',
  surface: 'WEB',
  correlationId: 'c' as CorrelationId,
  impersonation: {
    installationTenantId: '01900000-0000-7000-8000-000000000002',
    ownerAdminId: '01900000-0000-7000-8000-000000000003',
    ownerLabel: 'owner',
    hostingSessionId: '01900000-0000-7000-8000-000000000004',
  },
};
const { impersonation: _dropped, ...operator } = entered;

describe('«ورود به پنل»: every secret writer refuses an entered session', () => {
  it('every purpose in SECRET_COLUMNS has a writer, and that writer calls the refusal for it', () => {
    const purposes = [...new Set(SECRET_COLUMNS.map((column) => column.purpose))].sort();
    expect(Object.keys(WRITERS).sort()).toEqual(purposes);
    for (const purpose of purposes) {
      const source = readFileSync(join(API, WRITERS[purpose]), 'utf8');
      expect(source, `${WRITERS[purpose]} must refuse '${purpose}'`).toContain(
        `refuseImpersonatedSecretWrite(actor, '${purpose}')`,
      );
    }
  });

  it('every file that seals is listed with the writer that covers it', () => {
    const sealing = sourceFiles(API)
      .filter((path) => /\.encrypt\(/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(API, path).split('\\').join('/'))
      .sort();
    expect(sealing).toEqual(Object.keys(ENCRYPT_SITES).sort());
  });

  it('the refusal answers identity.impersonation_forbidden, and only to an entered actor', () => {
    for (const refuse of [
      () => refuseImpersonatedSecretWrite(entered, 'bot_instance.token'),
      () => refuseImpersonatedAccountChange(entered, 'admin.password_change'),
    ]) {
      let code: string | null = null;
      try {
        refuse();
      } catch (error) {
        code = isNexaError(error) ? error.code : 'not-a-nexa-error';
      }
      expect(code).toBe(IDENTITY_ERROR_CODES.IMPERSONATION_FORBIDDEN);
    }
    expect(() => refuseImpersonatedSecretWrite(operator, 'bot_instance.token')).not.toThrow();
    expect(() => refuseImpersonatedAccountChange(operator, 'x')).not.toThrow();
  });

  it('the denied permissions cover the admins, panel credentials and the installation-only keys', () => {
    expect(IMPERSONATION_DENIED_PERMISSIONS).toEqual(
      expect.arrayContaining([
        'admins.edit',
        'admins.permissions.edit',
        'panels.credentials.rotate',
        ...INSTALLATION_ONLY_PERMISSIONS,
      ]),
    );
  });
});
