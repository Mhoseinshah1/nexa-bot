import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  CreateProviderUserInput,
  ProviderServiceTarget,
  ProviderUserRef,
  SanaeiActivation,
} from '@nexa/contracts';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { RickpanelAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/rickpanel.adapter';
import { SanaeiAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/sanaei.adapter';
import {
  MARZBAN_USAGE,
  RICKPANEL_USAGE,
  readLastSeen,
  readRecordUsage,
} from '../../apps/api/src/modules/platform/providers/infrastructure/provider-numbers';
import {
  LAST_SEEN_FUTURE_TOLERANCE_MS,
  boundedLastSeen,
} from '../../apps/api/src/modules/commerce/provisioning/domain/last-seen';
import { marzbanOnlineAt, startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { CANARY, startFake3xUi, type Fake3xUi } from '../support/fake-3xui';

/*
 * The process runs in Asia/Tehran for this file (C1 review N1). Every other suite runs in
 * UTC, where a parser that reads a zoneless time as LOCAL time gives the same answer as
 * one that reads it as UTC — so "naive is UTC" could not fail anywhere. Node applies TZ
 * at runtime; the first test below proves it took.
 */
const previousTz = process.env['TZ'];
process.env['TZ'] = 'Asia/Tehran';
afterAll(() => {
  if (previousTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = previousTz;
});

/**
 * «آخرین زمان اتصال» (C1): what each adapter reports as a service's last connection.
 *
 * Marzban reads `online_at` off the user record, ONLY when the record carries the key.
 * RickPanel does not read it until its real-panel A9 runs (OQ-LC-02), and 3X-UI reads
 * nothing (OQ-LC-01). The fakes carry the field in the shape the
 * evidence gives — Marzban v0.8.4's source, naive UTC — and they are fakes: what a real
 * panel emits is `pnpm test:acceptance`, NOT RUN (`docs/real-panel-acceptance.md`).
 */

const record = (extra: Record<string, unknown>) => ({ used_traffic: 0, ...extra });

describe('readLastSeen — the `online_at` of a Marzban-shaped record', () => {
  it('runs in Asia/Tehran, so local-time parsing would be caught', () => {
    expect(new Date(2026, 9, 6, 12, 0, 0).toISOString()).toBe('2026-10-06T08:30:00.000Z');
    expect(new Date('2026-10-06T08:30:00').toISOString()).toBe('2026-10-06T05:00:00.000Z');
  });

  it('reads Marzban’s naive ISO time (no offset) as UTC', () => {
    expect(readLastSeen(record({ online_at: '2026-10-06T08:30:00' }))).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.000Z'),
    });
  });

  it('keeps the fraction pydantic adds when the microseconds are not zero', () => {
    expect(readLastSeen(record({ online_at: '2026-10-06T08:30:00.123456' }))).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.123Z'),
    });
  });

  it('honours an explicit Z, and an explicit offset, rather than shifting them again', () => {
    expect(readLastSeen(record({ online_at: '2026-10-06T08:30:00Z' }))).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.000Z'),
    });
    expect(readLastSeen(record({ online_at: '2026-10-06T12:00:00+03:30' }))).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.000Z'),
    });
    expect(readLastSeen(record({ online_at: '2026-10-06T03:30:00.5-05:00' }))).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.500Z'),
    });
  });

  it('reads null as NEVER — the panel saying the account has never connected', () => {
    expect(readLastSeen(record({ online_at: null }))).toEqual({ kind: 'NEVER' });
  });

  it('reads a MISSING key as UNSUPPORTED, never as NEVER', () => {
    expect(readLastSeen(record({}))).toEqual({ kind: 'UNSUPPORTED' });
    // Present-but-undefined cannot come off the wire; a missing key is the case.
    expect(readLastSeen({ used_traffic: 0, sub_updated_at: '2026-10-06T08:30:00' })).toEqual({
      kind: 'UNSUPPORTED',
    });
  });

  for (const garbage of [
    '',
    'never',
    'online',
    'offline',
    '2026-10-06',
    '2026-10-06 08:30:00',
    '2026-10-06T08:30',
    '2026-02-30T08:30:00',
    '2026-13-01T08:30:00',
    '2026-10-06T24:00:00',
    '2026-10-06T08:60:00',
    '2026-10-06T08:30:60',
    '2026-10-06T08:30:00+15:00',
    '2026-10-06T08:30:00+0330',
    '2026-10-06T08:30:00z',
    ' 2026-10-06T08:30:00',
    '1970-01-01T00:00:00',
    '1999-12-31T23:59:59',
    0,
    1_735_680_000_000,
    '1735680000000',
    true,
    {},
    [],
  ]) {
    it(`reads ${JSON.stringify(garbage)} as UNSUPPORTED, never as a time`, () => {
      expect(readLastSeen(record({ online_at: garbage }))).toEqual({ kind: 'UNSUPPORTED' });
    });
  }

  it('never fails the usage read it travels with', () => {
    const read = readRecordUsage(
      record({ used_traffic: 1024, online_at: 'garbage' }),
      MARZBAN_USAGE,
    );
    expect(read).toEqual({
      ok: true,
      usage: {
        usedBytes: 1024n,
        totalBytes: null,
        expiresAt: null,
        lastSeen: { kind: 'UNSUPPORTED' },
      },
    });
  });

  it('is never derived from another timestamp on the record', () => {
    // Every other time a Marzban record carries, and no `online_at`: nothing to show.
    const read = readRecordUsage(
      record({
        expire: 1_900_000_000,
        created_at: '2026-01-01T00:00:00',
        sub_updated_at: '2026-10-06T08:30:00',
        on_hold_timeout: '2026-10-07T00:00:00',
      }),
      MARZBAN_USAGE,
    );
    expect(read.ok && read.usage.lastSeen).toEqual({ kind: 'UNSUPPORTED' });
  });
});

