import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { PERMISSION_KEYS, type PermissionKey } from '@nexa/contracts';
import { GROUP_ORDER, NAV, ROUTE_PATTERNS, navPermitted } from '../../apps/web/src/app';
import { Sidebar } from '../../apps/web/src/shell';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Hotfix — «هوش مصنوعی پشتیبانی»: the support-AI pages in one navigation group of their own.
 * Presentation only: every path and permission is what it was, the generic support pages
 * stay where they were, and the group is drawn only when one of its links would be.
 */

const GROUP = 'web.navgroup_support_ai';
const AI_ENTRIES: readonly [id: string, path: string][] = [
  ['business-chats', '/business-chats'],
  ['support-ai', '/support-ai'],
  ['support-knowledge', '/support-knowledge'],
  ['learning-candidates', '/support-learning'],
  ['knowledge-build', '/knowledge-build'],
  ['support-analytics', '/support-analytics'],
];

function sidebar(permissions: readonly PermissionKey[]) {
  stubApi([{ url: '/health/info', body: { environment: 'test', name: 'nexa' } }]);
  renderPage(
    <Sidebar
      entries={NAV.filter((entry) => navPermitted(entry, permissions, []))}
      currentPath="/"
      collapsed={false}
      onToggle={() => {}}
      counters={{}}
      theme="system"
      onTheme={() => {}}
    />,
  );
}

describe('the «هوش مصنوعی پشتیبانی» navigation group', () => {
  it('holds the six support-AI pages, in order, at their unchanged paths', () => {
    expect(t(GROUP)).toBe('هوش مصنوعی پشتیبانی');
    expect(GROUP_ORDER.filter((group) => group === GROUP)).toHaveLength(1);
    const members = NAV.filter((entry) => entry.group === GROUP);
    expect(members.map((entry) => [entry.id, entry.path])).toEqual(AI_ENTRIES);
    for (const [, path] of AI_ENTRIES) expect(ROUTE_PATTERNS).toContain(path);
  });

  it('keeps each entry’s permission exactly as before', () => {
    const permission = (id: string) => NAV.find((entry) => entry.id === id)?.permission;
    expect(permission('business-chats')).toBe('business_chats.view');
    expect(permission('support-ai')).toBe('support_ai.configure');
    expect(permission('support-knowledge')).toBe('support_knowledge.view');
    expect(permission('learning-candidates')).toBe('support_knowledge.view');
    expect(permission('knowledge-build')).toBe('support_knowledge.view');
    expect(permission('support-analytics')).toBe('support_ai.configure');
  });

  it('leaves the generic support pages where they were, and lists nothing twice', () => {
    const group = (id: string) => NAV.find((entry) => entry.id === id)?.group;
    expect(group('tickets')).toBe('web.navgroup_ops');
    expect(group('support')).toBe('web.navgroup_comms');
    const ids = NAV.map((entry) => entry.id);
    const paths = NAV.map((entry) => entry.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('is drawn when one child is permitted, with only that child', async () => {
    sidebar(['business_chats.view']);
    const group = await screen.findByRole('group', { name: t(GROUP) });
    const links = within(group).getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/business-chats']);
    expect(within(group).getByText(t('web.nav_business_chats'))).toBeTruthy();
  });

  it('draws every child for an actor holding every permission, under the group', async () => {
    sidebar([...PERMISSION_KEYS]);
    const group = await screen.findByRole('group', { name: t(GROUP) });
    expect(
      within(group)
        .getAllByRole('link')
        .map((link) => link.getAttribute('href')),
    ).toEqual(AI_ENTRIES.map(([, path]) => path));
    // No AI link is drawn a second time in another group.
    for (const [, path] of AI_ENTRIES) {
      expect(document.querySelectorAll(`a[href="${path}"]`)).toHaveLength(1);
    }
  });

  it('is not drawn at all when no child is permitted', async () => {
    sidebar(['tickets.view', 'settings.view']);
    await screen.findByRole('group', { name: t('web.navgroup_ops') });
    expect(screen.queryByRole('group', { name: t(GROUP) })).toBeNull();
    expect(screen.queryByText(t(GROUP))).toBeNull();
  });
});
