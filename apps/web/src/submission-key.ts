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
  /**
   * Retires the key only when the outcome is KNOWN — a 4xx the server
   * authored. A 5xx or a transport failure keeps it.
   */
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
      // A 4xx is an ANSWER: the server considered the command and refused it,
      // so the next press is a new question and deserves a new key.
      //
      // A 5xx is not. A 500 from the application, or a 502 from a proxy that
      // never heard back, leaves the caller unable to tell whether the write
      // committed — and this used to retire the key for those too, on the
      // grounds that "an HTTP status came back". So a `POST /notifications/test`
      // that queued its intent and then died behind a 502 would, on the next
      // press, arrive with a FRESH key and queue a second external message:
      // the exact double-send the key exists to prevent, in the one case it
      // was written for.
      //
      // Ambiguity therefore keeps the key, alongside the transport failures
      // that saw nothing at all. The retry then carries the key its first
      // attempt used, and the server recognises the same command.
      if (error instanceof ApiError && error.status < 500) settle();
    },
  };
}
