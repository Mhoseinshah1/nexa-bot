import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { LOGIN_FAILURE_REASONS, TEMPLATE_KEYS } from '@nexa/contracts';
import { App } from '../../apps/web/src/app';
import { AuditLogPage } from '../../apps/web/src/pages/audit-log';
import { SystemPage } from '../../apps/web/src/pages/system';
import { notificationTypeName } from '../../apps/web/src/pages/alerts';
import {
  AUDIT_REASON_LABELS,
  LOGIN_FAILURE_REASON_LABELS,
  auditReasonLabel,
} from '../../apps/web/src/audit-reason-labels';
import {
  DEPENDENCY_LABELS,
  dependencyLabel,
  readinessDetailText,
} from '../../apps/web/src/readiness-labels';
import { navigate } from '../../apps/web/src/router';
import { WEB_FA, t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * C1: no raw machine key is the text an operator reads. Each map is walked over every value
 * the server can write, a known value reads in Persian with its raw key kept (title, or small
 * muted left-to-right), and an unknown value falls back to the raw key, never a blank.
 */

const PERSIAN = /[؀-ۿ]/u;
const repo = join(import.meta.dirname, '../..');
const apiSource = (path: string) => readFileSync(join(repo, 'apps/api/src', path), 'utf8');

afterEach(() => act(() => navigate('/', { replace: true, force: true })));

describe('the top bar names each role in Persian', () => {
  it('shows the role names, not the role keys, and an unknown key as itself', async () => {
    stubApi([
      {
        url: '/auth/session',
        body: {
          admin: {
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
            username: 'sara',
            displayName: 'سارا احمدی',
            status: 'ACTIVE',
            telegramUserId: null,
            roleKeys: ['operator', 'night_shift'],
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: '2026-09-06T08:00:00.000Z',
          },
          permissions: [],
          expiresAt: '2026-09-07T08:00:00.000Z',
        },
      },
    ]);
    renderPage(<App />);
    // The owner pill carries the role (demo parity A1); the name heads its menu.
    const roles = (await waitFor(() => {
      const found = document.querySelector('.user-trigger .who-name');
      expect(found).not.toBeNull();
      return found;
    })) as HTMLElement;
    expect(roles.textContent).toContain(t('web.role_key_operator'));
    expect(roles.textContent).toContain('night_shift');
    expect(roles.textContent).not.toMatch(/\boperator\b/u);
    expect(roles).toHaveAttribute('title', 'operator, night_shift');
  });
});

describe('an audit row’s reason', () => {
  const entry = (id: string, reason: string) => ({
    id: `019360ab-cdef-7012-8345-6789abcdef${id}`,
    occurredAt: '2026-09-20T10:00:00.000Z',
    actorType: 'WEB_ADMIN',
    actorId: null,
    actorLabel: 'owner',
    surface: 'WEB',
    action: 'auth.login',
    entityType: 'Admin',
    entityId: null,
    result: 'DENIED',
    reason,
    correlationId: `corr-${id}`,
    before: null,
    after: null,
    security: [],
    links: { customerId: null, orderId: null, paymentId: null, serviceId: null },
  });

  it('says codes by name, keeps an operator’s Persian, and hides the server’s English', async () => {
    const english = 'An administrator exported the Recovery Kit.';
    const typed = 'به درخواست مشتری';
    stubApi([
      {
        url: '/audit-log',
        body: {
          entries: [
            entry('01', 'THROTTLED'),
            entry('02', 'auth.rate_limited'),
            entry('03', english),
            entry('04', typed),
            entry('05', 'SOMETHING_NEW'),
          ],
          nextCursor: null,
        },
      },
    ]);
    const { container } = renderPage(
      <AuditLogPage
        route={{ path: '/audit-log', query: new URLSearchParams() }}
        denied={false}
        mayExport={false}
      />,
    );
    const throttled = await screen.findByText(t('web.audit_reason_throttled'));
    expect(throttled.closest('.code-label')).toHaveAttribute('title', 'THROTTLED');
    expect(screen.getByText(t('web.err_auth_rate_limited')).closest('.code-label')).toHaveAttribute(
      'title',
      'auth.rate_limited',
    );
    expect(screen.getByText(typed)).toBeInTheDocument();
    // The English sentence is never the reason; it sits under «جزئیات فنی».
    expect(screen.getByText(english).closest('details')).not.toBeNull();
    expect(screen.getAllByText(t('web.audit_reason_technical')).length).toBe(1);
    // An unknown code is shown as itself, never blank.
    expect(screen.getByText('SOMETHING_NEW')).toHaveAttribute('dir', 'ltr');
    for (const reason of container.querySelectorAll('.audit-reason')) {
      expect(reason.textContent ?? '').toMatch(PERSIAN);
    }
  });

  it('names every login failure reason the identity module records', () => {
    for (const reason of LOGIN_FAILURE_REASONS) {
      const key = LOGIN_FAILURE_REASON_LABELS[reason];
      expect((WEB_FA as Record<string, string>)[key] ?? '', reason).toMatch(PERSIAN);
    }
    for (const code of Object.keys(AUDIT_REASON_LABELS)) {
      expect(auditReasonLabel(code), code).toMatch(PERSIAN);
    }
    expect(auditReasonLabel('SOMETHING_NEW')).toBeNull();
  });
});

describe('the readiness probe', () => {
  const service = apiSource('modules/platform/system/application/readiness.service.ts');

  it('names every dependency the API probes', () => {
    const names = [...service.matchAll(/this\.timed\('([^']+)'/gu)].map((match) => match[1]);
    expect(names.length).toBeGreaterThanOrEqual(4);
    for (const name of names) {
      expect(DEPENDENCY_LABELS[name ?? ''], name).toBeDefined();
      expect(dependencyLabel(name ?? '')).toMatch(PERSIAN);
    }
    expect(dependencyLabel('kafka')).toBe('kafka');
  });

  it('says every detail the API writes in Persian', () => {
    // Every `detail: '…'`, `detail: \`…\`` and `return '…'` of the closed vocabulary, with each
    // `${…}` filled by a number.
    const literals = [
      ...[...service.matchAll(/detail: '([^']+)'/gu)].map((match) => match[1] ?? ''),
      ...[...service.matchAll(/detail: `([^`]+)`/gu)].map((match) =>
        (match[1] ?? '')
          .replace(/\$\{verdict\.next\}/gu, '0156_next')
          .replace(/\$\{[^}]+\}/gu, '7'),
      ),
      ...[
        ...service
          .slice(service.indexOf('function classifyProbeFailure'))
          .matchAll(/return '([^']+)'/gu),
      ].map((match) => match[1] ?? ''),
    ];
    expect(literals.length).toBeGreaterThanOrEqual(10);
    const unsaid = literals.filter((detail) => {
      const text = readinessDetailText(detail);
      return text === null || !PERSIAN.test(text);
    });
    // `diverged: …` carries the API's reason; the Persian line names the state.
    expect(unsaid).toEqual([]);
    expect(readinessDetailText('ECONNREFUSED')).toBeNull();
  });

  it('renders Persian names and details, the raw text kept for support', async () => {
    stubApi([
      {
        url: '/system/readiness',
        body: {
          status: 'degraded',
          dependencies: [
            { name: 'postgres', status: 'up', latencyMs: 2, required: true },
            { name: 'redis', status: 'down', detail: 'unreachable', required: false },
            { name: 'migrations', status: 'up', detail: '27 applied', required: true },
            { name: 'outbox', status: 'down', detail: 'something new', required: true },
          ],
        },
      },
    ]);
    renderPage(
      <SystemPage route={{ path: '/system', query: new URLSearchParams() }} permissions={[]} />,
    );
    const name = await screen.findByText(t('web.readiness_dep_postgres'));
    expect(name.closest('.code-label')).toHaveAttribute('title', 'postgres');
    const unreachable = screen.getByText(t('web.readiness_detail_unreachable'));
    expect(unreachable).toHaveAttribute('title', 'unreachable');
    expect(
      screen.getByText(/۲۷|27/u, { selector: 'span[title="27 applied"]' }),
    ).toBeInTheDocument();
    const unknown = screen.getByText('something new');
    expect(unknown.closest('details')).not.toBeNull();
    const row = unknown.closest('tr') as HTMLElement;
    expect(within(row).getByText(t('web.readiness_detail_other'))).toBeInTheDocument();
  });
});

describe('a notification’s type', () => {
  it('names every template key the server can send in Persian', () => {
    const unnamed = TEMPLATE_KEYS.filter(
      (key) => notificationTypeName(key) === key || !PERSIAN.test(notificationTypeName(key)),
    );
    expect(TEMPLATE_KEYS.length).toBeGreaterThan(500);
    expect(unnamed).toEqual([]);
  });

  it('every template key the API writes literally is a catalogued key', () => {
    const root = join(repo, 'apps/api/src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.ts$/u.test(path) && !/\.test\.ts$/u.test(path)) files.push(path);
      }
    };
    walk(root);
    const known = new Set<string>(TEMPLATE_KEYS);
    const literal = new Set<string>();
    for (const file of files) {
      for (const match of readFileSync(file, 'utf8').matchAll(/templateKey: '([^']+)'/gu)) {
        literal.add(match[1] ?? '');
      }
    }
    expect(literal.size).toBeGreaterThan(5);
    expect([...literal].filter((key) => !known.has(key))).toEqual([]);
  });

  it('falls back to the raw key for a key this build does not know', () => {
    expect(notificationTypeName('event.something_new')).toBe('event.something_new');
  });
});

describe('the user menu heading', () => {
  it('opens with the Persian role names too', async () => {
    stubApi([
      {
        url: '/auth/session',
        body: {
          admin: {
            id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
            username: 'sara',
            displayName: 'سارا احمدی',
            status: 'ACTIVE',
            telegramUserId: null,
            roleKeys: ['finance'],
            createdAt: '2026-01-01T00:00:00.000Z',
            lastLoginAt: '2026-09-06T08:00:00.000Z',
          },
          permissions: [],
          expiresAt: '2026-09-07T08:00:00.000Z',
        },
      },
    ]);
    renderPage(<App />);
    fireEvent.click(await screen.findByRole('button', { name: t('web.user_menu') }));
    expect(
      await screen.findByText(`سارا احمدی · ${t('web.role_key_finance')}`),
    ).toBeInTheDocument();
  });
});
