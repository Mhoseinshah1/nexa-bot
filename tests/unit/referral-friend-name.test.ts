import { describe, expect, it } from 'vitest';
import {
  FRIEND_NAME_MAX_LENGTH,
  friendDisplayName,
  maskUsername,
} from '../../apps/api/src/modules/commerce/referrals/application/referral-friend-name';

/**
 * R11 B3: how an invited friend is named to the customer who invited them. A first name, or a
 * username with its middle hidden, or nothing: never more than the referrer could already
 * know, and never anything a Telegram id or a phone could be hidden in.
 */
describe('friendDisplayName', () => {
  it('shows the first name and nothing of the username when there is a first name', () => {
    expect(friendDisplayName('مهسا', 'mahsa_secret')).toBe('مهسا');
  });

  it('hides the middle of a username when there is no first name', () => {
    expect(friendDisplayName(null, 'mahsa_secret')).toBe('@ma***');
    expect(friendDisplayName('', '@mahsa_secret')).toBe('@ma***');
    expect(friendDisplayName('   ', 'mahsa_secret')).toBe('@ma***');
    // The full username never appears in any masked form.
    expect(maskUsername('mahsa_secret')).not.toContain('secret');
  });

  it('reveals less of a shorter username, and none of a very short one', () => {
    expect(maskUsername('abcde')).toBe('@ab***');
    expect(maskUsername('abcd')).toBe('@a***');
    expect(maskUsername('abc')).toBe('@a***');
    expect(maskUsername('ab')).toBe('@***');
  });

  it('is null when there is neither a name nor a username', () => {
    expect(friendDisplayName(null, null)).toBeNull();
    expect(friendDisplayName('', '')).toBeNull();
    expect(friendDisplayName(' ', '@')).toBeNull();
  });

  it('bounds a long first name by characters and strips invisible and bidi controls', () => {
    const long = friendDisplayName('ب'.repeat(100), null) ?? '';
    expect(Array.from(long)).toHaveLength(FRIEND_NAME_MAX_LENGTH);
    expect(friendDisplayName('‮علی‏\n  رضا\u0000', null)).toBe('علی رضا');
  });

  it('keeps the zero-width non-joiner a Persian name is spelt with', () => {
    expect(friendDisplayName('نگین\u200cدخت', null)).toBe('نگین\u200cدخت');
  });
});