const client = (baseUrl: string) =>
  new SafeHttpClient({
    allowLoopback: true,
    totalTimeoutMs: 2_000,
    maxResponseBytes: 256 * 1024,
    maxRetries: 0,
  }).forBase(baseUrl);

const ref = (username: string): ProviderUserRef => ({
  username,
  subscriptionRef: `sub-${username}`,
  clientId: '11111111-2222-4333-8444-555555555555',
});

const createInput = (username: string): CreateProviderUserInput =>
  ({
    ...ref(username),
    serviceId: '99999999-8888-4777-8666-555555555555',
    volumeBytes: null,
    durationDays: null,
    expiresAt: null,
    deviceLimit: null,
  }) as CreateProviderUserInput;

describe('the Marzban adapter reports the panel’s own last connection', () => {
  let panel: FakeMarzban;
  const adapter = new MarzbanAdapter();
  const target = (): ProviderServiceTarget => ({
    baseUrl: panel.baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: panel.password },
    activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
  });

  beforeAll(async () => {
    panel = await startFakeMarzban();
  });
  afterEach(() => panel.reset());
  afterAll(async () => panel.close());

  it('a fresh account has never connected: NEVER, from the create and from a read', async () => {
    const created = await adapter.createUser(
      target(),
      client(panel.baseUrl),
      createInput('nx_lc1'),
    );
    expect(created.ok).toBe(true);
    const read = await adapter.readUsage(target(), client(panel.baseUrl), ref('nx_lc1'));
    expect(read.ok && read.usage.lastSeen).toEqual({ kind: 'NEVER' });
  });

  it('a used account reports the time xray last saw it, read as UTC', async () => {
    panel.seed({
      username: 'nx_lc2',
      onlineAt: marzbanOnlineAt(new Date('2026-10-06T08:30:00.250Z')),
    });
    expect(panel.users.get('nx_lc2')?.onlineAt).toBe('2026-10-06T08:30:00.250000');
    const read = await adapter.readUsage(target(), client(panel.baseUrl), ref('nx_lc2'));
    expect(read.ok && read.usage.lastSeen).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.250Z'),
    });
    const found = await adapter.lookupUser(target(), client(panel.baseUrl), ref('nx_lc2'));
    expect(found.ok && found.found && found.usage?.lastSeen).toEqual({
      kind: 'AT',
      at: new Date('2026-10-06T08:30:00.250Z'),
    });
  });
});

describe('RICKPANEL_USAGE does not read `online_at` at all (OQ-LC-02)', () => {
  it('a time and a null both read as UNSUPPORTED', () => {
    for (const online_at of ['2026-10-06T08:30:00', null]) {
      const read = readRecordUsage(record({ online_at }), RICKPANEL_USAGE);
      expect(read.ok && read.usage.lastSeen).toEqual({ kind: 'UNSUPPORTED' });
      const marzban = readRecordUsage(record({ online_at }), MARZBAN_USAGE);
      expect(marzban.ok && marzban.usage.lastSeen).not.toEqual({ kind: 'UNSUPPORTED' });
    }
  });
});

