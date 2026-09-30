import { useEffect } from 'react';
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
