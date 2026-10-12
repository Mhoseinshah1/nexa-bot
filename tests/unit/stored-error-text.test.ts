import { describe, expect, it, vi } from 'vitest';
import { NexaError } from '@nexa/contracts';
import { REDACTED, redactStoredText } from '../../apps/api/src/infrastructure/redaction';
import { DomainErrorFilter } from '../../apps/api/src/surfaces/web/error.filter';
import type { Container } from '../../apps/api/src/container';

/**
 * FIX-04 (S4 + the NEEDS_TEST the audit left): two places an internal error's TEXT could
 * leave the process.
 *
 *   - a durable error column (`backup_runs.delivery_detail` and `failure_message`,
 *     `outbox_messages.last_error`, `provisioning_operations.failure_message`), which the
 *     Web Admin reads back and every backup copies — `redactStoredText` is what each of
 *     their writers now calls;
 *   - the body of a 500, which must carry a fixed sentence and the correlation id and
 *     nothing of the message or the stack. That was true and untested.
 *
 * Every credential below is synthetic.
 */

const FAKE_TOKEN = '7012345678:AAFakeTokenSynthetic0123456789xyzQ';
const TRANSPORT_TEXT = `Failed to parse URL from https://api.telegram.org:99999/bot${FAKE_TOKEN}/sendDocument`;

describe('redactStoredText', () => {
  it('redacts a transport error that quotes the request URL', () => {
    const stored = redactStoredText(`The request did not complete: ${TRANSPORT_TEXT}`);
    expect(stored).not.toContain(FAKE_TOKEN);
    expect(stored).not.toContain('AAFakeTokenSynthetic');
    expect(stored).toContain(REDACTED);
    expect(stored).toContain('The request did not complete');
  });

  it('passes null and undefined through, and plain text unchanged', () => {
    expect(redactStoredText(null)).toBeNull();
    expect(redactStoredText(undefined)).toBeUndefined();
    expect(redactStoredText('HTTP 400 (400): Bad Request: chat not found')).toBe(
      'HTTP 400 (400): Bad Request: chat not found',
    );
  });

  it('redacts a labelled secret in a provider answer', () => {
    expect(redactStoredText('panel said {"password":"hunter2-synthetic"}')).toBe(
      `panel said {"password":"${REDACTED}"}`,
    );
  });
});

interface Captured {
  status?: number;
  body?: unknown;
}

function run(exception: unknown): { captured: Captured; logged: unknown[] } {
  const captured: Captured = {};
  const logged: unknown[] = [];
  const reply = {
    status(code: number) {
      captured.status = code;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  };
  const container = {
    logger: { error: vi.fn((context: unknown) => logged.push(context)) },
    // No installation tenant: the operations-log report returns before writing.
    installationTenantId: null,
  } as unknown as Container;
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ method: 'POST', routeOptions: { url: '/api/x' } }),
    }),
  };
  new DomainErrorFilter(container).catch(exception, host as never);
  return { captured, logged };
}

describe('a 500 response body', () => {
  const internal = new Error(`database at 10.1.2.3:5432 refused: ${TRANSPORT_TEXT}`);
  const cases: [string, unknown][] = [
    ['an unhandled Error', internal],
    ['a thrown non-Error object', { message: TRANSPORT_TEXT, stack: 'at secret (/x.js:1:1)' }],
    ['a thrown string', TRANSPORT_TEXT],
    [
      'a NexaError of kind INTERNAL',
      new NexaError({ kind: 'INTERNAL', code: 'x.internal', message: TRANSPORT_TEXT }),
    ],
    [
      'a NexaError of kind CONFIGURATION',
      new NexaError({
        kind: 'CONFIGURATION',
        code: 'config.invalid',
        message: `TELEGRAM_BOT_TOKEN=${FAKE_TOKEN} is invalid`,
        details: { value: FAKE_TOKEN },
      }),
    ],
  ];

  it.each(cases)('%s carries no message, stack or detail', (_name, exception) => {
    const { captured } = run(exception);
    expect(captured.status).toBeGreaterThanOrEqual(500);
    const body = JSON.stringify(captured.body);
    expect(body).not.toContain('AAFakeTokenSynthetic');
    expect(body).not.toContain('api.telegram.org');
    expect(body).not.toContain('10.1.2.3');
    expect(body).not.toContain('Failed to parse');
    expect(body).not.toMatch(/\bat [\w<]/);
    expect(body).not.toContain('"details"');
    expect(body).not.toContain('"stack"');
    expect((captured.body as { error: { message: string } }).error.message).toBe(
      'An internal error occurred.',
    );
    expect((captured.body as { error: { correlationId: string } }).error.correlationId).toBe(
      'unknown',
    );
  });

  it('still logs the failure for the operator', () => {
    const { logged } = run(internal);
    expect(logged).toHaveLength(1);
  });
});
