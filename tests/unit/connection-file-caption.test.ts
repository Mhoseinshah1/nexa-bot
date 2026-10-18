import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTION_FILE_CAPTION_VARIABLE_TOKENS,
  PANEL_SETTING_KEYS,
  SETTING_KEYS,
  TELEGRAM_CAPTION_MAX_LENGTH,
  TENANT_SETTING_KEYS,
  connectionFileCaptionTemplateIssues,
  parseSettingValue,
  resolvePanelPolicy,
  settingDefinition,
  settingScope,
  templateDefinition,
  type ActorContext,
  type CorrelationId,
  type ProviderAdapter,
  type TenantContext,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  renderConnectionFileCaption,
} from '@nexa/i18n';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import {
  SubscriptionFileService,
  connectionFileCaptionVariables,
  type ConnectionFileCaptionPolicy,
  type SubscriptionFileDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/subscription-file.service';
import type { CustomerCaption } from '../../apps/api/src/modules/commerce/messaging/application/ports';

/**
 * Track 3 §2: a panel's connection-file caption — the registry's PANEL scope and its three
 * keys, the one validator, the one renderer (escaping, the closed grammar, Telegram's
 * bound), the variables a service gives, and which file the send puts the caption on.
 */

describe('the PANEL scope in the settings registry', () => {
  it('declares the three caption keys per panel, with the owner’s defaults', () => {
    expect([...PANEL_SETTING_KEYS].sort()).toEqual([
      'panel.connection_files.caption_mode',
      'panel.connection_files.caption_placement',
      'panel.connection_files.caption_template',
    ]);
    expect(settingDefinition('panel.connection_files.caption_mode').defaultValue).toBe('CUSTOM');
    expect(settingDefinition('panel.connection_files.caption_template').defaultValue).toBeNull();
    expect(settingDefinition('panel.connection_files.caption_placement').defaultValue).toBe(
      'LAST_FILE',
    );
  });

  it('keeps every other key TENANT, and the two lists partition the registry', () => {
    expect(settingScope('sales.currency')).toBe('TENANT');
    expect(TENANT_SETTING_KEYS.some((key) => PANEL_SETTING_KEYS.includes(key))).toBe(false);
    expect(TENANT_SETTING_KEYS.length + PANEL_SETTING_KEYS.length).toBe(SETTING_KEYS.length);
  });

  it('validates each value with its own schema — the server’s check', () => {
    const template = 'panel.connection_files.caption_template';
    expect(parseSettingValue(template, null).ok).toBe(true);
    expect(parseSettingValue(template, 'سرویس {username} — {sub_link}').ok).toBe(true);
    const unknown = parseSettingValue(template, 'سرویس {usrname}');
    expect(unknown.ok).toBe(false);
    expect(unknown.ok ? [] : unknown.issues.join(' ')).toContain('{usrname}');
    expect(parseSettingValue(template, '   ').ok).toBe(false);
    expect(parseSettingValue(template, 'x'.repeat(TELEGRAM_CAPTION_MAX_LENGTH + 1)).ok).toBe(false);
    expect(parseSettingValue(template, 'x'.repeat(TELEGRAM_CAPTION_MAX_LENGTH)).ok).toBe(true);
    expect(parseSettingValue('panel.connection_files.caption_mode', 'SOMETIMES').ok).toBe(false);
    expect(parseSettingValue('panel.connection_files.caption_placement', 'FIRST_FILE').ok).toBe(
      false,
    );
  });
});

describe('the caption template validator', () => {
  it('accepts every declared variable and decoration that is not a token', () => {
    const all = CONNECTION_FILE_CAPTION_VARIABLE_TOKENS.map((token) => `{${token}}`).join(' ');
    expect(connectionFileCaptionTemplateIssues(all)).toEqual([]);
    expect(connectionFileCaptionTemplateIssues('اشتراک رایگان {تست}')).toEqual([]);
    expect(CONNECTION_FILE_CAPTION_VARIABLE_TOKENS).toEqual([
      'username',
      'service_name',
      'product',
      'volume_total',
      'volume_used',
      'volume_left',
      'expires_at_jalali',
      'days_left',
      'platform',
      'file_name',
      'sub_link',
      'support',
    ]);
  });

  it('refuses an unknown variable, an icon marker, a blank body and one past the bound', () => {
    expect(connectionFileCaptionTemplateIssues('{caption} {username}')).toEqual([
      { kind: 'UNKNOWN_VARIABLE', token: 'caption' },
    ]);
    expect(connectionFileCaptionTemplateIssues('{icon:user} {username}')).toEqual([
      { kind: 'UNKNOWN_VARIABLE', token: 'icon:user' },
    ]);
    expect(connectionFileCaptionTemplateIssues(' \n ')).toEqual([{ kind: 'EMPTY' }]);
    expect(connectionFileCaptionTemplateIssues('x'.repeat(1025))).toEqual([
      { kind: 'TOO_LONG', length: 1025, max: TELEGRAM_CAPTION_MAX_LENGTH },
    ]);
  });

  it('holds the default template to it: short, Persian, and no username line', () => {
    const body = CATALOGUE_FA['bot.service.connection_files_caption'];
    expect(connectionFileCaptionTemplateIssues(body)).toEqual([]);
    expect(body).not.toContain('{username}');
    expect(body.length).toBeLessThan(300);
    expect(templateDefinition('bot.service.connection_files_caption').maxLength).toBe(
      TELEGRAM_CAPTION_MAX_LENGTH,
    );
  });
});

describe('the one renderer', () => {
  it('substitutes values and drops a line whose facts are all absent', () => {
    const rendered = renderConnectionFileCaption('سرویس {service_name}\nپشتیبانی: {support}', {
      service_name: 'پایه',
    });
    expect(rendered).toEqual({ text: 'سرویس پایه', entities: [] });
  });

  it('escapes HTML in values: a value is text, never markup', () => {
    const rendered = renderConnectionFileCaption('کاربر: {username}', {
      username: '<b>x</b> & "y"',
    });
    expect(rendered.text).toBe('کاربر: <b>x</b> & "y"');
    expect(rendered.entities).toEqual([]);
  });

  it('reads the operator’s formatting tags into entities around the value', () => {
    const rendered = renderConnectionFileCaption('<b>{username}</b> <code>{sub_link}</code>', {
      username: 'ali<',
      sub_link: 'https://s.example/x?a=1&b=2',
    });
    expect(rendered.text).toBe('ali< https://s.example/x?a=1&b=2');
    expect(rendered.entities).toEqual([
      { type: 'bold', offset: 0, length: 4 },
      { type: 'code', offset: 5, length: 27 },
    ]);
  });

  it('never exceeds Telegram’s bound: cut with an ellipsis, entities clipped', () => {
    const rendered = renderConnectionFileCaption('<b>{sub_link}</b>', {
      sub_link: 'a'.repeat(3000),
    });
    expect(rendered.text).toHaveLength(TELEGRAM_CAPTION_MAX_LENGTH);
    expect(rendered.text.endsWith('…')).toBe(true);
    expect(rendered.entities).toEqual([
      { type: 'bold', offset: 0, length: TELEGRAM_CAPTION_MAX_LENGTH - 1 },
    ]);
  });

  it('never cuts inside a surrogate pair', () => {
    const rendered = renderConnectionFileCaption('{sub_link}', {
      sub_link: `${'a'.repeat(TELEGRAM_CAPTION_MAX_LENGTH - 2)}😀😀`,
    });
    expect(rendered.text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX_LENGTH);
    expect(rendered.text.endsWith('a…')).toBe(true);
  });
});

describe('the variables a service and a file give', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const service = {
    providerUsername: 'nx_ali',
    trafficLimitBytes: 50n * 1024n ** 3n,
    trafficUsedBytes: 60n * 1024n ** 3n,
    usageSyncedAt: now,
    expiresAt: new Date('2026-10-20T13:00:00Z'),
    subscriptionUrl: 'https://s.example/sub/abc',
  };
  const extras = { serviceName: 'پایه ۵۰', location: null, status: null, product: 'پایه' };

  it('names each fact, a Jalali expiry, whole days rounded up, never negative traffic', () => {
    const values = connectionFileCaptionVariables(
      service,
      extras,
      { fileName: 'iOS MacOS.bpf' },
      { now, presentation: DEFAULT_TEMPLATE_PRESENTATION, support: 'nexa_support' },
    );
    expect(values).toMatchObject({
      username: 'nx_ali',
      service_name: 'پایه ۵۰',
      product: 'پایه',
      volume_total: service.trafficLimitBytes,
      volume_used: service.trafficUsedBytes,
      volume_left: 0n,
      expires_at_jalali: '1405/07/28',
      days_left: 3,
      platform: 'iOS MacOS',
      file_name: 'iOS MacOS.bpf',
      sub_link: 'https://s.example/sub/abc',
      support: '@nexa_support',
    });
  });

  it('leaves a fact the service lacks ABSENT, so its line is dropped', () => {
    const values = connectionFileCaptionVariables(
      { ...service, usageSyncedAt: null, expiresAt: null, subscriptionUrl: null },
      { serviceName: null, location: null, status: null },
      { fileName: 'Windows.bpf' },
      { now, presentation: DEFAULT_TEMPLATE_PRESENTATION, support: null },
    );
    for (const token of [
      'service_name',
      'product',
      'volume_used',
      'volume_left',
      'expires_at_jalali',
      'days_left',
      'sub_link',
      'support',
    ]) {
      expect(values[token]).toBeUndefined();
    }
    expect(values['platform']).toBe('Windows');
  });
});

