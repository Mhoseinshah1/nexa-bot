import { useRef } from 'react';
import { newIdempotencyKey } from './api/client';

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
 * So the key survives a failure and is only retired once a response has been
 * seen. `mutations.retry` in `main.tsx` covers the automatic attempt; this
 * covers the person pressing the button, which is the case that reaches a
 * queue.
 */
export function useSubmissionKey(): {
  /** The key for the submission now beginning, minting one if none is held. */
  current: () => string;
  /** Called once a definitive response has been seen. */
  settle: () => void;
} {
  const held = useRef<string | null>(null);
  return {
    current: () => (held.current ??= newIdempotencyKey()),
    settle: () => {
      held.current = null;
    },
  };
}