describe('boundedLastSeen — a time after the read is not shown (C1 review N3)', () => {
  const readAt = new Date('2026-10-06T08:30:00.000Z');
  const at = (ms: number) => ({ kind: 'AT' as const, at: new Date(readAt.getTime() + ms) });

  it('keeps a past time, and one up to five minutes ahead (a fast panel clock)', () => {
    expect(boundedLastSeen(at(-3_600_000), readAt)).toEqual(at(-3_600_000));
    expect(boundedLastSeen(at(LAST_SEEN_FUTURE_TOLERANCE_MS), readAt)).toEqual(
      at(LAST_SEEN_FUTURE_TOLERANCE_MS),
    );
  });

  it('refuses anything later as UNSUPPORTED — naive Tehran read as UTC is +3:30', () => {
    expect(boundedLastSeen(at(LAST_SEEN_FUTURE_TOLERANCE_MS + 1), readAt)).toEqual({
      kind: 'UNSUPPORTED',
    });
    expect(boundedLastSeen(at(210 * 60_000), readAt)).toEqual({ kind: 'UNSUPPORTED' });
  });

  it('passes NEVER and UNSUPPORTED through untouched', () => {
    expect(boundedLastSeen({ kind: 'NEVER' }, readAt)).toEqual({ kind: 'NEVER' });
    expect(boundedLastSeen({ kind: 'UNSUPPORTED' }, readAt)).toEqual({ kind: 'UNSUPPORTED' });
  });
});

describe('the RickPanel adapter does not report `online_at` yet, whatever the record holds', () => {
  let panel: FakeRickpanel;
  const adapter = new RickpanelAdapter();
  const target = (): ProviderServiceTarget => ({
    baseUrl: panel.baseUrl,
    credentials: { shape: 'USERNAME_PASSWORD', username: panel.username, password: panel.password },
    activation: {},
  });

  beforeAll(async () => {
    panel = await startFakeRickpanel();
  });
  afterEach(() => {
    for (const key of Object.keys(panel.userReadExtras)) delete panel.userReadExtras[key];
  });
  afterAll(async () => panel.close());

  it('null, a naive time and a missing key all read UNSUPPORTED', async () => {
    panel.seedUser('nxrplc1');
    const never = await adapter.readUsage(target(), client(panel.baseUrl), ref('nxrplc1'));
    expect(never.ok && never.usage.lastSeen).toEqual({ kind: 'UNSUPPORTED' });

    panel.seedUser('nxrplc2', { onlineAt: '2026-10-06T08:30:00' });
    const at = await adapter.readUsage(target(), client(panel.baseUrl), ref('nxrplc2'));
    expect(at.ok && at.usage.lastSeen).toEqual({ kind: 'UNSUPPORTED' });
    const found = await adapter.lookupUser(target(), client(panel.baseUrl), ref('nxrplc2'));
    expect(found.ok && found.found && found.usage?.lastSeen).toEqual({ kind: 'UNSUPPORTED' });

    panel.userReadExtras['online_at'] = undefined; // JSON.stringify drops the key
    const silent = await adapter.readUsage(target(), client(panel.baseUrl), ref('nxrplc2'));
    expect(silent.ok && silent.usage.lastSeen).toEqual({ kind: 'UNSUPPORTED' });
  });
});

describe('the Sanaei adapter reports no last connection (OQ-LC-01)', () => {
  let fake: Fake3xUi;
  const activation: SanaeiActivation = { subscriptionDomain: 'subs.example.test', inboundId: 1 };

  beforeAll(async () => {
    fake = await startFake3xUi({ tokens: { [CANARY.token]: 'admin' } });
  });
  afterAll(async () => fake.close());

  it('stays UNSUPPORTED even when the record carries a non-zero `lastOnline`', async () => {
    const adapter = new SanaeiAdapter();
    const target: ProviderServiceTarget = {
      baseUrl: fake.baseUrl,
      credentials: { shape: 'OPAQUE_TOKEN', token: CANARY.token },
      activation,
    };
    const created = await adapter.createUser(target, client(fake.baseUrl), createInput('nxsnlc1'));
    expect(created.ok, JSON.stringify(created)).toBe(true);
    fake.setLastOnline('nxsnlc1', 1_735_680_000_000);
    const read = await adapter.readUsage(target, client(fake.baseUrl), ref('nxsnlc1'));
    expect(read.ok).toBe(true);
    expect(read.ok && read.usage.lastSeen).toEqual({ kind: 'UNSUPPORTED' });
    // And the field really was on the wire, so the adapter ignored it rather than missed it.
    const raw = await fetch(new URL('panel/api/clients/traffic/nxsnlc1', fake.baseUrl), {
      headers: { authorization: `Bearer ${CANARY.token}` },
    });
    const body = (await raw.json()) as { obj: Record<string, unknown> };
    expect(body.obj['lastOnline']).toBe(1_735_680_000_000);
  });
});
