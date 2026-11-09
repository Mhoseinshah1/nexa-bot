import { describe, expect, it } from 'vitest';
import { MOVE_ERROR_CODES } from '@nexa/contracts';

describe('the server-move error codes (ADR-0039 § 8)', () => {
  it('are a closed vocabulary under the move. prefix, each named once', () => {
    const codes = Object.values(MOVE_ERROR_CODES);
    expect(codes.every((code) => /^move\.[a-z_]+$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain('move.head_newer');
    expect(codes).toContain('move.target_not_fresh');
    expect(codes).toContain('move.hosted_mismatch');
  });
});
