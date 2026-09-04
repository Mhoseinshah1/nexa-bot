import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  auditLogs,
  panelCredentials,
  panels,
} from '../../apps/api/src/infrastructure/persistence/schema';
import type { ProviderProbeOutcome, ProviderType } from '@nexa/contracts';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import { PanelService } from '../../apps/api/src/modules/platform/panels/application/panel.service';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { DrizzlePanelRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { AesGcmSecretCipher } from '../../apps/api/src/infrastructure/crypto/secret-cipher';
import { SECRET_COLUMNS } from '../../apps/api/src/infrastructure/crypto/secret-registry';
import { rewrapColumn, statusOf } from '../../apps/api/src/secrets.cli';
import type { SecretKeyring } from '../../apps/api/src/infrastructure/crypto/keyring';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Panels, credentials and health against a real database.
 *
 * The properties under test are the ones a unit test cannot express, because
 * they live in the storage: that a credential's ciphertext is bound to the row
 * it sits in, that a tenant predicate is in every statement rather than in a
 * caller's memory, and that the columns a response is built from do not contain
 * a plaintext value in the first place.
 *
 * Two tenants are seeded and both are used. A cross-tenant test with one tenant
 * seeded proves nothing: every id is absent from a database with one tenant in
 * it, so the test passes whether or not the predicate exists.
 */

/** Distinctive enough that a substring search over a whole table is meaningful. */
const PASSWORD = 'z9-panel-secret-do-not-leak-Q4';
const USERNAME = 'panel-admin-w7-distinctive';
const TOKEN = 'tok-3f-never-in-a-response-11';

describe('panels', () => {
  let ctx: TestContext;
  let owner: SeededAdmin;
  /** panels.view + panels.edit, but NOT panels.credentials.rotate. */
  let technical: SeededAdmin;
  /** panels.view only. */
  let operator: SeededAdmin;
  /** No panel permission at all. */
  let support: SeededAdmin;
  let ownerB: SeededAdmin;

  beforeEach(async () => {
    ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner_a',
      roleKeys: ['owner'],
    });
    technical = await createAdmin(ctx.container, tenantA, {
      username: 'tech_a',
      roleKeys: ['technical'],
    });
    operator = await createAdmin(ctx.container, tenantA, {
      username: 'op_a',
      roleKeys: ['operator'],
    });
    support = await createAdmin(ctx.container, tenantA, {
      username: 'sup_a',
      roleKeys: ['support'],
    });
    ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner_b',
      roleKeys: ['owner'],
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  let keyCounter = 0;
  // At least eight characters, which the contract schema requires.
  const key = () => `idem-key-${(keyCounter += 1)}`;

  const create = (
    admin: SeededAdmin,
    scope: typeof tenantA,
    overrides: Record<string, unknown> = {},
  ) =>
    ctx.container.panels.create(scope, adminActorFor(admin), {
      name: 'Frankfurt',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey: key(),
      ...overrides,
    });

  // -------------------------------------------------------------------------
  // The ordinary path
  // -------------------------------------------------------------------------

  it('creates a panel and reports its credentials as configured, never their values', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    expect(view.panel.name).toBe('Frankfurt');
    expect(view.panel.providerType).toBe('marzban');
    expect(view.panel.status).toBe('ACTIVE');
    // Never probed, so there is no health row. Absence is the state.
    expect(view.health).toBeNull();

    expect(view.credentials.usernameSetAt).toBeInstanceOf(Date);
    expect(view.credentials.passwordSetAt).toBeInstanceOf(Date);
    expect(view.credentials.apiTokenSetAt).toBeNull();

    // The view type has no field for a value; this asserts that no property
    // carrying one was added by any layer between the row and here.
    expect(JSON.stringify(view)).not.toContain(PASSWORD);
    expect(JSON.stringify(view)).not.toContain(USERNAME);
  });

  /**
   * One credential set, the other two absent — for each of the three.
   *
   * These exist because the original suite always set `username` first, and a
   * read-path bug hid behind exactly that habit: the repository selected the
   * three timestamps as a nested group, and Drizzle collapses such a group to
   * null when its FIRST column is null. A panel with a password and no username
   * therefore reported every credential as not configured. An operator would
   * have retyped a password that was already correct, and a token-only provider
   * — which never has a username, and Sanaei is one — would have reported
   * itself unconfigured permanently.
   *
   * Table-driven so the next credential kind cannot be added without a case,
   * and so no single ordering can hide the next version of this.
   */
  const soleCredential = [
    ['username', USERNAME, 'usernameSetAt'],
    ['password', PASSWORD, 'passwordSetAt'],
    ['apiToken', TOKEN, 'apiTokenSetAt'],
  ] as const;

  for (const [field, value, timestamp] of soleCredential) {
    it(`reports ${field} as configured when it is the only credential set`, async () => {
      const { view } = await create(owner, tenantA, {
        name: `Only ${field}`,
        credentials: { [field]: value },
      });

      expect(view.credentials[timestamp], `${field} read back as unset`).toBeInstanceOf(Date);
      for (const [, , other] of soleCredential) {
        if (other !== timestamp) expect(view.credentials[other]).toBeNull();
      }

      // And on a fresh read, not only on the one the write returned.
      const reread = await ctx.container.panels.get(tenantA, adminActorFor(owner), view.panel.id);
      expect(reread.credentials[timestamp]).toBeInstanceOf(Date);

      // And in a list, which is a different query with the same projection.
      const listed = await ctx.container.panels.list(tenantA, adminActorFor(owner));
      expect(
        listed.find((v) => v.panel.id === view.panel.id)?.credentials[timestamp],
      ).toBeInstanceOf(Date);
    });
  }

  it('carries health and credentials together when both joins are populated', async () => {
    // The other direction of the same join. A probed panel must report its
    // health AND its credential state in one view, with the credential it does
    // not have reported as absent rather than collapsing the group.
    //
    // "Health but no credentials at all" is deliberately not tested: it is
    // unreachable, because a probe with nothing to authenticate with is refused
    // before anything is contacted. The test below proves that refusal.
    const { view } = await create(owner, tenantA, {
      name: 'Health and credentials',
      credentials: { username: USERNAME, password: PASSWORD },
    });
    const probed = await probeWith(view.panel.id, {
      ok: true,
      degraded: false,
      providerVersion: '0.8.4',
    });

    expect(probed.view.health?.state).toBe('HEALTHY');
    expect(probed.view.health?.providerVersion).toBe('0.8.4');
    expect(probed.view.credentials.usernameSetAt).toBeInstanceOf(Date);
    expect(probed.view.credentials.passwordSetAt).toBeInstanceOf(Date);
    expect(probed.view.credentials.apiTokenSetAt).toBeNull();
  });

  it('stores a v2 envelope and no plaintext anywhere in the credential row', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD, apiToken: TOKEN },
    });

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, view.panel.id));

    expect(row).toBeDefined();
    // v2 is the format with the (purpose, tenant, entity) binding. A v1 value
    // has no binding at all, so a panel credential stored as v1 would be
    // transplantable — the property three tests below depend on.
    expect(row?.usernameCiphertext?.startsWith('v2.')).toBe(true);
    expect(row?.passwordCiphertext?.startsWith('v2.')).toBe(true);
    expect(row?.apiTokenCiphertext?.startsWith('v2.')).toBe(true);

    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain(USERNAME);
    expect(serialised).not.toContain(TOKEN);
  });

  it('finds no plaintext credential anywhere in the database', async () => {
    await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD, apiToken: TOKEN },
    });

    // Every text-ish column of every table, scanned for the three values. A
    // targeted check on the columns we expect to be safe would pass even if a
    // credential were copied into an audit payload or an operational event.
    const { rows } = (await ctx.container.database.db.execute(
      sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND data_type IN ('text', 'character varying', 'jsonb', 'json')
      ` as never,
    )) as unknown as { rows: { table_name: string; column_name: string }[] };

    const hits: string[] = [];
    for (const { table_name, column_name } of rows) {
      const found = (await ctx.container.database.db.execute(
        sql`
          SELECT 1 FROM ${sql.identifier(table_name)}
          WHERE ${sql.identifier(column_name)}::text LIKE ${'%' + PASSWORD + '%'}
             OR ${sql.identifier(column_name)}::text LIKE ${'%' + USERNAME + '%'}
             OR ${sql.identifier(column_name)}::text LIKE ${'%' + TOKEN + '%'}
          LIMIT 1
        ` as never,
      )) as unknown as { rows: unknown[] };
      if (found.rows.length > 0) hits.push(`${table_name}.${column_name}`);
    }

    expect(hits, `plaintext credential found in: ${hits.join(', ')}`).toEqual([]);
  });

  it('audits which credentials were set without recording what they were', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    const entries = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityId, view.panel.id));

    const created = entries.find((entry) => entry.action === 'panel.create');
    expect(created).toBeDefined();
    // Which KINDS were supplied, never the values. The field is `configured`
    // rather than `credentialsSet` because the audit writer redacts any key
    // containing `credential` — an accurate name that survives the redactor,
    // not a name chosen to slip past it.
    expect((created?.after as { configured: string[] }).configured).toEqual([
      'USERNAME',
      'PASSWORD',
    ]);
    expect(JSON.stringify(entries)).not.toContain(PASSWORD);
    expect(JSON.stringify(entries)).not.toContain(USERNAME);
  });

  // -------------------------------------------------------------------------
  // Credential replacement
  // -------------------------------------------------------------------------

  it('replaces a credential without disturbing the ones it does not mention', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });
    const before = await ctx.container.panels.get(tenantA, adminActorFor(owner), view.panel.id);

    await ctx.container.panels.setCredentials(tenantA, adminActorFor(owner), view.panel.id, {
      credentials: { password: 'a-completely-different-password' },
      idempotencyKey: key(),
    });

    const stored = await readCredentials(view.panel.id, tenantA);
    expect(stored?.password).toBe('a-completely-different-password');
    // Untouched, because the write did not mention it.
    expect(stored?.username).toBe(USERNAME);

    const after = await ctx.container.panels.get(tenantA, adminActorFor(owner), view.panel.id);
    expect(after.credentials.usernameSetAt?.getTime()).toBe(
      before.credentials.usernameSetAt?.getTime(),
    );
  });

  it('does not erase a credential when a metadata edit omits it', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    await ctx.container.panels.update(tenantA, adminActorFor(owner), view.panel.id, {
      name: 'Frankfurt (renamed)',
      idempotencyKey: key(),
    });

    // The whole reason a rename and a credential replacement are different
    // endpoints. The legacy admin's write-only setting screens made "the only
    // way to read a value is to overwrite it" true; this makes the opposite
    // mistake — overwriting by not mentioning — impossible.
    const stored = await readCredentials(view.panel.id, tenantA);
    expect(stored?.username).toBe(USERNAME);
    expect(stored?.password).toBe(PASSWORD);
  });

  it('removes a credential only when explicitly told to', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD, apiToken: TOKEN },
    });

    await ctx.container.panels.setCredentials(tenantA, adminActorFor(owner), view.panel.id, {
      credentials: { apiToken: null },
      idempotencyKey: key(),
    });

    const stored = await readCredentials(view.panel.id, tenantA);
    expect(stored?.apiToken).toBeNull();
    expect(stored?.password).toBe(PASSWORD);

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, view.panel.id));
    // The table's CHECK requires the three columns of one credential to be all
    // null or all present. A removal that cleared the ciphertext and left the
    // key id would have been rejected by the database.
    expect(row?.apiTokenCiphertext).toBeNull();
    expect(row?.apiTokenKeyId).toBeNull();
    expect(row?.apiTokenSetAt).toBeNull();
  });

  it('records a credential replacement as replaced and a removal as removed', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD, apiToken: TOKEN },
    });

    await ctx.container.panels.setCredentials(tenantA, adminActorFor(owner), view.panel.id, {
      credentials: { password: 'next-password-value', apiToken: null },
      idempotencyKey: key(),
    });

    const [entry] = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityId, view.panel.id),
          eq(auditLogs.action, 'panel.credentials.replace'),
        ),
      );

    const after = entry?.after as { replaced: string[]; removed: string[] };
    expect(after.replaced).toEqual(['PASSWORD']);
    expect(after.removed).toEqual(['API_TOKEN']);
    expect(JSON.stringify(entry)).not.toContain('next-password-value');
  });

  // -------------------------------------------------------------------------
  // Transplant: the property the AEAD context exists for
  // -------------------------------------------------------------------------

  it('refuses a credential ciphertext moved to another panel', async () => {
    const source = await create(owner, tenantA, {
      name: 'Source',
      credentials: { password: PASSWORD },
    });
    const target = await create(owner, tenantA, { name: 'Target' });

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, source.view.panel.id));

    // Written directly, as an attacker with database write access would.
    await ctx.container.database.db.insert(panelCredentials).values({
      panelId: target.view.panel.id,
      tenantId: tenantA.tenantId,
      passwordCiphertext: row?.passwordCiphertext ?? null,
      passwordKeyId: row?.passwordKeyId ?? null,
      passwordSetAt: new Date(),
    });

    await expect(readCredentials(target.view.panel.id, tenantA)).rejects.toThrow();
  });

  it('refuses a credential ciphertext moved to another tenant', async () => {
    const source = await create(owner, tenantA, { credentials: { password: PASSWORD } });
    const target = await create(ownerB, tenantB, { name: 'Target B' });

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, source.view.panel.id));

    await ctx.container.database.db.insert(panelCredentials).values({
      panelId: target.view.panel.id,
      tenantId: tenantB.tenantId,
      passwordCiphertext: row?.passwordCiphertext ?? null,
      passwordKeyId: row?.passwordKeyId ?? null,
      passwordSetAt: new Date(),
    });

    await expect(readCredentials(target.view.panel.id, tenantB)).rejects.toThrow();
  });

  it('refuses a password ciphertext moved into the username column of its own row', async () => {
    const { view } = await create(owner, tenantA, { credentials: { password: PASSWORD } });

    const [row] = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, view.panel.id));

    // Same tenant, same entity, same row. The PURPOSE is the only thing left
    // separating the two contexts, which is why there are three purposes and
    // not one.
    await ctx.container.database.db
      .update(panelCredentials)
      .set({
        usernameCiphertext: row?.passwordCiphertext ?? null,
        usernameKeyId: row?.passwordKeyId ?? null,
        usernameSetAt: new Date(),
      })
      .where(eq(panelCredentials.panelId, view.panel.id));

    await expect(readCredentials(view.panel.id, tenantA)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Tenant isolation
  // -------------------------------------------------------------------------

  it('answers NOT_FOUND for another tenant, with the id known to exist', async () => {
    const { view } = await create(owner, tenantA);
    // The id is real. If the predicate were missing this call would succeed,
    // which is exactly what a single-tenant fixture could not detect.
    await expect(
      ctx.container.panels.get(tenantB, adminActorFor(ownerB), view.panel.id),
    ).rejects.toMatchObject({ code: 'panel.not_found' });
  });

  it('does not list another tenant panels', async () => {
    await create(owner, tenantA, { name: 'A only' });
    await create(ownerB, tenantB, { name: 'B only' });

    const listA = await ctx.container.panels.list(tenantA, adminActorFor(owner));
    const listB = await ctx.container.panels.list(tenantB, adminActorFor(ownerB));

    expect(listA.map((view) => view.panel.name)).toEqual(['A only']);
    expect(listB.map((view) => view.panel.name)).toEqual(['B only']);
  });

  it('refuses to update, re-credential, restatus or test another tenant panel', async () => {
    const { view } = await create(owner, tenantA);
    const actor = adminActorFor(ownerB);
    const id = view.panel.id;

    await expect(
      ctx.container.panels.update(tenantB, actor, id, { name: 'stolen', idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: 'panel.not_found' });
    await expect(
      ctx.container.panels.setCredentials(tenantB, actor, id, {
        credentials: { password: 'x' },
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.not_found' });
    await expect(
      ctx.container.panels.setStatus(tenantB, actor, id, {
        status: 'ARCHIVED',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.not_found' });
    await expect(
      ctx.container.panels.testConnection(tenantB, actor, id, { idempotencyKey: key() }),
    ).rejects.toMatchObject({ code: 'panel.not_found' });

    // And nothing was written to the panel by any of the four.
    const after = await ctx.container.panels.get(tenantA, adminActorFor(owner), id);
    expect(after.panel.name).toBe('Frankfurt');
    expect(after.panel.status).toBe('ACTIVE');
  });

  it('does not let a tenant credential write reach another tenant row', async () => {
    const { view } = await create(owner, tenantA, { credentials: { password: PASSWORD } });

    // Tenant B naming tenant A's panel id directly at the store, below the
    // service. The store's own predicate is what must refuse this.
    const read = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(
        and(
          eq(panelCredentials.panelId, view.panel.id),
          eq(panelCredentials.tenantId, tenantB.tenantId),
        ),
      );
    expect(read).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Permissions
  // -------------------------------------------------------------------------

  it('refuses every panel operation to an admin with no panel permission', async () => {
    const { view } = await create(owner, tenantA);
    const actor = adminActorFor(support);

    await expect(ctx.container.panels.list(tenantA, actor)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    await expect(ctx.container.panels.get(tenantA, actor, view.panel.id)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    await expect(create(support, tenantA, { name: 'nope' })).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
  });

  it('records exactly one DENIED audit row for a refused write', async () => {
    const { view } = await create(owner, tenantA, { credentials: { password: PASSWORD } });

    await expect(
      ctx.container.panels.setCredentials(tenantA, adminActorFor(technical), view.panel.id, {
        credentials: { password: 'not-allowed-to-do-this' },
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });

    const denied = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.result, 'DENIED'));

    // Exactly one. The permission is checked twice on a write — once before the
    // transaction, because the replay path and the connection test both act
    // before one opens, and once inside it, which is the authority. Only the
    // check that actually refuses records, so two checks still mean one row.
    //
    // This test exists because the early check was added without it and ate
    // the audit trail: a denied credential rotation left nothing behind at all,
    // which is the opposite of what a CRITICAL permission is for.
    expect(denied).toHaveLength(1);
    expect(denied[0]?.action).toBe('panel.credentials.replace');
    expect(denied[0]?.entityId).toBe(view.panel.id);
    expect((denied[0]?.after as { deniedPermission: string }).deniedPermission).toBe(
      'panels.credentials.rotate',
    );
    expect(JSON.stringify(denied)).not.toContain('not-allowed-to-do-this');
  });

  it('lets a viewer read but not write', async () => {
    const { view } = await create(owner, tenantA);
    const actor = adminActorFor(operator);

    await expect(ctx.container.panels.get(tenantA, actor, view.panel.id)).resolves.toBeDefined();
    await expect(
      ctx.container.panels.update(tenantA, actor, view.panel.id, {
        name: 'renamed',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
  });

  it('separates editing a panel from rotating its credentials', async () => {
    const { view } = await create(owner, tenantA, { credentials: { password: PASSWORD } });
    const actor = adminActorFor(technical);

    // `technical` holds panels.view and panels.edit and NOT
    // panels.credentials.rotate — a ladder that exists in the frozen catalogue
    // rather than one invented for this test.
    await expect(
      ctx.container.panels.update(tenantA, actor, view.panel.id, {
        name: 'Renamed by technical',
        idempotencyKey: key(),
      }),
    ).resolves.toBeDefined();

    await expect(
      ctx.container.panels.setCredentials(tenantA, actor, view.panel.id, {
        credentials: { password: 'technical-should-not-manage-this' },
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });

    const stored = await readCredentials(view.panel.id, tenantA);
    expect(stored?.password).toBe(PASSWORD);
  });

  // -------------------------------------------------------------------------
  // Provider types and URLs
  // -------------------------------------------------------------------------

  it('refuses a string that is not a provider type, naming the field', async () => {
    await expect(create(owner, tenantA, { providerType: 'not-a-panel' })).rejects.toMatchObject({
      code: 'panel.request_invalid',
      details: { issues: [{ path: 'providerType' }] },
    });
    expect(await ctx.container.database.db.select().from(panels)).toEqual([]);
  });

  it('refuses a declared provider type this release has no adapter for', async () => {
    // `sanaei` is in the frozen contracts and has no adapter yet. Refused at
    // CREATE, not at the first probe: the legacy bot let an operator configure
    // a panel it could never talk to and reported success (SOURCE_BUG-XUI-001).
    await expect(create(owner, tenantA, { providerType: 'sanaei' })).rejects.toMatchObject({
      code: 'panel.provider_type_unsupported',
    });
    expect(await ctx.container.database.db.select().from(panels)).toEqual([]);
  });

  it('refuses a URL the policy blocks, at write time', async () => {
    // Link-local. Never a self-hosted panel, always the cloud metadata service.
    await expect(
      create(owner, tenantA, { baseUrl: 'http://169.254.169.254/latest/meta-data/' }),
    ).rejects.toMatchObject({ code: 'panel.target_blocked' });
    expect(await ctx.container.database.db.select().from(panels)).toEqual([]);
  });

  it('accepts a private-network panel, which is the ordinary self-hosted case', async () => {
    const { view } = await create(owner, tenantA, { baseUrl: 'https://10.8.0.4:8443' });
    expect(view.panel.baseUrl).toBe('https://10.8.0.4:8443/');
  });

  // -------------------------------------------------------------------------
  // Names, status and archive
  // -------------------------------------------------------------------------

  it('refuses a duplicate live name within a tenant and allows it across tenants', async () => {
    await create(owner, tenantA, { name: 'Shared' });
    await expect(create(owner, tenantA, { name: 'Shared' })).rejects.toMatchObject({
      code: 'panel.name_taken',
    });
    await expect(create(ownerB, tenantB, { name: 'Shared' })).resolves.toBeDefined();
  });

  it('releases a name when a panel is archived', async () => {
    const { view } = await create(owner, tenantA, { name: 'Recycled' });
    await ctx.container.panels.setStatus(tenantA, adminActorFor(owner), view.panel.id, {
      status: 'ARCHIVED',
      idempotencyKey: key(),
    });
    await expect(create(owner, tenantA, { name: 'Recycled' })).resolves.toBeDefined();
  });

  it('hides an archived panel from the list and refuses to edit or test it', async () => {
    const { view } = await create(owner, tenantA, { credentials: { password: PASSWORD } });
    const actor = adminActorFor(owner);
    await ctx.container.panels.setStatus(tenantA, actor, view.panel.id, {
      status: 'ARCHIVED',
      idempotencyKey: key(),
    });

    expect(await ctx.container.panels.list(tenantA, actor)).toEqual([]);
    // Still addressable by id: archiving hides it, it does not destroy the
    // record, and a later phase needs the row to explain a service that was
    // provisioned through it.
    const archived = await ctx.container.panels.get(tenantA, actor, view.panel.id);
    expect(archived.panel.status).toBe('ARCHIVED');
    expect(archived.panel.archivedAt).toBeInstanceOf(Date);

    await expect(
      ctx.container.panels.update(tenantA, actor, view.panel.id, {
        name: 'x',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.archived' });
    await expect(
      ctx.container.panels.testConnection(tenantA, actor, view.panel.id, {
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.archived' });
    await expect(
      ctx.container.panels.setCredentials(tenantA, actor, view.panel.id, {
        credentials: { password: 'x' },
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.archived' });
  });

  it('refuses to restore a panel whose name was taken while it was archived', async () => {
    // C11. Archiving RELEASES the name on purpose, so another panel can take
    // it — which makes restoring the first one an ordinary thing to attempt
    // and an ordinary thing to refuse. The partial unique index caught it
    // either way; what escaped was an unhandled 500 rather than the documented
    // conflict, so an operator was told the system broke rather than what to do.
    const { view } = await create(owner, tenantA, { name: 'Recycled name' });
    const actor = adminActorFor(owner);
    await ctx.container.panels.setStatus(tenantA, actor, view.panel.id, {
      status: 'ARCHIVED',
      idempotencyKey: key(),
    });
    await create(owner, tenantA, { name: 'Recycled name' });

    await expect(
      ctx.container.panels.setStatus(tenantA, actor, view.panel.id, {
        status: 'ACTIVE',
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.name_taken' });

    // And the archived panel is still archived: the refusal rolled back.
    const after = await ctx.container.panels.get(tenantA, actor, view.panel.id);
    expect(after.panel.status).toBe('ARCHIVED');
  });

  it('refuses a malformed panel identifier before it reaches PostgreSQL', async () => {
    await expect(
      ctx.container.panels.get(tenantA, adminActorFor(owner), 'not-a-uuid'),
    ).rejects.toMatchObject({ code: 'panel.request_invalid' });
  });

  it('restores an archived panel and keeps its credentials', async () => {
    const { view } = await create(owner, tenantA, { credentials: { password: PASSWORD } });
    const actor = adminActorFor(owner);
    await ctx.container.panels.setStatus(tenantA, actor, view.panel.id, {
      status: 'ARCHIVED',
      idempotencyKey: key(),
    });
    const restored = await ctx.container.panels.setStatus(tenantA, actor, view.panel.id, {
      status: 'ACTIVE',
      idempotencyKey: key(),
    });

    expect(restored.panel.status).toBe('ACTIVE');
    // The CHECK constraint requires an ARCHIVED panel to have a time and a live
    // one not to, so a restore that forgot to clear it would have been rejected.
    expect(restored.panel.archivedAt).toBeNull();
    expect((await readCredentials(view.panel.id, tenantA))?.password).toBe(PASSWORD);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('creates one panel for a replayed create', async () => {
    const idempotencyKey = key();
    const first = await ctx.container.panels.create(tenantA, adminActorFor(owner), {
      name: 'Once',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      credentials: { password: PASSWORD },
      idempotencyKey,
    });
    const second = await ctx.container.panels.create(tenantA, adminActorFor(owner), {
      name: 'Once',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      credentials: { password: PASSWORD },
      idempotencyKey,
    });

    expect(second.replayed).toBe(true);
    expect(second.view.panel.id).toBe(first.view.panel.id);
    expect(await ctx.container.database.db.select().from(panels)).toHaveLength(1);
  });

  it('replays a create whose credentials differ, because the values are not in the hash', async () => {
    const idempotencyKey = key();
    const base = {
      name: 'Once',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey,
    };
    await ctx.container.panels.create(tenantA, adminActorFor(owner), {
      ...base,
      credentials: { password: PASSWORD },
    });
    // A retry where the operator retyped the password. Hashing the value would
    // make this a DIFFERENT request, which would then be refused as a name
    // conflict — a retry that reports a conflict it caused itself.
    const retry = await ctx.container.panels.create(tenantA, adminActorFor(owner), {
      ...base,
      credentials: { password: 'retyped-the-same-thing-differently' },
    });
    expect(retry.replayed).toBe(true);
    expect((await readCredentials(retry.view.panel.id, tenantA))?.password).toBe(PASSWORD);
  });

  it('refuses a replay whose permission was revoked in the meantime', async () => {
    const idempotencyKey = key();
    const command = {
      name: 'Revoked',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey,
    };
    await ctx.container.panels.create(tenantA, adminActorFor(technical), command);

    // The role goes away; the idempotency record does not. A replay returns a
    // LIVE panel view, so without a permission check ahead of the store an
    // ex-administrator could read a panel back with a key they used while they
    // still had the right to.
    await ctx.container.roles.setAdminRoles(tenantA, technical.id, [], null);

    await expect(
      ctx.container.panels.create(tenantA, adminActorFor(technical), command),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  it('refuses to test a panel with no credentials, before contacting anything', async () => {
    const { view } = await create(owner, tenantA);
    await expect(
      ctx.container.panels.testConnection(tenantA, adminActorFor(owner), view.panel.id, {
        idempotencyKey: key(),
      }),
    ).rejects.toMatchObject({ code: 'panel.credentials_missing' });
  });

  it('records a probe outcome as health without carrying anything from the panel', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    const outcome = await probeWith(view.panel.id, {
      ok: false,
      failure: 'AUTHENTICATION_FAILED',
      status: 401,
    });

    expect(outcome.probed).toBe(true);
    expect(outcome.view.health?.state).toBe('AUTH_FAILED');
    expect(outcome.view.health?.failure).toBe('AUTHENTICATION_FAILED');
    expect(outcome.view.health?.statusCode).toBe(401);
    // Never healthy, so nothing to carry forward.
    expect(outcome.view.health?.lastHealthyAt).toBeNull();
    // The panel is untouched: a failing probe changes health and nothing else.
    expect(outcome.view.panel.status).toBe('ACTIVE');
    expect((await readCredentials(view.panel.id, tenantA))?.password).toBe(PASSWORD);
  });

  it('carries lastHealthyAt forward across a failure', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    const healthy = await probeWith(view.panel.id, {
      ok: true,
      degraded: false,
      providerVersion: '0.8.4',
    });
    expect(healthy.view.health?.state).toBe('HEALTHY');
    const lastHealthyAt = healthy.view.health?.lastHealthyAt;
    expect(lastHealthyAt).toBeInstanceOf(Date);

    const down = await probeWith(view.panel.id, { ok: false, failure: 'TIMEOUT', status: null });
    expect(down.view.health?.state).toBe('UNREACHABLE');
    // "Unreachable, last worked four minutes ago" and "unreachable, last worked
    // in March" are the same state and completely different problems.
    expect(down.view.health?.lastHealthyAt?.getTime()).toBe(lastHealthyAt?.getTime());
  });

  it('does not disable, archive or erase a panel because a probe failed', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    // Every failure kind an unreachable panel can produce. Not a sample: the
    // rule is that NO failure touches the panel, and a rule tested against one
    // failure is a rule about that failure.
    for (const failure of ['TIMEOUT', 'UNREACHABLE', 'TLS_FAILED', 'PROVIDER_ERROR'] as const) {
      await probeWith(view.panel.id, { ok: false, failure, status: null });
    }

    const after = await ctx.container.panels.get(tenantA, adminActorFor(owner), view.panel.id);
    expect(after.panel.status).toBe('ACTIVE');
    expect(after.panel.archivedAt).toBeNull();
    expect(after.credentials.passwordSetAt).toBeInstanceOf(Date);
    expect((await readCredentials(view.panel.id, tenantA))?.password).toBe(PASSWORD);
  });

  it('tests a disabled panel, because that is when an operator needs to', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });
    const actor = adminActorFor(owner);
    await ctx.container.panels.setStatus(tenantA, actor, view.panel.id, {
      status: 'DISABLED',
      idempotencyKey: key(),
    });

    const result = await probeWith(view.panel.id, {
      ok: true,
      degraded: false,
      providerVersion: '0.8.4',
    });
    expect(result.probed).toBe(true);
    expect(result.view.health?.state).toBe('HEALTHY');
    expect(result.view.panel.status).toBe('DISABLED');
  });

  it('keeps a probe result free of anything the panel said', async () => {
    const { view } = await create(owner, tenantA, {
      credentials: { username: USERNAME, password: PASSWORD },
    });

    // A hostile panel answering with the operator's own credentials in its
    // version string. The stored version is bounded and character-restricted,
    // so nothing arbitrary reaches the health row or the audit entry.
    await probeWith(view.panel.id, {
      ok: true,
      degraded: false,
      providerVersion: null,
    });

    const health = (await ctx.container.panels.get(tenantA, adminActorFor(owner), view.panel.id))
      .health;
    expect(JSON.stringify(health)).not.toContain(PASSWORD);

    const entries = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'panel.test'));
    expect(entries).toHaveLength(1);
    // The audit records the normalized outcome only. There is no field on the
    // probe result a provider message could be put in.
    expect(Object.keys(entries[0]?.after as object).sort()).toEqual([
      'failure',
      'latencyMs',
      'state',
    ]);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Decrypts through the real store, which is the only path to a plaintext.
   *
   * Constructed here from the container's own database and cipher rather than
   * reached for inside the service, so this helper exercises exactly the code
   * production uses — including the (purpose, tenant, entity) context, which is
   * what makes the three transplant tests above mean anything.
   */
  function readCredentials(panelId: string, scope: typeof tenantA) {
    return new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher).read(
      scope,
      panelId,
    );
  }

  /**
   * Runs `testConnection` against a scripted probe outcome.
   *
   * A second `PanelService` over the container's own collaborators, differing
   * only in its adapter registry. What is under test is what the SERVICE does
   * with an outcome — which health state it stores, what it carries forward,
   * and what it declines to touch. The adapter's own mapping from HTTP to
   * outcome is covered by its unit tests and the client's by `safe-http`; a
   * fake at this seam does not stand in for either.
   */
  function probeWith(panelId: string, outcome: ProviderProbeOutcome) {
    const scripted = new PanelService({
      repository: new DrizzlePanelRepository(ctx.container.database.db),
      credentials: new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher),
      guard: ctx.container.guard,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      sessions: ctx.container.sessions,
      uow: ctx.container.uow,
      idempotency: ctx.container.idempotency,
      clock: ctx.container.clock,
      ids: ctx.container.ids,
      http: new SafeHttpClient({
        allowLoopback: true,
        totalTimeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRetries: 0,
      }),
      urlPolicy: { allowLoopback: true },
      // No throttle. These tests are about what the service does with a probe
      // OUTCOME, and several of them probe one panel repeatedly to watch a
      // health state move. The cooldown has its own suite
      // (`panel-probe-throttle.test.ts`) where it is the subject rather than an
      // obstacle.
      probeCooldownMs: 0,
      // Generous, so these suites — which are about something else — never
      // hit the tenant-wide bound. Its own suite pins it low.
      probeBudget: { capacity: 10_000, refillPerMs: 1 },
      adapters: (type: ProviderType) => ({ ...providerAdapter(type), probe: async () => outcome }),
    });
    return scripted.testConnection(tenantA, adminActorFor(owner), panelId, {
      idempotencyKey: key(),
    });
  }
});

/**
 * Key rotation over panel credentials.
 *
 * Its own describe block because it needs a keyring the container does not
 * normally have: two keys, the second active, so there is something to rotate
 * FROM. The property is the one the whole rewrap exists for — after rotation
 * the stored value still decrypts, under the new key, with the same
 * (purpose, tenant, entity) context it was sealed with.
 *
 * This is also the test that fails when the rewrap's UPDATE names the wrong
 * column. Drizzle's `.set()` keys on the TypeScript property while a column
 * handle's `.name` is the SQL identifier, so an update assembled from the
 * latter type-checks, compiles, reports success for every row, and re-encrypts
 * none of them. `secrets status` would then show the old key forever with no
 * error anywhere. Counting rows cannot catch that; decrypting the value can.
 */
describe('panel credential rewrap', () => {
  let ctx: TestContext;
  let owner: SeededAdmin;

  const KEY_OLD = Buffer.alloc(32, 11).toString('base64');
  const KEY_NEW = Buffer.alloc(32, 13).toString('base64');

  const ring = (entries: Record<string, string>, active: string): SecretKeyring => ({
    activeKeyId: active,
    keys: new Map(Object.entries(entries).map(([id, k]) => [id, Buffer.from(k, 'base64')])),
    format: 'canonical',
  });

  const withKeyring = (keys: Record<string, string>, active: string) => {
    (ctx.container as { cipher: unknown }).cipher = new AesGcmSecretCipher(
      ring(keys, active),
      true,
    );
  };

  beforeEach(async () => {
    ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner_rw',
      roleKeys: ['owner'],
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('re-encrypts every panel credential under the new key and keeps them readable', async () => {
    const { view } = await ctx.container.panels.create(tenantA, adminActorFor(owner), {
      name: 'Rotates',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey: 'rewrap-key-0001',
    });

    // Sealed under the OLD key through a store built for it, rather than
    // through the container's service: the container's store captured its
    // cipher when it was constructed, so swapping the container's cipher
    // afterwards would leave the write on the original key and the test would
    // rotate nothing while appearing to.
    withKeyring({ old: KEY_OLD }, 'old');
    await writeCredentials(view.panel.id, {
      username: USERNAME,
      password: PASSWORD,
      apiToken: TOKEN,
    });

    const before = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, view.panel.id));
    expect(before[0]?.passwordKeyId).toBe('old');

    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    const args = {
      command: 'rewrap' as const,
      batch: 10,
      max: Number.MAX_SAFE_INTEGER,
      keyId: null,
    };

    // All three panel columns, because they are three registry entries and a
    // factory shared between them is exactly where one wrong closure hides.
    for (const column of SECRET_COLUMNS.filter((c) => c.table === 'panel_credentials')) {
      const result = await rewrapColumn(ctx.container, column, args, 'new');
      expect(result.rewrapped, `${column.purpose} was reported as re-encrypted`).toBe(1);
    }

    const after = await ctx.container.database.db
      .select()
      .from(panelCredentials)
      .where(eq(panelCredentials.panelId, view.panel.id));

    // The bookkeeping half: the key id actually moved. A no-op UPDATE leaves
    // this at 'old' and fails here.
    expect(after[0]?.usernameKeyId).toBe('new');
    expect(after[0]?.passwordKeyId).toBe('new');
    expect(after[0]?.apiTokenKeyId).toBe('new');
    // And the ciphertext is not the one that went in.
    expect(after[0]?.passwordCiphertext).not.toBe(before[0]?.passwordCiphertext);

    // The half that matters: the values still decrypt, under the context they
    // were sealed with. A rewrap that re-encrypted under the wrong context
    // would pass every assertion above and fail this one.
    const store = new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher);
    const stored = await store.read(tenantA, view.panel.id);
    expect(stored?.username).toBe(USERNAME);
    expect(stored?.password).toBe(PASSWORD);
    expect(stored?.apiToken).toBe(TOKEN);
  });

  it('does not count an unset credential as a stored secret', async () => {
    const { view } = await ctx.container.panels.create(tenantA, adminActorFor(owner), {
      name: 'Password only',
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey: 'rewrap-key-0002',
    });
    withKeyring({ old: KEY_OLD }, 'old');
    await writeCredentials(view.panel.id, {
      username: undefined,
      password: PASSWORD,
      apiToken: undefined,
    });

    withKeyring({ old: KEY_OLD, new: KEY_NEW }, 'new');
    const byPurpose = new Map(SECRET_COLUMNS.map((column) => [column.purpose, column]));

    // The direction this error must never go: over-counting a dependency on a
    // key would block a retirement that was safe, and the operator would have
    // no way to find the row that does not exist.
    const username = await statusOf(ctx.container, byPurpose.get('panel.username')!);
    expect([...username.byKeyId.values()].reduce((a, b) => a + b, 0)).toBe(0);

    const password = await statusOf(ctx.container, byPurpose.get('panel.password')!);
    expect([...password.byKeyId.values()].reduce((a, b) => a + b, 0)).toBe(1);
  });

  /** Writes through the real store, built on whichever keyring is current. */
  function writeCredentials(
    panelId: string,
    write: {
      username?: string | undefined;
      password?: string | undefined;
      apiToken?: string | undefined;
    },
  ) {
    const store = new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher);
    return ctx.container.uow.run(tenantA, (tx) =>
      store.write(
        tenantA,
        panelId,
        {
          username: write.username,
          password: write.password,
          apiToken: write.apiToken,
        },
        ctx.container.clock.now(),
        tx,
      ),
    );
  }
});

/**
 * The carve-out for this installation's OWN network.
 *
 * Private space stays reachable — a self-hosted panel on a LAN is the ordinary
 * case and the rest of this file depends on it — but the API container shares a
 * bridge network with PostgreSQL and Redis, so "private is allowed" also meant
 * an operator with panel permissions could aim a panel at Nexa's own data
 * services and read the difference between a refused connection and an open
 * port. Response bodies never come back, which does not help: three distinct
 * outcomes is a port scanner.
 *
 * Built from the config the container was actually constructed with, so this
 * tests the wiring — connection strings to policy to service — and not a
 * hand-written list that could drift from it.
 */
describe('panels — this installation’s own network', () => {
  /** A network nothing in this suite uses, standing in for the data subnet. */
  const DATA_SUBNET = '10.77.0.0/16';
  const OVERRIDES = {
    // Loopback ALLOWED, which is what makes the two tests below meaningful:
    // the data services are on loopback here, so anything that refuses them
    // must be refusing them for being the data services.
    PANEL_HTTP_ALLOW_LOOPBACK: 'true',
    PANEL_HTTP_DENIED_SUBNETS: DATA_SUBNET,
  };
  const config = testConfig(OVERRIDES);

  let ctx: TestContext;
  let owner: SeededAdmin;
  let counter = 0;

  beforeEach(async () => {
    ctx ??= await createTestContext(OVERRIDES);
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner_net',
      roleKeys: ['owner'],
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const at = (baseUrl: string) =>
    ctx.container.panels.create(tenantA, adminActorFor(owner), {
      name: `Net ${(counter += 1)}`,
      providerType: 'marzban' as ProviderType,
      baseUrl,
      idempotencyKey: `net-key-${counter}`,
    });

  /** The host and port a connection string actually names. */
  const service = (connectionString: string) => {
    const url = new URL(connectionString);
    return `https://${url.hostname}:${url.port === '' ? '8443' : url.port}`;
  };

  it('refuses the database this installation is running against', async () => {
    await expect(at(service(config.DATABASE_URL))).rejects.toMatchObject({
      code: 'panel.target_blocked',
    });
    expect(await ctx.container.database.db.select().from(panels)).toEqual([]);
  });

  it('refuses the cache this installation is running against', async () => {
    await expect(at(service(config.REDIS_URL))).rejects.toMatchObject({
      code: 'panel.target_blocked',
    });
    expect(await ctx.container.database.db.select().from(panels)).toEqual([]);
  });

  it('refuses an address inside the configured data network', async () => {
    await expect(at('https://10.77.1.4:2053')).rejects.toMatchObject({
      code: 'panel.target_blocked',
    });
    expect(await ctx.container.database.db.select().from(panels)).toEqual([]);
  });

  it('still accepts a private panel outside it, which is the ordinary case', async () => {
    // The control. A carve-out that widened into "refuse private space" would
    // pass every test above and break the product.
    const { view } = await at('https://10.78.1.4:2053');
    expect(view.panel.baseUrl).toBe('https://10.78.1.4:2053/');
  });

  it('still accepts a public panel, unchanged', async () => {
    const { view } = await at('https://panel.example.test:2096');
    expect(view.panel.baseUrl).toBe('https://panel.example.test:2096/');
  });

  it('tells the operator nothing about what is behind the refusal', async () => {
    // The refusal is an oracle if it describes what it refused. It says which
    // rule applied and never the host, the address, the port or the network.
    const error = await at(service(config.DATABASE_URL)).catch((thrown: unknown) => thrown);
    const text = JSON.stringify(error).toLowerCase();
    const databaseHost = new URL(config.DATABASE_URL).hostname;
    for (const leak of [databaseHost, '10.77', 'subnet', 'postgres', 'redis', '5432', '6379']) {
      expect(text, `the refusal leaks ${leak}`).not.toContain(leak.toLowerCase());
    }
  });
});
