import { describe, expect, it } from 'vitest';
import type { Logger } from '@nexa/contracts';
import { createLogger, redactLogArguments } from '../../apps/api/src/infrastructure/logging/logger';
import {
  REDACTED,
  normaliseForScan,
  redactForLog,
  redactOperatorText,
  redactSecretText,
  redactSecrets,
  redactStack,
} from '../../apps/api/src/infrastructure/redaction';

/**
 * FIX-04 (S1, S3, S5): what the PROCESS LOG writes, captured from the stream.
 *
 * Every assertion here reads the bytes pino actually produced, not the redactor's return
 * value, because the leak this file exists for was between the two: the redactor was right
 * about the object it was given and the logger handed it only one of its arguments, and
 * then only judged that one's keys. A secret in the message, in a stack logged as a string,
 * or in any nested string reached stdout verbatim.
 *
 * The matrix is the cross product of SECRETS × ENCODINGS × CARRIERS, and the assertion is
 * the same for all of it: no secret's core survives, read raw or read after the same
 * normalisation the redactor applies (a zero-width-split token that survives is still a
 * token to whoever pastes it). Every credential below is synthetic.
 */

/** A Luhn-valid number from a prefix, so no real card number is written down here. */
function luhnComplete(prefix: string): string {
  for (let check = 0; check <= 9; check += 1) {
    const candidate = `${prefix}${String(check)}`;
    let sum = 0;
    let double = false;
    for (let index = candidate.length - 1; index >= 0; index -= 1) {
      let digit = candidate.charCodeAt(index) - 48;
      if (double) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return candidate;
  }
  throw new Error('unreachable');
}

const FAKE_TOKEN_ID = '7012345678';
const FAKE_TOKEN_SECRET = 'AAFakeTokenSynthetic0123456789xyzQ';
const FAKE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdXNlciJ9.c3ludGhldGljU2lnbmF0dXJlMDEyMw';
const FAKE_OPAQUE = 'opq9Synthetic_Value-0123';
const FAKE_SUB_PATH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FAKE_HOOK_PATH = 'Wh00kSyntheticPathSegment77';
const FAKE_PAN = luhnComplete('603799123456789');

interface SecretCase {
  readonly name: string;
  /** The text a carrier will hold. */
  readonly text: string;
  /** What must not survive, compared against the output raw and normalised. */
  readonly cores: readonly string[];
}

const SECRETS: readonly SecretCase[] = [
  {
    name: 'telegram bot token in a request URL',
    text: `Failed to parse URL from https://api.telegram.org/bot${FAKE_TOKEN_ID}:${FAKE_TOKEN_SECRET}/sendMessage`,
    cores: [FAKE_TOKEN_SECRET],
  },
  {
    name: 'telegram bot token, colon percent-encoded',
    text: `GET /bot${FAKE_TOKEN_ID}%3A${FAKE_TOKEN_SECRET}/getMe failed`,
    cores: [FAKE_TOKEN_SECRET],
  },
  {
    name: 'telegram bot token, colon double-encoded',
    text: `GET /bot${FAKE_TOKEN_ID}%253a${FAKE_TOKEN_SECRET}/getMe failed`,
    cores: [FAKE_TOKEN_SECRET],
  },
  { name: 'bare JWT', text: `rejected ${FAKE_JWT} as expired`, cores: [FAKE_JWT.split('.')[2]!] },
  {
    name: 'Bearer header',
    text: `Authorization: Bearer ${FAKE_OPAQUE}`,
    cores: [FAKE_OPAQUE],
  },
  { name: 'lowercase bearer', text: `sent bearer ${FAKE_OPAQUE} upstream`, cores: [FAKE_OPAQUE] },
  {
    name: 'password query parameter',
    text: `login https://panel.example.test/login?username=admin&password=${FAKE_OPAQUE}`,
    cores: [FAKE_OPAQUE],
  },
  {
    name: 'password, equals sign percent-encoded',
    text: `form body password%3D${FAKE_OPAQUE}&remember=1`,
    cores: [FAKE_OPAQUE],
  },
  { name: 'secret= in prose', text: `config secret=${FAKE_OPAQUE} rejected`, cores: [FAKE_OPAQUE] },
  {
    name: 'token= in a query',
    text: `callback https://pay.example.test/cb?id=1&token=${FAKE_OPAQUE}`,
    cores: [FAKE_OPAQUE],
  },
  {
    name: 'subscription link',
    text: `delivered https://sub.example.test/sub/${FAKE_SUB_PATH} to the customer`,
    cores: [FAKE_SUB_PATH],
  },
  {
    name: 'webhook secret path',
    text: `POST https://hooks.example.test/hook/${FAKE_HOOK_PATH} returned 500`,
    cores: [FAKE_HOOK_PATH],
  },
  {
    name: 'credentials in a URL authority',
    text: `connect https://admin:${FAKE_OPAQUE}@panel.example.test:2053/ refused`,
    cores: [FAKE_OPAQUE],
  },
  { name: 'PAN, contiguous', text: `card ${FAKE_PAN} declined`, cores: [FAKE_PAN] },
  {
    name: 'PAN, spaced',
    text: `card ${FAKE_PAN.replace(/(\d{4})(?=\d)/g, '$1 ')} declined`,
    cores: [FAKE_PAN],
  },
  {
    name: 'PAN, dashed',
    text: `card ${FAKE_PAN.replace(/(\d{4})(?=\d)/g, '$1-')} declined`,
    cores: [FAKE_PAN],
  },
  {
    name: 'PAN, dotted',
    text: `card ${FAKE_PAN.replace(/(\d{4})(?=\d)/g, '$1.')} declined`,
    cores: [FAKE_PAN],
  },
  {
    name: 'PAN, double-spaced',
    text: `card ${FAKE_PAN.replace(/(\d{4})(?=\d)/g, '$1  ')} declined`,
    cores: [FAKE_PAN],
  },
];

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);
const ZERO_WIDTH_NON_JOINER = String.fromCharCode(0x200c);
const FULLWIDTH_COLON = String.fromCharCode(0xff1a);
const SOFT_HYPHEN = String.fromCharCode(0x00ad);
const RIGHT_TO_LEFT_MARK = String.fromCharCode(0x200f);

