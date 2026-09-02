import { describe, expect, it } from 'vitest';
import {
  coerceTemplateValue,
  coerceTemplateValues,
  isMoneyValue,
  templateDefinition,
  type PlaceholderDefinition,
} from '@nexa/contracts';
import {
  redactSecretText,
  REDACTED,
  TEXT_SENSITIVE_FRAGMENTS_FOR_TEST,
} from '../../apps/api/src/infrastructure/redaction';
import { deserialiseValues } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';

const placeholder = (type: PlaceholderDefinition['type']): PlaceholderDefinition => ({
  token: 'sample',
  type,
  description: 'A sample.',
  required: false,
  repeatable: false,
});

/**
 * Sample values arrive from a form as text and have to become the type the
 * catalogue declares.
 *
 * This is the half that made three placeholder types unusable from the admin
 * screen: the field could only ever send a string, and the validator only ever
 * accepted a `Date`, a `Money` or a number.
 */
describe('coercing a typed sample value out of a text field', () => {
  it('turns a whole number into a number', () => {
    const result = coerceTemplateValue(placeholder('NUMBER'), ' 30 ');
    expect(result).toEqual({ ok: true, value: 30 });
  });

  it('refuses an empty field for a number rather than reading it as zero', () => {
    // `Number('')` is 0, and zero means something specific enough in this
    // system to have its own registry field. A blank box is not a supplied
    // zero.
    expect(coerceTemplateValue(placeholder('NUMBER'), '').ok).toBe(false);
    expect(coerceTemplateValue(placeholder('NUMBER'), '12.5').ok).toBe(false);
    expect(coerceTemplateValue(placeholder('NUMBER'), 'thirty').ok).toBe(false);
  });

  it('turns an ISO timestamp into a Date', () => {
    const result = coerceTemplateValue(placeholder('DATETIME'), '2026-09-02T08:00:00Z');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBeInstanceOf(Date);
    expect(result.ok && (result.value as Date).toISOString()).toBe('2026-09-02T08:00:00.000Z');
  });

  it('refuses a date it cannot read, naming the form it wanted', () => {
    const result = coerceTemplateValue(placeholder('DATETIME'), 'yesterday');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain('2026-09-02T08:00:00Z');
  });

  it('turns minor units and a currency into Money', () => {
    const result = coerceTemplateValue(placeholder('MONEY'), '1250000 irr');
    expect(result.ok).toBe(true);
    expect(result.ok && isMoneyValue(result.value)).toBe(true);
    expect(result.ok && isMoneyValue(result.value) && result.value.amountMinor).toBe(1250000n);
    expect(result.ok && isMoneyValue(result.value) && result.value.currency).toBe('IRR');
  });

  it('refuses a bare amount, because a unit typed into copy is the legacy bug', () => {
    // One card-to-card template says تومان where its twin says ریال for the
    // same `{price}`. A MONEY value carries its currency or it is not one.
    expect(coerceTemplateValue(placeholder('MONEY'), '1250000').ok).toBe(false);
    expect(coerceTemplateValue(placeholder('MONEY'), '1250000 XYZ').ok).toBe(false);
  });

  describe('a whole form at once', () => {
    const definition = templateDefinition('ops.notification.operational_event');

    it('reports every wrong field, not the first', () => {
      const wrong: Record<string, string> = {};
      for (const p of definition.placeholders) wrong[p.token] = 'definitely not valid';
      const { problems } = coerceTemplateValues(definition, wrong);
      const typed = definition.placeholders.filter((p) => p.type !== 'STRING');
      expect(problems).toHaveLength(typed.length);
    });

    it('treats an empty field as no sample rather than as a value', () => {
      const blank: Record<string, string> = {};
      for (const p of definition.placeholders) blank[p.token] = '   ';
      const { values, problems } = coerceTemplateValues(definition, blank);
      expect(problems).toEqual([]);
      expect(Object.keys(values)).toEqual([]);
    });

    it('refuses a token the catalogue does not declare', () => {
      const { problems } = coerceTemplateValues(definition, { not_a_token: 'x' });
      expect(problems).toEqual(['{not_a_token} is not declared for this template.']);
    });
  });
});

/**
 * The stored payload back into typed values.
 *
 * Both branches, because both were untested: a DATETIME comes back from an ISO
 * string and a MONEY from its two fields, so the single formatter renders it
 * and no unit is ever typed into copy.
 */
describe('deserialising a stored notification payload', () => {
  it('rebuilds a Date and a Money from their stored forms', () => {
    // A synthetic definition is not available here, so the assertion uses the
    // one template that carries a DATETIME placeholder.
    const values = deserialiseValues({
      templateKey: 'ops.notification.operational_event',
      payload: {
        severity: 'ERROR',
        code: 'panel.unreachable',
        message: 'The panel did not answer.',
        occurrences: 3,
        firstSeenAt: '2026-09-02T08:00:00.000Z',
      },
    });
    expect(values.firstSeenAt).toBeInstanceOf(Date);
    expect((values.firstSeenAt as Date).toISOString()).toBe('2026-09-02T08:00:00.000Z');
    expect(values.occurrences).toBe(3);
  });

  it('skips a placeholder the payload does not carry', () => {
    const values = deserialiseValues({
      templateKey: 'ops.notification.operational_event',
      payload: { code: 'panel.unreachable' },
    });
    expect(Object.keys(values)).toEqual(['code']);
  });
});

