import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ANTI_SPAM_CUSTOMER_BLOCKED_CODE,
  INTERNAL_UNHANDLED_CODE,
  JOB_LOOP_RECOVERED_CODE,
  JOB_LOOP_STALLED_CODE,
  OPS_AGGREGATION_WINDOW_MS,
  OPS_ERROR_CLASSES,
  OPS_ERROR_CLASS_POLICY,
  OPS_ERROR_EVENTS,
  OPS_ERROR_PRESENTATION_TEMPLATES,
  PAYMENT_LINK_CAUSE_TOKENS,
  PAYMENT_LINK_CREATE_FAILED_CODE,
  PAYMENT_LINK_FAILURE_KINDS,
  opsAggregationKey,
  opsErrorClassOf,
  opsErrorEventFor,
  opsErrorPresentationOf,
  opsLogTopicForCode,
  templateDefinition,
  type OperationalEventInput,
  type PaymentLinkFailureKind,
  type TenantContext,
  type TenantId,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import {
  REDACTED,
  redactCardNumbers,
  redactOperatorText,
  redactUrls,
} from '../../apps/api/src/infrastructure/redaction';
import {
  httpStatusOfCode,
  recordQuietly,
  safeIdentifier,
  safeTelegramUserId,
  sanitizedErrorCode,
} from '../../apps/api/src/modules/platform/opslog/application/error-events';
import {
  LOOP_STALL_RERECORD_MS,
  LoopStallReporter,
  loopStallConditionKey,
} from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';
import {
  GATEWAY_CREATE_UNKNOWN_EVENT_CODE,
  paymentLinkConfigurationFailure,
  paymentLinkFailureEvent,
  paymentLinkFailureOf,
  paymentLinkInterruptedFailure,
  type PaymentLinkFailureFacts,
} from '../../apps/api/src/modules/commerce/payments/application/payment-link-failure';
import { GATEWAY_CREATE_UNKNOWN_CODE } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import type { GatewayCreateOutcome } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import { paymentLinkFailureValues } from '../../apps/api/src/modules/control/notifications/application/payment-link-presentation';
import { NotifyingOperationalEventRecorder } from '../../apps/api/src/modules/control/notifications/application/operational-event-projector';

/**
 * FIX-04 / FIX-05 — the taxonomy, the payment-link mapping, the group presentation and
 * the redaction it relies on. Synthetic data only.
 */

const API_KEY = 'tp_live_KEY_that_must_never_leak_71c0de';
const BOT_TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const PAN = '6037991234567893'; // Luhn-valid
const SIGNED_LINK = 'https://pay.tonpays.online/i/TP-1?sig=deadbeefcafe';

const AT = new Date('2026-10-09T09:37:00Z');
const FACTS: PaymentLinkFailureFacts = {
  provider: 'TONPAYS',
  paymentId: '01900000-0000-7000-8000-00000000fa11',
  orderId: '01900000-0000-7000-8000-00000000fa12',
  providerOrderId: 'nx7d433a363380f69e',
  providerInvoiceId: null,
  trackingCode: '7d433a363380f69e',
  telegramUserId: '123456789',
  botInstanceId: '01900000-0000-7000-8000-00000000a001',
  elapsedMs: 812,
  at: AT,
};

const created = (
  overrides: Partial<Extract<GatewayCreateOutcome, { kind: 'CREATED' }>> = {},
): GatewayCreateOutcome => ({
  kind: 'CREATED',
  invoiceId: 'TP-1',
  orderId: FACTS.providerOrderId,
  invoiceUrl: null,
  webInvoiceUrl: null,
  status: 'pending',
  requestAmount: null,
  finalAmount: null,
  ...overrides,
});

// ---------------------------------------------------------------------------------------

