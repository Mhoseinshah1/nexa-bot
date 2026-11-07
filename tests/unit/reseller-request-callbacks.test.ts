import { describe, expect, it } from 'vitest';
import {
  OPS_LOG_ACTION_BUTTON_KINDS,
  RESELLER_REQUEST_CALLBACKS,
  opsLogButtonCallbackData,
} from '@nexa/contracts';
import { intentOf } from '../../apps/api/src/surfaces/telegram/runtime/intent-of';
import { encodeIdPair } from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { WebAdminButtonResolver } from '../../apps/api/src/modules/control/notifications/application/ops-button-resolver';

/**
 * PR-2: the callback vocabulary of «درخواست نمایندگی». A callback is parsed before any
 * permission is looked at, so a malformed one must be UNSUPPORTED and every one must fit
 * Telegram's 64-byte limit; and an operator's action button must be drawn even without a
 * Web Admin address, while a link button still needs one.
 */

const REQUEST = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const TIER = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const call = (data: string) => intentOf({ callback_query: { id: 'q1', data } });

describe('the reseller request callbacks', () => {
  it('routes the menu command and the customer steps', () => {
    expect(intentOf({ message: { text: '/reseller_request' } }).intent).toBe('RESELLER_REQUEST');
    for (const action of ['g', 's', 'b', 'x', 'e']) {
      expect(call(`rrs:${action}:${REQUEST}`)).toMatchObject({
        intent: 'RESELLER_REQUEST_STEP',
        targetId: REQUEST,
        secondaryId: action,
      });
    }
    expect(call(`rqr:${REQUEST}`).intent).toBe('RESELLER_REQUEST_REPLY');
  });

  it('routes the operator buttons to admin intents', () => {
    expect(call(`rqa:${REQUEST}`).intent).toBe('ADMIN_RESELLER_REQUEST_APPROVE');
    expect(call(`rqj:${REQUEST}`).intent).toBe('ADMIN_RESELLER_REQUEST_REJECT');
    expect(call(`rqm:${REQUEST}`).intent).toBe('ADMIN_RESELLER_REQUEST_MESSAGE');
    expect(call(`rqp:${REQUEST}`).intent).toBe('ADMIN_RESELLER_REQUEST_REJECT_PLAIN');
    expect(call(`rqx:${REQUEST}`).intent).toBe('ADMIN_RESELLER_REQUEST_CANCEL');
  });

  it('refuses malformed data instead of guessing', () => {
    expect(call('rrs:z:' + REQUEST).intent).toBe('UNSUPPORTED');
    expect(call('rrs:g:not-a-uuid').intent).toBe('UNSUPPORTED');
    expect(call(`rrs:g:${REQUEST}:extra`).intent).toBe('UNSUPPORTED');
    expect(call('rqt:garbage').intent).toBe('UNSUPPORTED');
    expect(call('rqc:garbage').intent).toBe('UNSUPPORTED');
    expect(call(`rqt:${encodeIdPair(REQUEST, TIER)}`).intent).toBe('ADMIN_RESELLER_REQUEST_TIER');
    expect(call(`rqc:${encodeIdPair(REQUEST, TIER)}`).intent).toBe(
      'ADMIN_RESELLER_REQUEST_CONFIRM',
    );
  });

  it('keeps every prefix distinct and every callback inside 64 bytes', () => {
    const prefixes = Object.values(RESELLER_REQUEST_CALLBACKS);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // `rq:` belongs to SERVICE_RENEW_PLAN: no reseller-request prefix may collide with it.
    for (const prefix of prefixes) {
      expect(prefix).not.toBe('rq:');
      expect(Buffer.byteLength(`${prefix}${encodeIdPair(REQUEST, TIER)}`)).toBeLessThanOrEqual(64);
    }
  });
});

describe('the operator action buttons', () => {
  it('builds callback data only for action kinds with a safe reference', () => {
    expect(opsLogButtonCallbackData({ kind: 'RESELLER_REQUEST_APPROVE', ref: REQUEST })).toBe(
      `rqa:${REQUEST}`,
    );
    expect(opsLogButtonCallbackData({ kind: 'RESELLER_REQUEST_REJECT', ref: REQUEST })).toBe(
      `rqj:${REQUEST}`,
    );
    expect(opsLogButtonCallbackData({ kind: 'RESELLER_REQUEST_MESSAGE', ref: REQUEST })).toBe(
      `rqm:${REQUEST}`,
    );
    expect(opsLogButtonCallbackData({ kind: 'RESELLER_REQUEST_APPROVE', ref: 'a b' })).toBeNull();
    expect(opsLogButtonCallbackData({ kind: 'RESELLER_REQUEST_APPROVE' })).toBeNull();
    expect(opsLogButtonCallbackData({ kind: 'USER', ref: 'u1' })).toBeNull();
  });

  it('draws action buttons without a Web Admin address, and links only with one', async () => {
    const scope = { tenantId: 't' as never, botInstanceId: null };
    const make = (origin: string | null) =>
      new WebAdminButtonResolver({
        settings: { valueOf: async () => '' } as never,
        defaultOrigin: origin,
        labelOf: (kind) => kind,
      });
    const buttons = [
      { kind: 'RESELLER_REQUEST_APPROVE' as const, ref: REQUEST },
      { kind: 'RESELLER_REQUEST_REJECT' as const, ref: REQUEST },
      { kind: 'RESELLER_REQUEST' as const, ref: REQUEST },
    ];
    expect(OPS_LOG_ACTION_BUTTON_KINDS).toContain('RESELLER_REQUEST_APPROVE');
    const without = await make(null).resolve(scope, buttons);
    expect(without.map((button) => ('data' in button ? button.data : null))).toEqual([
      `rqa:${REQUEST}`,
      `rqj:${REQUEST}`,
    ]);
    const withOrigin = await make('https://a.example.com').resolve(scope, buttons);
    expect(withOrigin).toHaveLength(3);
    expect(withOrigin[2]).toMatchObject({ url: expect.stringContaining('https://a.example.com') });
  });
});
