import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { ROLE_SEEDS } from '@nexa/contracts';
import { SystemPage } from '../../apps/web/src/pages/system';
import { ROLE_KEY_LABELS, roleLabel } from '../../apps/web/src/rbac-labels';
import {
  OUTBOX_AGGREGATE_LABELS,
  OUTBOX_EVENT_LABELS,
} from '../../apps/web/src/pages/system-diagnostics';
import {
  AUDIT_SUBJECT_LABELS,
  AUDIT_VERB_LABELS,
  auditActionLabel,
} from '../../apps/web/src/audit-action-labels';
import { WEB_FA, t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';
import {
  BACKUP_RUN_STATES,
  EVENT_TYPES,
  RECOVERY_STAGES,
  RECOVERY_STATES,
  TEMPLATE_KEYS,
} from '@nexa/contracts';
import {
  BACKUP_RUN_STATE_LABELS,
  RECOVERY_STAGE_LABELS,
  RECOVERY_STATE_LABELS,
} from '../../apps/web/src/recovery-failure-labels';
import {
  NOTIFICATION_CATEGORY_LABELS,
  NotificationsPage,
  notificationCategoryOf,
  notificationTypeName,
} from '../../apps/web/src/pages/alerts';

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

describe('audit action names', () => {
  it('names every subject and verb it knows', () => {
    for (const [code, key] of [
      ...Object.entries(AUDIT_SUBJECT_LABELS),
      ...Object.entries(AUDIT_VERB_LABELS),
    ]) {
      expect(WEB_FA[key], code).toBeTruthy();
    }
  });

  it('composes subject and verb, across a middle segment, and falls back to null', () => {
    expect(auditActionLabel('order.cancel')).toBe(
      `${t('web.audit_subj_order')} — ${t('web.audit_verb_cancel')}`,
    );
    expect(auditActionLabel('support_ai.credential.test')).toBe(
      `${t('web.audit_subj_support_ai')} — ${t('web.audit_verb_test')}`,
    );
    expect(auditActionLabel('order.brand_new_verb')).toBeNull();
    expect(auditActionLabel('nothing')).toBeNull();
  });
});

describe('notification types', () => {
  it('names every operator-notification template in Persian', () => {
    const ops = TEMPLATE_KEYS.filter((key) => key.startsWith('ops.'));
    expect(ops.length).toBeGreaterThan(0);
    for (const key of ops) expect(notificationTypeName(key), key).not.toBe(key);
    expect(notificationTypeName('ops.brand_new')).toBe('ops.brand_new');
    for (const key of Object.values(NOTIFICATION_CATEGORY_LABELS)) expect(WEB_FA[key]).toBeTruthy();
  });

  it('files each message under finance, support or notice', () => {
    expect(notificationCategoryOf('ops.financial.order_paid')).toBe('FINANCE');
    expect(notificationCategoryOf('ops.support.handoff_required')).toBe('SUPPORT');
    expect(notificationCategoryOf('ops.notification.test')).toBe('NOTICE');
  });

  it('draws «نوع اعلان» as the Persian name, the chip beside it, the key in the tooltip', async () => {
    stubApi([
      {
        url: '/notifications',
        body: {
          notifications: [
            {
              id: 'n1',
              kind: 'OPERATIONAL_EVENT',
              status: 'SENT',
              templateKey: 'ops.financial.order_paid',
              attemptCount: 1,
              maxAttempts: 5,
              createdAt: '2026-09-06T08:00:00.000Z',
              lastAttemptAt: '2026-09-06T08:00:01.000Z',
              completedAt: '2026-09-06T08:00:01.000Z',
              correlationId: 'c1',
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<NotificationsPage mayTest={false} denied={false} />);
    const name = await screen.findByRole('button', {
      name: notificationTypeName('ops.financial.order_paid'),
    });
    expect(name).toHaveAttribute('title', 'ops.financial.order_paid');
    expect(screen.getByText(t('web.notif_cat_finance'))).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: t('web.notif_type') })).toBeInTheDocument();
  });
});

describe('recovery states, stages and backup runs', () => {
  it('names every state, stage and run state the contract declares', () => {
    for (const state of RECOVERY_STATES)
      expect(WEB_FA[RECOVERY_STATE_LABELS[state]], state).toBeTruthy();
    for (const stage of RECOVERY_STAGES)
      expect(WEB_FA[RECOVERY_STAGE_LABELS[stage]], stage).toBeTruthy();
    for (const state of BACKUP_RUN_STATES) {
      expect(WEB_FA[BACKUP_RUN_STATE_LABELS[state]], state).toBeTruthy();
    }
  });
});

describe('diagnostics outbox types', () => {
  it('names every event type the contract declares, and every aggregate the API writes', () => {
    for (const type of EVENT_TYPES) expect(WEB_FA[OUTBOX_EVENT_LABELS[type]], type).toBeTruthy();
    for (const [type, key] of Object.entries(OUTBOX_AGGREGATE_LABELS)) {
      expect(WEB_FA[key], type).toBeTruthy();
    }
  });
});
