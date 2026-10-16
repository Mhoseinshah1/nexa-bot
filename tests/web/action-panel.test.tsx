import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ActionPanel } from '../../apps/web/src/ui/action-panel';
import { Button } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';

/** W1.5 — one framed panel of titled groups; the page's own buttons, only placed. */

describe('the action panel', () => {
  it('draws titled groups of the page’s own buttons, which keep their handlers', () => {
    let synced = 0;
    render(
      <ActionPanel
        title="عملیات روی این سرویس"
        groups={[
          {
            key: 'panel',
            title: 'پنل و همگام‌سازی',
            actions: [
              <Button key="s" onClick={() => (synced += 1)}>
                همگام‌سازی
              </Button>,
            ],
          },
          { key: 'link', title: 'لینک اشتراک', actions: [<Button key="c">کپی</Button>] },
        ]}
      />,
    );
    const panel = screen.getByRole('region', { name: 'عملیات روی این سرویس' });
    const group = within(panel).getByRole('group', { name: 'پنل و همگام‌سازی' });
    fireEvent.click(within(group).getByRole('button', { name: 'همگام‌سازی' }));
    expect(synced).toBe(1);
    expect(within(panel).getByRole('group', { name: 'لینک اشتراک' })).toBeInTheDocument();
  });

  it('defaults its title to «عملیات»', () => {
    render(
      <ActionPanel groups={[{ key: 'a', title: 'الف', actions: [<Button key="x">x</Button>] }]} />,
    );
    expect(screen.getByRole('region', { name: t('web.action_panel_title') })).toBeInTheDocument();
  });

  it('draws no group whose actions are all absent, and no panel when nothing is left', () => {
    const { container, rerender } = render(
      <ActionPanel
        groups={[
          { key: 'a', title: 'الف', actions: [null, false] },
          { key: 'b', title: 'ب', actions: [<Button key="x">x</Button>] },
        ]}
      />,
    );
    expect(screen.queryByRole('group', { name: 'الف' })).toBeNull();
    expect(screen.getByRole('group', { name: 'ب' })).toBeInTheDocument();
    rerender(
      <ActionPanel groups={[{ key: 'a', title: 'الف', actions: [null] }]} sensitive={[false]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the sensitive actions in their own red strip, even alone', () => {
    render(
      <ActionPanel
        groups={[{ key: 'a', title: 'الف', actions: [null] }]}
        sensitive={[
          <Button key="d" variant="danger">
            حذف سرویس
          </Button>,
        ]}
      />,
    );
    const strip = screen.getByRole('group', { name: t('web.action_panel_sensitive') });
    expect(strip).toHaveClass('danger');
    expect(within(strip).getByRole('button', { name: 'حذف سرویس' })).toBeInTheDocument();
  });

  it('folds the reasons buttons are disabled under «چرا N دکمه غیرفعال است؟»', () => {
    const { container } = render(
      <ActionPanel
        groups={[
          {
            key: 'a',
            title: 'الف',
            actions: [
              <Button key="x" disabled>
                x
              </Button>,
            ],
          },
        ]}
        disabledReasons={['پنل در دسترس نیست', null, 'سرویس معلق است']}
      />,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(
      within(details as HTMLElement).getByText(t('web.action_panel_why').replace('{n}', '2')),
    ).toBeInTheDocument();
    expect(within(details as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
  });

  it('draws no fold when nothing is disabled', () => {
    const { container } = render(
      <ActionPanel groups={[{ key: 'a', title: 'الف', actions: [<Button key="x">x</Button>] }]} />,
    );
    expect(container.querySelector('details')).toBeNull();
  });
});