describe('which file carries the caption', () => {
  const scope = { tenantId: 't', botInstanceId: null } as unknown as TenantContext;
  const actor: ActorContext = {
    type: 'SYSTEM_JOB',
    id: null,
    label: 'test',
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
    trafficLimitBytes: 0n,
    trafficUsedBytes: 0n,
    usageSyncedAt: null,
    expiresAt: null,
    subscriptionUrl: null,
  };
  const FILES = ['Android.bpf', 'iOS MacOS.bpf', 'Windows.bpf'];
  const adapter = {
    descriptor: new RickpanelAdapter().descriptor,
    supports: (capability: string) => capability === 'SUBSCRIPTION_FILES',
    fetchSubscriptionFiles: vi.fn(async () => ({
      ok: true as const,
      found: true as const,
      failed: 0,
      files: FILES.map((fileName) => ({
        fileName,
        mediaType: 'application/octet-stream' as const,
        bytes: new Uint8Array([1]),
        caption: `<code>${fileName}</code> panel text`,
      })),
    })),
  } as unknown as ProviderAdapter;

  async function captionsFor(
    policy: ConnectionFileCaptionPolicy | null,
  ): Promise<(CustomerCaption | undefined)[]> {
    const sendMediaGroup = vi.fn(async () => ({ outcome: 'DELIVERED' as const }));
    const deps: SubscriptionFileDeps = {
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
      implementedProviderTypes: ['rickpanel'],
      http: { forBase: () => ({ send: vi.fn() }) },
      urlPolicy: { allowLoopback: false, allowPrivate: true } as never,
      probeBudget: { capacity: 10, refillPerSecond: 1 } as never,
      messenger: { sendFile: vi.fn(), sendMediaGroup },
      guard: { check: vi.fn(async () => undefined) } as never,
      uow: { run: async (_s: unknown, fn: (tx: unknown) => unknown) => fn({}) } as never,
      clock: { now: () => new Date('2026-10-18T00:00:00Z') },
      panelPolicy: { forPanel: vi.fn(async () => resolvePanelPolicy(null)) },
      ...(policy === null
        ? {}
        : {
            connectionCaptions: {
              policyFor: vi.fn(async () => policy),
              defaultTemplate: vi.fn(async () => 'پیش‌فرض {platform}'),
              presentationFor: vi.fn(async () => DEFAULT_TEMPLATE_PRESENTATION),
              supportHandle: vi.fn(async () => null),
            },
          }),
    };
    const result = await new SubscriptionFileService(deps).sendAfterDelivery(
      scope,
      actor,
      service as never,
      { chatId: '1', botInstanceId: 'b' as never },
    );
    expect(result).toEqual({ outcome: 'SENT', sent: 3, failed: 0 });
    const call = sendMediaGroup.mock.calls[0] as unknown as [
      unknown,
      { items: { caption?: CustomerCaption }[] },
    ];
    return call[1].items.map((item) => item.caption);
  }

  it('CUSTOM on the LAST file only, rendered from the panel’s template', async () => {
    const captions = await captionsFor({
      mode: 'CUSTOM',
      template: '<b>{platform}</b> · {file_name}',
      placement: 'LAST_FILE',
    });
    expect(captions[0]).toBeUndefined();
    expect(captions[1]).toBeUndefined();
    expect(captions[2]?.rendered).toEqual({
      text: 'Windows · Windows.bpf',
      entities: [{ type: 'bold', offset: 0, length: 7 }],
    });
    expect(captions[2]?.templateKey).toBe('bot.service.connection_files_caption');
  });

  it('CUSTOM on EVERY file, each naming its own platform, from the default body', async () => {
    const captions = await captionsFor({ mode: 'CUSTOM', template: null, placement: 'EVERY_FILE' });
    expect(captions.map((caption) => caption?.rendered?.text)).toEqual([
      'پیش‌فرض Android',
      'پیش‌فرض iOS MacOS',
      'پیش‌فرض Windows',
    ]);
  });

  it('NONE captions nothing', async () => {
    const captions = await captionsFor({
      mode: 'NONE',
      template: '{username}',
      placement: 'EVERY_FILE',
    });
    expect(captions).toEqual([undefined, undefined, undefined]);
  });

  it('PANEL_DEFAULT is the panel’s own caption, placed by the setting', async () => {
    const captions = await captionsFor({
      mode: 'PANEL_DEFAULT',
      template: null,
      placement: 'LAST_FILE',
    });
    expect(captions[0]).toBeUndefined();
    expect(captions[2]).toMatchObject({
      templateKey: 'bot.service.file_caption',
      values: { caption: 'Windows.bpf panel text' },
    });
    expect(captions[2]?.rendered).toBeUndefined();
  });

  it('a composition without caption settings captions every file as before', async () => {
    const captions = await captionsFor(null);
    expect(captions.every((caption) => caption?.templateKey === 'bot.service.file_caption')).toBe(
      true,
    );
  });
});
