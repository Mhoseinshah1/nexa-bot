import { t } from '../i18n/web.fa';
import { Icon } from './icons';
import { Menu, type MenuItem } from './overlays';

/**
 * The page head's «بیشتر» overflow menu (demo parity, PR-1): the page's secondary actions in one
 * menu next to the primary ones, as the approved demo draws it. It decides nothing — a page
 * hands over its own items (each `onSelect` is the handler the button had, behind the same
 * permission props) and the menu only draws them. With no item there is nothing to open, so
 * nothing is drawn.
 */
export function PageMoreMenu({ items }: { items: readonly MenuItem[] }) {
  if (items.filter((item) => !('separator' in item) && !('heading' in item)).length === 0) {
    return null;
  }
  return (
    <Menu
      label={t('web.page_more_menu')}
      trigger={
        <>
          {t('web.page_more_menu')}
          <Icon name="chevron" size={14} />
        </>
      }
      items={items}
      triggerClassName="btn sm"
    />
  );
}