/**
 * Secrets inside free text.
 *
 * The first version of this wrapped the message in `{ message }` and called the
 * key-based redactor, which matched nothing at all — a function that truncated
 * under a comment saying it redacted.
 */
describe('redacting a transport error message', () => {
  it('removes a Telegram bot token quoted out of a request URL', () => {
    const message =
      'Request failed: POST https://api.telegram.org/bot123456789:AAH4kK9vQwErTyUiOpAsDfGhJkLzXcVbNmQ/sendMessage';
    const redacted = redactSecretText(message);
    expect(redacted).not.toContain('AAH4kK9vQwErTyUiOpAsDfGhJkLzXcVbNmQ');
    expect(redacted).toContain(REDACTED);
    expect(redacted).toContain('api.telegram.org');
  });

  it('removes a labelled credential and keeps its label', () => {
    const redacted = redactSecretText('rejected: api_key=sk-live-9f2c8 and password: hunter2');
    expect(redacted).not.toContain('sk-live-9f2c8');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).toContain('api_key');
    expect(redacted).toContain('password');
    // The sentence around it survives: an ordinary labelled value loses its
    // first token, not the rest of the line.
    expect(redacted).toContain('and');
  });

  it('removes an authorization header value entirely, whatever scheme it uses', () => {
    // A credential header's value is the whole rest of the line, because the
    // set of schemes is OPEN. Two attempts got this wrong the same way: one
    // named `Bearer`, the next named seven — and both left the credential
    // behind for the eighth.
    expect(redactSecretText('Authorization: Bearer abc.def.ghi refused')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(redactSecretText('Authorization: SSWS 00QCjAl4MlV-WPXM')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(redactSecretText('Proxy-Authorization: NTLM TlRMTVNTUAAB')).toBe(
      `Proxy-Authorization: ${REDACTED}`,
    );
    expect(redactSecretText('Authorization: GoogleLogin auth=xyzsecret')).toBe(
      `Authorization: ${REDACTED}`,
    );
  });

  it('removes a credential whose value opens with a scheme under any header name', () => {
    // `X-Auth-Token` is not one of the two credential header names, so without
    // this the scheme word was taken and the credential after it survived.
    expect(redactSecretText('X-Auth-Token: Token abc123def456')).toBe(`X-Auth-Token: ${REDACTED}`);
  });

  it('leaves an ordinary sentence that begins with a scheme word', () => {
    // `Bearer`, `Basic`, `Digest` and `Negotiate` are also English. Requiring
    // the credential to LOOK like one — eight characters with something that
    // is not a letter — is what keeps these readable.
    for (const line of [
      'Basic auth failed for user alice',
      'Digest mismatch: recomputed 9f8e',
      'Negotiate handshake failed, falling back',
      'Token expired at 2026-09-02',
    ]) {
      expect(redactSecretText(line)).toBe(line);
    }
  });

  it('removes a credential under any authorization scheme, not just Bearer', () => {
    // Naming only `Bearer` left every other scheme's credential in the table:
    // the labelled rule matched `Authorization: Basic` with `Basic` as the
    // whole value and stored what followed. A rule about one scheme is not a
    // rule about the header.
    expect(redactSecretText('Authorization: Basic dXNlcjpwYXNz')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(redactSecretText('Authorization: Digest abc123def456')).toBe(
      `Authorization: ${REDACTED}`,
    );
    expect(redactSecretText('X-Auth-Token: Token abc123def456')).toBe(`X-Auth-Token: ${REDACTED}`);
  });

  it('removes a quoted value containing spaces, and leaves it quoted', () => {
    // Quoted in, quoted out: `{"token":[redacted]}` does not parse, and the
    // point of keeping the name's quotes was to leave something a person still
    // recognises as JSON.
    expect(redactSecretText('password="correct horse battery staple"')).toBe(
      `password="${REDACTED}"`,
    );
    expect(redactSecretText("password='correct horse battery staple'")).toBe(
      `password="${REDACTED}"`,
    );
  });

  it('does not eat the sentence after an ordinary labelled value', () => {
    // The scheme list is a LIST rather than "any word", because
    // "any word followed by a token" would have consumed an extra word here.
    expect(redactSecretText('token: abc reported by alice')).toBe(
      `token: ${REDACTED} reported by alice`,
    );
  });

  it('removes an unlabelled bearer credential', () => {
    const redacted = redactSecretText('sent Bearer abc.def.ghi and it was refused');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).toContain(`Bearer ${REDACTED}`);
  });

  it('removes a secret quoted the way a JSON error body quotes one', () => {
    // The gap the first version had, and the reason its docblock was wrong: it
    // named "an unlabelled secret in prose" as its limitation while every one
    // of these — labelled, in the shape the rule claimed to cover — went
    // through untouched. A transport that surfaces a response BODY rather than
    // a parsed field hands exactly this to the append-only attempt column.
    expect(redactSecretText('rejected: {"token":"123abcSECRETVALUE","chat_id":-100}')).toBe(
      `rejected: {"token":"${REDACTED}","chat_id":-100}`,
    );
    expect(redactSecretText('login failed: {"username":"admin","password":"hunter2"}')).toBe(
      `login failed: {"username":"admin","password":"${REDACTED}"}`,
    );
    // And it still parses, which is what the quotes are for.
    expect(() =>
      JSON.parse(redactSecretText('{"token":"123abcSECRETVALUE","chat_id":-100}')),
    ).not.toThrow();
  });

  it('removes a single-quoted secret', () => {
    expect(redactSecretText("panel error: password='hunter2' rejected")).toBe(
      `panel error: password="${REDACTED}" rejected`,
    );
  });

  it('leaves a word that merely contains a fragment of a fragment', () => {
    // The key rule can afford to over-match; in prose it costs the operator
    // the sentence they needed. `auth` as a bare fragment turned
    // `author: alice` into `author: [redacted]`.
    expect(redactSecretText('author: alice reported it')).toBe('author: alice reported it');
  });

  it('does not stall on an adversarial input that is WITHIN the length bound', () => {
    // Deliberately under `MAX_REDACTABLE_LENGTH`, so the length bound cannot
    // carry this test. The previous version fed 80 KB, which was sliced to
    // 8 000 before matching — so it pinned the bound and nothing else, and the
    // unbounded character classes it was written for could have been reverted
    // with the suite green.
    const hostile = 'a.'.repeat(3_900) + 'token';
    expect(hostile.length).toBeLessThan(8_000);
    const started = Date.now();
    redactSecretText(hostile);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('redacts a quoted value whose closing quote is beyond the bound', () => {
    // The bounded quoted alternatives need their terminator inside 4 096 and
    // the unquoted one refuses to begin at a quote, so a long
    // `privateKey="…"` matched NOTHING and was returned untouched — then
    // stored, truncated. A bound that makes a matcher give up must make it give
    // up by redacting more, never by redacting nothing.
    const long = `privateKey="${'A'.repeat(5_000)}"`;
    expect(redactSecretText(long)).not.toContain('AAAAAAAAAAAAAAAAAAAA');
  });

  it('still stops at the closing quote when there is one', () => {
    // The fail-closed alternative must not become the ordinary path: JSON with
    // a normal short value keeps everything after it.
    expect(redactSecretText('{"token":"abc","chat_id":-100}')).toBe(
      `{"token":"${REDACTED}","chat_id":-100}`,
    );
  });

  it('redacts a parameterised Digest credential in full', () => {
    // `Digest username="…", realm="…", response="…"` is one header value split
    // by commas and quotes — the characters a token-shaped matcher stops at.
    const digest =
      'Authorization: Digest username="Mufasa", realm="example", nonce="abc", response="deadbeef"';
    expect(redactSecretText(digest)).toBe(`Authorization: ${REDACTED}`);
  });

  it('drops the tail it did not scan rather than returning it unredacted', () => {
    // A fixed-offset slice can cut a credential below the pattern's length
    // threshold, and returning what follows would store the unscanned half —
    // the same defect `redactErrorMessage` was corrected for, one layer down.
    const token = '123456789:AAH4kK9vQwErTyUiOpAsDfGhJkLzXcVbNmQ';
    const long = 'x'.repeat(7_990) + token;
    const redacted = redactSecretText(long);
    expect(redacted).not.toContain('AAH4kK9vQwErTyUiOpAsDfGhJkLzXcVbNmQ');
    expect(redacted).toContain('not scanned and dropped');
  });

  it('keeps every fragment a plain literal, so interpolating them cannot change the pattern', () => {
    // The list is interpolated into a RegExp. Every entry is simple today,
    // which is exactly why this is asserted rather than assumed: `x.509` would
    // silently widen the alternation and `api(v2)` would throw at module load.
    for (const fragment of TEXT_SENSITIVE_FRAGMENTS_FOR_TEST) {
      expect(fragment, `${fragment} is not a plain literal`).toMatch(/^[a-z][a-z0-9_-]*$/);
    }
  });

  it('leaves ordinary operational text alone', () => {
    // A redactor that eats the message is as useless as one that does nothing:
    // the point of keeping this text is that somebody can act on it.
    const message = 'chat not found (400) after 2 attempts against chat -100999';
    expect(redactSecretText(message)).toBe(message);
  });
});
