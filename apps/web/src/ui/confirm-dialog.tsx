import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A plain yes/cancel confirmation, drawn over the page.
 *
 * It is not `window.confirm`, because the browser's dialog cannot label its buttons.
 * An operator should read «بله، خاموش شود», not the browser's own OK. Nothing is typed
 * into it. The confirmation is a question, not a test.
 *
 * Cancel is focused first and Escape cancels, so a reflexive Enter or a stray key backs
 * out instead of going ahead. Clicking the backdrop cancels too.
 */
export function ConfirmDialog({
  title,
  question,
  detail,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: {
  /** What is being changed, e.g. the feature's Persian name. */
  title: string;
  question: string;
  detail?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
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
    </div>
  );
}
