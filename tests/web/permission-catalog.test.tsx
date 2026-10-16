import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PERMISSIONS, PERMISSION_KEYS } from '@nexa/contracts';
import {
  PermissionCatalog,
  permissionLabel,
  permissionSections,
} from '../../apps/web/src/ui/permission-catalog';
import { t } from '../../apps/web/src/i18n/web.fa';

/**
 * W1.7 — the permission catalogue draws and filters; it never decides a grant. Every toggle
 * goes to the page, a locked row is never toggled, and a card's «انتخاب همه» passes only the
 * keys that would change.
 */

const CRITICAL = PERMISSIONS.filter((one) => one.riskLevel === 'CRITICAL').map((one) => one.key);
const USERS = PERMISSIONS.filter((one) => one.resource === 'users').map((one) => one.key);

describe('sections', () => {
  it('groups by domain in catalogue order with critical permissions first', () => {
    const sections = permissionSections(PERMISSION_KEYS);
    expect(sections[0]?.domain).toBe(PERMISSIONS[0]?.resource);
    for (const section of sections) {
      const risks = section.keys.map((key) => CRITICAL.includes(key as never));
      const firstNonCritical = risks.indexOf(false);
      if (firstNonCritical >= 0) expect(risks.slice(firstNonCritical)).not.toContain(true);
    }
  });

  it('names an unknown key by itself rather than dropping it', () => {
    expect(permissionLabel('ghost.view')).toBe('ghost.view');
    expect(permissionSections(['ghost.view'])[0]?.keys).toEqual(['ghost.view']);
  });
});

describe('view mode', () => {
  it('starts collapsed above 24 permissions, opens and closes all, and filters', () => {
    render(<PermissionCatalog keys={PERMISSION_KEYS} mode="view" idPrefix="eff" />);
    expect(screen.queryByText(permissionLabel(USERS[0] as string))).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: t('web.pc_expand_all') }));
    expect(screen.getAllByText(permissionLabel(USERS[0] as string)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: t('web.pc_collapse_all') }));
    expect(screen.queryByText(permissionLabel(USERS[0] as string))).toBeNull();
    // The critical filter opens every card with a match, and only critical rows show.
    fireEvent.click(screen.getByRole('button', { name: t('web.pc_critical_only') }));
    const rows = document.querySelectorAll('.perm-row');
    expect(rows.length).toBe(CRITICAL.length);
    rows.forEach((row) => expect(row).toHaveClass('risk-critical'));
  });

  it('starts open with 24 or fewer, and shows the raw key small and in the title', () => {
    render(<PermissionCatalog keys={USERS} mode="view" />);
    const key = USERS[0] as string;
    const row = screen.getByTitle(key);
    expect(within(row).getByText(key)).toBeInTheDocument();
    expect(within(row).getByText(permissionLabel(key))).toBeInTheDocument();
  });

  it('searches by name and by key', () => {
    render(<PermissionCatalog keys={PERMISSION_KEYS} mode="view" />);
    fireEvent.change(screen.getByRole('searchbox', { name: t('web.rbac_search') }), {
      target: { value: 'users.view' },
    });
    expect(screen.getByTitle('users.view')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: t('web.rbac_search') }), {
      target: { value: 'zzz-nothing' },
    });
    expect(screen.getByText(t('web.pc_no_match'))).toBeInTheDocument();
  });
});

function Editor({
  locked,
  onToggle,
  onMany,
}: {
  locked: ReadonlySet<string>;
  onToggle: (key: string, next: boolean) => void;
  onMany: (keys: readonly string[], next: boolean) => void;
}) {
  const [selected] = useState<ReadonlySet<string>>(new Set([USERS[0] as string]));
  return (
    <PermissionCatalog
      keys={USERS}
      mode="edit"
      selected={selected}
      onToggle={onToggle}
      onToggleMany={onMany}
      isLocked={(key) => locked.has(key)}
    />
  );
}

describe('edit mode', () => {
  it('keeps the checkbox ids and hands every toggle to the page', () => {
    const calls: [string, boolean][] = [];
    render(
      <Editor
        locked={new Set()}
        onToggle={(key, next) => calls.push([key, next])}
        onMany={() => undefined}
      />,
    );
    const second = USERS[1] as string;
    const box = document.getElementById(`rbac-perm-${second.replace(/\./g, '-')}`);
    expect(box).not.toBeNull();
    fireEvent.click(box as HTMLElement);
    expect(calls).toEqual([[second, true]]);
    expect(document.getElementById('rbac-search')).not.toBeNull();
  });

  it('never toggles a locked row, alone or through «انتخاب همه»', () => {
    const calls: [string, boolean][] = [];
    const many: [readonly string[], boolean][] = [];
    const lockedKey = USERS[1] as string;
    render(
      <Editor
        locked={new Set([lockedKey])}
        onToggle={(key, next) => calls.push([key, next])}
        onMany={(keys, next) => many.push([keys, next])}
      />,
    );
    const box = document.getElementById(`rbac-perm-${lockedKey.replace(/\./g, '-')}`);
    expect(box).toBeDisabled();
    fireEvent.click(box as HTMLElement);
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: t('web.pc_select_all') }));
    expect(many).toHaveLength(1);
    expect(many[0]?.[1]).toBe(true);
    expect(many[0]?.[0]).not.toContain(lockedKey);
    // Already selected keys are not passed again.
    expect(many[0]?.[0]).not.toContain(USERS[0]);
    fireEvent.click(screen.getByRole('button', { name: t('web.pc_select_none') }));
    expect(many[1]).toEqual([[USERS[0]], false]);
  });

  it('counts held over total and the critical ones on each card', () => {
    render(<Editor locked={new Set()} onToggle={() => undefined} onMany={() => undefined} />);
    const head = screen.getByRole('button', { expanded: true });
    expect(head).toHaveTextContent(`1/${USERS.length}`);
  });
});

describe('the comparison table', () => {
  it('draws roles as columns and permissions as rows, with per-role counts', () => {
    const owner = { key: 'owner', label: 'مالک', has: () => true };
    const viewer = { key: 'viewer', label: 'بیننده', has: (key: string) => key.endsWith('.view') };
    render(<PermissionCatalog keys={USERS} mode="view" matrix={[owner, viewer]} />);
    fireEvent.click(screen.getByRole('button', { name: t('web.pc_view_matrix') }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'مالک' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'بیننده' })).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: new RegExp(permissionLabel('users.view')) });
    expect(within(row).getAllByRole('img', { name: t('web.pc_has') })).toHaveLength(2);
  });

  it('is not offered without columns', () => {
    render(<PermissionCatalog keys={USERS} mode="view" />);
    expect(screen.queryByRole('button', { name: t('web.pc_view_matrix') })).toBeNull();
  });
});