describe('the taxonomy (FIX-05)', () => {
  it('gives every class a policy, and SECURITY a stored severity the CHECK constraint accepts', () => {
    for (const eventClass of OPS_ERROR_CLASSES) {
      expect(OPS_ERROR_CLASS_POLICY[eventClass].when.length).toBeGreaterThan(20);
    }
    expect(OPS_ERROR_CLASS_POLICY.SECURITY.storedSeverity).toBe('WARN');
    expect(OPS_ERROR_CLASS_POLICY.ERROR.storedSeverity).toBe('ERROR');
  });

  it('classifies every code once, and every recovery closes a failure the table knows', () => {
    const codes = OPS_ERROR_EVENTS.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of OPS_ERROR_EVENTS) {
      if (entry.kind === 'RECOVERY') {
        expect(entry.recovers, entry.code).toBeDefined();
        expect(opsErrorEventFor(entry.recovers!)?.kind, entry.code).toBe('FAILURE');
      }
    }
  });

  it('carries the codes this fix adds, each routed to the topic its prefix names', () => {
    expect(opsErrorEventFor(PAYMENT_LINK_CREATE_FAILED_CODE)).toMatchObject({
      area: 'PAYMENTS',
      dedupe: 'WINDOW',
      presentation: 'PAYMENT_LINK',
    });
    expect(opsLogTopicForCode(PAYMENT_LINK_CREATE_FAILED_CODE)).toBe('PAYMENTS');
    expect(opsErrorEventFor(ANTI_SPAM_CUSTOMER_BLOCKED_CODE)?.eventClass).toBe('SECURITY');
    expect(opsLogTopicForCode(ANTI_SPAM_CUSTOMER_BLOCKED_CODE)).toBe('SECURITY');
    expect(opsErrorEventFor(JOB_LOOP_RECOVERED_CODE)?.recovers).toBe(JOB_LOOP_STALLED_CODE);
    expect(opsLogTopicForCode(INTERNAL_UNHANDLED_CODE)).toBe('ERRORS');
  });

  it('presents a security code as SECURITY and everything else by its severity', () => {
    expect(opsErrorClassOf('access.permission_denied', 'WARN')).toBe('SECURITY');
    expect(opsErrorClassOf('admin.password_reset', 'INFO')).toBe('SECURITY');
    expect(opsErrorClassOf('provisioning.stalled', 'ERROR')).toBe('ERROR');
    expect(opsErrorClassOf('something.nobody.declared', 'DEBUG')).toBe('INFO');
    expect(opsErrorPresentationOf('payments.gateway_create_unknown')).toBe('PAYMENT_LINK');
    expect(opsErrorPresentationOf('something.nobody.declared')).toBe('GENERIC');
    expect(OPS_ERROR_PRESENTATION_TEMPLATES.PAYMENT_LINK).toBe(
      'ops.notification.payment_link_failed',
    );
  });

  it('keeps the UNKNOWN code the operators already filter on', () => {
    expect(GATEWAY_CREATE_UNKNOWN_CODE).toBe('payments.gateway_create_unknown');
    expect(GATEWAY_CREATE_UNKNOWN_EVENT_CODE).toBe(GATEWAY_CREATE_UNKNOWN_CODE);
  });

  it('aggregates within a window and announces again in the next', () => {
    const base = 'x:TONPAYS:TIMEOUT';
    const start = new Date(Math.floor(AT.getTime() / OPS_AGGREGATION_WINDOW_MS) * 3_600_000);
    expect(opsAggregationKey(base, start)).toBe(
      opsAggregationKey(base, new Date(start.getTime() + OPS_AGGREGATION_WINDOW_MS - 1)),
    );
    expect(opsAggregationKey(base, start)).not.toBe(
      opsAggregationKey(base, new Date(start.getTime() + OPS_AGGREGATION_WINDOW_MS)),
    );
  });
});

// ---------------------------------------------------------------------------------------
// The inventory: every code the source records is classified
// ---------------------------------------------------------------------------------------

const ROOT = join(__dirname, '..', '..');
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * The codes the source records: a `code:` beside a `severity:` in one object literal, its
 * value a literal or a constant declared anywhere in the API or the contracts. Support AI,
 * support knowledge and the legacy importer are out of this fix's scope (the owner's brief)
 * and are excluded by path, by name, here.
 */
