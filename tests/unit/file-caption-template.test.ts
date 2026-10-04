import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_CAPTION_PLACEHOLDERS,
  TELEGRAM_CAPTION_MAX_LENGTH,
  templateDefinition,
  validateTemplateBody,
  validateTemplateValues,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody, type TemplatePresentation } from '@nexa/i18n';
import {
  connectionFileCaption,
  fileCaptionValues,
} from '../../apps/api/src/modules/commerce/provisioning/application/subscription-file.service';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import { TELEGRAM_CAPTION_MAX } from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * UX Batch 01 item 4 — a tenant's caption on a RickPanel connection file.
 *
 * The caption is the existing `bot.service.file_caption` template, edited through the
 * existing template screen (the same `templates.edit` permission, the same revision and
 * audit). What this pins is the part that is new: the closed set of facts it may name, what
 * a missing fact does, that no credential can be named, and Telegram's caption bound.
 */

const KEY = 'bot.service.file_caption' satisfies TemplateKey;
const definition = templateDefinition(KEY);
const TEHRAN: TemplatePresentation = { timezone: 'Asia/Tehran', calendar: 'jalali' };

const GB = 1024n * 1024n * 1024n;
const service = {
  providerUsername: 'ali_01',
  trafficLimitBytes: 50n * GB,
  trafficUsedBytes: 20n * GB,
  usageSyncedAt: new Date('2026-10-01T00:00:00Z'),
  expiresAt: new Date('2026-10-30T20:30:00Z'),
  subscriptionUrl: 'https://sub.example.test/s/abc',
};
const extras = { serviceName: 'سرویس ۵۰ گیگ', location: 'آلمان', status: 'فعال' };

const OWNER_BODY = [
  '👤 نام کاربری: {username}',
  '📦 سرویس: {service_name}',
  '📊 حجم: {total_volume}',
  '📉 مصرف: {used_volume}',
  '📈 باقی‌مانده: {remaining_volume}',
  '⏳ اعتبار: {expiry}',
  '📍 لوکیشن: {location}',
  '🔘 وضعیت: {status}',
].join('\n');

const render = (body: string, values: TemplateValues) =>
  renderTemplateBody(definition, body, values, 'fa', TEHRAN);

