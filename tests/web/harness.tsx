import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import { vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { ToastProvider } from '../../apps/web/src/ui/kit';

/**
 * The Web Admin test harness.
 *
 * It stubs `fetch` and NOTHING else. Every layer above it is the real one: the
 * real API client with the real zod parsing, the real query cache, the real
 * components. That matters because the risk this suite exists to cover is
 * production WIRING — a page that renders beautifully from a hand-made prop and
 * throws on the shape the server actually sends is the defect, and a test that
 * passes a prop directly cannot see it.
 */

export interface Route {
  /** Matched as a substring of the request URL. */
  readonly url: string;
  readonly body: unknown;
  readonly status?: number;
}

export interface Api {
  /** Every request the component made, in order. */
  readonly calls: { url: string; method: string; body: unknown }[];
}

export function stubApi(routes: readonly Route[]): Api {
  const calls: { url: string; method: string; body: unknown }[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });

      // Longest match wins, so `/panels/abc` is not answered by the `/panels`
      // route that happens to be registered first.
      const matches = routes.filter((route) => url.includes(route.url));
      const route = matches.sort((a, b) => b.url.length - a.url.length)[0];

      if (route === undefined) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                kind: 'not_found',
                code: 'test.unrouted',
                message: url,
                correlationId: 'test',
              },
            }),
            {
              status: 404,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );

  return { calls };
}

/**
 * Renders inside the providers the real app mounts.
 *
 * `retry: false` because a test that retries a deliberate failure spends its
 * timeout proving the retry works rather than the thing under test.
 */
export function renderPage(element: ReactElement): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrap = (node: ReactNode) => (
    <QueryClientProvider client={client}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>
  );
  const result = render(wrap(element));
  return {
    ...result,
    // Re-wraps. Testing Library's own `rerender` replaces the WHOLE tree, so
    // calling it with a bare page drops the providers and the component throws
    // "No QueryClient set" — which looks like a defect in the page. Re-rendering
    // the same instance with new props is how a test reaches the state SPA
    // navigation produces, so it has to work.
    rerender: (node: ReactNode) => result.rerender(wrap(node)),
  };
}

// ---------------------------------------------------------------------------
// Fixtures, shaped exactly as the server's schemas describe them
// ---------------------------------------------------------------------------

export function panel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
    name: 'Frankfurt A',
    providerType: 'marzban',
    providerName: 'Marzban',
    baseUrl: 'https://panel.example/api',
    status: 'ACTIVE',
    capabilities: ['HEALTH_CHECK'],
    credentials: {
      username: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
      password: { configured: true, lastReplacedAt: '2026-01-01T00:00:00.000Z' },
      apiToken: { configured: false, lastReplacedAt: null },
    },
    health: {
      state: 'HEALTHY',
      checkedAt: '2026-09-06T08:00:00.000Z',
      latencyMs: 42,
      failure: null,
      status: 200,
      providerVersion: '0.8.4',
      lastHealthyAt: '2026-09-06T08:00:00.000Z',
      stale: false,
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function setting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'ops.notifications.max_attempts',
    value: 5,
    source: 'DEFAULT',
    version: null,
    updatedAt: null,
    updatedByAdminId: null,
    description: 'How many times one notification may be attempted.',
    zeroMeaning: 'NOT_APPLICABLE',
    mutability: 'RUNTIME',
    classification: 'PUBLIC',
    configures: 'ops_notifications',
    consumer: 'ACTIVE',
    storedValueInvalid: false,
    ...overrides,
  };
}

export function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c9',
    // A code a production path actually writes. `admin.roles_change` was an
    // invention — the audit ACTION is `admin.roles_change`, the operational
    // event CODE is `admin.roles_changed` — so every assertion built on it was
    // about a row nothing inserts.
    code: 'admin.roles_changed',
    severity: 'WARN',
    message: 'Roles changed.',
    context: null,
    occurrenceCount: 1,
    firstSeenAt: '2026-09-06T08:00:00.000Z',
    lastSeenAt: '2026-09-06T08:00:00.000Z',
    correlationId: 'c1',
    recoversCode: null,
    resolvedAt: null,
    resolvedByEventId: null,
    ...overrides,
  };
}
