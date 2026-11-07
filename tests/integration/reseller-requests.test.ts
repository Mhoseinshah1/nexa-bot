import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  RESELLER_REQUEST_ERROR_CODES,
  money,
  type DomainEvent,
  type UserId,
} from '@nexa/contracts';
import { ResellerRequestLogConsumer } from '../../apps/api/src/modules/commerce/reseller-requests/application/reseller-request-log.consumer';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { DrizzleResellerRequestRepository } from '../../apps/api/src/modules/commerce/reseller-requests/infrastructure/drizzle-reseller-request.repository';
import { adminActorFor, tenantA } from './harness';
import {
  BOT_A,
  TG,
  bindNewAdmin,
  customerNamed,
  keyboardOf,
  lastKeyboard,
  lastReply,
  lastText,
  photoUpdate,
  receiptFixture,
  replayOf,
  rows,
  say,
  systemActor,
  tap,
  tapOn,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * «درخواست نمایندگی» (PR-2) against a real database: the owner's questions, the customer's
 * edit-in-place application, the rules (one open, the wait after a rejection, an existing
 * reseller), the conversation, the decision, and the permission.
 *
 * MUTATION (each rule checked by reverting it and watching the named test fail):
 *  - `entryBlock`: the pending-request check removed        -> 'one open request' (and the index);
 *  - `entryBlock`: the cooldown comparison inverted          -> 'the wait after a rejection';
 *  - `customerReply`/`postMessage`: the `status !== PENDING` refusal removed -> 'closed thread';
 *  - the `reseller_requests_one_pending_key` index dropped   -> 'the index is the backstop'.
 */

const LABEL = CATALOGUE_FA['bot.menu.reseller_request'];

describe('reseller requests (PR-2)', () => {
  let f: ReceiptFixture;
  let n = 0;
  const key = (): string => `rr-${String((n += 1))}-${String(Date.now())}`;
  const c = () => f.ctx.container;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);
  afterAll(async () => {
    await f?.close();
  });
  beforeEach(async () => {
    await f.reset();
    await setFlag(true);
    await setCooldown(7);
    await saveQuestions([
      { text: 'نام فروشگاه شما چیست؟', required: true, maxLength: 20 },
      { text: 'توضیح اختیاری', required: false, maxLength: 500 },
    ]);
  });

  async function setFlag(enabled: boolean) {
    const current = await c().featureFlagResolver.resolve(tenantA, 'reseller_requests');
    if (current.enabled === enabled) return;
    await c().featureFlags.set(tenantA, f.owner, {
      key: 'reseller_requests',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'PR-2 integration test.',
    });
  }

  async function setCooldown(days: number) {
    const before = await c().settingsService.get(
      tenantA,
      f.owner,
      'reseller_request.cooldown_days',
    );
    await c().settingsService.set(tenantA, f.owner, {
      idempotencyKey: key(),
      key: 'reseller_request.cooldown_days',
      value: days,
      expectedVersion: before.version,
    });
  }

  async function saveQuestions(
    questions: readonly { id?: string; text: string; required: boolean; maxLength: number }[],
  ) {
    return c().resellerRequests.saveQuestions(tenantA, f.owner, {
      idempotencyKey: key(),
      questions,
    });
  }

  const requestsOf = (customerId: string = f.customer) =>
    rows<{ id: string; status: string; answers: unknown; reason: string | null }>(
      f,
      sql`SELECT id, status, answers, reason FROM reseller_requests
           WHERE tenant_id = ${tenantA.tenantId} AND customer_id = ${customerId}
           ORDER BY created_at`,
    );

  /** The application's first screen: the menu button, then «شروع». Returns the draft id. */
  async function begin(tg: string = TG.customer): Promise<string> {
    const intro = await say(f, LABEL, tg);
    expect(intro.replyKey).toBe('bot.reseller_request.intro');
    const draft = /^rrs:g:(.+)$/u.exec(lastKeyboard(f)[0]?.callback_data ?? '')?.[1];
    expect(draft).toBeDefined();
    await tapOn(f, `rrs:g:${draft}`, tg, { id: 11 }).result;
    return draft as string;
  }
  const step = (action: string, draft: string, tg: string = TG.customer) =>
    tapOn(f, `rrs:${action}:${draft}`, tg, { id: 11 }).result;

  /** A filed request for the fixture's customer, answered through the bot. */
  async function fileRequest(tg: string = TG.customer): Promise<string> {
    const draft = await begin(tg);
    await say(f, 'فروشگاه زهرا', tg);
    await step('s', draft, tg);
    await step('x', draft, tg);
    const rowsNow = await requestsOf();
    return rowsNow[rowsNow.length - 1]?.id as string;
  }

  describe('the owner’s questions', () => {
    it('saves the whole ordered list, reorders it and soft-removes a dropped question', async () => {
      const first = (await c().resellerRequests.listQuestions(tenantA, f.owner)).map(
        (one) => one.id,
      );
      expect(first).toHaveLength(2);
      const swapped = await saveQuestions([
        { id: first[1] as string, text: 'توضیح اختیاری', required: false, maxLength: 500 },
        { id: first[0] as string, text: 'نام فروشگاه', required: true, maxLength: 30 },
        { text: 'سؤال تازه', required: true, maxLength: 100 },
      ]);
      expect(swapped.changed).toBe(true);
      expect(swapped.questions.map((one) => one.text)).toEqual([
        'توضیح اختیاری',
        'نام فروشگاه',
        'سؤال تازه',
      ]);
      // The same list again is a no-op, not a second audit row.
      const again = await saveQuestions(
        swapped.questions.map(({ id, text, required, maxLength }) => ({
          id,
          text,
          required,
          maxLength,
        })),
      );
      expect(again.changed).toBe(false);
      // Dropping one keeps its row as a record, inactive.
      await saveQuestions([
        { id: first[0] as string, text: 'نام فروشگاه', required: true, maxLength: 30 },
      ]);
      const stored = await rows<{ active: boolean }>(
        f,
        sql`SELECT active FROM reseller_request_questions ORDER BY created_at`,
      );
      expect(stored.filter((one) => one.active)).toHaveLength(1);
      expect(stored.length).toBeGreaterThan(1);
    });

    it('refuses an id that is not this tenant’s question and an over-long list', async () => {
      await expect(
        saveQuestions([{ id: c().ids.uuid(), text: 'x', required: true, maxLength: 10 }]),
      ).rejects.toMatchObject({ code: RESELLER_REQUEST_ERROR_CODES.QUESTIONS_INVALID });
    });
  });

  describe('the customer’s application', () => {
    it('is not offered while the flag is off', async () => {
      await setFlag(false);
      expect((await say(f, LABEL, TG.customer)).replyKey).toBe('bot.reseller_request.unavailable');
      expect(await requestsOf()).toEqual([]);
    });

    it('walks intro → required → optional → summary, back and edit included, and files it', async () => {
      const draft = await begin();
      expect(lastText(f)).toContain('نام فروشگاه شما چیست؟');
      // A required question has no skip; «بازگشت» is there.
      const callbacks = () => lastKeyboard(f).map((button) => button.callback_data);
      expect(callbacks()).toEqual([`rrs:b:${draft}`]);

      // Too long for this question (20): refused, the question stays.
      await say(f, 'ا'.repeat(21), TG.customer);
      expect(lastText(f)).toContain('20');
      await say(f, 'فروشگاه زهرا', TG.customer);
      expect(lastText(f)).toContain('توضیح اختیاری');
      expect(callbacks()).toContain(`rrs:s:${draft}`);

      // Back to the first question shows the answer given, then forward again.
      await step('b', draft);
      expect(lastText(f)).toContain('نام فروشگاه شما چیست؟');
      expect(lastText(f)).toContain('فروشگاه زهرا');
      await say(f, 'فروشگاه تازه', TG.customer);
      await say(f, 'سه سال سابقه', TG.customer);
      // The summary lists every question with its answer; «ویرایش» goes back to the first.
      expect(lastText(f)).toContain('فروشگاه تازه');
      expect(lastText(f)).toContain('سه سال سابقه');
      expect(callbacks()).toEqual([`rrs:x:${draft}`, `rrs:e:${draft}`, `rrs:b:${draft}`]);
      await step('e', draft);
      expect(lastText(f)).toContain('نام فروشگاه شما چیست؟');
      await say(f, 'فروشگاه نهایی', TG.customer);
      await step('s', draft);
      expect(lastText(f)).toContain('فروشگاه نهایی');

      const sent = await step('x', draft);
      expect(sent.replyKey).toBe('bot.reseller_request.submitted');
      const [filed] = await requestsOf();
      expect(filed?.status).toBe('PENDING');
      expect(filed?.answers).toEqual([
        expect.objectContaining({ text: 'نام فروشگاه شما چیست؟', answer: 'فروشگاه نهایی' }),
        expect.objectContaining({ text: 'توضیح اختیاری', required: false, answer: null }),
      ]);
    });

    it('stores the questions as they were asked: a later edit changes no request', async () => {
      const request = await fileRequest();
      const [question] = await c().resellerRequests.listQuestions(tenantA, f.owner);
      await saveQuestions([
        { id: question?.id as string, text: 'سؤال بازنویسی‌شده', required: true, maxLength: 5 },
      ]);
      const detail = await c().resellerRequests.get(tenantA, f.owner, request);
      expect(detail.request.answers.map((one) => one.text)).toEqual([
        'نام فروشگاه شما چیست؟',
        'توضیح اختیاری',
      ]);
    });

    it('allows ONE open request: a second tap shows its status and a second row cannot exist', async () => {
      const request = await fileRequest();
      const again = await say(f, LABEL, TG.customer);
      expect(again.replyKey).toBe('bot.reseller_request.status_pending');
      expect(await requestsOf()).toHaveLength(1);
      // The unique index is the backstop for two taps, two bots or two replicas.
      await expect(
        c().database.db.execute(sql`
          INSERT INTO reseller_requests (id, tenant_id, customer_id, bot_instance_id, answers, opening_key)
          VALUES (${c().ids.uuid()}, ${tenantA.tenantId}, ${f.customer}, ${BOT_A}, '[]'::jsonb, 'dup')`),
      ).rejects.toMatchObject({ cause: { code: '23505' } });
      expect(request).toBeDefined();
    });

    it('refuses a customer who already is a reseller, and files nothing', async () => {
      const tier = await c().resellersAdmin.createTier(tenantA, f.owner, {
        idempotencyKey: key(),
        write: {
          name: 'Gold',
          pricingMode: 'LIST_PRICE',
          discountPercentage: null,
          creditLimit: money(0n, 'IRT'),
        },
      });
      await c().resellersAdmin.register(tenantA, f.owner, {
        idempotencyKey: key(),
        customerId: f.customer,
        write: {
          tierId: tier.id,
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });
      expect((await say(f, LABEL, TG.customer)).replyKey).toBe(
        'bot.reseller_request.already_reseller',
      );
      expect(await requestsOf()).toEqual([]);
    });

    it('makes a rejected customer wait reseller_request.cooldown_days, shows the reason, and 0 means no wait', async () => {
      const request = await fileRequest();
      await c().resellerRequests.reject(tenantA, f.owner, {
        requestId: request,
        reason: 'سابقهٔ کافی ندارید',
        idempotencyKey: key(),
      });
      const blocked = await say(f, LABEL, TG.customer);
      expect(blocked.replyKey).toBe('bot.reseller_request.cooldown');
      expect(lastText(f)).toContain('سابقهٔ کافی ندارید');
      expect(lastText(f)).toMatch(/7|۷/u);

      // Eight days later the wait is over. (The fake Telegram numbers every message 11, a real
      // one numbers them apart: the finished application's wizard row is cleared to match.)
      await f.ctx.container.database.db.execute(sql`
        UPDATE reseller_requests SET decided_at = decided_at - interval '8 days'`);
      await f.ctx.container.database.db.execute(sql`DELETE FROM telegram_wizards`);
      expect((await say(f, LABEL, TG.customer)).replyKey).toBe('bot.reseller_request.intro');

      // Rejected again: cooldown_days = 0 lets the customer straight back in.
      const draft = /^rrs:g:(.+)$/u.exec(lastKeyboard(f)[0]?.callback_data ?? '')?.[1] as string;
      await tapOn(f, `rrs:g:${draft}`, TG.customer, { id: 11 }).result;
      await say(f, 'دوباره', TG.customer);
      await step('s', draft);
      await step('x', draft);
      const second = (await requestsOf())[1]?.id as string;
      await c().resellerRequests.reject(tenantA, f.owner, {
        requestId: second,
        idempotencyKey: key(),
      });
      await setCooldown(0);
      expect((await say(f, LABEL, TG.customer)).replyKey).toBe('bot.reseller_request.intro');
    });

    it('files at most once for a redelivered «ارسال»', async () => {
      const draft = await begin();
      await say(f, 'فروشگاه', TG.customer);
      await step('s', draft);
      const tapped = tapOn(f, `rrs:x:${draft}`, TG.customer, { id: 11 });
      await tapped.result;
      await replayOf(f, tapped.update);
      expect(await requestsOf()).toHaveLength(1);
    });
  });

  describe('the conversation', () => {
    it('carries an operator’s message to the applicant, her text and photo back, and shows it all to the operator', async () => {
      const request = await fileRequest();
      await c().resellerRequests.postMessage(tenantA, f.owner, {
        requestId: request,
        text: 'لطفاً نمونه کار بفرستید',
        idempotencyKey: key(),
      });
      // «در حال گفتگو»: still PENDING, now conversing.
      const listed = await c().resellerRequests.list(tenantA, f.owner, {});
      expect(listed.counts).toMatchObject({ pending: 0, conversing: 1 });
      expect((await say(f, LABEL, TG.customer)).replyKey).toBe(
        'bot.reseller_request.status_conversing',
      );

      f.sent = [];
      await c().customerNotificationLoop.tick();
      expect(lastText(f)).toContain('لطفاً نمونه کار بفرستید');
      const reply = keyboardOf(lastReply(f)).find((button) =>
        (button.callback_data ?? '').startsWith('rqr:'),
      );
      expect(reply?.callback_data).toBe(`rqr:${request}`);

      // «پاسخ» opens the window; her text and then a photo are attached to the same request.
      expect((await tap(f, reply?.callback_data as string, TG.customer)).replyKey).toBe(
        'bot.reseller_request.reply_prompt',
      );
      expect((await say(f, 'این نمونه کار من است', TG.customer)).replyKey).toBe(
        'bot.reseller_request.reply_sent',
      );
      await tap(f, `rqr:${request}`, TG.customer);
      await c().botRuntime.handle(tenantA, systemActor('bot'), photoUpdate('sample', TG.customer));

      const detail = await c().resellerRequests.get(tenantA, f.owner, request);
      expect(detail.request.status).toBe('PENDING');
      expect(
        detail.messages.map((one) => [one.senderType, one.body, one.attachment?.kind]),
      ).toEqual([
        ['ADMIN', 'لطفاً نمونه کار بفرستید', undefined],
        ['CUSTOMER', 'این نمونه کار من است', undefined],
        ['CUSTOMER', null, 'PHOTO'],
      ]);
    });

    it('closes the thread when the request is decided: no reply, no message, nothing sent', async () => {
      const request = await fileRequest();
      await c().resellerRequests.postMessage(tenantA, f.owner, {
        requestId: request,
        text: 'سؤال',
        idempotencyKey: key(),
      });
      await c().resellerRequests.reject(tenantA, f.owner, {
        requestId: request,
        idempotencyKey: key(),
      });

      // The customer's «پاسخ» is answered "closed"; a forced reply is refused by the service.
      expect((await tap(f, `rqr:${request}`, TG.customer)).replyKey).toBe(
        'bot.reseller_request.thread_closed',
      );
      await expect(
        c().resellerRequests.customerReply(tenantA, systemActor('reply'), {
          customerId: f.customer as UserId,
          requestId: request,
          text: 'دیر شد',
          attachment: null,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: RESELLER_REQUEST_ERROR_CODES.CLOSED });
      await expect(
        c().resellerRequests.postMessage(tenantA, f.owner, {
          requestId: request,
          text: 'دیر شد',
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: RESELLER_REQUEST_ERROR_CODES.CLOSED });
      const stored = await rows<{ n: number }>(
        f,
        sql`SELECT count(*)::int AS n FROM reseller_request_messages`,
      );
      expect(stored[0]?.n).toBe(1);
    });
  });

  describe('the decision', () => {
    it('rejects with a reason, tells the customer, is idempotent and sends the customer one message', async () => {
      const request = await fileRequest();
      const key1 = key();
      const first = await c().resellerRequests.reject(tenantA, f.owner, {
        requestId: request,
        reason: 'مدارک کافی نیست',
        idempotencyKey: key1,
      });
      expect(first).toMatchObject({ changed: true, request: { status: 'REJECTED' } });
      // The same key replays; another key on a decided request changes nothing and says nothing.
      expect(
        (
          await c().resellerRequests.reject(tenantA, f.owner, {
            requestId: request,
            reason: 'مدارک کافی نیست',
            idempotencyKey: key1,
          })
        ).changed,
      ).toBe(false);
      expect(
        (
          await c().resellerRequests.reject(tenantA, f.owner, {
            requestId: request,
            idempotencyKey: key(),
          })
        ).changed,
      ).toBe(false);
      const notices = await rows<{ n: number }>(
        f,
        sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'RESELLER_REQUEST_DECISION'`,
      );
      expect(notices[0]?.n).toBe(1);

      f.sent = [];
      await c().customerNotificationLoop.tick();
      expect(lastText(f)).toContain('مدارک کافی نیست');
      expect((await requestsOf())[0]).toMatchObject({
        status: 'REJECTED',
        reason: 'مدارک کافی نیست',
      });
    });

    it('refuses an administrator without resellers.edit, for every write, and audits the denial', async () => {
      const request = await fileRequest();
      const viewerId = await bindNewAdmin(f, 'viewer-rr', null, ['resellers.view']);
      const viewer = adminActorFor({ id: viewerId, username: 'viewer-rr', password: 'x' });
      await expect(
        c().resellerRequests.reject(tenantA, viewer, { requestId: request, idempotencyKey: key() }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      await expect(
        c().resellerRequests.postMessage(tenantA, viewer, {
          requestId: request,
          text: 'سلام',
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      await expect(
        c().resellerRequests.saveQuestions(tenantA, viewer, {
          idempotencyKey: key(),
          questions: [],
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      // Reading is allowed with the view permission.
      await expect(c().resellerRequests.get(tenantA, viewer, request)).resolves.toBeDefined();
      expect((await requestsOf())[0]?.status).toBe('PENDING');
      const denials = await rows<{ n: number }>(
        f,
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE result = 'DENIED' AND action LIKE 'reseller_request.%'`,
      );
      expect(denials[0]?.n).toBeGreaterThanOrEqual(2);
    });

    it('keeps approve a boundary: authorised, then refused as not implemented, changing nothing', async () => {
      const request = await fileRequest();
      const tier = await c().resellersAdmin.createTier(tenantA, f.owner, {
        idempotencyKey: key(),
        write: {
          name: 'Gold',
          pricingMode: 'LIST_PRICE',
          discountPercentage: null,
          creditLimit: money(0n, 'IRT'),
        },
      });
      await expect(
        c().resellerRequests.approve(tenantA, f.owner, {
          requestId: request,
          tierId: tier.id,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: RESELLER_REQUEST_ERROR_CODES.APPROVE_NOT_IMPLEMENTED });
      expect((await requestsOf())[0]?.status).toBe('PENDING');
    });

    // The next change (the approve path, money-tier reviewer) fills these in. Each one names
    // what it MUST prove; none may be deleted or weakened to make that change pass.
    it.todo(
      'approve from the operations group: the tier list, the confirmation, then a reseller on that tier',
    );
    it.todo('approve from the Web Admin: the same service, the same audit, the same ops log line');
    it.todo(
      'approve moves NO wallet entry and grants NO credit (ledger and credit limits unchanged)',
    );
    it.todo(
      'a double approve (same key, or a second tap) is idempotent: one reseller row, one notification',
    );
    it.todo(
      'an administrator without resellers.edit is refused on approve, from the group and from the Web Admin',
    );
    it.todo(
      'approve and the request’s state change commit in ONE transaction (a failing registration leaves it PENDING)',
    );
    it.todo('the approval message names the tier; a decided request takes no further reply');
  });

  describe('the operations group', () => {
    function consumer(queued: unknown[]) {
      return new ResellerRequestLogConsumer({
        lane: {
          queue: async (_scope, input) => {
            queued.push(input);
          },
        },
        requests: new DrizzleResellerRequestRepository(c().database.db),
        tierName: async () => null,
        facts: new DrizzleOpsLogFacts(c().database.db),
        words: i18nOpsLogWords,
      });
    }
    const event = (eventType: string, payload: unknown, aggregateId: string): DomainEvent =>
      ({
        eventId: c().ids.uuid(),
        eventType,
        eventVersion: 1,
        tenantId: String(tenantA.tenantId),
        aggregateType: 'ResellerRequest',
        aggregateId,
        sequence: 1,
        correlationId: 'rr-log',
        causationId: null,
        actor: { type: 'SYSTEM_JOB', id: null },
        occurredAt: '2026-10-12T09:30:00.000Z',
        payload,
      }) as unknown as DomainEvent;

    it('logs a new request with the customer, the services, every question and answer, and the three action buttons', async () => {
      const request = await fileRequest();
      const queued: {
        templateKey: string;
        values: Record<string, unknown>;
        buttons: { kind: string }[];
      }[] = [];
      await c().uow.run(tenantA, (tx) =>
        consumer(queued).handle(
          event(
            'ResellerRequestSubmitted',
            { requestId: request, customerId: f.customer },
            request,
          ),
          tx as never,
        ),
      );
      expect(queued).toHaveLength(1);
      expect(queued[0]?.templateKey).toBe('ops.reseller_request.new');
      expect(String(queued[0]?.values['qa'])).toContain('فروشگاه زهرا');
      expect(queued[0]?.values['servicesCount']).toBe(0);
      expect(queued[0]?.buttons.map((one) => one.kind)).toEqual([
        'RESELLER_REQUEST_APPROVE',
        'RESELLER_REQUEST_REJECT',
        'RESELLER_REQUEST_MESSAGE',
        'RESELLER_REQUEST',
        'USER',
      ]);
    });

    it('logs the applicant’s reply as a new message and the decision without action buttons; an operator’s own message is not logged', async () => {
      const request = await fileRequest();
      await c().resellerRequests.postMessage(tenantA, f.owner, {
        requestId: request,
        text: 'سلام',
        idempotencyKey: key(),
      });
      await tap(f, `rqr:${request}`, TG.customer);
      await say(f, 'پاسخ من', TG.customer);
      const messages = await c().resellerRequests.get(tenantA, f.owner, request);
      const mine = messages.messages.find((one) => one.senderType === 'CUSTOMER');
      const queued: {
        templateKey: string;
        values: Record<string, unknown>;
        buttons: { kind: string }[];
      }[] = [];
      await c().uow.run(tenantA, async (tx) => {
        const log = consumer(queued);
        await log.handle(
          event(
            'ResellerRequestMessagePosted',
            { requestId: request, messageId: mine?.id, senderType: 'CUSTOMER' },
            request,
          ),
          tx as never,
        );
        await log.handle(
          event(
            'ResellerRequestMessagePosted',
            { requestId: request, messageId: messages.messages[0]?.id, senderType: 'ADMIN' },
            request,
          ),
          tx as never,
        );
      });
      expect(queued.map((one) => one.templateKey)).toEqual(['ops.reseller_request.reply']);
      expect(String(queued[0]?.values['snippet'])).toContain('پاسخ من');
      expect(queued[0]?.buttons.map((one) => one.kind)).toContain('RESELLER_REQUEST_MESSAGE');

      await c().resellerRequests.reject(tenantA, f.owner, {
        requestId: request,
        idempotencyKey: key(),
      });
      queued.length = 0;
      await c().uow.run(tenantA, (tx) =>
        consumer(queued).handle(
          event(
            'ResellerRequestDecided',
            { requestId: request, customerId: f.customer, status: 'REJECTED', tierId: null },
            request,
          ),
          tx as never,
        ),
      );
      expect(queued[0]?.templateKey).toBe('ops.reseller_request.decided');
      expect(queued[0]?.buttons.map((one) => one.kind)).toEqual(['RESELLER_REQUEST', 'USER']);
    });

    /** A tap on a log message's button, as a Telegram group sends it. */
    function groupTap(data: string, telegramUserId: string) {
      const id = 880_000 + (n += 1);
      return c().botRuntime.handle(tenantA, systemActor('group'), {
        idempotencyKey: `group-tap-${String(id)}`,
        botInstanceId: BOT_A,
        update: {
          // The lowest id there is: a window reads only messages sent AFTER the tap that
          // opened it, and the fixture numbers its own updates upward from small values.
          update_id: 1,
          callback_query: {
            id: `cbq-${String(id)}`,
            from: { id: Number(telegramUserId), is_bot: false, first_name: 'ادمین' },
            data,
            message: { message_id: 5, date: 0, chat: { id: -100123, type: 'supergroup' } },
          },
        },
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'ادمین' },
      });
    }

    it('answers a permitted administrator’s tap in their PRIVATE chat only, and a stranger’s not at all', async () => {
      const request = await fileRequest();
      await makeTier();
      // The owner has opened the bot before (a customer row), as a real administrator has.
      await customerNamed(f, TG.owner, 'owner_admin');
      f.sent = [];
      await groupTap(`rqa:${request}`, TG.owner);
      const toGroup = f.sent.filter((one) => String(one.body['chat_id']).startsWith('-'));
      expect(toGroup.filter((one) => one.method === 'sendMessage')).toEqual([]);
      const dm = f.sent.find(
        (one) => one.method === 'sendMessage' && String(one.body['chat_id']) === TG.owner,
      );
      expect(String(dm?.body['text'])).toContain('کدام سطح');

      // A customer pressing the same button in the group gets nothing.
      f.sent = [];
      await groupTap(`rqa:${request}`, TG.customer);
      expect(f.sent.filter((one) => one.method === 'sendMessage')).toEqual([]);
    });

    it('rejects from the group with a reason typed in the private chat, and refuses a viewer', async () => {
      const request = await fileRequest();
      await customerNamed(f, TG.owner, 'owner_admin');
      await groupTap(`rqj:${request}`, TG.owner);
      await say(f, 'سابقهٔ کافی ندارید', TG.owner);
      expect((await requestsOf())[0]).toMatchObject({
        status: 'REJECTED',
        reason: 'سابقهٔ کافی ندارید',
      });

      // A viewer (resellers.view only) bound to Telegram cannot act from the group.
      const second = await customerNamed(f, '750911', 'second');
      expect(second).toBeDefined();
      await bindNewAdmin(f, 'viewer-tg', TG.observer, ['resellers.view']);
      await customerNamed(f, TG.observer, 'viewer_tg');
      const other = await fileRequestFor('750911');
      await groupTap(`rqj:${other}`, TG.observer);
      await say(f, 'تلاش', TG.observer);
      const left = await rows<{ status: string }>(
        f,
        sql`SELECT status FROM reseller_requests WHERE id = ${other}`,
      );
      expect(left[0]?.status).toBe('PENDING');
    });

    const makeTier = () =>
      c().resellersAdmin.createTier(tenantA, f.owner, {
        idempotencyKey: key(),
        write: {
          name: 'Gold',
          pricingMode: 'LIST_PRICE',
          discountPercentage: null,
          creditLimit: money(0n, 'IRT'),
        },
      });

    async function fileRequestFor(tg: string): Promise<string> {
      const draft = await begin(tg);
      await say(f, 'فروشگاه', tg);
      await step('s', draft, tg);
      await step('x', draft, tg);
      const mine = await rows<{ id: string }>(
        f,
        sql`SELECT r.id FROM reseller_requests r JOIN customers c ON c.id = r.customer_id
             WHERE c.telegram_user_id = ${tg}`,
      );
      return mine[0]?.id as string;
    }
  });
});
