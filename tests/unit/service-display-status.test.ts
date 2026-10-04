import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SERVICE_STATES,
  appearanceMarker,
  templateDefinition,
  type BotInstanceId,
  type InlineButtonStyles,
  type ScopeContext,
  type ServiceState,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import {
  SERVICE_DISPLAY_STATUSES,
  SERVICE_STATUS_PRESENTATION,
  serviceDisplayStatus,
  type ServiceDisplayStatus,
  type ServiceStatusFacts,
} from '../../apps/api/src/modules/commerce/provisioning/domain/service-display-status';
import { serviceListButton } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { CustomerScreenComposer } from '../../apps/api/src/modules/commerce/messaging/application/customer-screens';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * Batch 01 item 3 — the colour of a service in «سرویس‌های من» is DERIVED from the state,
 * the deadline and the read usage, never chosen by hand. Active is green; over by time or
 * by volume is red even while the row still says ACTIVE.
 */

const NOW = new Date('2026-10-04T12:00:00Z');
const GB = 1_073_741_824n;
const LIMIT = 50n * GB;

const DEADLINES = {
  none: null,
  future: new Date('2026-10-20T12:00:00Z'),
  // Half-open: the deadline instant itself is already past.
  exactlyNow: new Date(NOW.getTime()),
  past: new Date('2026-10-01T12:00:00Z'),
} as const;

const USAGES = {
  unread: { trafficLimitBytes: LIMIT, trafficUsedBytes: LIMIT * 2n, usageSyncedAt: null },
  under: { trafficLimitBytes: LIMIT, trafficUsedBytes: LIMIT - 1n, usageSyncedAt: NOW },
  atLimit: { trafficLimitBytes: LIMIT, trafficUsedBytes: LIMIT, usageSyncedAt: NOW },
  over: { trafficLimitBytes: LIMIT, trafficUsedBytes: LIMIT + GB, usageSyncedAt: NOW },
  // 0n is the unlimited sentinel: any usage is fine.
  unlimited: { trafficLimitBytes: 0n, trafficUsedBytes: 900n * GB, usageSyncedAt: NOW },
} as const;

/**
 * The owner's rule, written down as a SPEC independently of the implementation: what each
 * combination must show. A second statement of the rule, so a change to either is caught.
 */
function expected(
  state: ServiceState,
  deadline: keyof typeof DEADLINES,
  usage: keyof typeof USAGES,
): ServiceDisplayStatus {
  const lapsed = deadline === 'exactlyNow' || deadline === 'past';
  const usedUp = usage === 'atLimit' || usage === 'over';
  if (state === 'TERMINATED') return 'TERMINATED';
  if (state === 'UNRECONCILED') return 'UNRECONCILED';
  if (state === 'PENDING_PROVISION') return 'PENDING';
  if (lapsed) return 'EXPIRED';
  if (usedUp) return 'EXHAUSTED';
  if (state === 'EXPIRED') return 'EXPIRED';
  return state === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
}

const facts = (
  state: ServiceState,
  deadline: keyof typeof DEADLINES,
  usage: keyof typeof USAGES,
): ServiceStatusFacts => ({ state, expiresAt: DEADLINES[deadline], ...USAGES[usage], now: NOW });

describe('the shown status, for every state × deadline × usage', () => {
  const cases = SERVICE_STATES.flatMap((state) =>
    (Object.keys(DEADLINES) as (keyof typeof DEADLINES)[]).flatMap((deadline) =>
      (Object.keys(USAGES) as (keyof typeof USAGES)[]).map(
        (usage) => [state, deadline, usage] as const,
      ),
    ),
  );

  it('covers every combination', () => {
    expect(cases).toHaveLength(SERVICE_STATES.length * 4 * 5);
  });

  it.each(cases)('%s, deadline %s, usage %s', (state, deadline, usage) => {
    expect(serviceDisplayStatus(facts(state, deadline, usage))).toBe(
      expected(state, deadline, usage),
    );
  });
});

