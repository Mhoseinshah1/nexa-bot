import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_TAGS_PER_TENANT_MAX,
  PLATFORM_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Customer notes and tags (program §8, `docs/customer-notes-tags.md`), end to end against a
 * real PostgreSQL with the migrations' indexes and triggers.
 *
 * Every rule §8 names has a case: tenant isolation, permissions, archived-tag behaviour, the
 * duplicate-name policy, assignment idempotency, notes privacy (append-only, never in an
 * audit row or an event), and the list filter. The archive/assign race is proved with a real
 * lock wait, not a mock.
 */

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
}

describe('customer notes and tags', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let operator: ActorContext;
  let support: ActorContext;
  let observer: ActorContext;
  let ownerB: ActorContext;
  let alice: UserId;
  let bob: UserId;
  let carol: UserId;
  let keySeq = 0;
  const key = (label: string) => `${label}-key-${String((keySeq += 1))}`;
  const crm = () => ctx.container.customerCrm;
  const query = async <T = Record<string, unknown>>(text: string, values: unknown[] = []) =>
    ctx.container.database.withClient(
      async (client) => (await client.query(text, values)).rows as T[],
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-crm', roleKeys: ['owner'] }),
    );
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-crm', roleKeys: ['operator'] }),
    );
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'sup-crm', roleKeys: ['support'] }),
    );
    observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-crm', roleKeys: ['observer'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-crm-b', roleKeys: ['owner'] }),
    );
    alice = await resolve(tenantA, SEED_IDS.botA1, '961001', 'Alice');
    bob = await resolve(tenantA, SEED_IDS.botA1, '961002', 'Bob');
    carol = await resolve(tenantB, SEED_IDS.botB1, '961003', 'Carol');
  });

  async function resolve(
    scope: TenantContext,
    bot: string,
    telegramUserId: string,
    firstName: string,
  ): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`r-${telegramUserId}`),
      {
        idempotencyKey: `resolve-crm-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: bot as BotInstanceId,
      },
    );
    return resolved.customer.id;
  }

  const createTag = (label: string, actor = operator, scope: TenantContext = tenantA) =>
    crm().createTag(scope, actor, { idempotencyKey: key('tag'), label, color: null });

  const assign = (customerId: UserId, tagId: string, actor = operator) =>
    crm().assignTag(tenantA, actor, { idempotencyKey: key('assign'), customerId, tagId });

  const listIds = async (
    search: { tagId?: string; status?: 'ACTIVE' | 'BLOCKED' },
    scope = tenantA,
    actor = owner,
  ) => (await ctx.container.customers.list(scope, actor, { search })).items.map((row) => row.id);

  // --- The duplicate-name policy --------------------------------------------------------

  describe('duplicate names', () => {
    it('stores the normalised label and refuses the same name in another case or spacing', async () => {
      const { tag } = await createTag('  Very   Important\tCustomer ');
      expect(tag.label).toBe('Very Important Customer');
      for (const clash of [
        'very important customer',
        'VERY IMPORTANT  CUSTOMER',
        ' Very Important Customer',
      ]) {
        expect(await codeOf(createTag(clash))).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_NAME_TAKEN);
      }
      expect(await query(`SELECT count(*)::int AS n FROM customer_tags`)).toEqual([{ n: 1 }]);
    });

    it('refuses a rename onto another active tag, and allows a rename that changes only case', async () => {
      const { tag: vip } = await createTag('VIP');
      const { tag: risk } = await createTag('Risk');
      expect(
        await codeOf(
          crm().updateTag(tenantA, operator, {
            idempotencyKey: key('rename'),
            tagId: risk.id,
            label: 'vip',
            color: null,
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_NAME_TAKEN);
      const recased = await crm().updateTag(tenantA, operator, {
        idempotencyKey: key('rename'),
        tagId: vip.id,
        label: 'Vip',
        color: 'violet',
      });
      expect(recased.changed).toBe(true);
      expect(recased.tag).toMatchObject({ id: vip.id, label: 'Vip', color: 'violet' });
    });

    it('frees an archived name for reuse, and refuses to restore the archived tag over it', async () => {
      const { tag: old } = await createTag('Wholesale');
      await crm().setTagArchived(tenantA, operator, {
        idempotencyKey: key('archive'),
        tagId: old.id,
        archived: true,
      });
      const { tag: fresh } = await createTag('wholesale');
      expect(fresh.id).not.toBe(old.id);
      expect(
        await codeOf(
          crm().setTagArchived(tenantA, operator, {
            idempotencyKey: key('restore'),
            tagId: old.id,
            archived: false,
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_NAME_TAKEN);
    });

    it('lets exactly one of two concurrent creates of one name win', async () => {
      const outcomes = await Promise.all(
        ['Gold', 'gold', ' GOLD '].map((label) => codeOf(createTag(label))),
      );
      expect(outcomes.filter((code) => code === null)).toHaveLength(1);
      expect(
        outcomes.filter((code) => code === COMMERCE_ERROR_CODES.CUSTOMER_TAG_NAME_TAKEN),
      ).toHaveLength(2);
      expect(await query(`SELECT count(*)::int AS n FROM customer_tags`)).toEqual([{ n: 1 }]);
    });

    it('holds the rule in the database for a writer that skipped the service', async () => {
      await createTag('Partner');
      const error = await query(
        `INSERT INTO customer_tags (id, tenant_id, label) VALUES ($1, $2, 'PARTNER')`,
        [ctx.container.ids.uuid(), SEED_IDS.tenantA],
      ).then(
        () => null,
        (caught: { constraint?: string }) => caught.constraint ?? 'other',
      );
      expect(error).toBe('customer_tags_active_label_key');
      const unnormalised = await query(
        `INSERT INTO customer_tags (id, tenant_id, label) VALUES ($1, $2, ' padded ')`,
        [ctx.container.ids.uuid(), SEED_IDS.tenantA],
      ).then(
        () => null,
        (caught: { constraint?: string }) => caught.constraint ?? 'other',
      );
      expect(unnormalised).toBe('customer_tags_label_check');
    });

    it('refuses an empty name, an over-long name, and a colour outside the design tones', async () => {
      expect(await codeOf(createTag('   '))).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      expect(await codeOf(createTag('x'.repeat(41)))).toBe(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      );
      const badColour = await query(
        `INSERT INTO customer_tags (id, tenant_id, label, color) VALUES ($1, $2, 'Hex', '#ff0000')`,
        [ctx.container.ids.uuid(), SEED_IDS.tenantA],
      ).then(
        () => null,
        (caught: { constraint?: string }) => caught.constraint ?? 'other',
      );
      expect(badColour).toBe('customer_tags_color_check');
    });

    it(`refuses a tag beyond ${String(CUSTOMER_TAGS_PER_TENANT_MAX)} per tenant`, async () => {
      await query(
        `INSERT INTO customer_tags (id, tenant_id, label)
         SELECT gen_random_uuid(), $1, 'bulk ' || g FROM generate_series(1, $2::int) AS g`,
        [SEED_IDS.tenantA, CUSTOMER_TAGS_PER_TENANT_MAX],
      );
      expect(await codeOf(createTag('One too many'))).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_LIMIT);
      // The cap is per tenant.
      expect(await codeOf(createTag('Fine elsewhere', ownerB, tenantB))).toBeNull();
    });
  });

  // --- Assignment -----------------------------------------------------------------------

  describe('assignment', () => {
    it('is idempotent: a second assignment changes nothing, a replayed key answers once', async () => {
      const { tag } = await createTag('VIP');
      const first = await assign(alice, tag.id);
      expect(first.changed).toBe(true);
      expect(first.tags.map((one) => one.id)).toEqual([tag.id]);
      const again = await assign(alice, tag.id);
      expect(again.changed).toBe(false);

      const replayKey = key('replay');
      const input = { idempotencyKey: replayKey, customerId: alice, tagId: tag.id };
      const removed = await crm().removeTag(tenantA, operator, input);
      const replayed = await crm().removeTag(tenantA, operator, input);
      expect(removed.changed).toBe(true);
      expect(replayed.changed).toBe(true);
      expect(replayed.tags).toEqual([]);

      // One audit row and one event per change that happened — not per request.
      const audits = await query<{ action: string; changed: boolean }>(
        `SELECT action, (after->>'changed')::boolean AS changed FROM audit_logs
          WHERE entity_type = 'Customer' AND entity_id = $1 AND action LIKE 'customer.tag.%'
          ORDER BY occurred_at, id`,
        [alice],
      );
      expect(audits).toEqual([
        { action: 'customer.tag.assign', changed: true },
        { action: 'customer.tag.assign', changed: false },
        { action: 'customer.tag.remove', changed: true },
      ]);
      const events = await query<{ event_type: string }>(
        `SELECT event_type FROM outbox_messages WHERE aggregate_id = $1
          AND event_type IN ('CustomerTagAssigned', 'CustomerTagRemoved') ORDER BY created_at`,
        [alice],
      );
      expect(events.map((row) => row.event_type)).toEqual([
        'CustomerTagAssigned',
        'CustomerTagRemoved',
      ]);
    });

    it('refuses a key reused for a different tag', async () => {
      const { tag: one } = await createTag('One');
      const { tag: two } = await createTag('Two');
      const reused = key('reused');
      await crm().assignTag(tenantA, operator, {
        idempotencyKey: reused,
        customerId: alice,
        tagId: one.id,
      });
      expect(
        await codeOf(
          crm().assignTag(tenantA, operator, {
            idempotencyKey: reused,
            customerId: alice,
            tagId: two.id,
          }),
        ),
      ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
    });

    it('lets two concurrent assignments of one pair produce one row', async () => {
      const { tag } = await createTag('Race');
      const results = await Promise.all([
        assign(alice, tag.id),
        assign(alice, tag.id),
        assign(alice, tag.id),
      ]);
      expect(results.filter((one) => one.changed)).toHaveLength(1);
      expect(
        await query(
          `SELECT count(*)::int AS n FROM customer_tag_assignments WHERE customer_id = $1`,
          [alice],
        ),
      ).toEqual([{ n: 1 }]);
    });

    it('keeps a renamed tag on the customer under its id', async () => {
      const { tag } = await createTag('Old name');
      await assign(alice, tag.id);
      await crm().updateTag(tenantA, operator, {
        idempotencyKey: key('rename'),
        tagId: tag.id,
        label: 'New name',
        color: 'teal',
      });
      const tags = await crm().tagsOf(tenantA, support, alice);
      expect(tags.map((one) => [one.id, one.label, one.color])).toEqual([
        [tag.id, 'New name', 'teal'],
      ]);
    });
  });

  // --- Archived tags --------------------------------------------------------------------

  describe('archived tags', () => {
    it('stay on the customers that carry them, cannot be newly assigned, can be removed and restored', async () => {
      const { tag } = await createTag('Legacy');
      await assign(alice, tag.id);
      const archived = await crm().setTagArchived(tenantA, operator, {
        idempotencyKey: key('archive'),
        tagId: tag.id,
        archived: true,
      });
      expect(archived.tag.archivedAt).not.toBeNull();

      const onAlice = await crm().tagsOf(tenantA, operator, alice);
      expect(onAlice.map((one) => [one.id, one.archivedAt !== null])).toEqual([[tag.id, true]]);
      // Still filterable: history keeps naming it.
      expect(await listIds({ tagId: tag.id })).toEqual([alice]);

      expect(await codeOf(assign(bob, tag.id))).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_ARCHIVED);
      // Even for a pair that already exists: the refusal is about the tag, not the row.
      expect(await codeOf(assign(alice, tag.id))).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_ARCHIVED);

      const removed = await crm().removeTag(tenantA, operator, {
        idempotencyKey: key('remove'),
        customerId: alice,
        tagId: tag.id,
      });
      expect(removed.changed).toBe(true);

      await crm().setTagArchived(tenantA, operator, {
        idempotencyKey: key('restore'),
        tagId: tag.id,
        archived: false,
      });
      expect((await assign(bob, tag.id)).changed).toBe(true);
    });

    it('lists active tags before archived ones', async () => {
      const { tag: a } = await createTag('Alpha');
      await createTag('Beta');
      await crm().setTagArchived(tenantA, operator, {
        idempotencyKey: key('arch'),
        tagId: a.id,
        archived: true,
      });
      const labels = (await crm().listTags(tenantA, support)).map((one) => one.label);
      expect(labels).toEqual(['Beta', 'Alpha']);
    });

    it('decides an assignment racing an archive AFTER the archive commits (FOR SHARE)', async () => {
      const { tag } = await createTag('Racing');
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // An archive in flight: the row is updated and the transaction is still open.
      const archiver = ctx.container.database.withClient(async (client) => {
        await client.query('BEGIN');
        await client.query(`UPDATE customer_tags SET archived_at = now() WHERE id = $1`, [tag.id]);
        locked();
        await held;
        await client.query('COMMIT');
      });
      await isLocked;
      const assignment = codeOf(assign(alice, tag.id));
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await query<{ query: string }>(
          `SELECT query FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        );
        if (waiting.some((row) => row.query.toLowerCase().includes('customer_tags'))) break;
        if (Date.now() > deadline) throw new Error('the assignment never waited for the archive');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();
      await archiver;
      expect(await assignment).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_ARCHIVED);
      expect(await query(`SELECT count(*)::int AS n FROM customer_tag_assignments`)).toEqual([
        { n: 0 },
      ]);
    }, 30_000);
  });

  // --- Permissions ----------------------------------------------------------------------

  describe('permissions', () => {
    it('reads tags under users.view, and charges every write its own key, auditing the denial', async () => {
      const { tag } = await createTag('VIP');
      // support holds users.view and nothing of §8.
      expect((await crm().listTags(tenantA, support)).map((one) => one.id)).toEqual([tag.id]);
      expect(await crm().tagsOf(tenantA, support, alice)).toEqual([]);
      // Thunks, run one at a time: the denials are asserted in order below.
      for (const attempt of [
        () => createTag('Support tag', support),
        () => assign(alice, tag.id, support),
        () => crm().notesOf(tenantA, support, { customerId: alice }),
        () =>
          crm().addNote(tenantA, support, {
            idempotencyKey: key('note'),
            customerId: alice,
            body: 'hi',
          }),
      ]) {
        expect(await codeOf(attempt())).toBe('platform.permission_denied');
      }
      const denied = await query<{ action: string }>(
        `SELECT action FROM audit_logs WHERE result = 'DENIED' AND actor_id = $1 ORDER BY occurred_at`,
        [support.id],
      );
      expect(denied.map((row) => row.action)).toEqual([
        'customer_tag.create',
        'customer.tag.assign',
        'customer.note.add',
      ]);
    });

    it('withholds notes from the observer role, whose every key is LOW', async () => {
      expect(await codeOf(crm().notesOf(tenantA, observer, { customerId: alice }))).toBe(
        'platform.permission_denied',
      );
    });

    it('lets the operator do all of it', async () => {
      const { tag } = await createTag('Op');
      expect((await assign(alice, tag.id, operator)).changed).toBe(true);
      const { note } = await crm().addNote(tenantA, operator, {
        idempotencyKey: key('note'),
        customerId: alice,
        body: 'called about renewal',
      });
      expect(note.authorLabel).toBe('op-crm');
    });
  });

  // --- Tenant isolation -----------------------------------------------------------------

  describe('tenant isolation', () => {
    it('never shows, assigns, filters by or renames another tenant’s tag, nor reads its notes', async () => {
      const { tag: tagA } = await createTag('Shared name');
      // The same name in B is no clash: uniqueness is per tenant.
      const { tag: tagB } = await createTag('Shared name', ownerB, tenantB);
      await assign(alice, tagA.id);

      expect((await crm().listTags(tenantB, ownerB)).map((one) => one.id)).toEqual([tagB.id]);
      expect(
        await codeOf(
          crm().assignTag(tenantB, ownerB, {
            idempotencyKey: key('x'),
            customerId: carol,
            tagId: tagA.id,
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_NOT_FOUND);
      expect(
        await codeOf(
          crm().updateTag(tenantB, ownerB, {
            idempotencyKey: key('x'),
            tagId: tagA.id,
            label: 'Mine',
            color: null,
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TAG_NOT_FOUND);
      // A's customer through B, and B's customer through A: unknown either way.
      expect(
        await codeOf(
          crm().assignTag(tenantA, operator, {
            idempotencyKey: key('x'),
            customerId: carol,
            tagId: tagA.id,
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND);
      await crm().addNote(tenantA, operator, {
        idempotencyKey: key('n'),
        customerId: alice,
        body: 'private',
      });
      expect(await codeOf(crm().notesOf(tenantB, ownerB, { customerId: alice }))).toBe(
        COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND,
      );
      // B filtering its list by A's tag id finds nothing.
      expect(await listIds({ tagId: tagA.id }, tenantB, ownerB)).toEqual([]);
    });

    it('refuses an assignment row pairing two tenants in the database', async () => {
      const { tag: tagA } = await createTag('A only');
      const error = await query(
        `INSERT INTO customer_tag_assignments (tenant_id, customer_id, tag_id) VALUES ($1, $2, $3)`,
        [SEED_IDS.tenantB, carol, tagA.id],
      ).then(
        () => null,
        (caught: { constraint?: string }) => caught.constraint ?? 'other',
      );
      expect(error).toBe('customer_tag_assignments_tag_fk');
    });
  });

  // --- The list filter ------------------------------------------------------------------

  describe('the customer list filter', () => {
    it('narrows by tag, alone and with the status filter, under users.view alone', async () => {
      const { tag } = await createTag('Filter me');
      await assign(alice, tag.id);
      await assign(bob, tag.id);
      await ctx.container.customers.block(tenantA, owner, {
        idempotencyKey: key('block'),
        customerId: bob,
        reason: 'fixture',
      });
      expect(new Set(await listIds({ tagId: tag.id }, tenantA, support))).toEqual(
        new Set([alice, bob]),
      );
      expect(await listIds({ tagId: tag.id, status: 'BLOCKED' }, tenantA, support)).toEqual([bob]);
      const { tag: empty } = await createTag('Nobody');
      expect(await listIds({ tagId: empty.id })).toEqual([]);
    });
  });

  // --- Notes ----------------------------------------------------------------------------

  describe('notes', () => {
    it('appends with author and time, pages newest first, and is idempotent', async () => {
      const bodies = ['first', 'second', 'third'];
      for (const body of bodies) {
        await crm().addNote(tenantA, operator, {
          idempotencyKey: key('note'),
          customerId: alice,
          body,
        });
      }
      const page1 = await crm().notesOf(tenantA, owner, { customerId: alice, limit: 2 });
      expect(page1.items.map((one) => one.body)).toEqual(['third', 'second']);
      expect(page1.items[0]).toMatchObject({ authorLabel: 'op-crm', authorAdminId: operator.id });
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await crm().notesOf(tenantA, owner, {
        customerId: alice,
        limit: 2,
        ...(page1.nextCursor === null ? {} : { cursor: page1.nextCursor }),
      });
      expect(page2.items.map((one) => one.body)).toEqual(['first']);
      expect(page2.nextCursor).toBeNull();

      const input = { idempotencyKey: key('once'), customerId: alice, body: 'only once' };
      const created = await crm().addNote(tenantA, operator, input);
      const replay = await crm().addNote(tenantA, operator, input);
      expect([created.created, replay.created]).toEqual([true, false]);
      expect(replay.note.id).toBe(created.note.id);
      expect(
        await query(`SELECT count(*)::int AS n FROM customer_notes WHERE body = 'only once'`),
      ).toEqual([{ n: 1 }]);
    });

    it('trims, refuses an empty note, and keeps line breaks', async () => {
      expect(
        await codeOf(
          crm().addNote(tenantA, operator, {
            idempotencyKey: key('e'),
            customerId: alice,
            body: '  \n ',
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      const { note } = await crm().addNote(tenantA, operator, {
        idempotencyKey: key('lines'),
        customerId: alice,
        body: '  line one\nline two  ',
      });
      expect(note.body).toBe('line one\nline two');
    });

    it('is append-only in the database', async () => {
      const { note } = await crm().addNote(tenantA, operator, {
        idempotencyKey: key('ao'),
        customerId: alice,
        body: 'cannot change',
      });
      for (const statement of [
        `UPDATE customer_notes SET body = 'rewritten' WHERE id = $1`,
        `DELETE FROM customer_notes WHERE id = $1`,
      ]) {
        const refused = await query(statement, [note.id]).then(
          () => false,
          () => true,
        );
        expect(refused, statement).toBe(true);
      }
      expect(await query(`SELECT body FROM customer_notes WHERE id = $1`, [note.id])).toEqual([
        { body: 'cannot change' },
      ]);
    });

    it('never writes the body into the audit log or the outbox', async () => {
      const secret = 'customer disputed charge with bank, see ticket';
      const { note } = await crm().addNote(tenantA, operator, {
        idempotencyKey: key('private'),
        customerId: alice,
        body: secret,
      });
      const audit = await query<{ after: unknown }>(
        `SELECT after FROM audit_logs WHERE action = 'customer.note.add' AND entity_id = $1`,
        [alice],
      );
      expect(audit).toEqual([{ after: { noteId: note.id, length: secret.length } }]);
      const leaks = await query(
        `SELECT 1 FROM audit_logs WHERE after::text LIKE $1 OR before::text LIKE $1
         UNION ALL SELECT 1 FROM outbox_messages WHERE payload::text LIKE $1`,
        ['%disputed%'],
      );
      expect(leaks).toEqual([]);
      const events = await query<{ payload: unknown }>(
        `SELECT payload FROM outbox_messages WHERE event_type = 'CustomerNoteAdded'`,
      );
      expect(events).toEqual([{ payload: { noteId: note.id } }]);
    });
  });

  // --- The role backfill ----------------------------------------------------------------

  describe('the role backfill migration', () => {
    const NEW_KEYS = [
      'users.notes.view',
      'users.notes.write',
      'users.tags.assign',
      'users.tags.manage',
    ];
    const KEY_LIST = NEW_KEYS.map((one) => `'${one}'`).join(', ');

    /**
     * READ FROM THE MIGRATION, never retyped (the 0031 backfill test says why). Found by its
     * name rather than its number, because migrations are renumbered when branches merge.
     */
    const backfill = () => {
      const file = readdirSync('apps/api/drizzle').find((name) =>
        name.endsWith('_customer_notes_tags_guards.sql'),
      );
      expect(file).toBeDefined();
      const text = readFileSync(`apps/api/drizzle/${file ?? ''}`, 'utf8');
      const start = text.indexOf('INSERT INTO "role_permissions"');
      expect(start).toBeGreaterThan(-1);
      return text.slice(start);
    };

    it('grants the four keys to owner and operator, in every tenant, and to nobody else', async () => {
      for (const scope of [tenantA, tenantB]) await ctx.container.roles.ensureSystemRoles(scope);
      await query(`DELETE FROM role_permissions WHERE permission_key IN (${KEY_LIST})`);
      await query(backfill());
      await query(backfill()); // idempotent
      const grants = await query<{ tenant_id: string; grant: string }>(
        `SELECT r.tenant_id, r.key || ':' || rp.permission_key AS grant
           FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          WHERE rp.permission_key IN (${KEY_LIST})
          ORDER BY 1, 2`,
      );
      const expected = [
        'operator:users.notes.view',
        'operator:users.notes.write',
        'operator:users.tags.assign',
        'operator:users.tags.manage',
        'owner:users.notes.view',
        'owner:users.notes.write',
        'owner:users.tags.assign',
        'owner:users.tags.manage',
      ];
      for (const tenantId of [SEED_IDS.tenantA, SEED_IDS.tenantB]) {
        expect(grants.filter((row) => row.tenant_id === tenantId).map((row) => row.grant)).toEqual(
          expected,
        );
      }
    });
  });

  it('is reachable from no SYSTEM_JOB actor', async () => {
    expect(await codeOf(crm().listTags(tenantA, systemActor('job')))).toBe(
      'platform.permission_denied',
    );
  });
});