function recordedCodes(): Map<string, Set<string>> {
  const files = [
    ...sourceFiles(join(ROOT, 'apps/api/src')),
    ...sourceFiles(join(ROOT, 'packages/contracts/src')),
  ];
  const constants = new Map<string, string>();
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /const ([A-Z][A-Z0-9_]*)\s*=\s*'([a-z_]+\.[a-z0-9_.]+)'/g,
    )) {
      constants.set(match[1]!, match[2]!);
    }
  }
  const found = new Map<string, Set<string>>();
  for (const file of files) {
    if (/support-ai|support-knowledge|legacy/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const severity of text.matchAll(/severity:\s*\S/g)) {
      const window = text.slice(Math.max(0, severity.index - 400), severity.index + 400);
      let best: RegExpExecArray | null = null;
      let distance = Infinity;
      for (const code of window.matchAll(
        /\bcode:\s*(?:'([a-z_]+\.[a-z0-9_.]+)'|([A-Z][A-Z0-9_]*)\b)/g,
      )) {
        const d = Math.abs(code.index - 400);
        if (d < distance) {
          distance = d;
          best = code as RegExpExecArray;
        }
      }
      if (best === null) continue;
      const code = best[1] ?? constants.get(best[2] ?? '');
      if (code === undefined) continue;
      const files = found.get(code) ?? new Set<string>();
      files.add(relative(ROOT, file));
      found.set(code, files);
    }
  }
  return found;
}