const toPersianDigits = (text: string): string =>
  text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x06f0 + Number(digit)));
const toArabicIndicDigits = (text: string): string =>
  text.replace(/[0-9]/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
const toFullwidthDigits = (text: string): string =>
  text.replace(/[0-9]/g, (digit) => String.fromCharCode(0xff10 + Number(digit)));

/** Ways the same secret is written by a client, a provider or an attacker. */
const ENCODINGS: readonly { readonly name: string; readonly apply: (text: string) => string }[] = [
  { name: 'as written', apply: (text) => text },
  {
    name: 'zero-width space inside every core',
    apply: (text) => {
      let out = text;
      for (const secret of SECRETS) {
        for (const core of secret.cores) {
          out = out.split(core).join(`${core.slice(0, 6)}${ZERO_WIDTH_SPACE}${core.slice(6)}`);
        }
      }
      return out.replace(`${FAKE_TOKEN_ID}:`, `${FAKE_TOKEN_ID}${ZERO_WIDTH_JOINER}:`);
    },
  },
  { name: 'fullwidth colon', apply: (text) => text.replace(/:/g, FULLWIDTH_COLON) },
  { name: 'Persian digits', apply: toPersianDigits },
  { name: 'Arabic-Indic digits', apply: toArabicIndicDigits },
  { name: 'fullwidth digits', apply: toFullwidthDigits },
  {
    name: 'soft hyphens and bidi marks',
    apply: (text) => text.replace(/:/g, `${SOFT_HYPHEN}:${RIGHT_TO_LEFT_MARK}`),
  },
];

type Emit = (log: Logger, text: string) => void;

/** Where a secret sits when it reaches the logger. */
const CARRIERS: readonly { readonly name: string; readonly emit: Emit }[] = [
  { name: 'message argument', emit: (log, text) => log.error({}, text) },
  {
    name: 'Error object (message and stack)',
    emit: (log, text) => log.error({ err: new Error(text) }, 'failed'),
  },
  {
    name: 'stack logged as a string',
    emit: (log, text) => log.error({ err: new Error(text).stack }, 'failed'),
  },
  {
    name: 'cause chain',
    emit: (log, text) =>
      log.error(
        { err: new Error('outer', { cause: new Error('middle', { cause: new TypeError(text) }) }) },
        'failed',
      ),
  },
  {
    name: 'AggregateError.errors',
    emit: (log, text) =>
      log.error(
        { err: new AggregateError([new Error('first'), new Error(text)], 'all failed') },
        'failed',
      ),
  },
  {
    name: 'enumerable property of an error',
    emit: (log, text) =>
      log.error(
        { err: Object.assign(new Error('provider failed'), { body: { detail: text } }) },
        'failed',
      ),
  },
  {
    name: 'nested object',
    emit: (log, text) => log.error({ a: { b: { c: { d: text } } } }, 'failed'),
  },
  { name: 'array', emit: (log, text) => log.error({ list: ['ok', [text]] }, 'failed') },
  {
    name: 'Map value',
    emit: (log, text) => log.error({ m: new Map([['detail', text]]) }, 'failed'),
  },
  { name: 'Map key', emit: (log, text) => log.error({ m: new Map([[text, 1]]) }, 'failed') },
  { name: 'Set', emit: (log, text) => log.error({ s: new Set([text]) }, 'failed') },
  { name: 'object key', emit: (log, text) => log.error({ index: { [text]: true } }, 'failed') },
  { name: 'child binding', emit: (log, text) => log.child({ upstream: text }).error({}, 'failed') },
  {
    name: 'non-Error throw',
    emit: (log, text) =>
      log.error({ err: { code: 'E_PROVIDER', response: { raw: text } } }, 'failed'),
  },
];

function capture(): { readonly lines: string[]; readonly log: Logger } {
  const lines: string[] = [];
  const log = createLogger('trace', 'test', { write: (chunk: string) => lines.push(chunk) });
  return { lines, log };
}

function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allStrings(item, out);
    }
  }
  return out;
}

