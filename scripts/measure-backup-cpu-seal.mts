/**
 * Setup for `scripts/measure-backup-cpu.mjs --seal-password`: stores a throwaway backup
 * password on the installation tenant of the database DATABASE_URL names, sealed with this
 * environment's keyring exactly as the Web Admin's «رمز فایل بکاپ» stores one, so the measured
 * run takes the production 7-Zip path. MEASUREMENT ONLY — never run against an installation.
 */
import { Client } from 'pg';
import { loadConfig } from '../apps/api/src/infrastructure/config/load-config';
import { createContainer } from '../apps/api/src/container';

const config = loadConfig(process.env);
const container = createContainer(config, 'worker');
const primary = await container.tenants.findPrimary();
if (primary === null) throw new Error('no primary tenant in this database');
const id = container.ids.uuid();
const sealed = container.cipher.encrypt('measure-backup-cpu', {
  purpose: 'backup.archive_password',
  tenantId: primary.id,
  entityId: id,
});
const client = new Client({ connectionString: config.DATABASE_URL });
await client.connect();
await client.query(
  'UPDATE backup_archive_passwords SET superseded_at = now() WHERE tenant_id = $1 AND superseded_at IS NULL',
  [primary.id],
);
await client.query(
  `INSERT INTO backup_archive_passwords
     (id, tenant_id, password_ciphertext, password_key_id, created_at, created_by_admin_id, superseded_at)
   VALUES ($1, $2, $3, $4, now(), NULL, NULL)`,
  [id, primary.id, sealed.ciphertext, sealed.keyId],
);
await client.end();
process.stderr.write(`sealed a throwaway backup password for tenant ${primary.id}\n`);
process.exit(0);