describe('the inventory (FIX-05): no recorded code is unclassified', () => {
  it('finds the codes the source records, and every one is in OPS_ERROR_EVENTS', () => {
    const found = recordedCodes();
    // The scanner itself is checked: a regex that silently matched nothing would make the
    // assertion below vacuous.
    expect(found.size).toBeGreaterThan(80);
    for (const known of [
      'payments.gateway_misconfigured',
      'telegram.turn_failed',
      'access.permission_denied',
      'antispam.customer_blocked',
      'internal.unhandled',
      'job.loop_stalled',
    ]) {
      expect([...found.keys()], known).toContain(known);
    }
    const unclassified = [...found]
      .filter(([code]) => opsErrorEventFor(code) === null)
      .map(([code, files]) => `${code} (${[...files].join(', ')})`);
    expect(unclassified).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// FIX-04: every failure case
// ---------------------------------------------------------------------------------------

describe('FIX-04: a payment link failure, classified once', () => {
  const cases: readonly {
    readonly name: string;
    readonly outcome: GatewayCreateOutcome;
    readonly form?: 'LINK' | 'CARD_TRANSFER';
    readonly kind: PaymentLinkFailureKind;
    readonly status: number | null;
    readonly classification: 'FINAL' | 'UNKNOWN';
  }[] = [
    { name: 'no link', outcome: created(), kind: 'NO_LINK', status: null, classification: 'FINAL' },
    {
      name: 'malformed link',
      outcome: created({ linkRejected: true }),
      kind: 'MALFORMED_LINK',
      status: null,
      classification: 'FINAL',
    },
    {
      name: 'no card',
      outcome: created({ instructions: null }),
      form: 'CARD_TRANSFER',
      kind: 'NO_CARD',
      status: null,
      classification: 'FINAL',
    },
    {
      name: '400',
      outcome: { kind: 'REFUSED', code: 'AMOUNT_TOO_LOW', configuration: false, httpStatus: 400 },
      kind: 'BAD_REQUEST',
      status: 400,
      classification: 'FINAL',
    },
    {
      name: '401',
      outcome: { kind: 'REFUSED', code: 'INVALID_API_KEY', configuration: true, httpStatus: 401 },
      kind: 'UNAUTHORIZED',
      status: 401,
      classification: 'FINAL',
    },
    {
      name: '403',
      outcome: { kind: 'REFUSED', code: 'ACCESS_DENIED', configuration: true, httpStatus: 403 },
      kind: 'FORBIDDEN',
      status: 403,
      classification: 'FINAL',
    },
    {
      name: '429 (final)',
      outcome: { kind: 'RATE_LIMITED', code: 'RATE_LIMIT_EXCEEDED', httpStatus: 429 },
      kind: 'RATE_LIMITED',
      status: 429,
      classification: 'FINAL',
    },
    {
      name: '5xx',
      outcome: { kind: 'UNKNOWN', code: 'http.502' },
      kind: 'PROVIDER_ERROR',
      status: 502,
      classification: 'UNKNOWN',
    },
    {
      name: 'an HTML page in front of the provider',
      outcome: { kind: 'UNKNOWN', code: 'http.403.unreadable.html' },
      kind: 'BAD_RESPONSE',
      status: 403,
      classification: 'UNKNOWN',
    },
    {
      name: 'timeout',
      outcome: { kind: 'UNKNOWN', code: 'http.timeout' },
      kind: 'TIMEOUT',
      status: null,
      classification: 'UNKNOWN',
    },
    {
      name: 'provider unreachable',
      outcome: { kind: 'UNKNOWN', code: 'http.network.ECONNREFUSED' },
      kind: 'UNREACHABLE',
      status: null,
      classification: 'UNKNOWN',
    },
    {
      name: 'unknown result',
      outcome: { kind: 'AMBIGUOUS', code: 'DUPLICATE_ORDER_ID', httpStatus: 409 },
      kind: 'UNKNOWN',
      status: 409,
      classification: 'UNKNOWN',
    },
    {
      name: 'an answer for another order',
      outcome: { kind: 'UNKNOWN', code: 'nexa.order_id_mismatch' },
      kind: 'UNKNOWN',
      status: null,
      classification: 'UNKNOWN',
    },
  ];

  for (const c of cases) {
    it(`${c.name} → ${c.kind} (${c.classification})`, () => {
      const failure = paymentLinkFailureOf(c.outcome, c.form ?? 'LINK', { rateLimitIsFinal: true });
      expect(failure).toMatchObject({
        kind: c.kind,
        httpStatus: c.status,
        classification: c.classification,
        retryable: PAYMENT_LINK_FAILURE_KINDS[c.kind].retryable,
      });
    });
  }

  it('tells a refused key on a 401 from one on a 403, through each adapter that reads one (Codex P2 #251)', async () => {
    const { NowPaymentsAdapter } =
      await import('../../apps/api/src/modules/commerce/payments/infrastructure/nowpayments-adapter');
    const { CentralPayAdapter } =
      await import('../../apps/api/src/modules/commerce/payments/infrastructure/centralpay-adapter');
    const answer = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    for (const [status, kind] of [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [400, 'BAD_REQUEST'],
    ] as const) {
      const now = new NowPaymentsAdapter({
        fetch: answer(status, {
          code: status === 400 ? 'AMOUNT_MINIMAL_ERROR' : 'INVALID_API_KEY',
        }),
      } as never);
      const outcome = await now.createInvoice('k', {
        orderId: 'NPORDER00000000000001',
        amount: 1000n,
        callbackUrl: null,
        buyerChatId: null,
        presentation: null,
      });
      const failure = paymentLinkFailureOf(outcome, 'LINK', { rateLimitIsFinal: true });
      expect(failure, `NOWPayments ${String(status)}`).toMatchObject({ kind, httpStatus: status });
    }
    const central = new CentralPayAdapter({ fetch: answer(400, { success: false }) } as never);
    const refused = await central.createInvoice('k', {
      orderId: '1234567890',
      amount: 150_000n,
      callbackUrl: 'https://bot.example.com/r',
      buyerChatId: null,
      presentation: null,
      providerUserId: '1987654321',
    });
    expect(refused).toMatchObject({ kind: 'REFUSED', httpStatus: 400 });
    expect(paymentLinkFailureOf(refused, 'LINK', { rateLimitIsFinal: true })?.httpStatus).toBe(400);
  });

  it('reports nothing for a usable invoice, or for a rate limit that will be asked again', () => {
    expect(
      paymentLinkFailureOf(created({ invoiceUrl: 'https://t.me/x' }), 'LINK', {
        rateLimitIsFinal: true,
      }),
    ).toBeNull();
    // A bot-sent invoice (Stars) has no link and needs none.
    expect(paymentLinkFailureOf(created(), 'BOT_INVOICE', { rateLimitIsFinal: true })).toBeNull();
    expect(
      paymentLinkFailureOf({ kind: 'RATE_LIMITED', code: 'RATE_LIMIT_EXCEEDED' }, 'LINK', {
        rateLimitIsFinal: false,
      }),
    ).toBeNull();
  });

  it('never calls a timeout, a 5xx or an unknown answer FINAL, and never retries one', () => {
    for (const code of ['http.timeout', 'http.502', 'http.network', 'nexa.send_interrupted']) {
      const failure = paymentLinkFailureOf({ kind: 'UNKNOWN', code }, 'LINK', {
        rateLimitIsFinal: true,
      });
      expect(failure?.classification, code).toBe('UNKNOWN');
      expect(failure?.creationState, code).toBe('CREATE_UNKNOWN');
    }
    expect(paymentLinkInterruptedFailure('nexa.send_interrupted').classification).toBe('UNKNOWN');
    expect(paymentLinkConfigurationFailure('nexa.credential_missing')).toMatchObject({
      kind: 'CONFIGURATION',
      classification: 'FINAL',
      retryable: false,
    });
  });

  it('is ONE event: the per-payment UNKNOWN code, or the windowed FINAL code', () => {
    const unknown = paymentLinkFailureEvent(
      paymentLinkFailureOf({ kind: 'UNKNOWN', code: 'http.timeout' }, 'LINK', {
        rateLimitIsFinal: true,
      })!,
      FACTS,
    );
    expect(unknown).toMatchObject({
      code: 'payments.gateway_create_unknown',
      severity: 'WARN',
      dedupeKey: `payments.gateway_create_unknown:${FACTS.paymentId}`,
    });
    const final = paymentLinkFailureEvent(
      paymentLinkFailureOf(
        { kind: 'REFUSED', code: 'INVALID_API_KEY', configuration: true, httpStatus: 401 },
        'LINK',
        { rateLimitIsFinal: true },
      )!,
      FACTS,
    );
    expect(final).toMatchObject({
      code: PAYMENT_LINK_CREATE_FAILED_CODE,
      severity: 'ERROR',
      dedupeKey: opsAggregationKey(`${PAYMENT_LINK_CREATE_FAILED_CODE}:TONPAYS:UNAUTHORIZED`, AT),
    });
    // A second customer's identical failure in the same window collapses onto that row.
    const second = paymentLinkFailureEvent(
      paymentLinkFailureOf(
        { kind: 'REFUSED', code: 'INVALID_API_KEY', configuration: true, httpStatus: 401 },
        'LINK',
        { rateLimitIsFinal: true },
      )!,
      {
        ...FACTS,
        paymentId: 'another',
        telegramUserId: '555',
        at: new Date(AT.getTime() + 60_000),
      },
    );
    expect(second.dedupeKey).toBe(final.dedupeKey);
    expect(final.context).toMatchObject({
      phase: 'PAYMENT_LINK_CREATE',
      category: 'PAYMENTS',
      provider: 'TONPAYS',
      method: 'GATEWAY',
      paymentId: FACTS.paymentId,
      orderId: FACTS.orderId,
      trackingCode: FACTS.trackingCode,
      telegramUserId: FACTS.telegramUserId,
      failureKind: 'UNAUTHORIZED',
      errorCode: 'INVALID_API_KEY',
      httpStatus: 401,
      retryable: false,
      classification: 'FINAL',
    });
  });

  it('drops a fact that is not what it claims to be rather than printing it', () => {
    const event = paymentLinkFailureEvent(
      paymentLinkFailureOf({ kind: 'UNKNOWN', code: `http.timeout ${API_KEY}` }, 'LINK', {
        rateLimitIsFinal: true,
      })!,
      {
        ...FACTS,
        trackingCode: SIGNED_LINK,
        telegramUserId: '@maryam',
        providerInvoiceId: PAN,
        orderId: `x ${BOT_TOKEN}`,
      },
    );
    const serialised = JSON.stringify(event);
    for (const secret of [API_KEY, BOT_TOKEN, SIGNED_LINK, PAN, '@maryam']) {
      expect(serialised).not.toContain(secret);
    }
    expect(event.context).not.toHaveProperty('trackingCode');
    expect(event.context).not.toHaveProperty('telegramUserId');
    expect(event.context).not.toHaveProperty('providerInvoiceId');
  });
});

// ---------------------------------------------------------------------------------------
// FIX-04: the group message
// ---------------------------------------------------------------------------------------

function renderPaymentLink(event: OperationalEventInput): string {
  const values = paymentLinkFailureValues(event.context, {
    eventId: 'evt_01900000-0000-7000-8000-00000000e001',
    occurrences: 1,
    at: AT,
    tenantId: '01900000-0000-7000-8000-000000000001',
  });
  expect(values).not.toBeNull();
  return renderTemplateBody(
    templateDefinition('ops.notification.payment_link_failed'),
    CATALOGUE_FA['ops.notification.payment_link_failed'],
    values!,
  );
}

describe('FIX-04: the Persian report in the group', () => {
  it('reads like the owner’s example: gateway, user, tracking code, phase, cause, status', () => {
    const text = renderPaymentLink(
      paymentLinkFailureEvent(
        paymentLinkFailureOf({ kind: 'UNKNOWN', code: 'http.502' }, 'LINK', {
          rateLimitIsFinal: true,
        })!,
        FACTS,
      ),
    );
    expect(text.split('\n')[0]).toBe('🚨 خطای ساخت لینک پرداخت');
    expect(text).toContain('درگاه: TONPAYS');
    expect(text).toContain('کاربر: <code>123456789</code>');
    expect(text).toContain('کد پیگیری پرداخت: <code>7d433a363380f69e</code>');
    expect(text).toContain('مرحله: ایجاد پیش‌فاکتور (PAYMENT_LINK_CREATE)');
    expect(text).toContain('علت: پاسخ نامعتبر درگاه؛ خطای سمت درگاه (<code>http.502</code>)');
    expect(text).toContain('وضعیت HTTP درگاه: 502');
    expect(text).toContain('وضعیت: نیازمند بررسی');
    expect(text).toContain('شناسه رخداد: <code>evt_01900000-0000-7000-8000-00000000e001</code>');
    expect(text).toContain('زمان: 2026-10-09T09:37:00.000Z');
    // Exactly one cause line, one retry line and one status line survive.
    expect(text.match(/^علت: /gm)).toHaveLength(1);
    expect(text.match(/^تکرار: /gm)).toHaveLength(1);
    expect(text.match(/^وضعیت: /gm)).toHaveLength(1);
  });

  it('gives every failure kind its own line, and none of them an empty or raw token', () => {
    for (const kind of Object.keys(PAYMENT_LINK_CAUSE_TOKENS) as PaymentLinkFailureKind[]) {
      const values = paymentLinkFailureValues(
        {
          phase: 'PAYMENT_LINK_CREATE',
          provider: 'NOWPAYMENTS',
          failureKind: kind,
          errorCode: `code.${kind.toLowerCase()}`,
          classification: kind === 'UNKNOWN' ? 'UNKNOWN' : 'FINAL',
          creationState: 'CREATE_FAILED',
        },
        { eventId: 'e', occurrences: 3, at: AT, tenantId: 't' },
      )!;
      const text = renderTemplateBody(
        templateDefinition('ops.notification.payment_link_failed'),
        CATALOGUE_FA['ops.notification.payment_link_failed'],
        values,
      );
      const causes = text.split('\n').filter((line) => line.startsWith('علت: '));
      expect(causes, kind).toHaveLength(1);
      expect(causes[0], kind).toContain(`code.${kind.toLowerCase()}`);
      expect(text, kind).not.toMatch(/\{[A-Za-z]+\}/);
      expect(text, kind).toContain('تعداد رخداد در این بازه: 3');
    }
  });

  it('never prints a secret, a signed link or a card number, whatever the context holds', () => {
    const text = renderPaymentLink({
      code: PAYMENT_LINK_CREATE_FAILED_CODE,
      severity: 'ERROR',
      message: 'x',
      context: {
        phase: 'PAYMENT_LINK_CREATE',
        provider: 'TONPAYS',
        failureKind: 'BAD_REQUEST',
        errorCode: `refused ${API_KEY} ${SIGNED_LINK} ${PAN} token=${BOT_TOKEN}`,
        trackingCode: SIGNED_LINK,
        paymentId: `<b>${PAN}</b>`,
        telegramUserId: `${BOT_TOKEN}`,
        apiKey: API_KEY,
        invoiceUrl: SIGNED_LINK,
        card: PAN,
        classification: 'FINAL',
        creationState: 'CREATE_FAILED',
      },
    });
    for (const secret of [API_KEY, SIGNED_LINK, 'deadbeefcafe', PAN, BOT_TOKEN, 'AAHdqTcv']) {
      expect(text).not.toContain(secret);
    }
  });

  it('leaves an event of the same code in another shape to the generic layout', () => {
    expect(
      paymentLinkFailureValues(
        { paymentId: 'p', provider: 'TONPAYS', reason: 'http.timeout' },
        { eventId: 'e', occurrences: 1, at: AT, tenantId: 't' },
      ),
    ).toBeNull();
    // Even one that names a failure kind: without the mapping's phase it is not its shape.
    expect(
      paymentLinkFailureValues(
        { paymentId: 'p', provider: 'TONPAYS', failureKind: 'TIMEOUT', reason: 'http.timeout' },
        { eventId: 'e', occurrences: 1, at: AT, tenantId: 't' },
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Redaction (the ONE implementation)
// ---------------------------------------------------------------------------------------

describe('operator-text redaction', () => {
  it('removes a Luhn-valid card number, grouped or not, and keeps an id that is not one', () => {
    expect(redactCardNumbers(`card ${PAN} paid`)).toBe(`card ${REDACTED} paid`);
    expect(redactCardNumbers('card 6037-9912-3456-7893 paid')).toBe(`card ${REDACTED} paid`);
    expect(redactCardNumbers('card 6037 9912 3456 7893 paid')).toBe(`card ${REDACTED} paid`);
    // A Telegram id, a 13-digit amount that fails Luhn, a uuid: kept.
    expect(redactCardNumbers('user 123456789')).toBe('user 123456789');
    expect(redactCardNumbers('amount 1000000000001')).toBe('amount 1000000000001');
    expect(redactCardNumbers('01900000-0000-7000-8000-00000000fa11')).toBe(
      '01900000-0000-7000-8000-00000000fa11',
    );
  });

  it('removes every URL, scheme included', () => {
    expect(redactUrls(`see ${SIGNED_LINK} now`)).toBe(`see ${REDACTED} now`);
    expect(redactUrls('tg://resolve?domain=x&start=inv_1')).toBe(REDACTED);
  });

  it('composes all three, so a caller cannot apply two and believe it applied three', () => {
    const text = redactOperatorText(`token=${BOT_TOKEN} ${SIGNED_LINK} ${PAN}`);
    for (const secret of [BOT_TOKEN, SIGNED_LINK, PAN]) expect(text).not.toContain(secret);
  });

  it('keeps a machine code a machine code, and an id an id', () => {
    expect(sanitizedErrorCode('http.403.unreadable.html')).toBe('http.403.unreadable.html');
    expect(sanitizedErrorCode(`INVALID ${SIGNED_LINK}`)).not.toContain('tonpays.online');
    expect(safeIdentifier('7d433a363380f69e')).toBe('7d433a363380f69e');
    expect(safeIdentifier(PAN)).toBeNull();
    expect(safeIdentifier(SIGNED_LINK)).toBeNull();
    expect(safeTelegramUserId('123456789')).toBe('123456789');
    expect(safeTelegramUserId('@maryam')).toBeNull();
    expect(httpStatusOfCode('http.502')).toBe(502);
    expect(httpStatusOfCode('http.403.unreadable.html')).toBe(403);
    expect(httpStatusOfCode('http.timeout')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// The projector and the quiet recorder
// ---------------------------------------------------------------------------------------

const tenant = {
  tenantId: '01900000-0000-7000-8000-000000000001' as TenantId,
  botInstanceId: null,
};

function projectorWith(queue: (input: Record<string, unknown>) => Promise<void>) {
  let seq = 0;
  const inner = {
    record: async (_scope: unknown, event: OperationalEventInput) => ({
      id: `evt-${String((seq += 1))}`,
      code: event.code,
      severity: event.severity,
      message: event.message,
      occurrenceCount: 1,
      firstSeenAt: AT,
      lastSeenAt: AT,
      isNew: true,
      reopened: false,
    }),
  };
  const uow = {
    run: async (_scope: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
    runNested: async (_scope: unknown, _tx: unknown, work: (tx: unknown) => Promise<unknown>) =>
      work({}),
  };
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const recorder = new NotifyingOperationalEventRecorder(
    inner as never,
    { queue: (_scope: unknown, input: Record<string, unknown>) => queue(input) } as never,
    uow as never,
    logger as never,
  );
  return { recorder, logger };
}

describe('the projector lays each event out by its presentation', () => {
  it('queues the FIX-04 template for a payment-link failure, the generic one otherwise', async () => {
    const queued: Record<string, unknown>[] = [];
    const { recorder } = projectorWith(async (input) => {
      queued.push(input);
    });
    await recorder.record(
      tenant,
      paymentLinkFailureEvent(paymentLinkConfigurationFailure('nexa.credential_missing'), FACTS),
    );
    await recorder.record(tenant, {
      code: ANTI_SPAM_CUSTOMER_BLOCKED_CODE,
      severity: 'WARN',
      message: 'blocked',
      context: { telegramUserId: '123456789' },
    });
    expect(queued[0]).toMatchObject({
      templateKey: 'ops.notification.payment_link_failed',
      opsTopic: 'PAYMENTS',
      values: { gateway: 'TONPAYS', causeConfiguration: 'nexa.credential_missing' },
    });
    expect(queued[1]).toMatchObject({
      templateKey: 'ops.notification.operational_event',
      opsTopic: 'SECURITY',
      // The CLASS is what the group reads, though the row stores WARN.
      values: { severity: 'SECURITY' },
    });
  });

  it('keeps the event when its notification cannot be queued (a log-group failure is not a payment failure)', async () => {
    const { recorder, logger } = projectorWith(async () => {
      throw new Error('notifications table unavailable');
    });
    const recorded = await recorder.record(
      tenant,
      paymentLinkFailureEvent(paymentLinkConfigurationFailure('nexa.credential_missing'), FACTS),
    );
    expect(recorded.code).toBe(PAYMENT_LINK_CREATE_FAILED_CODE);
    expect(logger.error).toHaveBeenCalled();
  });

  it('recordQuietly never throws, and says what it could not record', async () => {
    const warn = vi.fn();
    const result = await recordQuietly(
      { record: () => Promise.reject(new Error(`db down ${API_KEY}`)) },
      tenant,
      { code: 'x.y', severity: 'ERROR', message: 'm' },
      { warn },
    );
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith({ code: 'x.y', error: 'Error' }, expect.any(String));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(API_KEY);
  });
});

// ---------------------------------------------------------------------------------------
// The job runner chokepoint
// ---------------------------------------------------------------------------------------

describe('a stalled worker loop is a condition in the operations log', () => {
  function reporterWith(open: string[] = []) {
    const events: OperationalEventInput[] = [];
    let now = AT.getTime();
    const openKeys = new Set(open);
    const recorder = {
      record: async (_scope: unknown, event: OperationalEventInput) => {
        events.push(event);
        return {} as never;
      },
    };
    const reporter = new LoopStallReporter({
      recorder,
      conditions: {
        openConditions: async (_scope: TenantContext, keys: readonly string[]) =>
          keys.some((key) => openKeys.has(key)) ? [JOB_LOOP_STALLED_CODE] : [],
      },
      scope: () => tenant,
      clock: { now: () => new Date(now) },
      logger: { warn: vi.fn() },
    });
    return { reporter, events, advance: (ms: number) => (now += ms) };
  }

  it('opens once per loop, re-records a lasting stall slowly, and closes it when fresh', async () => {
    const { reporter, events, advance } = reporterWith();
    await reporter.observe([{ name: 'gateway-payments', stalled: true }]);
    await reporter.observe([{ name: 'gateway-payments', stalled: true }]);
    expect(events.map((event) => event.code)).toEqual([JOB_LOOP_STALLED_CODE]);
    expect(events[0]).toMatchObject({
      severity: 'ERROR',
      dedupeKey: loopStallConditionKey('gateway-payments'),
    });
    advance(LOOP_STALL_RERECORD_MS);
    await reporter.observe([{ name: 'gateway-payments', stalled: true }]);
    expect(events).toHaveLength(2);
    await reporter.observe([{ name: 'gateway-payments', stalled: false }]);
    expect(events[2]).toMatchObject({
      code: JOB_LOOP_RECOVERED_CODE,
      recoversCode: JOB_LOOP_STALLED_CODE,
      recoversDedupeKey: loopStallConditionKey('gateway-payments'),
    });
    // Closed once: a fresh loop with nothing open records nothing more.
    await reporter.observe([{ name: 'gateway-payments', stalled: false }]);
    expect(events).toHaveLength(3);
  });

  it('closes a stall another process left open, once, on its first observation', async () => {
    const { reporter, events } = reporterWith([loopStallConditionKey('fx-refresh')]);
    await reporter.observe([
      { name: 'fx-refresh', stalled: false },
      { name: 'broadcasts', stalled: false },
    ]);
    expect(events.map((event) => [event.code, event.recoversDedupeKey])).toEqual([
      [JOB_LOOP_RECOVERED_CODE, loopStallConditionKey('fx-refresh')],
    ]);
  });

  it('never throws into the heartbeat', async () => {
    const reporter = new LoopStallReporter({
      recorder: { record: () => Promise.reject(new Error('down')) },
      conditions: { openConditions: () => Promise.reject(new Error('down')) },
      scope: () => tenant,
      clock: { now: () => AT },
      logger: { warn: vi.fn() },
    });
    await expect(
      reporter.observe([
        { name: 'a', stalled: true },
        { name: 'b', stalled: false },
      ]),
    ).resolves.toBeUndefined();
  });
});
