import { useEffect, useRef, type ReactNode } from 'react';
import { t } from './i18n/t.js';

/**
 * A bottom sheet (the design's QR and location sheets): a modal dialog over the page with
 * its own heading, closed by its button, the backdrop or Escape. Focus moves into it when
 * it opens and returns to what opened it when it closes.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus();
    };
    // Opened once per mount; a new `onClose` closure must not steal the focus again.
  }, []);

  return (
    <div className="sheet-root">
      <button
        type="button"
        className="sheet-backdrop"
        tabIndex={-1}
        aria-label={t('miniapp.sheet_close')}
        onClick={onClose}
      />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        tabIndex={-1}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <h2 className="sheet-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
