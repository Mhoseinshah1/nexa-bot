import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_PRECONDITIONS,
  CUSTOMER_NOTIFICATION_QUIET_HOURS,
  CUSTOMER_NOTIFICATION_STATES,
  CUSTOMER_NOTIFICATION_TEMPLATES,
  DIRECT_MESSAGE_DELIVERY_STATES,
  PERMISSION_REQUIRES,
  directMessageDeliveryState,
  sendDirectMessageRequestSchema,
  templateDefinition,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';

/**
 * Phase A2: the rules of a direct message that live in the contract — the operator-facing
 * projection of the lane's state, the lane's per-kind decisions, and the template.
 */
describe('the delivery projection', () => {
  it('maps every lane state, and never says "delivered" or "read"', () => {
    const seen = new Set<string>();
    for (const state of CUSTOMER_NOTIFICATION_STATES) {
      for (const sendStarted of [false, true]) {
        seen.add(directMessageDeliveryState({ state, sendStarted }));
      }
    }
    expect([...seen].sort()).toEqual([...DIRECT_MESSAGE_DELIVERY_STATES].sort());
    expect(DIRECT_MESSAGE_DELIVERY_STATES as readonly string[]).not.toContain('DELIVERED');
    expect(DIRECT_MESSAGE_DELIVERY_STATES as readonly string[]).not.toContain('READ');
  });

  it('keeps the four outcomes apart: accepted, refused, unknown, expired', () => {
    expect(directMessageDeliveryState({ state: 'PENDING', sendStarted: false })).toBe('QUEUED');
    expect(directMessageDeliveryState({ state: 'PENDING', sendStarted: true })).toBe('SENDING');
    expect(directMessageDeliveryState({ state: 'DELIVERED', sendStarted: false })).toBe('SENT');
    expect(directMessageDeliveryState({ state: 'FAILED', sendStarted: false })).toBe('FAILED');
    expect(directMessageDeliveryState({ state: 'UNCONFIRMED', sendStarted: false })).toBe(
      'UNKNOWN',
    );
    expect(directMessageDeliveryState({ state: 'SUPERSEDED', sendStarted: false })).toBe('EXPIRED');
    expect(directMessageDeliveryState(null)).toBe('FAILED');
  });
});

describe('the lane kinds', () => {
  it('re-check staleness at send time and are never held by quiet hours', () => {
    for (const kind of ['DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA'] as const) {
      expect(CUSTOMER_NOTIFICATION_PRECONDITIONS[kind]).toBe(true);
      expect(CUSTOMER_NOTIFICATION_QUIET_HOURS[kind]).toBe(false);
    }
    expect(CUSTOMER_NOTIFICATION_TEMPLATES.DIRECT_MESSAGE).toBe('bot.direct_message.text');
    expect(CUSTOMER_NOTIFICATION_TEMPLATES.DIRECT_MESSAGE_MEDIA).toBe('bot.direct_message.media');
  });

  it('requires reading the customer for both keys', () => {
    expect(PERMISSION_REQUIRES['users.message.send']).toBe('users.view');
    expect(PERMISSION_REQUIRES['users.message.view']).toBe('users.view');
  });
});

describe('the templates', () => {
  const rendered = (
    key: 'bot.direct_message.text' | 'bot.direct_message.media',
    values: Record<string, string>,
  ) =>
    appearanceFallbackText(
      renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values, 'fa'),
    );

  it('carry the operator’s words verbatim under an Appearance-marked heading', () => {
    expect(CATALOGUE_FA['bot.direct_message.text']).toContain('{icon:support}');
    const text = rendered('bot.direct_message.text', { text: '<b>not html</b> {firstName}' });
    expect(text).toContain('<b>not html</b> {firstName}');
  });

  it('drop the caption line when a file is sent without one', () => {
    const bare = rendered('bot.direct_message.media', {});
    expect(bare).not.toContain('{caption}');
    expect(bare.trim().split('\n')).toHaveLength(1);
    expect(rendered('bot.direct_message.media', { caption: 'فاکتور' })).toContain('فاکتور');
  });
});

describe('the request', () => {
  it('needs an idempotency key and refuses unknown fields', () => {
    expect(sendDirectMessageRequestSchema.safeParse({ text: 'x' }).success).toBe(false);
    expect(
      sendDirectMessageRequestSchema.safeParse({ idempotencyKey: 'k'.repeat(10), chatId: '1' })
        .success,
    ).toBe(false);
    expect(
      sendDirectMessageRequestSchema.parse({ idempotencyKey: 'k'.repeat(10), text: 'سلام' }),
    ).toEqual({ idempotencyKey: 'k'.repeat(10), text: 'سلام', file: null });
  });
});