describe('the owner’s acceptance rows', () => {
  const tone = (f: ServiceStatusFacts) =>
    SERVICE_STATUS_PRESENTATION[serviceDisplayStatus(f)].buttonStyle;

  it('Active → green', () => {
    expect(tone(facts('ACTIVE', 'future', 'under'))).toBe('success');
    expect(tone(facts('ACTIVE', 'none', 'unlimited'))).toBe('success');
    // An unread usage is unknown, never "used up".
    expect(tone(facts('ACTIVE', 'future', 'unread'))).toBe('success');
  });

  it('Expired by time → red, even while the row still says ACTIVE', () => {
    expect(tone(facts('ACTIVE', 'past', 'under'))).toBe('danger');
    expect(tone(facts('ACTIVE', 'exactlyNow', 'under'))).toBe('danger');
    expect(tone(facts('EXPIRED', 'past', 'under'))).toBe('danger');
  });

  it('Exhausted by volume → red, even while the row still says ACTIVE', () => {
    expect(tone(facts('ACTIVE', 'future', 'atLimit'))).toBe('danger');
    expect(tone(facts('ACTIVE', 'none', 'over'))).toBe('danger');
    expect(tone(facts('EXPIRED', 'future', 'over'))).toBe('danger');
  });

  it('a switched-off service is red; pending, under review and removed derive no colour', () => {
    expect(tone(facts('SUSPENDED', 'future', 'under'))).toBe('danger');
    for (const state of ['PENDING_PROVISION', 'UNRECONCILED', 'TERMINATED'] as const) {
      expect(tone(facts(state, 'future', 'under'))).toBeNull();
    }
  });
});

describe('the one presentation table', () => {
  it('is green only for ACTIVE, red for the three that do not serve', () => {
    expect(SERVICE_STATUS_PRESENTATION.ACTIVE).toMatchObject({
      slot: 'active',
      buttonStyle: 'success',
    });
    for (const status of ['EXPIRED', 'EXHAUSTED', 'SUSPENDED'] as const) {
      expect(SERVICE_STATUS_PRESENTATION[status]).toMatchObject({
        slot: 'inactive',
        buttonStyle: 'danger',
      });
    }
  });

  it('gives the card and the list the SAME marker: every label starts with its slot', () => {
    for (const status of SERVICE_DISPLAY_STATUSES) {
      const { slot, label } = SERVICE_STATUS_PRESENTATION[status];
      expect(CATALOGUE_FA[label].startsWith(`${appearanceMarker(slot)} `)).toBe(true);
    }
    // And the list button draws the marker, through the Appearance system, not an emoji.
    expect(CATALOGUE_FA['bot.service.list_item_button']).toBe('{marker} {username}');
  });
});

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

