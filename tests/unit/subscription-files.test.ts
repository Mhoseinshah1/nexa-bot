import { describe, expect, it, vi } from 'vitest';
import {
  SUBSCRIPTION_FILES_MAX_COUNT,
  SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH,
  SUBSCRIPTION_FILE_MAX_BYTES,
  SUBSCRIPTION_FILE_NAME_MAX_LENGTH,
  canFetchSubscriptionFiles,
  type ActorContext,
  type CorrelationId,
  type ProviderAdapter,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import { SanaeiAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter';
import {
  SUBSCRIPTION_FILES_DEFAULT_RETRY_MS,
  decodeStrictBase64,
  parseSubscriptionFiles,
  retryAfterMs,
  safeCaption,
  safeFileName,
  safeMediaType,
} from '../../apps/api/src/modules/platform/providers/infrastructure/subscription-files';
import {
  SubscriptionFileService,
  type SubscriptionFileDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/subscription-file.service';

/**
 * Package E — the decoding, bounding and naming of a provider's files, and the refusals
 * that happen before a panel is asked (`docs/package-e-rickpanel-files-audit.md`).
 */

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('a provider’s files, decoded and bounded (E3)', () => {
  it('decodes strict Base64 only, never a lenient partial', () => {
    expect(Buffer.from(decodeStrictBase64(b64('hello'))!).toString('utf8')).toBe('hello');
    expect(decodeStrictBase64('')).toBeNull();
    expect(decodeStrictBase64('not base64!!')).toBeNull();
    expect(decodeStrictBase64('Zm9v=')).toBeNull(); // mis-padded
    expect(decodeStrictBase64('Zm9vYg')).toBeNull(); // unpadded
    expect(decodeStrictBase64('Zm9vYh==')).toBeNull(); // non-zero padding bits
    expect(decodeStrictBase64('Zm9v\nYmFy')).toBeNull(); // whitespace
    expect(decodeStrictBase64('Zm9v-_==')).toBeNull(); // URL-safe alphabet
  });

  it('accepts a bare array and a files envelope, and nothing else', () => {
    const entry = { filename: 'a.txt', media_type: 'text/plain', content_b64: b64('a') };
    expect(parseSubscriptionFiles(JSON.stringify([entry]))?.files).toHaveLength(1);
    expect(parseSubscriptionFiles(JSON.stringify({ files: [entry] }))?.files).toHaveLength(1);
    expect(parseSubscriptionFiles(JSON.stringify({ data: [entry] }))).toBeNull();
    expect(parseSubscriptionFiles('not json')).toBeNull();
    expect(parseSubscriptionFiles('null')).toBeNull();
  });

  it('counts a failed format and keeps the others', () => {
    const parsed = parseSubscriptionFiles(
      JSON.stringify([
        { filename: 'a.json', media_type: 'application/json', content_b64: b64('{}') },
        { filename: 'b.yaml', error: 'build failed' },
        { filename: 'c.yaml', error: { code: 1 }, content_b64: b64('x') },
        { filename: 'd.txt' },
        'not an object',
      ]),
    );
    expect(parsed?.files.map((file) => file.fileName)).toEqual(['a.json']);
    expect(parsed?.failed).toBe(4);
  });

  it('refuses more entries than the bound as malformed, never truncating', () => {
    const entries = (n: number) =>
      JSON.stringify(
        Array.from({ length: n }, (_, i) => ({ filename: `${String(i)}`, content_b64: b64('x') })),
      );
    expect(parseSubscriptionFiles(entries(SUBSCRIPTION_FILES_MAX_COUNT))?.files).toHaveLength(
      SUBSCRIPTION_FILES_MAX_COUNT,
    );
    expect(parseSubscriptionFiles(entries(SUBSCRIPTION_FILES_MAX_COUNT + 1))).toBeNull();
  });

  it('refuses an empty file and one past the per-file bound as failed formats', () => {
    const big = Buffer.alloc(SUBSCRIPTION_FILE_MAX_BYTES + 1, 0x61).toString('base64');
    const exact = Buffer.alloc(SUBSCRIPTION_FILE_MAX_BYTES, 0x61).toString('base64');
    const parsed = parseSubscriptionFiles(
      JSON.stringify([
        { filename: 'big', content_b64: big },
        { filename: 'exact', content_b64: exact },
      ]),
    );
    expect(parsed?.files.map((file) => file.fileName)).toEqual(['exact']);
    expect(parsed?.failed).toBe(1);
  });

  it('stops adding files at the aggregate bound and counts the rest as failed', () => {
    const four = Buffer.alloc(4 * 1024 * 1024, 0x61).toString('base64');
    const parsed = parseSubscriptionFiles(
      JSON.stringify(
        Array.from({ length: 6 }, (_, i) => ({ filename: String(i), content_b64: four })),
      ),
    );
    // 5 × 4 MiB = 20 MiB is the bound; the sixth would pass it.
    expect(parsed?.files).toHaveLength(5);
    expect(parsed?.failed).toBe(1);
  });

  it('reduces a file name to a safe base name', () => {
    expect(safeFileName('../../etc/passwd', 0)).toBe('passwd');
    expect(safeFileName('C:\\Users\\x\\config.json', 0)).toBe('config.json');
    expect(safeFileName('a"b\u0000c\nd.txt', 0)).toBe('abcd.txt');
    expect(safeFileName('..', 2)).toBe('subscription-3');
    expect(safeFileName(42, 0)).toBe('subscription-1');
    expect(safeFileName('x'.repeat(500), 0)).toHaveLength(SUBSCRIPTION_FILE_NAME_MAX_LENGTH);
  });

  it('maps a media type into the closed set, charset allowed, anything else octet-stream', () => {
    expect(safeMediaType('application/json')).toBe('application/json');
    expect(safeMediaType('TEXT/PLAIN; charset=UTF-8')).toBe('text/plain');
    expect(safeMediaType('text/html')).toBe('application/octet-stream');
    expect(safeMediaType('text/plain; boundary=x')).toBe('application/octet-stream');
    expect(safeMediaType('text/plain\r\nX-Injected: 1')).toBe('application/octet-stream');
    expect(safeMediaType(undefined)).toBe('application/octet-stream');
  });

  it('cleans and bounds a caption, and drops an empty one', () => {
    expect(safeCaption('line one\nline two\u0007')).toBe('line one\nline two');
    expect(safeCaption('   ')).toBeNull();
    expect(safeCaption(7)).toBeNull();
    const long = safeCaption('x'.repeat(5000))!;
    expect(long).toHaveLength(SUBSCRIPTION_FILE_CAPTION_MAX_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the panel’s rate limit (E4)', () => {
  it('honours Retry-After in seconds and falls back to the documented minute', () => {
    expect(retryAfterMs('17')).toBe(17_000);
    expect(retryAfterMs(' 5 ')).toBe(5_000);
    expect(retryAfterMs(undefined)).toBe(SUBSCRIPTION_FILES_DEFAULT_RETRY_MS);
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(SUBSCRIPTION_FILES_DEFAULT_RETRY_MS);
    expect(retryAfterMs('-3')).toBe(SUBSCRIPTION_FILES_DEFAULT_RETRY_MS);
    expect(retryAfterMs('999999')).toBe(3_600_000);
  });
});

describe('the capability (E1)', () => {
  it('is offered by RickPanel and by no other provider', () => {
    expect(canFetchSubscriptionFiles(new RickpanelAdapter())).toBe(true);
    expect(canFetchSubscriptionFiles(new MarzbanAdapter())).toBe(false);
    expect(canFetchSubscriptionFiles(new SanaeiAdapter())).toBe(false);
  });

  it('requires the method AND the declaration', () => {
    const rick = new RickpanelAdapter();
    const undeclared = Object.assign(Object.create(rick) as ProviderAdapter, {
      supports: () => false,
    });
    expect(canFetchSubscriptionFiles(undeclared)).toBe(false);
  });
});

describe('the service, before any panel is asked', () => {
  const scope = { tenantId: 't', botInstanceId: null } as unknown as TenantContext;
  const actor: ActorContext = {
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: 'c' as CorrelationId,
  };
  const service = {
    id: 's',
    panelId: 'p',
    state: 'ACTIVE',
    providerUsername: 'user1',
    subscriptionRef: 'ref',
    providerClientId: 'cid',
  };

  function deps(adapter: ProviderAdapter, overrides: Partial<SubscriptionFileDeps> = {}) {
    const sendFile = vi.fn();
    const send = vi.fn();
    const built: SubscriptionFileDeps = {
      services: { getForCustomer: vi.fn(async () => service as never) },
      panels: {
        find: vi.fn(async () => ({
          panel: {
            status: 'ACTIVE',
            providerType: 'rickpanel',
            baseUrl: 'https://panel.example.test',
            archivedAt: null,
            activation: {},
          },
          credentials: { passwordSetAt: new Date(), usernameSetAt: new Date(), tokenSetAt: null },
        })) as never,
        takeProbeBudget: vi.fn(async () => ({ permitted: true as const, remaining: 5 })),
      },
      credentials: {
        read: vi.fn(async () => ({ username: 'a', password: 'b', token: null })) as never,
      },
      adapters: () => adapter,
      implementedProviderTypes: ['rickpanel', 'marzban', 'sanaei'],
      http: { forBase: () => ({ send }) },
      urlPolicy: { allowLoopback: false, allowPrivate: true } as never,
      probeBudget: { capacity: 10, refillPerSecond: 1 } as never,
      messenger: { sendFile },
      guard: { check: vi.fn(async () => undefined) } as never,
      uow: { run: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({}) } as never,
      clock: { now: () => new Date('2026-09-28T00:00:00Z') },
      ...overrides,
    };
    return { built, sendFile, send };
  }

  it('answers UNAVAILABLE for a provider without the capability, and sends nothing', async () => {
    const { built, sendFile, send } = deps(new MarzbanAdapter());
    const files = new SubscriptionFileService(built);
    const result = await files.send(scope, actor, {
      customerId: 'u' as UserId,
      serviceId: 's',
      chatId: '1',
      botInstanceId: 'b' as never,
    });
    expect(result).toEqual({ outcome: 'UNAVAILABLE' });
    expect(send).not.toHaveBeenCalled();
    expect(sendFile).not.toHaveBeenCalled();
    expect(await files.offered(scope, service as never)).toBe(false);
  });

  it('answers NOT_FOUND for a service that is not the customer’s', async () => {
    const { built, send } = deps(new RickpanelAdapter(), {
      services: {
        getForCustomer: vi.fn(async () => {
          throw new Error('not found');
        }),
      },
    });
    const result = await new SubscriptionFileService(built).send(scope, actor, {
      customerId: 'u' as UserId,
      serviceId: 's',
      chatId: '1',
      botInstanceId: 'b' as never,
    });
    expect(result).toEqual({ outcome: 'NOT_FOUND' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not offer, nor fetch, the files of a service that is not readable', async () => {
    const terminated = { ...service, state: 'TERMINATED' };
    const { built, send } = deps(new RickpanelAdapter(), {
      services: { getForCustomer: vi.fn(async () => terminated as never) },
    });
    const files = new SubscriptionFileService(built);
    expect(await files.offered(scope, terminated as never)).toBe(false);
    expect(
      await files.send(scope, actor, {
        customerId: 'u' as UserId,
        serviceId: 's',
        chatId: '1',
        botInstanceId: 'b' as never,
      }),
    ).toEqual({ outcome: 'UNAVAILABLE' });
    expect(send).not.toHaveBeenCalled();
  });

  const request = {
    customerId: 'u' as UserId,
    serviceId: 's',
    chatId: '1',
    botInstanceId: 'b' as never,
  };

  it('checks the permission before it reads anything', async () => {
    const denied = new Error('denied');
    const getForCustomer = vi.fn(async () => service as never);
    const { built, send } = deps(new RickpanelAdapter(), {
      services: { getForCustomer },
      guard: {
        check: vi.fn(async () => {
          throw denied;
        }),
      } as never,
    });
    await expect(new SubscriptionFileService(built).send(scope, actor, request)).rejects.toBe(
      denied,
    );
    expect(getForCustomer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('never dials a panel address the URL policy refuses', async () => {
    const base = deps(new RickpanelAdapter()).built;
    const { built, send } = deps(new RickpanelAdapter(), {
      panels: {
        ...base.panels,
        find: vi.fn(async () => ({
          ...(await base.panels.find(scope, 'p' as never))!,
          panel: {
            ...(await base.panels.find(scope, 'p' as never))!.panel,
            baseUrl: 'http://127.0.0.1:8000',
          },
        })) as never,
      },
    });
    expect(await new SubscriptionFileService(built).send(scope, actor, request)).toEqual({
      outcome: 'UNAVAILABLE',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('asks nothing of a panel the operator disabled', async () => {
    const base = deps(new RickpanelAdapter()).built;
    const { built, send } = deps(new RickpanelAdapter(), {
      panels: {
        ...base.panels,
        find: vi.fn(async () => ({
          ...(await base.panels.find(scope, 'p' as never))!,
          panel: { ...(await base.panels.find(scope, 'p' as never))!.panel, status: 'DISABLED' },
        })) as never,
      },
    });
    expect(await new SubscriptionFileService(built).send(scope, actor, request)).toEqual({
      outcome: 'UNAVAILABLE',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('asks nothing of a panel whose stored credential cannot be read', async () => {
    const { built, send } = deps(new RickpanelAdapter(), {
      credentials: { read: vi.fn(async () => ({ username: null, password: null, token: null })) },
    } as never);
    expect(await new SubscriptionFileService(built).send(scope, actor, request)).toEqual({
      outcome: 'UNAVAILABLE',
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('asks nothing of the panel when the tenant’s outbound budget is spent', async () => {
    const { built, send } = deps(new RickpanelAdapter(), {
      panels: {
        ...deps(new RickpanelAdapter()).built.panels,
        takeProbeBudget: vi.fn(async () => ({ permitted: false as const, retryAfterMs: 1000 })),
      },
    });
    const result = await new SubscriptionFileService(built).send(scope, actor, {
      customerId: 'u' as UserId,
      serviceId: 's',
      chatId: '1',
      botInstanceId: 'b' as never,
    });
    expect(result).toEqual({ outcome: 'UNAVAILABLE' });
    expect(send).not.toHaveBeenCalled();
  });
});
