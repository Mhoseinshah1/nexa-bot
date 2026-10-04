import { describe, expect, it } from 'vitest';
import {
  BUSINESS_BOT_RIGHTS,
  businessConnectionStatus,
  classifyBusinessMessage,
} from '@nexa/contracts';
import {
  businessUpdateOf,
  parseBusinessConnection,
  parseBusinessDeletion,
  parseBusinessMessage,
} from '../../apps/api/src/modules/commerce/business-chats/domain/telegram-business';
import {
  allowedUpdatesNarrowed,
  TELEGRAM_HANDLED_UPDATE_TYPES,
} from '../../apps/api/src/modules/platform/tenancy/domain/webhook-url';

/**
 * TB1 — the pure rules under ADR-0033: who sent a business message, whether a connection
 * may send, and how Telegram's Business objects are read.
 */

const OWNER = '5000001';
const CUSTOMER = '7000001';
const OUR_BOT = '9000001';
const OTHER_BOT = '9000002';

function classify(overrides: Partial<Parameters<typeof classifyBusinessMessage>[0]>) {
  return classifyBusinessMessage({
    fromUserId: OWNER,
    ownerUserId: OWNER,
    senderBusinessBotId: null,
    ownBotId: OUR_BOT,
    isFromOffline: false,
    knownOwnMessage: false,
    ...overrides,
  });
}

describe('classifying a business message (ADR-0033 §3, tb0-audit §1.4)', () => {
  it('a message from anyone but the owner is the customer writing in', () => {
    expect(classify({ fromUserId: CUSTOMER })).toBe('INBOUND');
  });

  it('a message our bot sent on the owner’s behalf is our own echo', () => {
    expect(classify({ senderBusinessBotId: OUR_BOT })).toBe('OWN_ECHO');
  });

  it('a message id our send record holds is our own echo, even without the bot field', () => {
    expect(classify({ knownOwnMessage: true })).toBe('OWN_ECHO');
  });

  it('an away, greeting or scheduled message is not a human entering', () => {
    expect(classify({ isFromOffline: true })).toBe('OFFLINE');
  });

  it('another business bot speaking for the owner takes the conversation like a human', () => {
    expect(classify({ senderBusinessBotId: OTHER_BOT })).toBe('OTHER_BOT');
  });

  it('the owner typing by hand is HUMAN', () => {
    expect(classify({})).toBe('HUMAN');
  });

  // The conservative rule (TB0 amendment 2): every doubt resolves toward HUMAN.
  it('an outgoing message is HUMAN when this bot’s own id is not yet known', () => {
    expect(classify({ ownBotId: null, senderBusinessBotId: OUR_BOT })).toBe('OTHER_BOT');
    expect(classify({ ownBotId: null })).toBe('HUMAN');
  });

  it('a message with no sender never counts as a customer starting AI work', () => {
    expect(classify({ fromUserId: null })).toBe('HUMAN');
    expect(classify({ fromUserId: null, senderBusinessBotId: OUR_BOT })).toBe('OWN_ECHO');
  });

  it('an offline message sent by ANOTHER bot is still offline, not ours', () => {
    expect(classify({ isFromOffline: true, senderBusinessBotId: OTHER_BOT })).toBe('OFFLINE');
  });
});

describe('a connection’s projected status', () => {
  const base = { isEnabled: true, rights: ['can_reply'], supersededAt: null };

  it('is ACTIVE only when enabled, holding can_reply, and not replaced', () => {
    expect(businessConnectionStatus(base)).toBe('ACTIVE');
  });

  it('fails closed on every other combination', () => {
    expect(businessConnectionStatus({ ...base, isEnabled: false })).toBe('DISABLED');
    expect(businessConnectionStatus({ ...base, rights: ['can_read_messages'] })).toBe(
      'RIGHTS_INSUFFICIENT',
    );
    expect(businessConnectionStatus({ ...base, rights: [] })).toBe('RIGHTS_INSUFFICIENT');
    expect(businessConnectionStatus({ ...base, supersededAt: new Date(0) })).toBe('SUPERSEDED');
    // Superseded wins over everything: a replaced connection is never re-enabled by a report.
    expect(
      businessConnectionStatus({
        isEnabled: true,
        rights: ['can_reply'],
        supersededAt: new Date(0),
      }),
    ).toBe('SUPERSEDED');
  });
});

