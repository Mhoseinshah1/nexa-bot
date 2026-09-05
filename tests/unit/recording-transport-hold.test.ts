import { describe, expect, it } from 'vitest';
import { RecordingTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/recording-transport';
import type { OutboundMessage } from '../../apps/api/src/modules/control/notifications/application/ports';

const message: OutboundMessage = {
  // The real destination union is discriminated on `transport`, and carries a
  // topic because the destination group may use forum topics. The fixture had
  // drifted to a `kind: 'TELEGRAM_CHAT'` shape that no longer exists, and a
  // top-level `transport` that the message itself does not carry — neither of
  // which anything checked, because this file was outside the test typecheck.
  destination: { transport: 'TELEGRAM', chatId: '-100999', topicId: null },
  text: 'the panel did not answer',
  html: false,
  tenantId: '01a06426-4d8d-741f-9985-656d51b61001',
};

/**
 * The parked send is a test instrument, and a test instrument that can hang the
 * suite is worse than no instrument at all.
 *
 * The ordering enumeration releases every hold it takes, so nothing there
 * exercises the failure this guards. But the enumeration is 1 125 orderings
 * long and shares one transport: a future ordering that returns early — an
 * added `continue`, a thrown assertion, a `break` — leaves a send parked
 * holding a claimed row while the next ordering truncates the tables under it.
 * The file then hangs to its ten-minute timeout rather than failing, and a
 * timeout says nothing about which ordering was wrong.
 *
 * `reset()` is the drain. The first version could not reach a send that had
 * actually entered — `send()` cleared the field before parking, so the release
 * only ever found a hold that had been armed and never used, which is the case
 * that needs no rescue. The docblock claimed the opposite.
 */
describe('RecordingTransport hold', () => {
  const settles = async (promise: Promise<unknown>): Promise<boolean> => {
    const pending = Symbol('pending');
    const raced = await Promise.race([
      promise.then(() => 'settled' as const),
      new Promise((resolve) => setTimeout(() => resolve(pending), 50)),
    ]);
    return raced === 'settled';
  };

  it('parks the send until it is released', async () => {
    const transport = new RecordingTransport();
    const hold = transport.holdNextSend();
    const send = transport.send(message);
    await hold.entered;

    expect(await settles(send), 'the send did not park').toBe(false);
    hold.release();
    await expect(send).resolves.toEqual({ outcome: 'SUCCEEDED' });
  });

  it('releases a send that has ALREADY entered when it is reset', async () => {
    const transport = new RecordingTransport();
    const hold = transport.holdNextSend();
    const send = transport.send(message);
    await hold.entered;

    // No `hold.release()`. This is the forgotten hold, and `reset()` is the
    // only thing standing between it and a ten-minute hang.
    transport.reset();
    expect(await settles(send), 'reset() left an entered send parked').toBe(true);
  });

  it('releases a hold that was armed but never entered', async () => {
    const transport = new RecordingTransport();
    const hold = transport.holdNextSend();
    transport.reset();
    hold.release();

    // The arming is forgotten too, so the NEXT send does not park by accident.
    expect(await settles(transport.send(message)), 'a stale arming parked a later send').toBe(true);
  });

  it('lands the outcome it was given, not the one armed while it was parked', async () => {
    const transport = new RecordingTransport();
    const hold = transport.holdNextSend({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
      errorMessage: 'chat not found',
      // No `retryAfterMs`: a permanent failure has nothing to wait for, and
      // the union says so. Passing one here asserted a field the outcome does
      // not have.
    });
    const send = transport.send(message);
    await hold.entered;

    // Armed mid-flight. This belongs to the NEXT call: an enumeration that let
    // an interleaving step rewrite the outstanding send's result would be
    // varying two things while reporting one.
    transport.failNextWith({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
      errorMessage: 'socket hang up',
      retryAfterMs: 0,
    });
    hold.release();

    await expect(send).resolves.toMatchObject({ outcome: 'FAILED_PERMANENT' });
    expect(transport.messages, 'a failed send was recorded as delivered').toHaveLength(0);
    await expect(transport.send(message)).resolves.toMatchObject({
      outcome: 'FAILED_RETRYABLE',
    });
  });
});
