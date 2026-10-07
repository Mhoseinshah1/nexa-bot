import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from './icons';
import { t } from '../i18n/web.fa';
import { confirmDialogOpen } from './confirm-dialog';
import { isTopTrap, pushTrap, tabbable } from './focusable';

/**
 * Overlays: a modal dialog, a side drawer and a menu.
 *
 * The dialog and the drawer render into `document.body` through a portal, so
 * no clipped or transformed ancestor can make the backdrop cover less than the
 * window. A test asserting that one is ABSENT must therefore query `document`
 * (or `screen`), never the container a page was rendered into.
 */

/**
 * Keeps keyboard focus inside `ref` while `active`, closes on Escape, and
 * returns focus to whatever had it before when it deactivates.
 *
 * `initial` is focused first if given; otherwise the first focusable control.
 *
 * Traps stack: only the innermost open one answers Tab and Escape, so a dialog opened from a
 * drawer closes alone and keeps Tab to itself. An Escape a control inside has already handled
 * (a menu closing itself calls `preventDefault`) closes nothing else.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
  initial?: RefObject<HTMLElement | null>,
): void {
  const escape = useRef(onEscape);
  useLayoutEffect(() => {
    escape.current = onEscape;
  });

  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = ref.current;
    const first =
      initial?.current ?? (container === null ? null : (tabbable(container)[0] ?? container));
    first?.focus();
    const token = {};
    const release = pushTrap(token);

    const onKey = (event: KeyboardEvent) => {
      // A confirmation is always the topmost layer, and it owns the keyboard:
      // its Escape cancels the question, not the surface underneath as well.
      if (confirmDialogOpen()) return;
      if (!isTopTrap(token) || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = ref.current;
      if (node === null) return;
      const controls = tabbable(node);
      const head = controls[0];
      const tail = controls[controls.length - 1];
      if (head === undefined || tail === undefined) {
        event.preventDefault();
        return;
      }
      const current = document.activeElement;
      const inside = current instanceof Node && node.contains(current);
      if (!inside) {
        event.preventDefault();
        head.focus();
      } else if (event.shiftKey && current === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && current === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      release();
      if (opener !== null && opener.isConnected) opener.focus();
    };
    // `initial` and `ref` are refs: stable identities, read when the trap activates.
  }, [active]);
}

/**
 * A modal dialog: portal, backdrop, focus trap, Escape and a close button.
 *
 * `open` false renders nothing at all, so a closed dialog's form is unmounted
 * and its draft discarded — a dialog that should keep a draft keeps it in its
 * caller's state. For a yes/cancel question use `ConfirmDialog`, which labels
 * both answers and focuses the safe one.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  foot,
  size = 'md',
  danger = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  size?: 'md' | 'lg';
  danger?: boolean;
}) {
  if (!open) return null;
  return (
    <ModalBody onClose={onClose} title={title} foot={foot} size={size} danger={danger}>
      {children}
    </ModalBody>
  );
}

function ModalBody({
  onClose,
  title,
  children,
  foot,
  size,
  danger,
}: {
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  foot: ReactNode;
  size: 'md' | 'lg';
  danger: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onClose);
  return createPortal(
    <div
      className="modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`modal${size === 'lg' ? ' lg' : ''}${danger ? ' danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          {danger && <Icon name="alert" />}
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot !== undefined && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * A panel from the inline end of the window, for a secondary task that keeps
 * the page it was opened from in view. Same focus rules as `Modal`.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  foot,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  foot?: ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <DrawerBody onClose={onClose} title={title} foot={foot} wide={wide}>
      {children}
    </DrawerBody>
  );
}

function DrawerBody({
  onClose,
  title,
  children,
  foot,
  wide,
}: {
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  foot: ReactNode;
  wide: boolean;
}) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, true, onClose);
  return createPortal(
    <>
      <div className="drawer-layer" onMouseDown={onClose} />
      <aside
        ref={ref}
        className={`drawer${wide ? ' wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="drawer-head">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="btn ghost icon sm"
            aria-label={t('web.close')}
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {foot !== undefined && <div className="drawer-foot">{foot}</div>}
      </aside>
    </>,
    document.body,
  );
}

export type MenuItem =
  | {
      readonly key: string;
      readonly label: string;
      readonly icon?: IconName;
      readonly onSelect: () => void;
      readonly danger?: boolean;
      /** A menuitemradio: the item is one of a set and this one is chosen. */
      readonly checked?: boolean;
      readonly disabled?: boolean;
    }
  | { readonly key: string; readonly separator: true }
  | { readonly key: string; readonly heading: string };

/**
 * A menu button: a trigger with `aria-haspopup`, and a list of items that the
 * arrow keys move through. Escape and a click outside close it and hand focus
 * back to the trigger. Not a portal — it hangs off its trigger.
 */
export function Menu({
  label,
  trigger,
  items,
  triggerClassName = 'btn ghost',
  placement = 'down',
}: {
  /** The trigger's accessible name. */
  label: string;
  /** What the trigger shows. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  triggerClassName?: string;
  placement?: 'down' | 'up';
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: MouseEvent) => {
      if (wrap.current !== null && !wrap.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    list.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const moveFocus = (delta: number) => {
    const entries = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [],
    );
    if (entries.length === 0) return;
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const next = entries[(at + delta + entries.length) % entries.length];
    next?.focus();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        className={triggerClassName}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={list}
          id={menuId}
          className={`menu${placement === 'up' ? ' up' : ''}`}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close(true);
            } else if (event.key === 'ArrowDown') {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(-1);
            } else if (event.key === 'Tab') {
              close(false);
            }
          }}
        >
          {items.map((item) => {
            if ('separator' in item) return <div key={item.key} className="sep" role="separator" />;
            if ('heading' in item)
              return (
                <div key={item.key} className="head" role="presentation">
                  {item.heading}
                </div>
              );
            return (
              <button
                key={item.key}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                {...(item.checked === undefined ? {} : { 'aria-checked': item.checked })}
                className={item.danger === true ? 'danger' : undefined}
                disabled={item.disabled === true}
                tabIndex={-1}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon !== undefined && <Icon name={item.icon} size={14} />}
                {item.label}
                {item.checked === true && <Icon name="check" size={13} className="end" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
