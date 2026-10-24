import { describe, expect, it } from 'vitest';
import { OPS_ERROR_EVENTS } from '@nexa/contracts';
import {
  OPERATIONAL_EVENT_MESSAGES_FA,
  OPERATIONAL_EVENT_LABELS_FA,
  operationalEventMessageFa,
} from '@nexa/i18n';
import * as opsLog from '../../packages/i18n/src/ops-log.fa';

/**
 * Round 8 B6: nothing the operator reads in the operations group or the notification centre
 * is an English sentence. The heuristic is pinned here: TWO OR MORE adjacent Latin words
 * («The backup volume») are English prose. A single Latin token — Nexa, 7-Zip, a code, an
 * identifier, a unit — is allowed, and so are `{placeholders}`.
 */
export const ENGLISH_RUN = /(?<![A-Za-z0-9_.{])[A-Za-z]{2,}(?:[ ]+[A-Za-z]{2,})+(?![A-Za-z0-9_.}])/;

function withoutPlaceholders(text: string): string {
  return text.replace(/\{[A-Za-z0-9_.]+\}/g, ' ');
}

describe('operational messages read in Persian', () => {
  it('the heuristic catches English prose and spares identifiers', () => {
    expect(ENGLISH_RUN.test('The backup volume has room')).toBe(true);
    expect(ENGLISH_RUN.test('Customer replies are back')).toBe(true);
    expect(ENGLISH_RUN.test('بکاپ با 7-Zip و Nexa تأیید شد')).toBe(false);
    expect(ENGLISH_RUN.test('backup.disk_threshold_exceeded')).toBe(false);
  });

  it('every Persian sentence for an event is Persian, short enough to print, and has a known code', () => {
    const catalogued = new Set(OPS_ERROR_EVENTS.map((event) => event.code));
    for (const [code, message] of Object.entries(OPERATIONAL_EVENT_MESSAGES_FA)) {
      expect(ENGLISH_RUN.test(message), code).toBe(false);
      expect(message, code).toMatch(/[؀-ۿ]/);
      expect(message.length, code).toBeLessThanOrEqual(120);
      expect(catalogued.has(code) || code in OPERATIONAL_EVENT_LABELS_FA, code).toBe(true);
      expect(operationalEventMessageFa(code)).toBe(message);
    }
  });

  it('every operations-group template body (pinned and posted) has no English prose', () => {
    const bodies = Object.entries(opsLog).flatMap(([name, value]) =>
      typeof value === 'object' && value !== null
        ? Object.entries(value as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          )
        : [[name, value] as [string, unknown]].filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
    );
    expect(bodies.length).toBeGreaterThan(20);
    for (const [key, body] of bodies) {
      expect(ENGLISH_RUN.test(withoutPlaceholders(body)), key).toBe(false);
    }
  });

  it('the catalogued codes whose recorder writes English have a Persian sentence', () => {
    // Codes whose message is already Persian at the producer, or is replaced by a presenter's
    // own layout, are named here; adding a code to this list needs a reason in review.
    const readsInPersianAtSource = (code: string): boolean =>
      // Families whose presenters write their own Persian layout (prefix entries in the catalogue).
      code.endsWith('.') ||
      code.startsWith('backup.') ||
      code.startsWith('recovery.') ||
      code.startsWith('panel.health.') ||
      code === 'telegram.customer_send_ok' ||
      code === 'telegram.customer_send_failed' ||
      code === 'payments.gateway_create_unknown' ||
      code === 'payments.payment_link_create_failed';
    const missing = OPS_ERROR_EVENTS.map((event) => event.code).filter(
      (code) => !readsInPersianAtSource(code) && operationalEventMessageFa(code) === null,
    );
    // The list below is the audited remainder: events no producer writes an English sentence for.
    expect(missing).toEqual([]);
    for (const code of Object.keys(OPERATIONAL_EVENT_MESSAGES_FA)) {
      expect(missing).not.toContain(code);
    }
  });
});

describe('the operations group prints the Persian sentence, not the English log line', () => {
  it('shows fx.single_source in Persian as the message, the server message kept on the technical line', async () => {
    const { OperationalEventPresenter } =
      await import('../../apps/api/src/modules/commerce/ops-log/application/event-presenter');
    const { i18nOpsLogWords } =
      await import('../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words');
    const { NotifyingOperationalEventRecorder } =
      await import('../../apps/api/src/modules/control/notifications/application/operational-event-projector');
    const queued: { values: Record<string, unknown> }[] = [];
    const english = 'Only one exchange-rate source is healthy.';
    const projector = new NotifyingOperationalEventRecorder(
      {
        record: async (_scope: unknown, input: { code: string; message: string }) => ({
          id: 'ev-1',
          code: input.code,
          severity: 'WARN',
          message: input.message,
          occurrenceCount: 1,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          isNew: true,
          reopened: false,
        }),
      } as never,
      { queue: async (_s: unknown, input: never) => queued.push(input) } as never,
      {
        runNested: async (_s: unknown, _t: unknown, fn: (tx: unknown) => unknown) => fn({}),
      } as never,
      { error: () => undefined } as never,
      new OperationalEventPresenter({ facts: {} as never, words: i18nOpsLogWords }),
    );
    await projector.record(
      { tenantId: '01900000-0000-7000-8000-000000000001' as never, botInstanceId: null },
      { code: 'fx.single_source', severity: 'WARN', message: english },
      {},
    );
    const values = queued[0]?.values ?? {};
    expect(String(values['technical'])).toContain('fx.single_source');
    // Codex on #319: the identifying detail of the server's own message is not lost.
    expect(String(values['technical'])).toContain('exchange-rate');
    expect(ENGLISH_RUN.test(String(values['message']))).toBe(false);
    expect(values['message']).toBe(operationalEventMessageFa('fx.single_source'));
  });
});
