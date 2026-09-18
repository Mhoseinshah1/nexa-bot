import { ADMIN_PASSWORD_MIN, ADMIN_USERNAME_MIN } from '@nexa/contracts';
import { describe, expect, it } from 'vitest';
import {
  checkOwnerDisplayName,
  checkOwnerPassword,
  checkOwnerTelegramId,
  checkOwnerUsername,
} from '../../apps/api/src/infrastructure/tty/owner-input.js';
import { PromptInputError } from '../../apps/api/src/infrastructure/tty/prompt.js';

/**
 * What an operator sees when they get the first owner's details wrong.
 *
 * On a real Ubuntu 24.04 staging host somebody typed an eleven-character
 * password. The schema rejected it correctly and the CLI printed a `ZodError`
 * stack trace with the string `Too small: expected string to have >=12
 * characters` in it, because a ZodError is neither a NexaError nor a
 * PromptInputError and fell into the branch reserved for bugs.
 */
describe('the first owner’s answers', () => {
  const failure = (run: () => unknown): PromptInputError => {
    try {
      run();
    } catch (error) {
      expect(error, 'an invalid answer is an operator mistake, not a bug').toBeInstanceOf(
        PromptInputError,
      );
      return error as PromptInputError;
    }
    throw new Error('the answer was accepted');
  };

  it('says how long the password must be, in a sentence', () => {
    const error = failure(() => checkOwnerPassword('short-pass'));
    expect(error.message).toBe(
      `The owner password must be at least ${ADMIN_PASSWORD_MIN} characters long.`,
    );
    // The exact shape of the failure that reached the staging operator.
    expect(error.message, 'the internal Zod wording leaked through').not.toContain('Too small');
    expect(error.stack, 'a stack is for a bug, not for a short password').toBeDefined();
  });

  it('never puts the password in the message', () => {
    // The one field that was typed blind, so it would not be displayed.
    const error = failure(() => checkOwnerPassword('hunter2'));
    expect(error.message).not.toContain('hunter2');
  });

  it('states the username rule the operator broke, and only that one', () => {
    const tooShort = failure(() => checkOwnerUsername('ab'));
    expect(tooShort.message).toBe(
      `The owner username must be at least ${ADMIN_USERNAME_MIN} characters long.`,
    );

    const badCharacters = failure(() => checkOwnerUsername('mamad!'));
    expect(badCharacters.message).toBe(
      'The owner username may contain only lowercase letters, digits, dot, underscore or hyphen.',
    );
  });

  it('accepts a username the service would have accepted', () => {
    // `BootstrapOwnerService` lower-cases and trims before parsing, so `Mamad`
    // is valid and is stored as `mamad`. A check on the raw value would reject
    // at the prompt what the service accepts — a stricter rule invented by an
    // error message, which is worse than the stack trace it replaced.
    expect(checkOwnerUsername('  Mamad  ')).toBe('mamad');
  });

  it('calls an empty display name empty', () => {
    // Not "must be at least 1 characters": the operator pressed Enter.
    expect(failure(() => checkOwnerDisplayName('   ')).message).toBe(
      'The display name must not be empty.',
    );
    expect(failure(() => checkOwnerDisplayName('x'.repeat(200))).message).toBe(
      'The display name must be at most 120 characters long.',
    );
    expect(checkOwnerDisplayName('  Mamad Owner  ')).toBe('Mamad Owner');
  });

  it('refuses everything that is not a Telegram numeric id, before the owner is created', () => {
    // The id binds the owner's authority to one Telegram account for good, and
    // Telegram cannot reassign a numeric id — which is exactly why a username,
    // an @handle, a sign, an interior space or a leading zero is refused with
    // the schema's own sentence rather than repaired into a guess.
    for (const bad of ['mamad', '@mamad', '-5', '12 34', '0123', '', '+123', '1.5', '1e9']) {
      expect(failure(() => checkOwnerTelegramId(bad)).message, `"${bad}" was accepted`).toBe(
        'The owner Telegram id must be a positive Telegram numeric id.',
      );
    }
    // Twenty digits is longer than any Telegram id and longer than the column.
    expect(failure(() => checkOwnerTelegramId('1'.repeat(20))).message).toContain(
      'must be a positive Telegram numeric id',
    );
  });

  it('accepts a Telegram numeric id, and trims only what a terminal adds around it', () => {
    expect(checkOwnerTelegramId('123456789')).toBe('123456789');
    // A trailing newline or a pasted space is not a value; an interior one is
    // refused above.
    expect(checkOwnerTelegramId('  123456789 \r')).toBe('123456789');
    expect(checkOwnerTelegramId('1')).toBe('1');
  });

  it('takes its numbers from the schema rather than restating them', () => {
    // A message that hard-codes "12" outlives the policy it explains. These
    // come from the contract's own constants, so changing the floor changes the
    // sentence.
    expect(failure(() => checkOwnerPassword('x')).message).toContain(String(ADMIN_PASSWORD_MIN));
    expect(failure(() => checkOwnerUsername('x')).message).toContain(String(ADMIN_USERNAME_MIN));
  });
});
