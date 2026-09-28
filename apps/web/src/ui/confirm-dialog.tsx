import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * How many confirmation dialogs are open right now: zero or one.
 *
 * Module state, not React state, because the question "may another dialog open?" is
 * asked by sibling components that share no parent state. The backdrop blocks the
 * pointer and the focus trap blocks the keyboard, and this count is the third guard:
 * an opener asks `confirmDialogOpen()` first and does nothing while one is up.
 */
let openDialogs = 0;

export function confirmDialogOpen(): boolean {
  return openDialogs > 0;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A plain yes/cancel confirmation, drawn over the page.
 *
 * It is not `window.confirm`, because the browser's dialog cannot label its buttons.
 * An operator should read «بله، خاموش شود», not the browser's own OK. Nothing is typed
 * into it. The confirmation is a question, not a test.
 *
 * Focus behaviour:
 * - Cancel is focused first, so a reflexive Enter backs out.
 * - Escape and a click on the backdrop cancel.
 * - Tab and Shift+Tab cycle among the dialog's own controls and never reach the
 *   switches behind it.
 * - On close, focus returns to `returnFocusTo`, or else to whatever had focus when the
 *   dialog opened.
 *
 * It renders into `document.body` through a portal, so no transformed or clipped
 * ancestor can make the fixed-position backdrop cover less than the whole window.
 */
export function ConfirmDialog({
  title,
  question,
  detail,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  returnFocusTo,
}: {
  /** What is being changed, e.g. the feature's Persian name. */
  title: string;
  question: string;
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** The control that opened the dialog; read when the dialog closes. */
  returnFocusTo?: () => HTMLElement | null;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The latest callbacks, for the mount-once effect below. Re-running that effect
  // would re-focus Cancel and count the same dialog twice.
  const onCancelRef = useRef(onCancel);
  const returnFocusRef = useRef(returnFocusTo);
  useLayoutEffect(() => {
    onCancelRef.current = onCancel;
    returnFocusRef.current = returnFocusTo;
  });

  useEffect(() => {
    openDialogs += 1;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const controls = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (!inside) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    // Focus that escapes by any other route, such as a script or an assistive
    // technology moving it, is pulled back in.
    const onFocusIn = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (dialog !== null && event.target instanceof Node && !dialog.contains(event.target)) {
        cancelRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocusIn);
      openDialogs -= 1;
      const target = returnFocusRef.current?.() ?? opener;
      target?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
      >
        <h2 id={titleId}>{title}</h2>
        <div id={bodyId}>
          <p>{question}</p>
          {detail !== undefined && <p className="muted small">{detail}</p>}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn danger solid" onClick={onConfirm}>
            {confirmLabel}
          </button>
          <button type="button" className="btn" ref={cancelRef} onClick={onCancel}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