function survivors(lines: readonly string[], cores: readonly string[]): string[] {
  const found: string[] = [];
  for (const line of lines) {
    const texts = [line, ...allStrings(JSON.parse(line))];
    for (const text of texts) {
      const forms = [text, normaliseForScan(text)];
      for (const core of cores) {
        if (forms.some((form) => form.includes(core))) found.push(core);
      }
    }
  }
  return found;
}

describe('the process log never writes a secret, wherever it is carried and however it is spelled', () => {
  for (const carrier of CARRIERS) {
    describe(carrier.name, () => {
      for (const encoding of ENCODINGS) {
        it.each(SECRETS.map((secret) => [secret.name, secret] as const))(
          `${encoding.name}: %s`,
          (_name, secret) => {
            const { lines, log } = capture();
            carrier.emit(log, encoding.apply(secret.text));
            expect(lines.length).toBeGreaterThan(0);
            expect(survivors(lines, secret.cores)).toEqual([]);
          },
        );
      }
    });
  }
});

describe('the process log keeps what an operator needs to diagnose', () => {
  it('an error keeps its name, its non-secret text and its frames’ file:line', () => {
    const { lines, log } = capture();
    const error = new TypeError(
      `Failed to parse URL from https://api.telegram.org/bot${FAKE_TOKEN_ID}:${FAKE_TOKEN_SECRET}/sendMessage`,
    );
    error.stack = [
      `TypeError: ${error.message}`,
      '    at TelegramTransport.send (file:///app/apps/api/dist/infrastructure/telegram/session.transport.js:142:19)',
      '    at async SessionTokenService.verify (/app/apps/api/dist/modules/token-service.js:88:5)',
      '    at node:internal/process/task_queues:95:5',
      '    at new Thing (/app/x.js:1:2)',
      '    at <anonymous>',
    ].join('\n');
    log.error({ err: error }, 'telegram send failed');
    const line = JSON.parse(lines[0]!) as {
      msg: string;
      err: { name: string; message: string; stack: string };
    };
    expect(line.msg).toBe('telegram send failed');
    expect(line.err.name).toBe('TypeError');
    expect(line.err.message).toContain('Failed to parse URL from https://api.telegram.org/');
    expect(line.err.message).not.toContain(FAKE_TOKEN_SECRET);
    expect(line.err.stack).toContain('session.transport.js:142:19');
    expect(line.err.stack).toContain('/app/apps/api/dist/modules/token-service.js:88:5');
    expect(line.err.stack).toContain('node:internal/process/task_queues:95:5');
    expect(line.err.stack).toContain('at new Thing (/app/x.js:1:2)');
    expect(line.err.stack).toContain('at <anonymous>');
    expect(line.err.stack).not.toContain(FAKE_TOKEN_SECRET);
  });

  it('a URL keeps its scheme, host, port and word-like path segments', () => {
    expect(
      redactSecretText('POST https://panel.example.test:2053/panel/api/inbounds/list failed'),
    ).toBe('POST https://panel.example.test:2053/panel/api/inbounds/list failed');
    expect(redactSecretText(`GET https://sub.example.test/sub/${FAKE_SUB_PATH}?x=1 failed`)).toBe(
      `GET https://sub.example.test/sub/${REDACTED}?${REDACTED} failed`,
    );
  });

  it('a cause chain, an AggregateError, a Map, a Set, a Buffer and a Date are rendered, not emptied', () => {
    const shared = new Error('shared reason');
    const value = redactForLog({
      err: new Error('outer', { cause: shared }),
      again: shared,
      agg: new AggregateError([new Error('one'), new RangeError('two')], 'both'),
      map: new Map<unknown, unknown>([
        ['count', 2],
        ['password', 'x'],
      ]),
      set: new Set(['a', 'b']),
      buffer: Buffer.from('synthetic bytes that are content'),
      at: new Date('2026-10-10T00:00:00.000Z'),
    }) as Record<string, any>;
    expect(value.err.cause.message).toBe('shared reason');
    // Referenced twice, circular never: the second appearance is rendered too.
    expect(value.again.message).toBe('shared reason');
    expect(value.agg.errors.map((e: { message: string }) => e.message)).toEqual(['one', 'two']);
    expect(value.map).toEqual({ type: 'Map', size: 2, entries: { count: 2, password: REDACTED } });
    expect(value.set).toEqual({ type: 'Set', size: 2, values: ['a', 'b'] });
    expect(value.buffer).toBe('[Buffer 32 bytes]');
    expect(value.at).toBe('2026-10-10T00:00:00.000Z');
  });

  it('a real cycle is still reported as one', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    expect(redactForLog(cyclic)).toEqual({ name: 'loop', self: '[circular]' });
  });

  it('a non-Error throw is rendered as what it is, never "[object Object]"', () => {
    const { lines, log } = capture();
    log.error({ err: { code: 'E_PROVIDER', status: 502 } }, 'failed');
    log.error({ err: 'plain string thrown' }, 'failed');
    expect(JSON.parse(lines[0]!).err).toEqual({ code: 'E_PROVIDER', status: 502 });
    expect(JSON.parse(lines[1]!).err).toBe('plain string thrown');
    expect(lines.join('')).not.toContain('[object Object]');
  });

  it('text with no secret is returned exactly as written, Persian digits and ZWNJ included', () => {
    const persian = `سفارش ${toPersianDigits('1234')} برای مشتری می${ZERO_WIDTH_NON_JOINER}خواهد تمدید شود`;
    expect(redactSecretText(persian)).toBe(persian);
    const ids =
      'order 01900000-0000-7000-8000-00000000fa11 tenant 0192f3c1-1234-7abc-9def-123456789012';
    expect(redactSecretText(ids)).toBe(ids);
    expect(redactSecretText('at 2026-10-10T07:19:46.123Z took 1760080786123 ms')).toBe(
      'at 2026-10-10T07:19:46.123Z took 1760080786123 ms',
    );
  });

  it('the durable key-rule redactor still leaves record values as written', () => {
    const record = { address: 'https://panel.example.test:2053/aB3dE9xYz/', note: 'free text' };
    expect(redactSecrets(record)).toEqual(record);
  });

  it('the operator channel composition still removes every URL whole', () => {
    expect(redactOperatorText('see https://panel.example.test/panel/api now')).toBe(
      `see ${REDACTED} now`,
    );
  });
});

