import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProductCategoryId } from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_MENU_BUTTON,
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The Telegram management panel's services section — Phase 6A-4 and 6A-5.
 *
 * Against real everything, for the reason `service-management.test.ts` gives: a real
 * PostgreSQL, the real provisioner, the real Marzban adapter, a deterministic Marzban
 * on a real socket, a real socket standing in for Telegram, and the real bot runtime.
 *
 * The section is the operator's half of what that file tests from the customer's side,
 * and the two differ in exactly the places that matter:
 *
 *   1. **Authority is a permission, not ownership.** A customer reaches their own
 *      service; an administrator reaches anybody's, if their role says so. So every
 *      case here asks about a DIFFERENT administrator, and `services.view`,
 *      `services.edit` and `services.terminate` are three separate answers.
 *   2. **The buttons are not the authorization.** A verdict and a permission decide
 *      which controls are DRAWN. Each case that asserts a control is absent is paired
 *      with one that sends the callback anyway.
 *   3. **What may never appear in a chat.** An admin message lives in somebody's
 *      Telegram for ever, so the detail carries no subscription URL, no subscription
 *      ref, no provider client id and no panel credential.
 *
 * 6A-5 lives at the bottom: what a failed provider operation does to the service, and
 * who is told about an action an operator took.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
/** Every callback prefix the section owns, spelled out rather than imported. */
const PREFIX = {
  services: 'H:',
  /** WP3: the browsable list, a screen INSIDE the services section rather than beside it. */
  browse: 'H:b',
  browsePage: 'H:b:',
  service: 'I:',
  sync: 'J:',
  resend: 'K:',
  retry: 'L:',
  reconcile: 'M:',
  suspend: 'N:',
  resume: 'O:',
  terminateAsk: 'P:',
  /** The one destructive callback in the admin panel. */
  terminate: 'Q:',
} as const;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('the services section of the Telegram management panel', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let sanaeiPanelId: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerAId: AdminId;
  let updateSeq = 0;

  /* The four Telegram accounts every case draws from. */
  const TG = {
    /** `owner`: every permission, including `services.terminate`. */
    owner: '700001',
    /** `support`: `services.view` and `services.edit`, and NOT terminate. */
    support: '700002',
    /** A custom role holding `services.view` alone. */
    viewer: '700003',
    /*
     * An administrator with NO section of the management panel.
     *
     * It was `sales` until WP2, and the field name is kept because the cases reading it
     * are about an administrator the panel does not open for. `sales` holds
     * `users.view`, so the customers section gives it a panel now; the cases below
     * build a role holding `catalog.view` alone instead, which opens nothing here.
     */
    sales: '700004',
    /** An ordinary customer. No administrator row anywhere. */
    customer: '910910',
  } as const;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        reply(request, response);
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');

    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    sent = [];
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    };

    /* 127.0.0.2: the container's URL policy denies whatever DATABASE_URL names. */
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    const seededOwner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tg-services',
      roleKeys: ['owner'],
    });
    ownerAId = seededOwner.id as AdminId;
    owner = adminActorFor(seededOwner);
    await bind(ownerAId, TG.owner);

    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-tg-admin-create',
    });
    panelId = created.view.panel.id;

    /*
     * A fully configured 3X-UI panel, for the capability case. Unconfigured it would
     * refuse everything with `CREDENTIALS_MISSING`, which is a different blocker — and
     * a capability case that passed for that reason would prove nothing.
     */
    const sanaei = await ctx.container.panels.create(tenantA, owner, {
      name: 'Sanaei A',
      providerType: 'sanaei',
      baseUrl: 'https://sanaei.example.test',
      credentials: { username: 'x', password: 'y' },
      activation: { subscriptionDomain: 'sub.example.test', inboundId: 3 },
      idempotencyKey: 'panel-tg-admin-sanaei',
    });
    sanaeiPanelId = sanaei.view.panel.id;
    /*
     * And CONNECTION-TESTED, which the create alone is not.
     *
     * `panels.create` writes an ACTIVE row and contacts nothing, so since this
     * hotfix the panel is `UNVALIDATED` and cannot be sold onto — a brand-new
     * row being immediately sellable is one of the holes being closed. These
     * fake panels are real and reachable, so recording a successful connection
     * test is exactly what an operator would do next.
     */
    await validatePanelConnection(ctx.container, tenantA, panelId);
    await validatePanelConnection(ctx.container, tenantA, sanaeiPanelId);

    customerA = await customerWithTelegramId(TG.customer);
  });

  // =========================================================================
  // Who sees the section at all
  // =========================================================================

  it('draws the Services button for an administrator who holds services.view', async () => {
    await bindNewAdmin('viewer-only', TG.viewer, { permissions: ['services.view'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.viewer),
    );

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage(), 'the Services button is drawn').toContain(PREFIX.services);
  });

  it('draws no Services button for an administrator whose role does not hold services.view', async () => {
    /*
     * `receipt_reviewer` HAS a section — receipts — so the panel opens. What it must
     * not carry is a button whose every press would record a denial. This is the
     * negative half of the case above, and without it a gate that always returned
     * true would pass both.
     */
    await bindNewAdmin('reviewer-no-services', TG.support, { roleKeys: ['receipt_reviewer'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.support),
    );

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage(), 'a section they cannot enter was offered').not.toContain(PREFIX.services);
  });

  it('opens the panel for an administrator whose ONLY section is Services', async () => {
    /*
     * The third arm of `isAdmin` and the third arm of `adminTurn`'s gate, which have to
     * agree: the main menu must not promise a panel the turn would refuse, and it must
     * not withhold one from an administrator who has a section. An installation whose
     * only `services.view` holder got no admin row on their keyboard is what a missing
     * arm here produces, and it is invisible until somebody with exactly that role
     * types `/start`.
     */
    await bindNewAdmin('viewer-only-menu', TG.viewer, { permissions: ['services.view'] });

    await runtime().handle(tenantA, systemActor('bot'), adminUpdate('/start', TG.viewer));
    const markup = lastBody()?.['reply_markup'] as { keyboard?: { text: string }[][] } | undefined;
    const labels = (markup?.keyboard ?? []).flat().map((button) => button.text);
    expect(labels, 'the admin row was withheld').toContain(CATALOGUE_FA[ADMIN_MENU_BUTTON.label]);

    /* And the panel the keyboard promised actually opens. */
    const opened = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.viewer),
    );
    expect(opened.replyKey).toBe('bot.admin.panel');
  });

  it('answers an ordinary customer who sends an admin services callback as unknown input', async () => {
    /*
     * The crafted-callback case, end to end through the real runtime.
     *
     * `TG.customer` is a real account of this installation, and their `H:` parses
     * exactly as an administrator's would. `telegramAdmins.resolve` answers null, so
     * the turn never reaches `adminTurn` and the reply is the ordinary fallback — the
     * customer learns nothing about what exists. Asserted for every prefix the section
     * owns, including the destructive one, because a registry entry pointed at the
     * wrong guard would show up on exactly one of them.
     */
    const serviceId = (await activeService('crafted')).id;
    for (const prefix of Object.values(PREFIX)) {
      sent = [];
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(prefix === PREFIX.services ? prefix : `${prefix}${serviceId}`, TG.customer),
      );
      expect(result.replyKey, `${prefix} answered an administrator's reply`).toBe(
        'bot.unknown_command',
      );
    }
    /* And nothing was planned by any of them. */
    expect(await operations.listForService(tenantA, serviceId, 50)).toHaveLength(1);
  });

  it('answers an administrator with no services permission as unknown input, not as a refusal', async () => {
    /*
     * A hand-made role holding `catalog.view` alone — NOT `sales`, which was the
     * fixture until WP2 and stopped being one.
     *
     * The premise this case needs is an administrator with NO section of the panel at
     * all, so `adminTurn` returns null before any service is read and the answer is the
     * one a customer gets. `sales` was that until the customers section shipped: it
     * holds `users.view`, so it now HAS a section, opens the panel, and a callback into
     * a section it lacks reaches the handler and is denied there — which is correct and
     * is a different case from this one.
     *
     * `catalog.view` opens nothing in Telegram, and the case still proves what it says:
     * a distinct refusal here would confirm that the id names something.
     */
    await bindNewAdmin('no-section-tg', TG.sales, { permissions: ['catalog.view'] });
    const serviceId = (await activeService('sales-probe')).id;

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${serviceId}`, TG.sales),
    );
    expect(result.replyKey).toBe('bot.unknown_command');
  });

  // =========================================================================
  // The queue
  // =========================================================================

  it('queues the two states nothing resolves on its own, and nothing else', async () => {
    /*
     * `UNRECONCILED` is a create whose answer was lost — 4D made it a dead end on
     * purpose, so that nobody asks a panel for a second account. A `FAILED` delivery is
     * a customer who paid and has no link, after the automatic lane spent its attempts.
     * Everything else either settles itself or belongs to the customer, and a queue
     * listing those would be a list of things not to do.
     */
    const healthy = await activeService('queue-healthy');
    const stranded = await activeService('queue-stranded');
    const undelivered = await failedDelivery('queue-undelivered');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'UNRECONCILED', provisioned_at = NULL WHERE id = ${stranded.id}`);

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.services, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.services_section');
    const body = lastMessage();
    expect(body, 'the unreconciled service is queued').toContain(`${PREFIX.service}${stranded.id}`);
    expect(body, 'the undelivered service is queued').toContain(
      `${PREFIX.service}${undelivered.id}`,
    );
    expect(body, 'a healthy service needs nobody').not.toContain(`${PREFIX.service}${healthy.id}`);
  });

  it('queues a service that is BOTH unreconciled and undelivered exactly once', async () => {
    /*
     * The de-duplication, and it is not cosmetic: two buttons for one service is a
     * queue that reads as twice the work, and an operator who clears it twice has
     * pressed a stale button once.
     */
    const both = await failedDelivery('queue-both');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'UNRECONCILED', provisioned_at = NULL WHERE id = ${both.id}`);

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(PREFIX.services, TG.owner));

    const occurrences = lastMessage().split(`${PREFIX.service}${both.id}`).length - 1;
    expect(occurrences, 'one service, one row').toBe(1);
  });

  it('says so when nothing needs a person, rather than drawing an empty keyboard', async () => {
    await activeService('queue-empty');
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.services, TG.owner),
    );
    expect(result.replyKey).toBe('bot.admin.services_none');
  });

  it('labels a queued service with the provider username and never with a credential', async () => {
    const stranded = await activeService('queue-label');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'UNRECONCILED', provisioned_at = NULL WHERE id = ${stranded.id}`);

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(PREFIX.services, TG.owner));

    const body = lastMessage();
    expect(body, 'the handle an operator types into the panel').toContain(stranded.username);
    /*
     * The two bearer capabilities the service row carries. Both are derived from
     * nothing and stored precisely so they cannot be guessed (4D-R3), and this message
     * stays in somebody's chat for ever.
     */
    const row = await services.findById(tenantA, stranded.id);
    expect(body).not.toContain(row?.subscriptionRef);
    expect(body).not.toContain(row?.providerClientId);
  });

  // =========================================================================
  // The browsable list beside the queue (WP3)
  // =========================================================================

  it('offers the browse button even when the queue is empty', async () => {
    /*
     * An empty queue is the normal, healthy state, and until WP3 it was also a DEAD
     * END: "nothing needs attention" with no route from there to the service a
     * customer is asking about. The button belongs on both answers for that reason.
     */
    await activeService('browse-from-empty');
    const empty = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.services, TG.owner),
    );
    expect(empty.replyKey).toBe('bot.admin.services_none');
    expect(lastMessage(), 'the empty queue must still lead somewhere').toContain(PREFIX.browse);

    const stranded = await activeService('browse-from-queue');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'UNRECONCILED', provisioned_at = NULL WHERE id = ${stranded.id}`);
    const queued = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.services, TG.owner),
    );
    expect(queued.replyKey).toBe('bot.admin.services_section');
    expect(lastMessage()).toContain(PREFIX.browse);
  });

  it('browses every service, including the ones the queue will never show', async () => {
    /*
     * The whole difference between a queue and an inventory. The queue lists what
     * nothing resolves on its own; a perfectly healthy ACTIVE, DELIVERED service is
     * invisible to it — and is exactly the one a customer writes in about.
     */
    const healthy = await activeService('browse-healthy');

    const queue = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.services, TG.owner),
    );
    expect(queue.replyKey, 'the queue has no work').toBe('bot.admin.services_none');
    expect(lastMessage(), 'and must not list a healthy service').not.toContain(
      `${PREFIX.service}${healthy.id}`,
    );

    const browse = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.browse, TG.owner),
    );
    expect(browse.replyKey).toBe('bot.admin.services_browse');
    const body = lastMessage();
    expect(body, 'the inventory reaches it').toContain(`${PREFIX.service}${healthy.id}`);
    expect(body, 'labelled by the handle an operator types into the panel').toContain(
      healthy.username,
    );
    /* The two bearer capabilities the row carries. A chat message is not revocable. */
    const row = await services.findById(tenantA, healthy.id);
    expect(body).not.toContain(row?.subscriptionRef);
    expect(body).not.toContain(row?.providerClientId);
  });

  it('pages the browsable list rather than truncating it', async () => {
    /*
     * `ADMIN_QUEUE_LIMIT` is ten. Eleven services is one more than a page, which is the
     * smallest fixture that can tell "paged" from "bounded and silently cut" — the
     * defect WP1 named, where a truncated list reads as a complete one.
     *
     * The traversal is the SERVER's keyset, carried through the codec that makes a
     * cursor fit Telegram's 64-byte callback limit. The assertion is that the second
     * page holds rows the first did not, and that between them every service is
     * reachable: a cursor that failed to advance would repeat the first page for ever.
     */
    const all: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      all.push((await activeService(`browse-page-${String(index)}`)).id);
    }

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(PREFIX.browse, TG.owner));
    const first = lastMessage();
    const onFirst = all.filter((id) => first.includes(`${PREFIX.service}${id}`));
    expect(onFirst, 'a full page').toHaveLength(10);

    const token = /"H:b:([^"]+)"/.exec(first)?.[1];
    expect(token, 'the more button carries a cursor').toBeDefined();

    const second = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.browsePage}${token ?? ''}`, TG.owner),
    );
    expect(second.replyKey).toBe('bot.admin.services_browse');
    const rest = lastMessage();
    const onSecond = all.filter((id) => rest.includes(`${PREFIX.service}${id}`));
    expect(onSecond, 'the eleventh is reachable').toHaveLength(1);
    expect(onFirst, 'the second page is not the first again').not.toContain(onSecond[0]);
    expect(new Set([...onFirst, ...onSecond]).size, 'every service is reachable').toBe(11);
  });

  it('refuses a browse cursor that is not one this codec minted', async () => {
    /*
     * `callback_data` is client-supplied text. A crafted token must be UNSUPPORTED at
     * the BOUNDARY rather than an invalid cast inside a query — the rule every other
     * paged section here follows. Nothing is authorized by a cursor, so this is about
     * shape, not trust.
     */
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.browsePage}not-a-cursor`, TG.owner),
    );
    expect(result.replyKey).toBe('bot.unknown_command');
  });

  it("cannot browse another tenant's services", async () => {
    /*
     * The list is scoped to the TURN's tenant, and the index it reads leads with
     * `tenant_id`. A browsable list is the worst place to get that wrong, because it
     * returns rows nobody asked for by id.
     */
    const foreign = await serviceInTenantB();
    await activeService('browse-own');

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(PREFIX.browse, TG.owner));
    expect(lastMessage()).not.toContain(foreign);
  });

  it('says so when there is nothing to browse, rather than drawing an empty keyboard', async () => {
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(PREFIX.browse, TG.owner),
    );
    expect(result.replyKey).toBe('bot.admin.services_browse_none');
  });

  // =========================================================================
  // The exact lookup and the detail
  // =========================================================================

  it('opens one service by id with /service, including one the queue does not list', async () => {
    const service = await activeService('lookup');

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate(`/service ${service.id}`, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.service');
    expect(lastMessage()).toContain(service.username);
  });

  it('answers a malformed /service argument as unknown, not as a failed cast', async () => {
    /*
     * The id reaches a `uuid` column. `not-a-uuid` used to be a 500 at the cast on
     * every surface that took one; the shape here is the one the rest of the product
     * uses — one answer for unknown, malformed and not-yours alike.
     *
     * Both strings here are WELL-FORMED provider usernames — lowercase ASCII, digits
     * and a dash, inside the length bounds — since WP3 gave the argument that second
     * shape. So they are looked up and found to name nobody, which is `service_gone`.
     * The case below covers the strings that are neither shape.
     */
    for (const text of ['/service not-a-uuid', '/service 12345']) {
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        adminUpdate(text, TG.owner),
      );
      expect(result.replyKey, text).toBe('bot.admin.service_gone');
    }
  });

  it('repeats the syntax for an argument that is neither an id nor a name', async () => {
    /*
     * The syntax, NOT a prompt for the missing argument. A prompt that outlives its
     * question swallows the next unrelated message, which is INCIDENT-FIN-001 — an
     * ordinary chat message overwrote a production gateway setting that way.
     *
     * `@maryam` is what somebody pastes when they mean a Telegram username, and
     * `سلام` is an ordinary word. Neither could ever be a service, so answering them
     * with "no such service" would report a fact the lookup never established.
     */
    for (const text of ['/service', '/service @maryam', '/service سلام']) {
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        adminUpdate(text, TG.owner),
      );
      expect(result.replyKey, text).toBe('bot.admin.service_usage');
    }
  });

  it('opens one service by the NAME on its panel, in either case', async () => {
    /*
     * The handle a customer's message actually contains. Until WP3 the only accepted
     * argument was the internal uuid, which appears in no support conversation ever —
     * `docs/wp3-service-audit.md` is blunt about it: service management was the most
     * built of the three and the least reachable.
     *
     * Asked twice, as stored and uppercased, because the fold happens once at the
     * boundary and an operator typing what the customer sent must reach the same row.
     */
    const service = await activeService('lookup-by-name');

    for (const typed of [service.username, service.username.toUpperCase()]) {
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        adminUpdate(`/service ${typed}`, TG.owner),
      );
      expect(result.replyKey, typed).toBe('bot.admin.service');
      expect(lastMessage(), typed).toContain(service.username);
    }
  });

  it('answers a PREFIX of a name as unknown, rather than with the account it names', async () => {
    /*
     * The rule that decides the whole shape of this lookup, asserted rather than
     * commented: a prefix search over account names is an enumeration of a panel's
     * accounts. The prefix used is deliberately one the grammar ACCEPTS, so this
     * measures the repository's equality and not the validator — a `like` in place of
     * the `eq` opens the service and this fails.
     */
    const service = await activeService('lookup-prefix');

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate(`/service ${service.username.slice(0, 6)}`, TG.owner),
    );
    expect(result.replyKey).toBe('bot.admin.service_gone');
  });

  it('hands back BOTH matches when one name names two services, and offers no action', async () => {
    /*
     * The Codex round's P1, and the reason this screen exists.
     *
     * `services_panel_provider_username_key` is unique per PANEL, not per tenant, and
     * this installation has two panels — so one name can name two accounts. The first
     * version asked for `limit: 1` and took the newest, which put SUSPEND and TERMINATE
     * on an arbitrary one of them: the wrong customer's service under a right answer's
     * heading.
     *
     * The second service is given the first's name directly, because the product
     * refuses to MINT a duplicate and this state is reached the other way — two panels
     * pointing at different machines, each legitimately holding the name. What is under
     * test is the lookup's behaviour when the row exists, not how it got there.
     */
    const first = await activeService('ambiguous-a');
    const second = await sanaeiService('ambiguous-b');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET provider_username = ${first.username} WHERE id = ${second}`);

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate(`/service ${first.username}`, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.service_ambiguous');
    const body = lastMessage();
    expect(body, 'the first match is reachable').toContain(`${PREFIX.service}${first.id}`);
    expect(body, 'and so is the second').toContain(`${PREFIX.service}${second}`);
    /*
     * NOT one action, and terminate least of all. A screen that has not established
     * WHICH service the operator means must not offer to end one.
     */
    for (const prefix of [
      PREFIX.terminate,
      PREFIX.terminateAsk,
      PREFIX.suspend,
      PREFIX.resume,
      PREFIX.sync,
      PREFIX.reconcile,
      PREFIX.retry,
      PREFIX.resend,
    ]) {
      expect(body, `${prefix} was offered before the service was identified`).not.toContain(
        `"${prefix}`,
      );
    }
  });

  it('still opens the one match directly when the name IS unique', async () => {
    /*
     * The half that keeps the case above honest: a disambiguation screen that appeared
     * for every lookup would pass the assertions there and make the ordinary path two
     * taps instead of one.
     */
    const service = await activeService('unambiguous');

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate(`/service ${service.username}`, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.service');
  });

  it('refuses /service for an administrator who does not hold services.view', async () => {
    /*
     * The PERMISSION decides before the shape of the argument is even considered, and
     * that ordering is the point: an administrator without the key must not learn from
     * this surface whether a string is a well-formed id, a name this product stores, or
     * neither. One refusal for all three.
     *
     * `receipt_reviewer`, not an administrator with no section at all: one with no
     * section never reaches `adminTurn` and gets `bot.unknown_command`, which the case
     * above already covers and which would pass here for the wrong reason. A reviewer
     * HAS a panel — the receipts section — and is inside the turn when this refusal is
     * decided, which is the arm that matters.
     */
    await bindNewAdmin('reviewer-no-lookup', TG.support, { roleKeys: ['receipt_reviewer'] });
    const service = await activeService('lookup-denied');

    for (const text of [`/service ${service.id}`, `/service ${service.username}`, '/service']) {
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        adminUpdate(text, TG.support),
      );
      expect(result.replyKey, text).toBe('bot.admin.refused');
    }
  });

  it("answers another tenant's service id as unknown, through every one of the section's callbacks", async () => {
    /*
     * The scope comes from the TURN, so a foreign id is simply not found. Asserted on
     * the read AND on all seven actions, because a write path that read the row without
     * the scope would leak existence through its refusal even while refusing.
     */
    const foreign = await serviceInTenantB();
    const paths: string[] = [
      PREFIX.service,
      PREFIX.sync,
      PREFIX.resend,
      PREFIX.retry,
      PREFIX.reconcile,
      PREFIX.suspend,
      PREFIX.resume,
      PREFIX.terminateAsk,
      PREFIX.terminate,
    ];
    /*
     * The assertion is INDISTINGUISHABILITY rather than a particular sentence.
     *
     * Naming the answers would pin whichever ones this release happens to produce; what
     * must hold is that a foreign service and an id that exists nowhere are answered
     * identically, because any difference between them is an oracle for deciding
     * whether somebody else's installation has a service by that id.
     */
    const nowhere = ctx.container.ids.uuid();
    for (const prefix of paths) {
      const onForeign = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`${prefix}${foreign}`, TG.owner),
      );
      expect(lastMessage(), `${prefix} leaked the foreign service`).not.toContain(foreign);
      const onNothing = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`${prefix}${nowhere}`, TG.owner),
      );
      expect(onForeign.replyKey, `${prefix} told a foreign id apart from an unknown one`).toBe(
        onNothing.replyKey,
      );
    }
    /* And nothing was planned against it. */
    expect(await operations.listForService(tenantB, foreign, 50)).toHaveLength(1);
  });

  it('carries the identity, both states, usage, expiry and the latest operation', async () => {
    const service = await activeService('detail');
    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.sync}${service.id}`, TG.owner),
    );

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
    );

    const text = String(lastBody()?.['text'] ?? '');
    /*
     * WHO, by the numeric Telegram identity — the handle a support conversation quotes.
     *
     * This asserted the internal UUID until WP3, which is what the runtime passed while
     * the contract's own description said "the numeric identity this installation
     * holds". A uuid names the right person to nobody, can be typed into no command
     * here, and is a customer identifier handed to an administrator who may not be
     * allowed to read customers at all. The negative half is the assertion: the uuid
     * must be GONE, not merely accompanied.
     */
    expect(text, 'the customer, by the handle a support conversation quotes').toContain(
      TG.customer,
    );
    expect(text, 'the internal customer uuid is not an identity').not.toContain(customerA);
    expect(text, 'the handle on the panel').toContain(service.username);
    expect(text, 'the panel').toContain(panelId);
    expect(text, 'the lifecycle state').toContain('ACTIVE');
    expect(text, 'the delivery state').toContain('DELIVERED');
    /*
     * The latest operation AND its outcome, which is what tells a planned action apart
     * from a completed one — the difference the legacy panel's "updated" erased.
     */
    expect(text, 'the latest operation and its state').toContain('SYNC_USAGE PLANNED');
    /*
     * And how much of the history that ONE operation is (WP3). A `PROVISION` and a
     * `SYNC_USAGE` is two, well inside the bound, so the figure is exact and carries no
     * `+`. A screen that printed one row of a history it had truncated would be
     * presenting a fragment as the whole story.
     */
    expect(text, 'the operation count').toContain('2');
    expect(text, 'the count is exact, so it carries no bound marker').not.toContain('50+');
  });

  it('says the history is UNREADABLE rather than reporting it as empty', async () => {
    /*
     * Found by the Codex review of this branch, and it is the package's own defect
     * class turned on itself.
     *
     * The screen reads the operation history behind a catch, because a services screen
     * must not fail over a history it only summarises. The first version caught the
     * failure into an empty history and rendered `0` — which tells the operator that
     * NOTHING has ever been attempted on this service. That is a diagnosis, and a
     * failed read is the absence of one: it sends somebody looking at provisioning when
     * the database was the thing that blinked.
     *
     * The failure is injected on the SAME instance the runtime holds — the container
     * wires one `ServiceAdminService` into both — so this exercises the real catch
     * rather than a copy of it.
     */
    const service = await activeService('history-unreadable');
    const operations = vi
      .spyOn(ctx.container.serviceAdmin, 'operations')
      .mockRejectedValue(new Error('the history could not be read'));

    try {
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
      );

      /* The SCREEN still renders: the catch is doing its job. */
      expect(result.replyKey).toBe('bot.admin.service');
      const text = String(lastBody()?.['text'] ?? '');
      expect(text, 'the service itself is still described').toContain(service.username);
      /*
       * And the count is a dash, not a zero. Asserted on the line rather than on the
       * whole message, because `-` appears wherever a fact is absent.
       */
      const line = text.split('\n').find((one) => one.includes('شمار عملیات ثبت‌شده'));
      expect(line, 'the history line is missing entirely').toBeDefined();
      expect(line, 'an unreadable history was reported as a count').toContain('-');
      expect(line, 'an unreadable history was reported as none').not.toContain('0');
    } finally {
      operations.mockRestore();
    }
  });

  it('links to the customer, and only for an administrator who may read them', async () => {
    /*
     * The other half of naming the person: one tap to the customer screen the customers
     * section already owns, rather than a second rendering of a customer here.
     *
     * The callback is `9:v:<customerId>` — the customers section's own detail prefix —
     * so the screen it opens charges `users.view` again when tapped. The button decides
     * what is ADVERTISED, never what is allowed, which is why the negative arm matters:
     * an administrator holding `services.view` alone gets no button and no identity,
     * because asking for the customer would only manufacture a denial per screen they
     * open.
     */
    const service = await activeService('detail-customer');

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
    );
    expect(lastMessage(), 'the owner holds users.view').toContain(`9:v:${customerA}`);

    await bindNewAdmin('services-only-detail', TG.viewer, { permissions: ['services.view'] });
    const viewer = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.viewer),
    );
    /*
     * The SCREEN still renders, and that is the half a "no button" assertion alone
     * cannot see.
     *
     * The customer read is SKIPPED when the key is absent rather than attempted and
     * caught: `CustomerService.get` charges `users.view` through the guard, so asking
     * anyway would both manufacture a denial per service screen an operator opens and —
     * because a denial is not `isCustomerMiss` — rethrow, turning a services screen into
     * an error over a permission the service itself does not need. Reverting the skip
     * leaves the button absent either way; what it breaks is this line.
     */
    expect(viewer.replyKey, 'a permission the SERVICE does not need broke its screen').toBe(
      'bot.admin.service',
    );
    const viewerText = lastMessage();
    expect(viewerText, 'a button whose every tap is a denial').not.toContain('9:v:');
    expect(viewerText, 'nor the identity behind it').not.toContain(TG.customer);
    expect(viewerText, 'and never the internal uuid instead').not.toContain(customerA);
  });

  it('carries no subscription URL, subscription ref, client id or panel credential', async () => {
    /*
     * The four things that must never reach an admin chat, each for its own reason: the
     * URL and the ref are bearer capabilities for the customer's traffic, the client id
     * authenticates it, and the panel password is the installation's access to somebody
     * else's machine. A Telegram message is not revocable.
     */
    const service = await activeService('secrets');
    const row = await services.findById(tenantA, service.id);
    expect(row?.subscriptionUrl, 'the fixture must actually have one').not.toBeNull();

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
    );

    const whole = lastMessage();
    for (const [label, secret] of [
      ['subscription URL', row?.subscriptionUrl],
      ['subscription ref', row?.subscriptionRef],
      ['provider client id', row?.providerClientId],
      ['panel password', panel.password],
    ] as const) {
      expect(whole, `the detail leaked the ${label}`).not.toContain(secret);
    }
  });

  // =========================================================================
  // Which buttons are drawn, and for whom
  // =========================================================================

  it('offers an owner the actions the service allows, and the end button only ASKS', async () => {
    const service = await activeService('buttons-owner');

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
    );

    const body = lastMessage();
    expect(body, 'sync is offered on an ACTIVE service').toContain(`${PREFIX.sync}${service.id}`);
    expect(body, 'resend is offered once a configuration exists').toContain(
      `${PREFIX.resend}${service.id}`,
    );
    expect(body, 'suspend is offered').toContain(`${PREFIX.suspend}${service.id}`);
    expect(body, 'resume is not, because it is not suspended').not.toContain(
      `${PREFIX.resume}${service.id}`,
    );
    expect(body, 'end is offered as a QUESTION').toContain(`${PREFIX.terminateAsk}${service.id}`);
    /*
     * And never as the destructive callback. `Q:` is produced in exactly one place —
     * the confirmation screen — which is what makes "terminate takes two taps" a
     * property of the code rather than a promise in a comment. The two prefixes differ
     * by one letter, which is why this is asserted rather than reviewed.
     */
    expect(body, 'a one-tap deletion was drawn').not.toContain(`${PREFIX.terminate}${service.id}`);
  });

  it('offers an administrator holding services.view alone no action at all', async () => {
    await bindNewAdmin('viewer-buttons', TG.viewer, { permissions: ['services.view'] });
    const service = await activeService('buttons-viewer');

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.viewer),
    );

    expect(result.replyKey, 'they may still READ it').toBe('bot.admin.service');
    const body = lastMessage();
    for (const prefix of [
      PREFIX.sync,
      PREFIX.resend,
      PREFIX.retry,
      PREFIX.reconcile,
      PREFIX.suspend,
      PREFIX.resume,
      PREFIX.terminateAsk,
      PREFIX.terminate,
    ]) {
      expect(body, `${prefix} was drawn without services.edit`).not.toContain(
        `${prefix}${service.id}`,
      );
    }
  });

  it('offers an administrator with services.edit the six, and withholds the terminate', async () => {
    /*
     * `services.terminate` is HIGH risk and held by the owner alone among the seeded
     * roles. The split is the whole reason the permission is separate, and a surface
     * that drew one button for all seven would hand it to every operator.
     */
    await bindNewAdmin('support-buttons', TG.support, { roleKeys: ['support'] });
    const service = await activeService('buttons-support');

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.support),
    );

    const body = lastMessage();
    expect(body, 'sync is theirs').toContain(`${PREFIX.sync}${service.id}`);
    expect(body, 'suspend is theirs').toContain(`${PREFIX.suspend}${service.id}`);
    expect(body, 'ending a service is not').not.toContain(`${PREFIX.terminateAsk}${service.id}`);
    expect(body).not.toContain(`${PREFIX.terminate}${service.id}`);
  });

  it('draws no action a 3X-UI panel cannot perform, and refuses it if asked anyway', async () => {
    /*
     * `docs/phase4e-audit.md` records the owner's correction: 3X-UI keeps the five
     * capabilities it has and gains no mutable scope. So the verdict is
     * `CAPABILITY_UNSUPPORTED` rather than a state refusal, the button is absent, and
     * the crafted callback is refused by the write path — the second half being what
     * makes the first half not the control.
     */
    const service = await sanaeiService('capability');

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service}`, TG.owner),
    );
    expect(lastMessage(), 'a suspend 3X-UI cannot do was offered').not.toContain(
      `${PREFIX.suspend}${service}`,
    );

    const forced = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service}`, TG.owner),
    );
    expect(forced.replyKey).toBe('bot.admin.service_unavailable');
    expect(await operations.listForService(tenantA, service, 50)).toHaveLength(1);
  });

  // =========================================================================
  // Terminate: the two taps
  // =========================================================================

  it('asks before ending a service, and only that screen carries the destructive callback', async () => {
    const service = await activeService('terminate-ask');

    const asked = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.terminateAsk}${service.id}`, TG.owner),
    );

    expect(asked.replyKey).toBe('bot.admin.service_terminate_ask');
    expect(lastMessage(), 'the confirmation carries the destructive callback').toContain(
      `${PREFIX.terminate}${service.id}`,
    );
    /* The ask alone plans nothing: the settlement's PROVISION is all there is. */
    expect(await operations.listForService(tenantA, service.id, 50)).toHaveLength(1);

    const confirmed = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.terminate}${service.id}`, TG.owner),
    );
    expect(confirmed.replyKey).toBe('bot.admin.service_planned');
    expect((await operationOf(service.id, 'TERMINATE'))?.state).toBe('PLANNED');
  });

  it('refuses the terminate question to an administrator without services.terminate', async () => {
    /*
     * The button is not drawn for them, so this is a CRAFTED callback — which is
     * exactly the case the permission exists for. The answer is the panel's blanket
     * refusal rather than a sentence about the service: what they lack is not the
     * service's problem, and naming it would tell whoever holds that chat what exists.
     */
    await bindNewAdmin('support-terminate', TG.support, { roleKeys: ['support'] });
    const service = await activeService('terminate-refused');

    const asked = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.terminateAsk}${service.id}`, TG.support),
    );
    expect(asked.replyKey).toBe('bot.admin.refused');
    expect(lastMessage(), 'the refusal carried a destructive button').not.toContain(
      PREFIX.terminate,
    );

    /* And the destructive callback itself, skipping the question entirely. */
    const forced = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.terminate}${service.id}`, TG.support),
    );
    expect(forced.replyKey).toBe('bot.admin.refused');
    expect(await operationOf(service.id, 'TERMINATE')).toBeUndefined();
  });

  it('answers the terminate question with a refusal once the service is already ended', async () => {
    /*
     * The verdict is read AGAIN on the confirmation screen, which is the case that
     * makes it worth reading twice: between an operator's first tap and their second,
     * somebody else can end the service, and a second destructive button offered for a
     * service that has none left is a promise the tap would refuse.
     */
    const service = await activeService('terminate-stale');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${service.id}`);

    const asked = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.terminateAsk}${service.id}`, TG.owner),
    );

    expect(asked.replyKey).toBe('bot.admin.service_unavailable');
    expect(lastMessage()).not.toContain(PREFIX.terminate);
  });

  // =========================================================================
  // Acting: the canonical path, and only it
  // =========================================================================

  it('plans a suspend through the same method the Web Admin calls, and carries it to the panel', async () => {
    const service = await activeService('suspend');

    const tapped = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner),
    );

    /*
     * The panel has NOT been called yet, and the reply says so. Claiming the service is
     * paused here would be a claim about somebody else's machine made before anything
     * was asked of it — the legacy "updated" for a write whose effect has not happened.
     */
    expect(tapped.replyKey).toBe('bot.admin.service_planned');
    expect(panel.users.get(service.username)?.status, 'still active on the panel').toBe('active');
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');

    await ctx.container.provisionerLoop.tick();

    expect(panel.users.get(service.username)?.status).toBe('disabled');
    expect((await services.findById(tenantA, service.id))?.state).toBe('SUSPENDED');
    expect((await operationOf(service.id, 'SUSPEND'))?.state).toBe('SUCCEEDED');
  });

  it('records the real administrator as the actor, and never a fabricated one', async () => {
    /*
     * `docs/conventions.md` forbids inventing actors. A Telegram administrator has an
     * `ActorContext` of their own, so the audit row names the person — not the
     * `SYSTEM_JOB` the webhook runs as with the requester tucked into a payload, which
     * is what `/admin/logs` did and what the research records it was worth.
     */
    const service = await activeService('audit');
    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner),
    );

    const rows = await auditRows('service.request_suspend');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['actor_type']).toBe('TELEGRAM_ADMIN');
    expect(rows[0]?.['actor_id'], 'the administrator who pressed it').toBe(ownerAId);
    expect(rows[0]?.['entity_id']).toBe(service.id);
  });

  it('answers a second tap with the operation it already planned, and plans no second one', async () => {
    /*
     * Two taps of one button are one request. The derived operation id is what makes
     * them share an answer, and the open-operation return is what makes a LATER tap —
     * with a different idempotency key, because it is a different update — idempotent
     * too. Both shapes, because they are held by different mechanisms.
     */
    const service = await activeService('double-tap');
    const update = tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner);

    const first = await runtime().handle(tenantA, systemActor('bot'), update);
    /* The SAME update, redelivered by Telegram: same key. */
    const replay = await runtime().handle(tenantA, systemActor('bot'), update);
    /* A genuinely different update, from an impatient second tap: different key. */
    const again = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner),
    );

    for (const result of [first, replay, again]) {
      expect(result.replyKey).toBe('bot.admin.service_planned');
    }
    const planned = (await operations.listForService(tenantA, service.id, 50)).filter(
      (operation) => operation.type === 'SUSPEND',
    );
    expect(planned, 'three taps, one operation').toHaveLength(1);
  });

  it('answers a stale button as not possible now, rather than throwing', async () => {
    /*
     * The state moved between the screen being drawn and the button being pressed,
     * which is the ordinary case rather than an attack: a suspend on a service somebody
     * else has already ended. The sentence sends the operator to the Web Admin, where
     * the reason is written; an unhandled throw here would be a 500 on a button
     * somebody pressed to fix a service.
     */
    const service = await activeService('stale');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${service.id}`);

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.service_unavailable');
    expect(await operationOf(service.id, 'SUSPEND')).toBeUndefined();
  });

  it('resends a configuration to the customer, plans no operation, and moves no state', async () => {
    const service = await activeService('resend');
    const before = await services.findById(tenantA, service.id);
    sent = [];

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.resend}${service.id}`, TG.owner),
    );

    expect(result.replyKey).toBe('bot.admin.service_resent');
    expect((await services.findById(tenantA, service.id))?.state).toBe(before?.state);
    expect(
      (await operations.listForService(tenantA, service.id, 50)).filter(
        (operation) => operation.type !== 'PROVISION',
      ),
      'a resend asks a panel for nothing',
    ).toHaveLength(0);

    /*
     * The configuration went to the CUSTOMER's chat, not the administrator's. The
     * admin's own reply says it was sent and carries no link — this surface reports
     * what happened rather than repeating the secret back.
     */
    const toCustomer = sent.filter((one) => String(one.body['chat_id']) === TG.customer);
    expect(toCustomer.length, 'the customer was not sent anything').toBeGreaterThan(0);
    const toAdmin = sent.filter((one) => String(one.body['chat_id']) !== TG.customer);
    for (const message of toAdmin) {
      expect(JSON.stringify(message.body)).not.toContain(before?.subscriptionUrl);
    }
  });

  it('refuses a retry on an UNRECONCILED service and offers the reconcile instead', async () => {
    /*
     * The rule 4D bought with a stranded service: a lost create is RECONCILED, never
     * created again, because a second create is a second paid-for account on somebody
     * else's panel. `retryProvisioning` has its own refusal for it, which is why retry
     * is a separate callback rather than a sixth entry in the operation table.
     */
    const service = await activeService('unreconciled');
    await ctx.container.database.db.execute(sql`
      UPDATE services SET state = 'UNRECONCILED', provisioned_at = NULL WHERE id = ${service.id}`);

    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
    );
    const body = lastMessage();
    expect(body, 'reconcile is offered').toContain(`${PREFIX.reconcile}${service.id}`);
    expect(body, 'retry is not').not.toContain(`${PREFIX.retry}${service.id}`);

    const refused = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.retry}${service.id}`, TG.owner),
    );
    expect(refused.replyKey).toBe('bot.admin.service_unavailable');

    const reconciled = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.reconcile}${service.id}`, TG.owner),
    );
    expect(reconciled.replyKey).toBe('bot.admin.service_planned');
    expect((await operationOf(service.id, 'RECONCILE'))?.state).toBe('PLANNED');
  });

  // =========================================================================
  // 6A-5: what failure does, and who is told
  // =========================================================================

  it('leaves the service alone when the panel refuses, and says so in the latest operation', async () => {
    /*
     * "No action may silently succeed when the provider did nothing." A refused suspend
     * moves the operation and NOT the service: reporting SUSPENDED here would be this
     * installation's record disagreeing with the panel it is meant to describe, and the
     * operator's next screen would tell them the job was done.
     */
    const service = await activeService('failure');
    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner),
    );

    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();
    panel.behaviour = 'healthy';

    expect((await services.findById(tenantA, service.id))?.state, 'the service did not move').toBe(
      'ACTIVE',
    );
    expect(panel.users.get(service.username)?.status).toBe('active');
    /*
     * And the operation is PLANNED again rather than terminal: a suspend whose answer
     * was lost is safe to repeat, because repeating it changes nothing the first one
     * did not already do. Routing it to UNKNOWN would strand it — RECONCILE asks
     * whether an account EXISTS, never what state it is in.
     */
    expect((await operationOf(service.id, 'SUSPEND'))?.state).toBe('PLANNED');

    /* And the operator's own screen carries the failure rather than hiding it. */
    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.service}${service.id}`, TG.owner),
    );
    expect(String(lastBody()?.['text'] ?? '')).toContain('SUSPEND');
  });

  it('tells the customer nothing about a suspend their operator ordered', async () => {
    /*
     * Phase 6A-5, and the defect 6A-1 introduced.
     *
     * `CUSTOMER_REQUESTABLE_OPERATIONS` decided this from the operation's TYPE, which
     * was sound while `SUSPEND` could only be reached from the customer's own screen.
     * An operator's suspend writes the same row, so the customer received
     * «درخواست شما با موفقیت روی سرور اعمال شد» — YOUR request — having made none.
     *
     * Silence, not a new sentence: `CUSTOMER_NOTIFICATION_KINDS` is a closed set and
     * none of its kinds means "an operator changed your service"; ADR-0030 §1 refuses
     * the parameterised payload one would need. Every other operator action here is
     * already silent to the customer.
     */
    const service = await activeService('notify-operator');
    await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.suspend}${service.id}`, TG.owner),
    );
    await ctx.container.provisionerLoop.tick();
    expect((await operationOf(service.id, 'SUSPEND'))?.state, 'the fixture must succeed').toBe(
      'SUCCEEDED',
    );

    expect(await notificationKinds(), 'the customer was told it was their request').toEqual([]);
    /*
     * And the operation IS answered. `announced_at` NULL means unanswered rather than
     * "no answer was owed", so a decision to say nothing still has to be stamped — a
     * row left NULL is one the sweep re-reads for ever.
     */
    expect((await operationOf(service.id, 'SUSPEND'))?.id).toBeDefined();
    expect(await unannouncedCount(), 'nothing was left for the sweep').toBe(0);
  });

  it('still tells the customer about a suspend they asked for themselves', async () => {
    /*
     * The other side of the same rule, and the case that proves the fix narrowed rather
     * than silenced. Same service, same operation type, same panel — the only
     * difference is who asked, which is now a column rather than an inference.
     */
    const service = await activeService('notify-customer');
    await ctx.container.provisioning.requestFromCustomer(
      tenantA,
      systemActor('customer-asked'),
      customerA,
      service.id,
      'SUSPEND',
      { idempotencyKey: 'customer-suspend-0001' },
    );
    await ctx.container.provisionerLoop.tick();

    expect(await notificationKinds()).toEqual(['SERVICE_ACTION_SUCCEEDED']);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastBody = () => messages()[messages().length - 1]?.body;
  const lastMessage = () => JSON.stringify(messages()[messages().length - 1] ?? {});

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  /**
   * An administrator with either a seeded role or a hand-made one, bound to a chat.
   *
   * The `permissions` form exists for the cases about ONE key: no seeded role holds
   * `services.view` without `services.edit`, and a case that used `support` for the
   * view-only administrator would be testing a different question.
   */
  async function bindNewAdmin(
    username: string,
    telegramUserId: string,
    grant: { roleKeys?: string[]; permissions?: string[] },
  ): Promise<AdminId> {
    const admin = await createAdmin(ctx.container, tenantA, {
      username,
      ...(grant.roleKeys === undefined ? {} : { roleKeys: grant.roleKeys }),
    });
    if (grant.permissions !== undefined) {
      const roleId = ctx.container.ids.uuid();
      await ctx.container.database.db.execute(sql`
        INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES (${roleId}, ${tenantA.tenantId}, ${`custom_${username.replaceAll('-', '_')}`}, ${username}, false)`);
      for (const permission of grant.permissions) {
        await ctx.container.database.db.execute(sql`
          INSERT INTO role_permissions (tenant_id, role_id, permission_key)
          VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
      }
      await ctx.container.database.db.execute(sql`
        INSERT INTO admin_roles (tenant_id, admin_id, role_id)
        VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    }
    await bind(admin.id as AdminId, telegramUserId);
    return admin.id as AdminId;
  }

  async function customerWithTelegramId(telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'مریم' },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  const baseUpdate = (payload: Record<string, unknown>, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    };
  };

  const adminUpdate = (text: string, telegramUserId: string) =>
    baseUpdate(
      {
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          text,
        },
      },
      telegramUserId,
    );

  const tapUpdate = (data: string, telegramUserId: string) =>
    baseUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
    );

  /** A settled order, which is what plans a provisioning operation. */
  async function paidOrder(
    key: string,
    where: { panelId: string; deviceLimit: number | null } = {
      panelId,
      deviceLimit: null,
    },
  ): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: where.panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: {
          durationDays: 30,
          trafficBytes: 53_687_091_200n,
          deviceLimit: where.deviceLimit,
        },
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  /** A service that exists on the fake panel, is ACTIVE here, and has been delivered. */
  async function activeService(key: string): Promise<{ id: string; username: string }> {
    const orderId = await paidOrder(key);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service === undefined) throw new Error('settlement made no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    // The STORED name. See the same correction in `service-management.test.ts`.
    return { id: service.id, username: service.providerUsername };
  }

  /**
   * A service whose configuration reached the attempt ceiling without being delivered.
   *
   * Driven through the REAL delivery lane rather than written with an UPDATE, because
   * the queue is about what the lane gives up on and a row set by hand could be a state
   * the lane never actually produces.
   */
  async function failedDelivery(key: string): Promise<{ id: string; username: string }> {
    const previous = reply;
    reply = (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }));
    };
    const orderId = await paidOrder(key);
    await ctx.container.provisionerLoop.tick();
    for (let attempt = 1; attempt < 3; attempt += 1) {
      await ctx.container.database.db.execute(
        sql`UPDATE services SET delivery_next_attempt_at = now() - interval '1 hour'`,
      );
      await ctx.container.delivery.deliverDue(tenantA, 10);
    }
    reply = previous;
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.deliveryState, 'the fixture must need a person').toBe('FAILED');
    // The STORED name. See the same correction in `service-management.test.ts`.
    return { id: service.id, username: service.providerUsername };
  }

  /** A service on the 3X-UI panel, for the capability cases. Never provisioned. */
  async function sanaeiService(key: string): Promise<string> {
    const orderId = await paidOrder(key, { panelId: sanaeiPanelId, deviceLimit: null });
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service === undefined) throw new Error('no service');
    return service.id;
  }

  /** A service belonging to the OTHER tenant, for the isolation cases. */
  async function serviceInTenantB(): Promise<string> {
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    const panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'marzban', 'https://b.example.test', 'ACTIVE')`);
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(ctx.container, tenantB, panelB);
    const customerB = (
      await ctx.container.customers.resolveFromUpdate(tenantB, systemActor('resolve-b'), {
        idempotencyKey: 'resolve-b',
        telegramUserId: '820820',
        from: { id: 820_820, first_name: 'سارا' },
        botInstanceId: SEED_IDS.botB1 as BotInstanceId,
      })
    ).customer.id;
    const product = await products.create(tenantB, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ب',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelB as PanelId,
        /*
         * Tenant B's OWN category. `products_tenant_category_fk` is composite, so a
         * tenant B product filed under tenant A's category is refused by the
         * database — which would turn this cross-tenant isolation case into a
         * foreign-key error instead of the assertion it was written to make.
         */
        categoryId: SEED_IDS.categoryB as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1_000n, deviceLimit: null },
        price: money(100_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantB, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantB, systemActor('b'), {
      idempotencyKey: 'b-draft',
      customerId: customerB,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantB, systemActor('b'), {
      idempotencyKey: 'b-confirm',
      customerId: customerB,
      orderId: draft.id,
    });
    /* The credit is authorized, so it must be tenant B's OWN owner. */
    await ctx.container.wallet.adjust(tenantB, ownerB, customerB, {
      idempotencyKey: 'b-credit',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantB, systemActor('b'), customerB, {
      idempotencyKey: 'b-pay',
      orderId: confirmed.id,
    });
    const service = await services.findByOrderId(tenantB, confirmed.id);
    if (service === null || service === undefined) throw new Error("tenant B's service is missing");
    return service.id;
  }

  const operationOf = async (serviceId: string, type: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).find(
      (operation) => operation.type === type,
    );

  const auditRows = async (action: string) =>
    (
      await ctx.container.database.db.execute(sql`
        SELECT actor_type, actor_id, entity_id FROM audit_logs WHERE action = ${action}`)
    ).rows as Record<string, unknown>[];

  const notificationKinds = async () =>
    (
      await ctx.container.database.db.execute<{ kind: string }>(
        sql`SELECT kind FROM customer_notifications ORDER BY created_at`,
      )
    ).rows.map((row) => row.kind);

  const unannouncedCount = async () =>
    Number(
      (
        await ctx.container.database.db.execute<{ count: string }>(sql`
          SELECT count(*)::text AS count FROM provisioning_operations
           WHERE announced_at IS NULL AND state IN ('SUCCEEDED', 'ABANDONED')`)
      ).rows[0]?.count ?? '-1',
    );
});
