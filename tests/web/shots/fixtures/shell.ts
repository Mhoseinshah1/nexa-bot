import {
  PERMISSION_KEYS,
  healthInfoResponseSchema,
  sessionResponseSchema,
  systemReadinessResponseSchema,
} from '@nexa/contracts';
import { ago, fixture, type ShotFixture } from '../fixture.ts';

/**
 * What every screen needs: a signed-in owner holding every permission (so the
 * whole navigation is drawn), and the build the sidebar names.
 */
export const SHELL: readonly ShotFixture[] = [
  fixture('/auth/session', sessionResponseSchema, {
    admin: {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292c8',
      username: 'owner',
      displayName: 'مدیر اصلی',
      status: 'ACTIVE',
      telegramUserId: null,
      roleKeys: ['owner'],
      createdAt: ago(60 * 24 * 400),
      lastLoginAt: ago(5),
    },
    permissions: [...PERMISSION_KEYS],
    expiresAt: ago(-60 * 8),
  }),
  fixture(
    '/health/info',
    healthInfoResponseSchema,
    {
      name: 'nexa-bot',
      version: '0.4.0',
      commit: '7ba1837e6c2d4a1b9f0e3c5d7a8b9c0d1e2f3a4b',
      buildTime: ago(60 * 24 * 2),
      nodeVersion: 'v22.11.0',
      environment: 'production',
    },
    { absolute: true },
  ),
  fixture('/system/readiness', systemReadinessResponseSchema, {
    status: 'ok',
    dependencies: [
      { name: 'postgres', status: 'up', latencyMs: 3 },
      { name: 'redis', status: 'up', latencyMs: 1 },
      { name: 'migrations', status: 'up', detail: '27 applied' },
      { name: 'outbox-relay', status: 'up', latencyMs: 12 },
    ],
  }),
];
