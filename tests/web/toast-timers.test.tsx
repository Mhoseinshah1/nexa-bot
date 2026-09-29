import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { ToastProvider, useToast } from '../../apps/web/src/ui/kit';

/**
 * A toast's dismissal timer must not outlive the provider that set it.
 *
 * It used to: `notify` armed a 4-second `setTimeout` and nothing ever cleared it, so a
 * provider unmounted within those four seconds — a sign-out, or the end of a web test —
 * left a timer that later called `setState` on a tree that no longer existed. In CI the
 * test environment was already gone by then, and the stray callback threw
 * `window is not defined`, failing a run in which every test had passed.
 */
describe('toast dismissal timers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are cleared when the provider unmounts', () => {
    vi.useFakeTimers();
    let notify: ReturnType<typeof useToast> = () => undefined;
    function Capture() {
      notify = useToast();
      return null;
    }
    const view = render(
      <ToastProvider>
        <Capture />
      </ToastProvider>,
    );
    act(() => notify({ tone: 'ok', message: 'saved' }));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('still dismisses a toast after four seconds while mounted', () => {
    vi.useFakeTimers();
    let notify: ReturnType<typeof useToast> = () => undefined;
    function Capture() {
      notify = useToast();
      return null;
    }
    const view = render(
      <ToastProvider>
        <Capture />
      </ToastProvider>,
    );
    act(() => notify({ tone: 'ok', message: 'saved' }));
    expect(view.getByText('saved')).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(view.queryByText('saved')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