const render = (key: TemplateKey, values: TemplateValues): string =>
  renderTemplateBody(
    templateDefinition(key),
    CATALOGUE_FA[key],
    values,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

const service = (overrides: Partial<Parameters<typeof serviceListButton>[0]> = {}) => ({
  id: '01900000-0000-7000-8000-0000000000c1',
  providerUsername: 'nx7k2m9q',
  state: 'ACTIVE' as const,
  expiresAt: DEADLINES.future,
  trafficLimitBytes: LIMIT,
  trafficUsedBytes: 10n * GB,
  usageSyncedAt: NOW,
  ...overrides,
});

describe('the «سرویس‌های من» button', () => {
  const scope = {
    tenantId: '01900000-0000-7000-8000-000000000001',
    botInstanceId: null,
  } as TenantContext;
  const bot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The keyboard a real messenger puts on the wire, under a tenant's stored styles. */
  async function wire(
    buttons: Parameters<typeof serviceListButton>[0][],
    styles: InlineButtonStyles,
  ) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, result: { message_id: 7 } }),
        };
      }),
    );
    const messenger = new TelegramCustomerMessenger(
      {
        render: async (_scope: unknown, key: TemplateKey, values: TemplateValues) =>
          render(key, values),
      } as never,
      { tokenForBotInstance: async () => 'test-token' } as never,
      { record: async () => undefined } as never,
      { conditionIsOpen: async () => false } as never,
      'https://telegram.invalid',
      1000,
      undefined,
      undefined,
      { stylesFor: async () => styles },
    );
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId: bot,
      templateKey: 'bot.service.list',
      values: { page: 1, pages: 1, total: buttons.length },
      buttons: buttons.map((one) => serviceListButton(one, NOW)),
    });
    return (
      bodies[0]?.reply_markup as { inline_keyboard: Record<string, unknown>[][] }
    ).inline_keyboard.flat();
  }

  it('draws green for an active service and red for one over by time or by volume', async () => {
    // A tenant who once set a manual colour for the button: the derived one wins.
    const cells = await wire(
      [
        service(),
        service({
          id: '01900000-0000-7000-8000-0000000000c2',
          providerUsername: 'late',
          expiresAt: DEADLINES.past,
        }),
        service({
          id: '01900000-0000-7000-8000-0000000000c3',
          providerUsername: 'full',
          trafficUsedBytes: LIMIT,
        }),
      ],
      { 'services.item': 'primary' },
    );
    expect(cells.map((cell) => [cell.text, cell.style])).toEqual([
      ['🟢 nx7k2m9q', 'success'],
      ['🔴 late', 'danger'],
      ['🔴 full', 'danger'],
    ]);
    // The route is the card's, whatever the colour.
    expect(cells.map((cell) => cell.callback_data)).toEqual([
      'sv:01900000-0000-7000-8000-0000000000c1',
      'sv:01900000-0000-7000-8000-0000000000c2',
      'sv:01900000-0000-7000-8000-0000000000c3',
    ]);
  });

  it('keeps the tenant’s style where no colour is derived', async () => {
    const cells = await wire([service({ state: 'PENDING_PROVISION' })], {
      'services.item': 'primary',
    });
    expect(cells[0]).toMatchObject({ text: '⏳ nx7k2m9q', style: 'primary' });
  });

  it('follows the facts: the same service turns red once a refresh reads its usage as used up', () => {
    const before = serviceListButton(service(), NOW);
    const after = serviceListButton(
      service({ trafficUsedBytes: LIMIT + 1n, usageSyncedAt: NOW }),
      NOW,
    );
    expect(before).toMatchObject({ derivedStyle: 'success' });
    expect(after).toMatchObject({ derivedStyle: 'danger' });
    // And once the clock passes the deadline, with nothing written at all.
    expect(serviceListButton(service(), new Date(DEADLINES.future.getTime() + 1))).toMatchObject({
      derivedStyle: 'danger',
    });
  });
});

describe('the service card’s status line', () => {
  const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as ScopeContext;
  const composer = new CustomerScreenComposer({
    render: async (_scope, key, values) => render(key, values),
  });
  const card = (overrides: Partial<Parameters<CustomerScreenComposer['serviceCard']>[1]>) =>
    composer.serviceCard(scope, {
      state: 'ACTIVE',
      serviceUsername: 'nx7k2m9q',
      serviceLocation: null,
      productName: 'پلن',
      trafficLimitBytes: LIMIT,
      trafficUsedBytes: 10n * GB,
      usageSyncedAt: NOW,
      expiresAt: DEADLINES.future,
      now: NOW,
      lastSeen: { kind: 'UNSUPPORTED' },
      note: null,
      rotateOffered: false,
      ...overrides,
    });
  const statusOf = async (overrides: Parameters<typeof card>[0]) =>
    appearanceFallbackText(String((await card(overrides)).values.status));

  it('reads green «فعال» only while it serves, and red once its time or traffic is over', async () => {
    expect(await statusOf({})).toBe('🟢 فعال');
    expect(await statusOf({ expiresAt: DEADLINES.past })).toBe('🔴 منقضی شده');
    expect(await statusOf({ trafficUsedBytes: LIMIT })).toBe('🔴 حجم تمام شده');
    expect(await statusOf({ state: 'EXPIRED' })).toBe('🔴 منقضی شده');
    expect(await statusOf({ state: 'SUSPENDED' })).toBe('🔴 خاموش');
    // «working» still wins while a change is applied.
    expect(await statusOf({ expiresAt: DEADLINES.past, working: true })).toContain('در حال اعمال');
  });
});
