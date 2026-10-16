import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { ROLE_SEEDS } from '@nexa/contracts';
import { SystemPage } from '../../apps/web/src/pages/system';
import { ROLE_KEY_LABELS, roleLabel } from '../../apps/web/src/rbac-labels';
import { WEB_FA, t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * W5 polish for the support, infra and system pages: no raw machine key as primary text.
 * Each map is total over the keys the contract knows, an unknown key falls back to the raw
 * key, and the page draws the Persian name with the raw key kept in a tooltip.
 */

describe('admin role keys', () => {
  it('names every seeded role key in Persian', () => {
    for (const seed of ROLE_SEEDS) {
      const key = ROLE_KEY_LABELS[seed.key];
      expect(key, seed.key).toBeDefined();
      expect(WEB_FA[key!], seed.key).toBeTruthy();
    }
  });

  it('falls back to the role name, then to the raw key, never to a blank', () => {
    expect(roleLabel('night_shift', 'Night shift')).toBe('Night shift');
    expect(roleLabel('night_shift')).toBe('night_shift');
    expect(roleLabel('owner', 'Owner')).toBe(t('web.role_key_owner'));
    // A seeded role an operator renamed reads as they named it.
    expect(roleLabel('support', 'Support desk')).toBe('Support desk');
  });

  it('shows the administrators table role as a Persian name with the key as its title', async () => {
    stubApi([
      {
        url: '/admins',
        body: {
          admins: [
            {
              id: '019a0000-0000-7000-8000-000000000001',
              username: 'mamad',
              displayName: 'Mamad',
              status: 'ACTIVE',
              telegramUserId: null,
              roleKeys: ['receipt_reviewer', 'night_shift'],
              createdAt: '2026-09-01T00:00:00.000Z',
              lastLoginAt: null,
            },
          ],
        },
      },
    ]);
    const route = {
      path: '/system',
      query: new URLSearchParams('section=admins'),
    } as unknown as Parameters<typeof SystemPage>[0]['route'];
    renderPage(<SystemPage route={route} permissions={['admins.view']} />);
    const badge = await screen.findByText(t('web.role_key_receipt_reviewer'));
    expect(badge).toHaveAttribute('title', 'receipt_reviewer');
    expect(screen.queryByText('receipt_reviewer')).toBeNull();
    expect(screen.getByText('night_shift')).toBeInTheDocument();
  });
});