describe('reading a BusinessConnection strictly', () => {
  const raw = {
    id: 'conn-1',
    user: { id: 5000001, is_bot: false, first_name: 'Owner' },
    user_chat_id: 5000001,
    date: 1_790_000_000,
    is_enabled: true,
    rights: { can_reply: true, can_read_messages: false, can_fly: true },
  };

  it('keeps the documented rights that are true, and drops unknown ones', () => {
    expect(parseBusinessConnection(raw)).toEqual({
      connectionId: 'conn-1',
      ownerTelegramUserId: '5000001',
      ownerUserChatId: '5000001',
      isEnabled: true,
      rights: ['can_reply'],
      connectedAt: new Date(1_790_000_000 * 1000),
    });
  });

  it('reads an absent rights object as NO rights', () => {
    const { rights: _omitted, ...withoutRights } = raw;
    expect(parseBusinessConnection(withoutRights)?.rights).toEqual([]);
  });

  it('refuses a malformed identity rather than coercing it', () => {
    expect(parseBusinessConnection({ ...raw, user: { id: '5000001' } })).toBeNull();
    expect(parseBusinessConnection({ ...raw, user: { id: -1 } })).toBeNull();
    expect(parseBusinessConnection({ ...raw, is_enabled: 'true' })).toBeNull();
    expect(parseBusinessConnection({ ...raw, id: '' })).toBeNull();
    expect(parseBusinessConnection(null)).toBeNull();
  });

  it('only stores rights the column CHECK admits', () => {
    const all = Object.fromEntries(BUSINESS_BOT_RIGHTS.map((right) => [right, true]));
    expect(parseBusinessConnection({ ...raw, rights: all })?.rights).toEqual([
      ...BUSINESS_BOT_RIGHTS,
    ]);
  });
});

describe('reading business messages and deletions', () => {
  const message = {
    message_id: 41,
    business_connection_id: 'conn-1',
    chat: { id: 7000001, type: 'private' },
    from: { id: 5000001, is_bot: false },
    sender_business_bot: { id: 9000001, is_bot: true },
    date: 1_790_000_100,
    text: 'hello',
  };

  it('reads the routing facts and none of the content', () => {
    const parsed = parseBusinessMessage(message);
    expect(parsed).toEqual({
      connectionId: 'conn-1',
      chatId: '7000001',
      chatType: 'private',
      messageId: 41,
      fromUserId: '5000001',
      senderBusinessBotId: '9000001',
      isFromOffline: false,
      sentAt: new Date(1_790_000_100 * 1000),
      editedAt: null,
    });
    expect(JSON.stringify(parsed)).not.toContain('hello');
  });

  it('refuses a message without a connection id', () => {
    const { business_connection_id: _omitted, ...rest } = message;
    expect(parseBusinessMessage(rest)).toBeNull();
  });

  it('reads a deletion, and refuses an empty one', () => {
    expect(
      parseBusinessDeletion({
        business_connection_id: 'conn-1',
        chat: { id: 7000001, type: 'private' },
        message_ids: [1, 2],
      }),
    ).toEqual({ connectionId: 'conn-1', chatId: '7000001', messageIds: [1, 2] });
    expect(
      parseBusinessDeletion({ business_connection_id: 'conn-1', chat: { id: 1 }, message_ids: [] }),
    ).toBeNull();
  });
});

describe('recognising a business update by its key', () => {
  it('names each of the four kinds, and nothing else', () => {
    expect(businessUpdateOf({ update_id: 1, business_connection: {} })?.kind).toBe('CONNECTION');
    expect(businessUpdateOf({ update_id: 1, business_message: {} })?.kind).toBe('MESSAGE');
    expect(businessUpdateOf({ update_id: 1, edited_business_message: {} })?.kind).toBe(
      'EDITED_MESSAGE',
    );
    expect(businessUpdateOf({ update_id: 1, deleted_business_messages: {} })?.kind).toBe(
      'DELETED_MESSAGES',
    );
    expect(businessUpdateOf({ update_id: 1, message: {} })).toBeNull();
  });

  // A malformed payload is still a business update: it must not fall through to the
  // ordinary routes because it did not parse.
  it('recognises a business update whose payload is not even an object', () => {
    expect(businessUpdateOf({ update_id: 1, business_message: null })?.kind).toBe('MESSAGE');
  });
});

describe('the webhook registration covers business updates', () => {
  it('handles all four business update types', () => {
    for (const type of [
      'business_connection',
      'business_message',
      'edited_business_message',
      'deleted_business_messages',
    ]) {
      expect(TELEGRAM_HANDLED_UPDATE_TYPES).toContain(type);
    }
  });

  it('reports an explicit allowed_updates list that leaves them out as narrowed', () => {
    expect(
      allowedUpdatesNarrowed(['message', 'callback_query', 'pre_checkout_query', 'my_chat_member']),
    ).toBe(true);
    // Telegram's default set (empty list / null) includes them.
    expect(allowedUpdatesNarrowed([])).toBe(false);
    expect(allowedUpdatesNarrowed(null)).toBe(false);
  });
});
