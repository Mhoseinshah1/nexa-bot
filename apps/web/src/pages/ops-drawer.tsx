import type { ReactNode } from 'react';
import { Drawer } from '../ui/overlays';
import { useConfirmedClose } from '../ui/unsaved';

/**
 * W3 compact pass for the support, infra and system pages: an action form that used to be
 * always open on the page now opens on a button, in this drawer, with exactly the same
 * fields, hints, validation, refusals and toasts. A typed draft asks before the drawer
 * closes (Esc, ×, the backdrop or «انصراف»); a drawer with nothing typed just closes.
 */
export function OpsActionDrawer({
  open,
  title,
  dirty,
  onClose,
  children,
  foot,
  wide = false,
}: {
  open: boolean;
  title: ReactNode;
  /** Something typed that closing would throw away. */
  dirty: boolean;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
  wide?: boolean;
}) {
  const { requestClose, dialog } = useConfirmedClose(dirty, onClose);
  return (
    <>
      <Drawer open={open} onClose={requestClose} title={title} wide={wide} foot={foot}>
        {children}
      </Drawer>
      {open && dialog}
    </>
  );
}
