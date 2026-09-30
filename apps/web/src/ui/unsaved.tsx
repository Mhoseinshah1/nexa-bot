import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { holdLeaveGuard, usePendingLeave } from '../router';
import { t } from '../i18n/web.fa';
import { ConfirmDialog } from './confirm-dialog';

/**
 * Dirty-state protection (brief §8).
 *
 * While `dirty` is true:
 *
 * - closing or reloading the tab triggers the browser's own "leave site?"
 *   prompt (`beforeunload`; browsers show their own words, not ours);
 * - an in-app navigation that would unmount the page — a sidebar or
 *   breadcrumb link, the command search, `navigate()`, a `?tab=` switch — is
 *   held and the operator is asked, through `ConfirmDialog`, whether to leave
 *   without saving;
 * - Back/Forward is re-pointed at the page and the same question is asked
 *   (see `router.ts` for why it cannot be cancelled outright).
 *
 * `message` replaces the default question when a page has something more
 * specific to say. Release is automatic: when `dirty` turns false or the page
 * unmounts, the guard is gone.
 */
export function useUnsavedChanges(dirty: boolean, message?: string): void {
  useEffect(() => {
    if (!dirty) return undefined;
    const release = holdLeaveGuard(message);
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still require a non-empty returnValue to show the prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      release();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty, message]);
}

/**
 * The one place a held navigation is asked about. The shell mounts it once;
 * a page test that exercises `useUnsavedChanges` mounts it beside the page.
 * Without a host nothing is blocked — nothing could ask.
 */
export function LeaveGuardHost() {
  const { pending, leave, stay } = usePendingLeave();
  if (pending === null) return null;
  return (
    <ConfirmDialog
      title={t('web.unsaved_title')}
      question={pending.message ?? t('web.unsaved_question')}
      confirmLabel={t('web.unsaved_leave')}
      cancelLabel={t('web.unsaved_stay')}
      onConfirm={leave}
      onCancel={stay}
    />
  );
}

/**
 * For a page that swaps the record its editor holds — Edit on another row, Add while a
 * row is open. The leave guard above asks about NAVIGATIONS only, and a swap is not
 * one: it re-keys or unmounts the editor on the same page, and its draft would go
 * without a word.
 *
 * The editor says whether it holds unsaved edits, either as `dirty` here (a form that
 * lives in the page itself) or through `onDirtyChange` (a form component, via
 * `useReportDirty`). `confirmDiscard(action)` runs `action` at once when nothing is
 * unsaved, and otherwise asks first; the page renders `dialog`. A caller passes only
 * the actions that WOULD drop the draft — Add while the create form is already the one
 * shown replaces nothing, and asking then would be a question with no stake.
 */
export function useDiscardGuard(dirty = false): {
  onDirtyChange: (dirty: boolean) => void;
  confirmDiscard: (action: () => void) => void;
  dialog: ReactNode;
} {
  const reported = useRef(false);
  const [pending, setPending] = useState<{ run: () => void } | null>(null);
  const onDirtyChange = useCallback((next: boolean) => {
    reported.current = next;
  }, []);
  const confirmDiscard = useCallback(
    (action: () => void) => {
      if (dirty || reported.current) setPending({ run: action });
      else action();
    },
    [dirty],
  );
  const dialog =
    pending === null ? null : (
      <ConfirmDialog
        title={t('web.unsaved_title')}
        question={t('web.unsaved_switch_question')}
        confirmLabel={t('web.discard')}
        cancelLabel={t('web.unsaved_stay')}
        onConfirm={() => {
          setPending(null);
          pending.run();
        }}
        onCancel={() => setPending(null)}
      />
    );
  return { onDirtyChange, confirmDiscard, dialog };
}

/**
 * The form's half of `useDiscardGuard`: tells the page whether this editor holds
 * unsaved edits, and that it holds none once it unmounts.
 */
export function useReportDirty(
  dirty: boolean,
  report: ((dirty: boolean) => void) | undefined,
): void {
  useEffect(() => {
    if (report === undefined) return undefined;
    report(dirty);
    return () => report(false);
  }, [dirty, report]);
}
