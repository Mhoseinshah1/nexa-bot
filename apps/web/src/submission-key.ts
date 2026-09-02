import { useRef } from 'react';
import { ApiError, newIdempotencyKey } from './api/client';

/**
 * One idempotency key per SUBMISSION, held until that submission definitively
 * succeeds.
 *
 * The distinction that matters is between a retry and a new command, and the
 * ambiguous case belongs on the retry side. If the server commits a write and
 * the response is lost, the mutation surfaces an error and the person presses
 * the button again — meaning "did that work?", not "do it twice". Minting a
 * fresh key there turns their question into a second command, and for the
 * notification test send that is a second message actually delivered.
 *
 * So the key survives a failure where NOTHING WAS SEEN, and is retired the
 * moment a server response arrives — including a rejection. That second half
 * was missing and turned the mechanism against itself: a 409 is a response,
 * the operator reloads the row and resubmits with a fresh `expectedVersion`,
 * and the same key with a different payload is precisely what
 * `platform.idempotency_payload_mismatch` exists to refuse. Every subsequent
 * save from that row failed identically until the component remounted.
 *
 * `mutations.retry` in `main.tsx` covers the automatic attempt; this covers
 * the person pressing the button, which is the case that reaches a queue.
 */
export function useSubmissionKey(): {
  /**
   * The key for the submission now beginning.
   *
   * `payload` is a fingerprint of what is about to be sent. A held key is
   * reused only while the payload is the SAME question — change it and a new
   * key is minted, because it is a new command.
   *
   * Without that, an ambiguous failure whose request had in fact committed
   * left the key held; the operator then edited the value and submitted, the
   * same key arrived with a different request hash, and the server refused it
   * as `platform.idempotency_payload_mismatch` — correctly, since reusing a
   * key for different input is a caller bug. The caller was this hook.
   */
  current: (payload: unknown) => string;
  /**
   * Called once a definitive response has been seen — success OR a rejection
   * the server actually sent. Only a transport failure, where nothing came
   * back, keeps the key.
   */
  settle: () => void;
  /** Retires the key when the error carries a server status, keeps it otherwise. */
  settleOn: (error: unknown) => void;
} {
  const held = useRef<{ key: string; payload: string } | null>(null);
  const settle = () => {
    held.current = null;
  };
  return {
    current: (payload: unknown) => {
      const fingerprint = JSON.stringify(payload ?? null);
      if (held.current?.payload !== fingerprint) {
        held.current = { key: newIdempotencyKey(), payload: fingerprint };
      }
      return held.current.key;
    },
    settle,
    settleOn: (error: unknown) => {
      // An `ApiError` means an HTTP status came back, so the command's outcome
      // is known and the next press is a NEW command. Anything else — a dropped
      // connection, a DNS failure — saw nothing, and the next press is the same
      // question asked again.
      if (error instanceof ApiError) settle();
    },
  };
}