describe('the redactor is bounded', () => {
  it('scans an adversarial 8 000-character string quickly and drops what it did not scan', () => {
    const shapes = [
      'a.a.a.'.repeat(1400) + 'token',
      '1 '.repeat(4000),
      '%25'.repeat(2700),
      'https://x.test/' + 'a/'.repeat(4000),
      'eyJ' + 'A'.repeat(7990),
      'token='.repeat(1400),
    ];
    for (const shape of shapes) {
      const started = performance.now();
      redactSecretText(shape);
      redactSecretText(`${shape}${shape}`);
      expect(performance.now() - started).toBeLessThan(500);
    }
    expect(redactSecretText('x'.repeat(9000))).toContain('characters not scanned and dropped');
  });

  it('caps what one log line renders', () => {
    const wide = Array.from({ length: 1000 }, (_, index) => index);
    const rendered = redactForLog({ wide }) as { wide: unknown[] };
    expect(rendered.wide).toHaveLength(101);
    expect(rendered.wide.at(-1)).toBe('[900 more]');
    const stack = [
      'Error: x',
      ...Array.from({ length: 200 }, (_, i) => `    at f (/a.js:${String(i)}:1)`),
    ].join('\n');
    expect(redactStack(stack).split('\n')).toHaveLength(61);
  });

  it('redactLogArguments leaves numbers and booleans alone and redacts every string', () => {
    expect(redactLogArguments([1, true, `token=${FAKE_OPAQUE}`])).toEqual([
      1,
      true,
      `token=${REDACTED}`,
    ]);
  });
});
