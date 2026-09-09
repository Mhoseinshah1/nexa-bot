import { describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ApiError } from '../../apps/web/src/api/client';
import { useSubmissionKey } from '../../apps/web/src/submission-key';

/**
 * The idempotency key a write carries, and when it is allowed to change.
 *
 * This file had no test at all, which is how it came to retire the key on any
 * response that carried a status — 500s and 502s included. The key exists so
 * that a retry of an AMBIGUOUS failure is recognised as the same command; the
 * one case it was written for was a double-sent Telegram message, and that was
 * the case it stopped covering.
 */
describe('the submission key', () => {
  const payload = { command: 'notifications.test' };

  it('is stable while the payload is', () => {
    const { result } = renderHook(() => useSubmissionKey());
    const first = result.current.current(payload);
    expect(result.current.current(payload)).toBe(first);
  });

  it('is a new key for a different payload', () => {
    const { result } = renderHook(() => useSubmissionKey());
    const first = result.current.current(payload);
    expect(result.current.current({ command: 'panels.test' })).not.toBe(first);
  });

  it('retires the key once the command has definitely landed', () => {
    const { result } = renderHook(() => useSubmissionKey());
    const first = result.current.current(payload);
    act(() => result.current.settle());
    expect(result.current.current(payload)).not.toBe(first);
  });

  it('retires the key on a refusal the server authored', () => {
    const { result } = renderHook(() => useSubmissionKey());
    const first = result.current.current(payload);
    // A 403 is an ANSWER: the command was considered and refused, so the next
    // press is a new question.
    act(() => result.current.settleOn(new ApiError(403, 'access.denied', 'no')));
    expect(result.current.current(payload)).not.toBe(first);
  });

  /**
   * The regression. A 502 from a proxy that never heard back leaves the caller
   * unable to tell whether `POST /notifications/test` queued its intent. If the
   * key is retired, the next press arrives with a fresh one and the server
   * treats it as a second command — a second external message sent, which is
   * precisely what the key is for.
   */
  it('KEEPS the key when a 5xx leaves the outcome unknown', () => {
    for (const status of [500, 502, 503, 504]) {
      const { result } = renderHook(() => useSubmissionKey());
      const first = result.current.current(payload);
      act(() => result.current.settleOn(new ApiError(status, 'internal.unhandled', 'boom')));
      expect(result.current.current(payload), `status ${status}`).toBe(first);
    }
  });

  it('keeps the key when nothing came back at all', () => {
    const { result } = renderHook(() => useSubmissionKey());
    const first = result.current.current(payload);
    act(() => result.current.settleOn(new TypeError('Failed to fetch')));
    expect(result.current.current(payload)).toBe(first);
  });
});
