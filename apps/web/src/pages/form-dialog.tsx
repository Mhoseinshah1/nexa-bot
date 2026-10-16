import type { ReactNode } from 'react';
import { Modal } from '../ui/overlays';
import { useConfirmedClose, useUnsavedChanges } from '../ui/unsaved';

/**
 * W3, the compact pass: an action form that used to stay open on the page, opened from a
 * button instead. The caller keeps the fields and their state — so validation, refusals and
 * toasts are exactly what they were — and says whether closing would lose something:
 * while `dirty`, every close (✕, Escape, the backdrop) asks first, and leaving
 * the page asks too.
 */
export function FormDialog({
  open,
  title,
  dirty,
  onClose,
  children,
  foot,
  danger = false,
}: {
  open: boolean;
  title: ReactNode;
  /** A typed draft that closing would throw away. */
  dirty: boolean;
  /** Closes AND resets the caller's draft; runs only once the operator agreed. */
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  danger?: boolean;
}) {
  const { requestClose, dialog } = useConfirmedClose(open && dirty, onClose);
  useUnsavedChanges(open && dirty);
  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title={title}
        danger={danger}
        {...(foot === undefined ? {} : { foot })}
      >
        {children}
      </Modal>
      {dialog}
    </>
  );
}
