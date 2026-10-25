import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMER_CAPTURE_PURPOSES } from '@nexa/contracts';

/**
 * v0.8.2 hotfix: a window a customer's button opens must be READ by the handler the next
 * message reaches. The behaviour, lane by lane through the real router, is
 * `tests/integration/capture-lanes-e2e.test.ts`; this is the cheap half that fails the moment
 * a capture purpose exists with no branch in the router's text dispatch, or the file path
 * stops offering a file to one of the three file windows.
 */

const ROUTER = readFileSync(
  resolve(__dirname, '../../apps/api/src/surfaces/telegram/bot-runtime.ts'),
  'utf8',
);

/** The body of one `BotRuntime` member, from its declaration to the next member's. */
function memberBody(signature: string): string {
  const start = ROUTER.indexOf(signature);
  expect(start, `${signature} is in bot-runtime.ts`).toBeGreaterThan(-1);
  const rest = ROUTER.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:\/\*\*|async |private |readonly |get |[a-zA-Z]+\()/u);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('every customer capture purpose is dispatched by the router', () => {
  const dispatch = memberBody('async capturedText(');

  it.each(CUSTOMER_CAPTURE_PURPOSES.filter((purpose) => purpose !== 'SERVICE_NOTE'))(
    '%s has its own branch in capturedText',
    (purpose) => {
      expect(dispatch).toContain(`capture.purpose === '${purpose}'`);
    },
  );

  it('SERVICE_NOTE is the one fallthrough, and it is named as such', () => {
    expect(dispatch).toContain('// SERVICE_NOTE:');
    expect(dispatch).not.toContain(`capture.purpose === 'SERVICE_NOTE'`);
  });
});

describe('a file is offered to every file window, in order', () => {
  it('a ticket window, then the TonPays receipt window (first or remainder), then the manual one', () => {
    const start = ROUTER.indexOf("command.intent === 'RECEIPT_UPLOAD'");
    expect(start).toBeGreaterThan(-1);
    const branch = ROUTER.slice(start, ROUTER.indexOf('\n    }\n', start));
    const ticket = branch.indexOf('supportFlow.ticketFile(');
    const gateway = branch.indexOf('cardReceiptFlow.gatewayReceiptPhoto(');
    const manual = branch.indexOf('cardReceiptFlow.submitReceipt(');
    expect(ticket, 'the ticket file window').toBeGreaterThan(-1);
    expect(gateway, 'the TonPays receipt window').toBeGreaterThan(ticket);
    expect(manual, 'the manual receipt window').toBeGreaterThan(gateway);
  });
});
