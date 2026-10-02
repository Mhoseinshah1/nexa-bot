import { describe, expect, it } from 'vitest';
import {
  RoutedBackupDelivery,
  type OpsGroupBackupRoute,
  type OpsGroupBackupTopic,
} from '../../apps/api/src/modules/platform/backup/application/routed-backup-delivery';
import type {
  BackupDeliveryChannel,
  DeliveryAttempt,
} from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * Spec §13.1 — where a backup archive goes, and the one resend that is safe.
 *
 * Fakes for the group and the channels: what is under test is the PRECEDENCE (group
 * topic, then the environment's dedicated chat, then nothing) and the handling of a
 * deleted topic. The Telegram classification is `backup-delivery.test.ts`'s, against a
 * real socket; the topic claim is the provisioner's (`ops-log-group.test.ts`).
 */

const SCOPE = { tenantId: 't1' as never, botInstanceId: null };
const AT = new Date('2026-10-02T09:00:00.000Z');

interface Sent {
  readonly to: string;
  readonly kind: 'document' | 'message';
}

function world(
  options: {
    group?: OpsGroupBackupRoute | (() => OpsGroupBackupRoute);
    dedicatedConfigured?: boolean;
    /** What a send into the group answers, per thread. */
    groupAnswer?: (threadId: number) => DeliveryAttempt;
    scoped?: boolean;
  } = {},
) {
  const sent: Sent[] = [];
  const routes: (number | null)[] = [];
  const delivered: string[] = [];
  let routeCount = 0;
  const group: OpsGroupBackupTopic = {
    async connected() {
      const route = typeof options.group === 'function' ? options.group() : options.group;
      return route !== undefined && route.kind !== 'NOT_CONNECTED';
    },
    async route(_scope, stale) {
      routes.push(stale);
      routeCount += 1;
      const route =
        typeof options.group === 'function'
          ? options.group()
          : (options.group ?? { kind: 'NOT_CONNECTED' as const });
      // A recreation (stale thread named) yields a NEW thread, like the provisioner.
      if (route.kind === 'ROUTED' && stale !== null) {
        return { ...route, threadId: route.threadId + routeCount * 100 };
      }
      return route;
    },
    async delivered(_scope, chatId) {
      delivered.push(chatId);
    },
  };
  const channelFor = (target: { token: string; chatId: string; threadId: number }) => ({
    async sendDocument() {
      sent.push({ to: `${target.chatId}#${String(target.threadId)}`, kind: 'document' as const });
      return (
        options.groupAnswer?.(target.threadId) ?? { state: 'SUCCEEDED' as const, detail: null }
      );
    },
    async sendMessage() {
      sent.push({ to: `${target.chatId}#${String(target.threadId)}`, kind: 'message' as const });
      return (
        options.groupAnswer?.(target.threadId) ?? { state: 'SUCCEEDED' as const, detail: null }
      );
    },
  });
  const dedicated: BackupDeliveryChannel = {
    configured: options.dedicatedConfigured ?? false,
    async sendDocument() {
      sent.push({ to: 'dedicated', kind: 'document' });
      return { state: 'SUCCEEDED', detail: null };
    },
    async sendMessage() {
      sent.push({ to: 'dedicated', kind: 'message' });
      return { state: 'SUCCEEDED', detail: null };
    },
  };
  const delivery = new RoutedBackupDelivery({
    opsGroup: group,
    scope: () => (options.scoped === false ? null : SCOPE),
    channelFor,
    dedicated,
    clock: { now: () => AT },
    logger: { warn() {} },
  });
  return { delivery, sent, routes, delivered };
}

const ROUTED: OpsGroupBackupRoute = {
  kind: 'ROUTED',
  chatId: '-100500',
  threadId: 7,
  token: '1:secret',
};

const DOC = { archivePath: '/a', filename: 'b.nxb', caption: 'c' };

async function sendDocument(w: ReturnType<typeof world>) {
  const resolution = await w.delivery.resolve();
  if (resolution.kind !== 'READY') throw new Error(`expected READY, got ${resolution.kind}`);
  return { resolution, attempt: await resolution.channel.sendDocument(DOC) };
}

describe('backup delivery precedence', () => {
  it('sends to the connected group’s backups topic, even with a dedicated chat configured', async () => {
    const w = world({ group: ROUTED, dedicatedConfigured: true });
    const { resolution, attempt } = await sendDocument(w);
    expect(resolution.kind === 'READY' && resolution.destination).toBe('OPS_GROUP_TOPIC');
    expect(attempt.state).toBe('SUCCEEDED');
    // The canonical destination is the group; the environment chat is not ALSO sent to.
    expect(w.sent).toEqual([{ to: '-100500#7', kind: 'document' }]);
    expect(w.delivered).toEqual(['-100500']);
    await expect(w.delivery.describe()).resolves.toBe('OPS_GROUP_TOPIC');
  });

  it('falls back to the dedicated chat when no group is connected', async () => {
    const w = world({ group: { kind: 'NOT_CONNECTED' }, dedicatedConfigured: true });
    const { resolution } = await sendDocument(w);
    expect(resolution.kind === 'READY' && resolution.destination).toBe('DEDICATED_CHAT');
    expect(w.sent).toEqual([{ to: 'dedicated', kind: 'document' }]);
    await expect(w.delivery.describe()).resolves.toBe('DEDICATED_CHAT');
  });

  it('falls back to the dedicated chat when the group topic is unusable before anything is sent', async () => {
    const w = world({
      group: { kind: 'UNAVAILABLE', errorCode: 'ops_group.topic_pending', errorMessage: 'x' },
      dedicatedConfigured: true,
    });
    const { resolution } = await sendDocument(w);
    expect(resolution.kind === 'READY' && resolution.destination).toBe('DEDICATED_CHAT');
  });

  it('records a connected-but-unusable group with no fallback as a refusal, sending nothing', async () => {
    const w = world({
      group: { kind: 'UNAVAILABLE', errorCode: 'telegram.no_bot_configured', errorMessage: 'x' },
    });
    const resolution = await w.delivery.resolve();
    expect(resolution.kind).toBe('UNAVAILABLE');
    expect(resolution.kind === 'UNAVAILABLE' && resolution.detail).toContain(
      'telegram.no_bot_configured',
    );
    expect(w.sent).toEqual([]);
  });

  it('is NONE with nothing configured anywhere, and before a tenant exists', async () => {
    await expect(world().delivery.resolve()).resolves.toEqual({ kind: 'NONE' });
    await expect(world().delivery.describe()).resolves.toBe('NONE');
    const unscoped = world({ group: ROUTED, scoped: false });
    await expect(unscoped.delivery.resolve()).resolves.toEqual({ kind: 'NONE' });
    expect(unscoped.routes).toEqual([]);
  });
});

describe('a deleted backups topic', () => {
  it('is recreated and the archive sent once more, after a DEFINITIVE "topic is gone"', async () => {
    const w = world({
      group: ROUTED,
      groupAnswer: (thread) =>
        thread === 7
          ? {
              state: 'FAILED_DEFINITIVE',
              detail: 'HTTP 400 (400): Bad Request: message thread not found',
              topicMissing: true,
            }
          : { state: 'SUCCEEDED', detail: null },
    });
    const { attempt } = await sendDocument(w);
    expect(attempt.state).toBe('SUCCEEDED');
    // The second route names the stale thread, so the provisioner recreates it ONCE.
    expect(w.routes).toEqual([null, 7]);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]?.to).not.toBe('-100500#7');
  });

  it('is never resent after an outcome nobody observed', async () => {
    const w = world({
      group: ROUTED,
      dedicatedConfigured: true,
      groupAnswer: () => ({ state: 'OUTCOME_UNKNOWN', detail: 'socket closed' }),
    });
    const { attempt } = await sendDocument(w);
    // The first may have landed: no recreation, no second copy in the group, and no
    // "fallback" copy in the dedicated chat either.
    expect(attempt.state).toBe('OUTCOME_UNKNOWN');
    expect(w.sent).toEqual([{ to: '-100500#7', kind: 'document' }]);
    expect(w.routes).toEqual([null]);
  });

  it('is not resent after an ordinary definitive refusal', async () => {
    const w = world({
      group: ROUTED,
      groupAnswer: () => ({ state: 'FAILED_DEFINITIVE', detail: 'HTTP 400: file too big' }),
    });
    const { attempt } = await sendDocument(w);
    expect(attempt.state).toBe('FAILED_DEFINITIVE');
    expect(w.sent).toHaveLength(1);
  });

  it('keeps the refusal when the topic cannot be recreated', async () => {
    let calls = 0;
    const w = world({
      group: () =>
        ++calls === 1
          ? ROUTED
          : { kind: 'UNAVAILABLE', errorCode: 'telegram.403', errorMessage: 'no rights' },
      groupAnswer: () => ({
        state: 'FAILED_DEFINITIVE',
        detail: 'message thread not found',
        topicMissing: true,
      }),
    });
    const { attempt } = await sendDocument(w);
    expect(attempt.state).toBe('FAILED_DEFINITIVE');
    expect(w.sent).toHaveLength(1);
  });
});