describe('the caption’s placeholders', () => {
  it('are exactly the allowlist, every one optional, and the template uses them', () => {
    expect(definition.placeholders).toBe(FILE_CAPTION_PLACEHOLDERS);
    expect(definition.placeholders.map((p) => p.token).sort()).toEqual(
      [
        'caption',
        'expiry',
        'location',
        'remaining_volume',
        'service_name',
        'status',
        'subscription_url',
        'total_volume',
        'used_volume',
        'username',
      ].sort(),
    );
    expect(definition.placeholders.every((p) => !p.required)).toBe(true);
    // The default is still the panel's own caption: nothing changes until a tenant edits it.
    expect(CATALOGUE_FA[KEY]).toBe('{caption}');
  });

  it('cannot name a credential or an internal id', () => {
    for (const forbidden of [
      'subscriptionRef',
      'subscription_ref',
      'sub_id',
      'providerClientId',
      'client_id',
      'uuid',
      'providerUserId',
      'id',
      'service_id',
      'order_id',
      'token',
      'password',
      'panel_name',
      'base_url',
    ]) {
      const issues = validateTemplateBody(definition, `x {${forbidden}}`);
      expect(issues.map((issue) => [issue.kind, issue.token])).toContainEqual([
        'UNKNOWN_PLACEHOLDER',
        forbidden,
      ]);
    }
    // And no declared token reads like one.
    for (const { token } of definition.placeholders) {
      expect(token).not.toMatch(/(^|_)(id|uuid|ref|token|secret|password|key)$/i);
    }
  });

  it('never produces a value for a credential, whatever the service row holds', () => {
    const values = fileCaptionValues(
      {
        ...service,
        // Fields the row has and the builder must not read.
        ...({ subscriptionRef: 'SECRET-SUB', providerClientId: 'SECRET-UUID' } as object),
      },
      extras,
    );
    expect(
      JSON.stringify(values, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toMatch(/SECRET/);
    expect(validateTemplateValues(definition, values)).toEqual([]);
  });

  it('refuses an unknown placeholder, naming it', () => {
    const issues = validateTemplateBody(definition, '👤 {username}\n⏳ {expiry_date}');
    expect(issues).toEqual([
      expect.objectContaining({ kind: 'UNKNOWN_PLACEHOLDER', token: 'expiry_date' }),
    ]);
    expect(validateTemplateBody(definition, OWNER_BODY)).toEqual([]);
  });
});

describe('rendering the caption', () => {
  it('fills every line when every fact is present, in the tenant’s zone and calendar', () => {
    const text = render(OWNER_BODY, fileCaptionValues(service, extras));
    expect(text.split('\n')).toEqual([
      '👤 نام کاربری: ali_01',
      '📦 سرویس: سرویس ۵۰ گیگ',
      '📊 حجم: 50 گیگابایت',
      '📉 مصرف: 20 گیگابایت',
      '📈 باقی‌مانده: 30 گیگابایت',
      // 20:30 UTC is 00:00 the next day in Tehran: the tenant's zone, not UTC.
      '⏳ اعتبار: 1405/08/09 00:00',
      '📍 لوکیشن: آلمان',
      '🔘 وضعیت: فعال',
    ]);
  });

  it('drops the line of a fact the service does not have, and says unlimited for no limit', () => {
    const values = fileCaptionValues(
      {
        ...service,
        trafficLimitBytes: 0n,
        usageSyncedAt: null,
        expiresAt: null,
        subscriptionUrl: null,
      },
      { serviceName: null, location: null, status: 'فعال' },
    );
    expect(values).not.toHaveProperty('used_volume');
    expect(values).not.toHaveProperty('remaining_volume');
    expect(values).not.toHaveProperty('expiry');
    expect(render(OWNER_BODY, values).split('\n')).toEqual([
      '👤 نام کاربری: ali_01',
      '📊 حجم: نامحدود',
      '🔘 وضعیت: فعال',
    ]);
  });

  it('never shows a negative remainder', () => {
    const values = fileCaptionValues({ ...service, trafficUsedBytes: 60n * GB }, extras);
    expect(values['remaining_volume']).toBe(0n);
  });

  it('carries the panel’s caption and the facts, with the username line as the fallback', () => {
    const caption = connectionFileCaption(
      '<b>Config</b> for you',
      'ali_01',
      fileCaptionValues(service, extras),
    );
    expect(caption.templateKey).toBe(KEY);
    expect(caption.values['caption']).toBe('Config for you');
    expect(caption.values['username']).toBe('ali_01');
    expect(caption.markup).toEqual({
      token: 'caption',
      entities: [{ type: 'bold', offset: 0, length: 6 }],
    });
    expect(caption.fallback).toEqual({
      templateKey: 'bot.service.connection_file_caption',
      values: { serviceUsername: 'ali_01' },
    });
    // The default body renders exactly the panel's caption, as before.
    expect(render(CATALOGUE_FA[KEY], caption.values)).toBe('Config for you');
  });

  it('renders nothing for a panel with no caption under the default body, so the fallback is sent', () => {
    const caption = connectionFileCaption(null, 'ali_01', fileCaptionValues(service, extras));
    expect(caption.values).not.toHaveProperty('caption');
    expect(render(CATALOGUE_FA[KEY], caption.values)).toBe('');
  });
});

describe('Telegram’s caption bound', () => {
  it('refuses a body longer than a caption may be', () => {
    expect(definition.maxLength).toBe(TELEGRAM_CAPTION_MAX_LENGTH);
    expect(TELEGRAM_CAPTION_MAX_LENGTH).toBe(TELEGRAM_CAPTION_MAX);
    const exact = `{username}${'ا'.repeat(TELEGRAM_CAPTION_MAX_LENGTH - '{username}'.length)}`;
    expect(validateTemplateBody(definition, exact)).toEqual([]);
    expect(validateTemplateBody(definition, `${exact}ب`).map((issue) => issue.kind)).toEqual([
      'TOO_LONG',
    ]);
  });
});

describe('the messenger sending the caption', () => {
  const bodies: Record<string, unknown>[] = [];
  /** A tenant override of the caption, rendered through the one renderer. */
  let override = CATALOGUE_FA[KEY];
  const templates = {
    render: async (_scope: unknown, key: TemplateKey, values: TemplateValues) =>
      renderTemplateBody(
        templateDefinition(key),
        key === KEY ? override : CATALOGUE_FA[key],
        values,
        'fa',
        TEHRAN,
      ),
  };
  const messenger = new TelegramCustomerMessenger(
    templates as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async () => undefined } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
  );
  const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as never;
  const send = (caption: ReturnType<typeof connectionFileCaption>) =>
    messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId: '01900000-0000-7000-8000-0000000000bb' as never,
      kind: 'DOCUMENT',
      source: { kind: 'FILE_ID', fileId: 'f' },
      caption,
    });

  afterEach(() => {
    vi.unstubAllGlobals();
    bodies.length = 0;
    override = CATALOGUE_FA[KEY];
  });
  const accept = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
      }),
    );

  it('sends the tenant’s caption with the service’s facts', async () => {
    accept();
    override = '👤 {username}\n📍 {location}\n⏳ {expiry}';
    await send(connectionFileCaption('panel text', 'ali_01', fileCaptionValues(service, extras)));
    expect(bodies[0]?.['caption']).toBe('👤 ali_01\n📍 آلمان\n⏳ 1405/08/09 00:00');
  });

  it('falls back to the username line when the tenant’s caption renders to nothing', async () => {
    accept();
    override = '📍 {location}';
    await send(
      connectionFileCaption(
        null,
        'ali_01',
        fileCaptionValues(service, { ...extras, location: null }),
      ),
    );
    const caption = bodies[0]?.['caption'];
    expect(typeof caption).toBe('string');
    expect(caption).toContain('ali_01');
  });

  it('cuts a render past Telegram’s bound with an ellipsis', async () => {
    accept();
    override = '{caption}\n{subscription_url}';
    await send(
      connectionFileCaption(
        `<b>${'x'.repeat(900)}</b>`,
        'ali_01',
        fileCaptionValues(
          { ...service, subscriptionUrl: `https://s.test/${'y'.repeat(300)}` },
          extras,
        ),
      ),
    );
    const caption = bodies[0]?.['caption'] as string;
    expect(caption.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX);
    expect(caption.endsWith('…')).toBe(true);
    // The panel's bold survives, clipped to the text it lies in.
    const entities = bodies[0]?.['caption_entities'] as { offset: number; length: number }[];
    expect(entities[0]).toMatchObject({ type: 'bold', offset: 0, length: 900 });
  });
});
