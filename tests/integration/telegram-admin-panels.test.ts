import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_MENU_BUTTON,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * The Telegram management panel's panels section — Phase 6B.
 *
 * Against real everything, the way the services section is tested: a real PostgreSQL,
 * the real `PanelService` with its real guard, a deterministic Marzban on a real socket
 * so a connection test is a real probe, a real socket standing in for Telegram, and the
 * real bot runtime.
 *
 * Three questions this file is about, and they are the three that make a PANEL section
 * different from a services one:
 *
 *   1. **What may never appear in a chat.** An admin message lives in somebody's
 *      Telegram for ever and is forwardable. A panel's base URL, any credential, a
 *      masked stand-in for one, and a provider's response body are all out — and the
 *      last one is the subtle one, because a failure body is the natural thing to
 *      render and can carry a hostname or a token fragment.
 *   2. **No credential path exists at all.** Not "is refused": absent. The section's
 *      dependency cannot reach `setCredentials`, and no reply in it offers to.
 *   3. **Authority is a permission.** `panels.view` opens the section and
 *      `panels.edit` draws every control. Each case that asserts a control is absent
 *      is paired with one that sends the callback anyway.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

/** Every callback prefix the section owns, spelled out rather than imported. */
const PREFIX = {
  panels: 'R:',
  detail: 'S:',
  test: 'T:',
  enable: 'U:',
  disable: 'V:',
  archiveAsk: 'W:',
  /** The one archiving callback. */
  archive: 'X:',
  page: 'Y:',
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

describe('the panels section of the Telegram management panel', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let panel: FakeMarzban;
  let panelId: string;
  let owner: ActorContext;
  let ownerAId: AdminId;
  let updateSeq = 0;

  /* The Telegram accounts every case draws from. */
  const TG = {
    /** `owner`: every permission, including `panels.edit`. */
    owner: '710001',
    /** A custom role holding `panels.view` ALONE — no seeded role has that shape. */
    viewer: '710002',
    /*
     * An administrator with NO section of the management panel.
     *
     * It was `sales` until WP2, and the field name is kept because the cases reading it
     * are about an administrator the panel does not open for. `sales` holds
     * `users.view`, so the customers section gives it a panel now; the cases below
     * build a role holding `catalog.view` alone instead, which opens nothing here.
     */
    sales: '710003',
    /** An ordinary customer. No administrator row anywhere. */
    customer: '911911',
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
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
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
    sent = [];

    /* 127.0.0.2: the container's URL policy denies whatever DATABASE_URL names. */
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    const seededOwner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-tg-panels',
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
      idempotencyKey: 'panel-tg-panels-create',
    });
    panelId = created.view.panel.id;
  });

  // =========================================================================
  // Who sees the section at all
  // =========================================================================

  it('draws the Panels button for an administrator who holds panels.view', async () => {
    await bindNewAdmin('panels-viewer', TG.viewer, { permissions: ['panels.view'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.viewer),
    );

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage(), 'the Panels button is drawn').toContain(PREFIX.panels);
  });

  it('draws no Panels button for an administrator whose role does not hold panels.view', async () => {
    /*
     * `receipt_reviewer` HAS a section — receipts — so the panel opens. What it must
     * not carry is a button whose every press would record a denial. Without this
     * negative half, a gate that always returned true would pass the case above.
     */
    await bindNewAdmin('reviewer-no-panels', TG.viewer, { roleKeys: ['receipt_reviewer'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.viewer),
    );

    expect(result.replyKey).toBe('bot.admin.panel');
    expect(lastMessage(), 'a section they cannot enter was offered').not.toContain(PREFIX.panels);
  });

  it('opens the panel for an administrator whose ONLY section is Panels', async () => {
    /*
     * The FOURTH arm of `isAdmin` and of `adminTurn`'s gate, which have to agree: the
     * keyboard must not promise a panel the turn would refuse, and it must not withhold
     * one from an administrator who has a section. An installation whose only
     * `panels.view` holder got no admin row on their keyboard is what a missing arm
     * produces, and it is invisible until somebody with exactly that role types
     * `/start`.
     */
    await bindNewAdmin('panels-only-menu', TG.viewer, { permissions: ['panels.view'] });

    await runtime().handle(tenantA, systemActor('bot'), adminUpdate('/start', TG.viewer));
    const markup = lastBody()?.['reply_markup'] as { keyboard?: { text: string }[][] } | undefined;
    const labels = (markup?.keyboard ?? []).flat().map((button) => button.text);
    expect(labels, 'the admin row was withheld').toContain(CATALOGUE_FA[ADMIN_MENU_BUTTON.label]);

    const opened = await runtime().handle(
      tenantA,
      systemActor('bot'),
      adminUpdate('/admin', TG.viewer),
    );
    expect(opened.replyKey).toBe('bot.admin.panel');
  });

  it('answers an ordinary customer who sends any panels callback as unknown input', async () => {
    /*
     * The crafted-callback case, end to end through the real runtime, for EVERY prefix
     * the section owns — including the one that archives. `telegramAdmins.resolve`
     * answers null for a customer, so the turn never reaches `adminTurn` and the reply
     * is the ordinary fallback: the customer learns nothing about what exists. A
     * registry entry pointed at the wrong guard would show up on exactly one prefix,
     * which is why the loop covers all of them.
     */
    for (const prefix of Object.values(PREFIX)) {
      sent = [];
      const data = prefix === PREFIX.panels ? prefix : `${prefix}${panelId}`;
      const result = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(data, TG.customer),
      );
      expect(result.replyKey, `${prefix} answered an administrator's reply`).toBe(
        'bot.unknown_command',
      );
    }
    /* And the panel is untouched by any of them. */
    const after = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(after.panel.status).toBe('ACTIVE');
  });

  it('answers an administrator with no panels permission as unknown input, not as a refusal', async () => {
    /*
     * A hand-made role holding `catalog.view` alone — NOT `sales`, which was the
     * fixture until WP2 and stopped being one.
     *
     * The premise this case needs is an administrator with NO section of the panel at
     * all, so `adminTurn` returns null before any panel is read and the answer is the
     * one a customer gets. `sales` was that until the customers section shipped: it
     * holds `users.view`, so it now HAS a section, opens the panel, and a callback into
     * a section it lacks reaches the handler and is denied there — which is correct and
     * is a different case from this one.
     *
     * `catalog.view` opens nothing in Telegram, and the case still proves what it says:
     * a distinct refusal here would confirm that the id names something.
     */
    await bindNewAdmin('no-section-tg-panels', TG.sales, { permissions: ['catalog.view'] });

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.detail}${panelId}`, TG.sales),
    );
    expect(result.replyKey).toBe('bot.unknown_command');
  });

  // =========================================================================
  // The fleet, and its paging
  // =========================================================================

  it('lists the live panels, one button each, and never an archived one', async () => {
    const second = await createPanel('Marzban B', 'panel-b');
    await archive(second);

    const result = await open(PREFIX.panels, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panels_section');
    expect(lastMessage()).toContain(`${PREFIX.detail}${panelId}`);
    expect(lastMessage(), 'an archived panel was offered').not.toContain(
      `${PREFIX.detail}${second}`,
    );
  });

  it('says there is no panel rather than drawing an empty section', async () => {
    await archive(panelId);

    const result = await open(PREFIX.panels, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panels_none');
  });

  it('carries no base URL in the fleet list', async () => {
    // The panel's own address, which is most of what somebody needs to go looking. The
    // button label is the NAME.
    const result = await open(PREFIX.panels, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panels_section');
    expect(lastMessage()).not.toContain(panel.baseUrl);
    expect(lastMessage()).toContain('Marzban A');
  });

  it('offers a further page only when the server says there is one, and that page works', async () => {
    /*
     * Eleven panels against a ten-row screen, so the page button is drawn — and then
     * FOLLOWED, because a cursor that encodes and does not decode is a button that
     * answers the unsupported-input fallback. That is the failure this case exists to
     * catch: the codec was written for a services list, and a panel cursor riding the
     * same 64 bytes is a claim worth proving rather than assuming.
     */
    for (let index = 0; index < 10; index += 1) {
      await createPanel(`Extra ${String(index)}`, `extra-${String(index)}`);
    }

    const first = await open(PREFIX.panels, TG.owner);
    expect(first.replyKey).toBe('bot.admin.panels_section');
    const markup = lastBody()?.['reply_markup'] as
      { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined;
    const rows = (markup?.inline_keyboard ?? []).flat();
    const more = rows.find((button) => button.callback_data.startsWith(PREFIX.page));
    expect(more, 'no further page was offered for eleven panels').toBeDefined();
    expect(more?.text).toBe(CATALOGUE_FA['bot.admin.panels_more_button']);

    sent = [];
    const second = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(more?.callback_data ?? '', TG.owner),
    );
    expect(second.replyKey, 'the page button did not open a page').toBe('bot.admin.panels_section');
    /* The second page is a DIFFERENT page: the first page's rows are not on it. */
    const firstPageRows = rows
      .filter((button) => button.callback_data.startsWith(PREFIX.detail))
      .map((button) => button.callback_data);
    for (const row of firstPageRows) {
      expect(lastMessage(), 'the page button repeated the first page').not.toContain(row);
    }
  });

  it('answers a forged page cursor as unknown input rather than casting it', async () => {
    // A cursor is client-supplied text. Decoded at the boundary, so a crafted one is
    // UNSUPPORTED before any query sees it.
    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`${PREFIX.page}not-a-cursor`, TG.owner),
    );
    expect(result.replyKey).toBe('bot.unknown_command');
  });

  // =========================================================================
  // One panel
  // =========================================================================

  it('carries the identity, the health, the occupancy — and no address, credential or body', async () => {
    await ctx.container.panels.testConnection(tenantA, owner, panelId, {
      idempotencyKey: 'tg-detail-probe',
    });

    const result = await open(`${PREFIX.detail}${panelId}`, TG.owner);
    expect(result.replyKey).toBe('bot.admin.panel_detail');

    const body = String(lastBody()?.['text'] ?? '');
    expect(body).toContain('Marzban A');
    expect(body).toContain('Marzban');
    expect(body).toContain('ACTIVE');
    expect(body).toContain('HEALTHY');

    /*
     * The four things that may never be in a chat. The credentials are the fake
     * panel's real ones, which is what makes this assertion meaningful rather than a
     * search for a string nothing holds.
     */
    expect(body, 'the base URL reached a chat').not.toContain(panel.baseUrl);
    expect(body, 'a credential reached a chat').not.toContain(panel.password);
    expect(body, 'a credential reached a chat').not.toContain(panel.username);
    expect(body, 'a masked stand-in was rendered').not.toContain('****');
  });

  it('reports the occupancy as three separate figures, and an absent cap as neither zero nor a number', async () => {
    const result = await open(`${PREFIX.detail}${panelId}`, TG.owner);
    const body = String(lastBody()?.['text'] ?? '');

    expect(result.replyKey).toBe('bot.admin.panel_detail');
    /*
     * A null cap renders as a dash. `0` would read as a full panel — the exact
     * inversion the null means — and that is the whole reason `cap` is a STRING
     * placeholder rather than a number.
     */
    expect(body).toContain('—');
    expect(body).not.toMatch(/سقف سرویس:\s*0/u);
  });

  it('renders the failure KIND from the taxonomy and never the provider body', async () => {
    /*
     * The probe is pointed at a panel that answers with a body, so there IS a body to
     * leak. What the detail carries is the frozen kind.
     */
    await panel.close();
    await ctx.container.panels.testConnection(tenantA, owner, panelId, {
      idempotencyKey: 'tg-detail-failed-probe',
    });

    const result = await open(`${PREFIX.detail}${panelId}`, TG.owner);
    const body = String(lastBody()?.['text'] ?? '');

    expect(result.replyKey).toBe('bot.admin.panel_detail');
    expect(body).toMatch(/UNREACHABLE|AUTH_FAILED|CONNECTION_FAILED|TIMEOUT|NETWORK/u);
    expect(body, 'the provider body reached a chat').not.toContain(panel.baseUrl);
  });

  it('answers an unknown panel and another tenant’s panel with the same sentence', async () => {
    /*
     * ONE answer for three cases — unknown, another tenant's, malformed — so nobody
     * holding a panel id can learn whether it exists. The cross-tenant half needs a
     * real panel in tenant B, because an id that names nothing would pass a check that
     * only looked up by id.
     */
    ctx.container.setInstallationTenant(tenantB.tenantId);
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-b-panels',
        roleKeys: ['owner'],
      }),
    );
    const theirs = await ctx.container.panels.create(tenantB, ownerB, {
      name: 'Theirs',
      providerType: 'sanaei',
      baseUrl: 'https://theirs.example.test',
      credentials: { username: 'x', password: 'y' },
      idempotencyKey: 'panel-b-tg',
    });
    ctx.container.setInstallationTenant(tenantA.tenantId);

    const unknown = await open(`${PREFIX.detail}${ctx.container.ids.uuid()}`, TG.owner);
    expect(unknown.replyKey).toBe('bot.admin.panel_gone');

    const crossTenant = await open(`${PREFIX.detail}${theirs.view.panel.id}`, TG.owner);
    expect(crossTenant.replyKey).toBe('bot.admin.panel_gone');
  });

  it('draws no action for an administrator who may only view, and refuses the callback anyway', async () => {
    await bindNewAdmin('panels-viewer-actions', TG.viewer, { permissions: ['panels.view'] });

    const detail = await open(`${PREFIX.detail}${panelId}`, TG.viewer);
    expect(detail.replyKey).toBe('bot.admin.panel_detail');
    for (const prefix of [PREFIX.test, PREFIX.disable, PREFIX.archiveAsk]) {
      expect(lastMessage(), `${prefix} was drawn for a viewer`).not.toContain(prefix);
    }

    /* And the callback sent anyway is refused by the SERVICE, not by the absent button. */
    const acted = await open(`${PREFIX.disable}${panelId}`, TG.viewer);
    expect(acted.replyKey).toBe('bot.admin.refused');
    const after = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(after.panel.status, 'a viewer disabled a panel').toBe('ACTIVE');
  });

  // =========================================================================
  // The four actions
  // =========================================================================

  it('runs a real probe, and says so', async () => {
    const result = await open(`${PREFIX.test}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_tested');
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.health?.state).toBe('HEALTHY');
  });

  it('says a replay was a replay rather than claiming a probe that did not happen', async () => {
    /*
     * The same turn twice. The idempotency key is the TURN's, so the second call is a
     * replay and `probed` is false — and reporting that as "tested" is the legacy
     * "✅ updated" for a write that did nothing.
     */
    const update = tapUpdate(`${PREFIX.test}${panelId}`, TG.owner);
    const first = await runtime().handle(tenantA, systemActor('bot'), update);
    expect(first.replyKey).toBe('bot.admin.panel_tested');

    const second = await runtime().handle(tenantA, systemActor('bot'), update);
    expect(second.replyKey).toBe('bot.admin.panel_test_replayed');
  });

  it('disables a panel, and says what that does not do', async () => {
    const result = await open(`${PREFIX.disable}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_disabled');
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.panel.status).toBe('DISABLED');
  });

  it('refuses to enable a panel nobody has successfully tested, and names the remedy', async () => {
    /*
     * The enable gate, reached from Telegram. The panel has never been probed, so the
     * validation does not exist — and the answer is its own sentence rather than the
     * one that points at the Web Admin, because the remedy is the Test button on the
     * same screen.
     */
    await open(`${PREFIX.disable}${panelId}`, TG.owner);

    const result = await open(`${PREFIX.enable}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_not_validated');
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.panel.status).toBe('DISABLED');
  });

  it('enables a panel a connection test vouches for', async () => {
    await open(`${PREFIX.disable}${panelId}`, TG.owner);
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const result = await open(`${PREFIX.enable}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_enabled');
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.panel.status).toBe('ACTIVE');
  });

  it('does not archive on the asking callback', async () => {
    /*
     * `W:` opens the question and `X:` archives. The two differ by one character, and
     * a mis-wiring makes the detail screen a one-tap archive from a phone.
     */
    const result = await open(`${PREFIX.archiveAsk}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_archive_ask');
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.panel.status, 'the asking callback archived the panel').toBe('ACTIVE');
  });

  it('puts the number of services still on the panel into the question', async () => {
    const result = await open(`${PREFIX.archiveAsk}${panelId}`, TG.owner);
    const body = String(lastBody()?.['text'] ?? '');

    expect(result.replyKey).toBe('bot.admin.panel_archive_ask');
    /* Zero here, and zero is the honest answer for a panel nothing is on. */
    expect(body).toMatch(/0/u);
    expect(lastMessage(), 'the confirming callback was not offered').toContain(
      `${PREFIX.archive}${panelId}`,
    );
  });

  it('refuses the archive question to an administrator without panels.edit', async () => {
    await bindNewAdmin('panels-viewer-ask', TG.viewer, { permissions: ['panels.view'] });

    const result = await open(`${PREFIX.archiveAsk}${panelId}`, TG.viewer);

    expect(result.replyKey).toBe('bot.admin.panel_unavailable');
    expect(lastMessage(), 'the archiving callback was offered to a viewer').not.toContain(
      PREFIX.archive,
    );
  });

  it('answers the archive question with a refusal once the panel is already archived', async () => {
    /*
     * The stale-callback case. The question screen re-reads the panel rather than
     * trusting the tap, so a button drawn before somebody else archived it answers a
     * refusal instead of offering a confirmation for a state that has passed.
     */
    await archive(panelId);

    const result = await open(`${PREFIX.archiveAsk}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_unavailable');
  });

  it('archives on the confirming callback, and says where a restore happens', async () => {
    const result = await open(`${PREFIX.archive}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_archived');
    const view = await ctx.container.panels.get(tenantA, owner, panelId);
    expect(view.panel.status).toBe('ARCHIVED');
  });

  it('answers an action on a panel that has moved with one sentence, and changes nothing', async () => {
    /*
     * A stale button: the panel was archived after the detail was drawn, and
     * `testConnection` refuses an ARCHIVED panel. One sentence for every such refusal
     * on this surface — the reason is named in the Web Admin, and the audit row and the
     * operational log carry the distinction.
     */
    await archive(panelId);

    const result = await open(`${PREFIX.test}${panelId}`, TG.owner);

    expect(result.replyKey).toBe('bot.admin.panel_unavailable');
  });

  it('records an audit row for every action, so nothing here is unattributed', async () => {
    await open(`${PREFIX.disable}${panelId}`, TG.owner);

    const rows = await ctx.container.database.db.execute(sql`
      SELECT actor_id, actor_type, action, source_surface FROM audit_logs
       WHERE tenant_id = ${tenantA.tenantId} AND entity_id = ${panelId}
       ORDER BY occurred_at DESC`);
    const latest = (rows as unknown as { rows: Record<string, unknown>[] }).rows[0];
    /*
     * `TELEGRAM_ADMIN`, not `SYSTEM_JOB`: the turn arrives as the bot and `adminTurn`
     * re-actors it as the administrator whose binding it resolved, so the row names
     * the person who pressed the button rather than the process that received the
     * update. That is the whole reason `adminTurn` exists as a separate step.
     */
    expect(latest?.['actor_type'], 'the bot was recorded instead of the person').toBe(
      'TELEGRAM_ADMIN',
    );
    expect(latest?.['actor_id']).toBe(ownerAId);
    /*
     * And the SURFACE, which is the half a reviewer reading the row later needs: the
     * same action is available in the Web Admin, and "who did this, and from where"
     * is one question.
     */
    expect(latest?.['source_surface']).toBe('TELEGRAM');
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastBody = () => messages()[messages().length - 1]?.body;
  const lastMessage = () => JSON.stringify(messages()[messages().length - 1] ?? {});

  /** One tap, with the outbound record cleared first so `lastMessage` is this turn's. */
  const open = async (data: string, telegramUserId: string) => {
    sent = [];
    return runtime().handle(tenantA, systemActor('bot'), tapUpdate(data, telegramUserId));
  };

  const bind = (adminId: AdminId, telegramUserId: string) =>
    ctx.container.adminManagement.setTelegramBinding(tenantA, owner, adminId, {
      telegramUserId,
      reason: 'test binding',
    });

  const archive = (id: string) =>
    ctx.container.panels.setStatus(tenantA, owner, id, {
      status: 'ARCHIVED',
      idempotencyKey: `archive-${id}`,
    });

  const createPanel = async (name: string, key: string): Promise<string> => {
    const created = await ctx.container.panels.create(tenantA, owner, {
      name,
      providerType: 'sanaei',
      baseUrl: `https://${key}.example.test`,
      credentials: { username: 'x', password: 'y' },
      idempotencyKey: `panel-${key}`,
    });
    return created.view.panel.id;
  };

  /**
   * An administrator with either a seeded role or a hand-made one, bound to a chat.
   *
   * The `permissions` form exists for the cases about ONE key: no seeded role holds
   * `panels.view` without `panels.edit`, so a case that borrowed one would be testing
   * a different question.
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
});
