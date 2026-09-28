import { describe, expect, it } from 'vitest';
import {
  CLIENT_APP_PLATFORMS,
  CONNECTION_GUIDE_PLATFORMS,
  MARZBAN_PROXY_PROTOCOLS,
  CLIENT_APP_PROTOCOLS,
  ROLE_SEEDS,
  clientAppInputSchema,
  clientAppTextProblem,
  normalizeClientAppUrl,
  permissionDefinition,
  renderClientAppGuide,
  templateDefinition,
  type ClientAppPlatform,
  type UserId,
} from '@nexa/contracts';
import { isClientAppRelevant } from '../../apps/api/src/modules/control/client-apps/domain/relevance';
import { ClientAppCatalog } from '../../apps/api/src/modules/control/client-apps/application/client-app-catalog';
import {
  ProvisionedServiceFacts,
  SERVICE_FACTS_LIMIT,
  SERVICE_FACTS_MAX_PAGES,
  SERVICE_FACTS_PAGE_SIZE,
  protocolsOf,
} from '../../apps/api/src/modules/control/client-apps/application/customer-service-facts';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type {
  ClientAppRecord,
  CustomerServiceFact,
} from '../../apps/api/src/modules/control/client-apps/application/ports';
import {
  CLIENT_APP_CALLBACK_PREFIX,
  clientAppPlatformScreen,
  clientAppScreen,
  intentOf,
  tutorialChoice,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';

/**
 * WP-A10 — the rules that decide what a customer is sent to download and read.
 *
 * Each block is one way this could send a customer somewhere they should not go, or hide
 * an app they needed: a link that is not a plain https download, guide text that is
 * interpreted rather than shown, an app offered for a service it cannot connect, a
 * disabled entry still served, and a button already in a chat that stops answering.
 */

const TENANT = { tenantId: '0191f4a0-0000-7000-8000-000000000001', botInstanceId: null } as never;
const CUSTOMER = '0191f4a0-0000-7000-8000-0000000000c1' as UserId;
const uuid = (n: number) => `0191f4a0-2d3c-7c2b-9a41-${String(n).padStart(12, '0')}`;

describe('a download link', () => {
  it.each([
    [
      'https://play.google.com/store/apps/details?id=com.example',
      'https://play.google.com/store/apps/details?id=com.example',
    ],
    ['https://apps.apple.com/app/id123', 'https://apps.apple.com/app/id123'],
    ['HTTPS://Downloads.Example.COM/App.APK', 'https://downloads.example.com/App.APK'],
    ['  https://example.com/a#b  ', 'https://example.com/a#b'],
    ['https://example.com:8443/x?y=1', 'https://example.com:8443/x?y=1'],
    ['https://xn--mgbh0fb.xn--kgbechtv/', 'https://xn--mgbh0fb.xn--kgbechtv/'],
  ])('accepts %j as %j', (raw, normalized) => {
    expect(normalizeClientAppUrl(raw)).toBe(normalized);
  });

  it.each([
    ['plain http', 'http://example.com/app.apk'],
    ['javascript:', 'javascript:alert(1)'],
    ['javascript: dressed as https', 'https://example.com/"onclick="alert(1)'],
    ['data:', 'data:text/html;base64,PHNjcmlwdD4='],
    ['a store scheme Telegram will not open', 'market://details?id=com.example'],
    ['userinfo that shows one host and opens another', 'https://play.google.com@evil.example/'],
    ['an IPv4 literal', 'https://203.0.113.5/app.apk'],
    ['a dotless host', 'https://downloads/app.apk'],
    ['a backslash', 'https:\\\\example.com\\app'],
    ['a space', 'https://example.com/my app.apk'],
    ['non-ASCII', 'https://مثال.example/app'],
    ['port zero', 'https://example.com:0/'],
    ['a port past the range', 'https://example.com:70000/'],
    ['no host at all', 'https:///path'],
    ['over the length bound', `https://example.com/${'a'.repeat(2048)}`],
  ])('refuses %s', (_label, raw) => {
    expect(normalizeClientAppUrl(raw)).toBeNull();
  });
});

describe('an entry as the operator writes it', () => {
  const valid = {
    platform: 'ANDROID',
    name: 'نمونه',
    description: 'توضیح کوتاه',
    officialUrl: 'https://downloads.example.com/a.apk',
    guide: '1. نصب کنید',
    sortOrder: 10,
  };

  it('normalises the links and reads empty optional fields as absent', () => {
    const parsed = clientAppInputSchema.parse({
      ...valid,
      officialUrl: 'HTTPS://Downloads.Example.com/a.apk',
      alternativeUrl: '  ',
      helpUrl: null,
      icon: '',
    });
    expect(parsed).toMatchObject({
      officialUrl: 'https://downloads.example.com/a.apk',
      alternativeUrl: null,
      helpUrl: null,
      icon: null,
      deliveryKinds: [],
      protocols: [],
      providerTypes: [],
    });
  });

  it.each([
    ['a script tag in the guide', { guide: '<script>alert(1)</script>' }],
    ['an event handler in the guide', { guide: '<img src=x onerror=alert(1)>' }],
    ['a javascript: link in the guide', { guide: '[باز کن](javascript:alert(1))' }],
    ['an http link in the guide', { guide: '[دانلود](http://example.com/a)' }],
    ['a data: URL in the description', { description: 'data:text/html,hi' }],
    ['markup in the name', { name: '<b>نام</b>' }],
    ['a control character', { guide: 'یک\u0000دو' }],
    ['a line break in the name', { name: 'یک\nدو' }],
    ['a spaced icon', { icon: '🟢 x' }],
    ['a javascript: alternative link', { alternativeUrl: 'javascript:alert(1)' }],
    ['a repeated compatibility member', { providerTypes: ['marzban', 'marzban'] }],
    ['a provider this release does not know', { providerTypes: ['hiddify'] }],
    ['a platform the contract does not know', { platform: 'AMIGA' }],
  ])('refuses %s', (_label, change) => {
    expect(clientAppInputSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it('does not mistake an ordinary sentence for a data: URL', () => {
    expect(clientAppTextProblem('Mobile data: on، سپس وصل شوید')).toBeNull();
  });

  /*
   * Codex review #1 of PR #95, C5: only `[label](link)` was checked, and Telegram
   * auto-links a BARE address in plain text — so a bare http link was a plaintext download
   * link sent to every customer.
   */
  it.each([
    ['a bare http link', 'Download http://x.example/a.apk'],
    ['a bare http link in Persian prose', 'برنامه را از http://x.example/a.apk بگیرید.'],
    ['a bare https link to an IP literal', 'https://1.2.3.4/a'],
    ['a scheme-less www host, which Telegram links as http', 'از www.example.com دانلود کنید'],
    ['any other scheme', 'ftp://files.example.com/a.apk'],
    ['a tg:// link', 'tg://resolve?domain=example'],
    ['an upper-case http scheme', 'HTTP://X.EXAMPLE/a'],
  ])('refuses %s', (_label, text) => {
    expect(clientAppTextProblem(text)).toBe('UNSAFE_LINK');
    expect(clientAppInputSchema.safeParse({ ...valid, guide: text }).success).toBe(false);
    expect(clientAppInputSchema.safeParse({ ...valid, description: text }).success).toBe(false);
  });

  it.each([
    ['a bare https link', 'https://ok.example/a'],
    ['one ending a sentence', 'نصب از https://ok.example/a.'],
    ['one beside a labelled link', '[دانلود](https://ok.example/a) یا https://ok.example/b'],
  ])('accepts %s', (_label, text) => {
    expect(clientAppTextProblem(text)).toBeNull();
  });
});

describe('the guide as a customer reads it', () => {
  it('draws the Markdown-like subset as plain text', () => {
    const rendered = renderClientAppGuide(
      'نصب:\r\n\r\n\r\n\r\n- گام اول\n* گام دوم\n1. مرحلهٔ یک\n۲) مرحلهٔ دو\n[دانلود](https://downloads.example.com/a)  ',
    );
    expect(rendered).toBe(
      [
        'نصب:',
        '',
        '• گام اول',
        '• گام دوم',
        '1. مرحلهٔ یک',
        '۲. مرحلهٔ دو',
        'دانلود: https://downloads.example.com/a',
      ].join('\n'),
    );
  });

  it('drops a stored bare link it would refuse, keeping the safe one and the prose', () => {
    const rendered = renderClientAppGuide(
      'Download http://x.example/a.apk, now\nwww.evil.example\nok https://ok.example/a.',
    );
    expect(rendered).toBe('Download , now\n\nok https://ok.example/a.');
    expect(rendered).not.toContain('http://');
    expect(rendered).not.toContain('www.');
  });

  it('neutralises an injection that got past validation: no link, no parse mode', () => {
    // A row written around the service. The renderer is total: an unsafe link is its
    // label alone, and markup stays characters.
    const rendered = renderClientAppGuide(
      '<script>alert(1)</script>\n[باز کن](javascript:alert(1))\n[این](http://evil.example)',
    );
    expect(rendered).not.toContain('javascript:');
    expect(rendered).not.toContain('http://evil.example');
    expect(rendered).toContain('باز کن');
    // And it is sent with NO parse mode, so the tag is shown as the characters it is.
    expect(templateDefinition('bot.apps.detail').format).toBe('PLAIN_TEXT');
    expect(templateDefinition('bot.apps.detail_files').format).toBe('PLAIN_TEXT');
  });
});

describe('which apps a customer is shown', () => {
  const any = { deliveryKinds: [], protocols: [], providerTypes: [] } as const;
  const marzbanLink = {
    deliveryKinds: ['SUBSCRIPTION_LINK'],
    protocols: ['vless'],
    providerType: 'marzban',
  } as const;
  const rickpanelFiles = {
    deliveryKinds: ['SUBSCRIPTION_LINK', 'CONNECTION_FILES'],
    protocols: null,
    providerType: 'rickpanel',
  } as const;

  it('shows everything to a customer with no live service', () => {
    expect(isClientAppRelevant({ ...any, providerTypes: ['rickpanel'] }, [])).toBe(true);
  });

  it('shows an app that names nothing to everybody', () => {
    expect(isClientAppRelevant(any, [marzbanLink])).toBe(true);
  });

  it('hides a files-only app from a customer whose panel cannot hand files over', () => {
    const filesOnly = { ...any, deliveryKinds: ['CONNECTION_FILES'] } as const;
    expect(isClientAppRelevant(filesOnly, [marzbanLink])).toBe(false);
    expect(isClientAppRelevant(filesOnly, [rickpanelFiles])).toBe(true);
  });

  it('filters by panel type and by a KNOWN protocol, never by an unknown one', () => {
    expect(isClientAppRelevant({ ...any, providerTypes: ['rickpanel'] }, [marzbanLink])).toBe(
      false,
    );
    expect(isClientAppRelevant({ ...any, protocols: ['vmess'] }, [marzbanLink])).toBe(false);
    expect(isClientAppRelevant({ ...any, protocols: ['vless', 'vmess'] }, [marzbanLink])).toBe(
      true,
    );
    // RickPanel's activation names no protocols: unknown, so it excludes nothing.
    expect(isClientAppRelevant({ ...any, protocols: ['vmess'] }, [rickpanelFiles])).toBe(true);
  });

  it('shows an app that fits ANY one of the customer’s services', () => {
    const rickOnly = { ...any, providerTypes: ['rickpanel'] } as const;
    expect(isClientAppRelevant(rickOnly, [marzbanLink, rickpanelFiles])).toBe(true);
  });

  it('reads protocols from the activation’s own schema, and unknown otherwise', () => {
    expect(
      protocolsOf('marzban', {
        proxyProtocols: ['vless', 'trojan'],
        inboundTags: { vless: ['a'], trojan: ['b'] },
      }),
    ).toEqual(['vless', 'trojan']);
    expect(protocolsOf('rickpanel', {})).toBeNull();
    expect(
      protocolsOf('sanaei', { subscriptionDomain: 'sub.example.com', inboundId: 3 }),
    ).toBeNull();
    // An activation that does not parse says nothing about protocols.
    expect(protocolsOf('marzban', { proxyProtocols: ['vless'] })).toBeNull();
    // Every protocol an activation can name is one an entry can declare.
    for (const protocol of MARZBAN_PROXY_PROTOCOLS) {
      expect(CLIENT_APP_PROTOCOLS).toContain(protocol);
    }
  });
});

function record(overrides: Partial<ClientAppRecord> & { id: string }): ClientAppRecord {
  return {
    platform: 'ANDROID',
    name: 'App',
    icon: null,
    description: 'd',
    officialUrl: 'https://downloads.example.com/a',
    alternativeUrl: null,
    helpUrl: null,
    guide: '- g',
    deliveryKinds: [],
    protocols: [],
    providerTypes: [],
    status: 'ENABLED',
    sortOrder: 0,
    version: 1,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function catalog(rows: readonly ClientAppRecord[], facts: readonly CustomerServiceFact[]) {
  return new ClientAppCatalog({
    repository: {
      // The repository's contract: tenant rows, filtered, in `sort_order` order.
      list: (_scope, options = {}) =>
        Promise.resolve(
          rows
            .filter((row) => options.platform === undefined || row.platform === options.platform)
            .filter((row) => options.status === undefined || row.status === options.status)
            .sort((a, b) => a.sortOrder - b.sortOrder),
        ),
      find: (_scope, id) => Promise.resolve(rows.find((row) => row.id === id) ?? null),
    },
    facts: { factsFor: () => Promise.resolve(facts) },
  });
}

const fact = (overrides: Partial<CustomerServiceFact> = {}): CustomerServiceFact => ({
  serviceId: uuid(900),
  providerType: 'marzban',
  deliveryKinds: ['SUBSCRIPTION_LINK'],
  protocols: ['vless'],
  linkDeliverable: true,
  filesOffered: false,
  ...overrides,
});

describe('the customer’s catalogue', () => {
  const rows = [
    record({ id: uuid(3), name: 'Third', sortOrder: 30 }),
    record({ id: uuid(1), name: 'First', icon: '🟢', sortOrder: 10 }),
    record({ id: uuid(2), name: 'Hidden', status: 'DISABLED', sortOrder: 20 }),
    record({ id: uuid(4), name: 'Files only', deliveryKinds: ['CONNECTION_FILES'], sortOrder: 5 }),
    record({ id: uuid(5), name: 'iOS app', platform: 'IOS' }),
  ];

  it('lists a platform’s ENABLED apps in the operator’s order, with the icon on the label', async () => {
    const apps = await catalog(rows, []).appsFor(TENANT, CUSTOMER, 'ANDROID');
    expect(apps.map((app) => app.label)).toEqual(['Files only', '🟢 First', 'Third']);
  });

  it('drops what does not fit the customer’s service', async () => {
    const apps = await catalog(rows, [fact()]).appsFor(TENANT, CUSTOMER, 'ANDROID');
    expect(apps.map((app) => app.label)).toEqual(['🟢 First', 'Third']);
  });

  it('offers «Other» only while it holds an app the customer may see', async () => {
    expect(await catalog(rows, []).platformsFor(TENANT, CUSTOMER)).toEqual(
      CONNECTION_GUIDE_PLATFORMS,
    );
    const withOther = [
      ...rows,
      record({ id: uuid(6), platform: 'OTHER', providerTypes: ['rickpanel'] }),
    ];
    expect(await catalog(withOther, []).platformsFor(TENANT, CUSTOMER)).toEqual(
      CLIENT_APP_PLATFORMS,
    );
    // The only OTHER app is for RickPanel, and this customer is on Marzban.
    expect(await catalog(withOther, [fact()]).platformsFor(TENANT, CUSTOMER)).toEqual(
      CONNECTION_GUIDE_PLATFORMS,
    );
  });

  it('re-checks a stored link as it is read, so a row written around the service costs one button', async () => {
    const bad = record({
      id: uuid(8),
      officialUrl: 'https://downloads.example.com/"onclick="x',
      helpUrl: 'https://video.example.com/a',
    });
    const detail = await catalog([bad], []).appFor(TENANT, CUSTOMER, uuid(8));
    expect(detail).toMatchObject({ officialUrl: null, helpUrl: 'https://video.example.com/a' });
    expect(
      clientAppScreen(detail).buttons?.map((button) => (button as { url?: string }).url),
    ).toEqual(['https://video.example.com/a', undefined, undefined]);
  });

  it('neutralises a stored bare unsafe link in the name and description, keeping a safe one (C6)', async () => {
    const written = record({
      id: uuid(9),
      icon: '🟢',
      name: 'App http://x.example/a.apk',
      description: 'از www.x.example بگیرید، یا https://ok.example/a.',
    });
    const reader = catalog([written], []);
    const [listed] = await reader.appsFor(TENANT, CUSTOMER, 'ANDROID');
    expect(listed?.label).toBe('🟢 App ');
    const detail = await reader.appFor(TENANT, CUSTOMER, uuid(9));
    expect(detail?.title).toBe('🟢 App ');
    expect(detail?.description).toBe('از  بگیرید، یا https://ok.example/a.');
    for (const text of [listed?.label, detail?.title, detail?.description]) {
      expect(text).not.toContain('http://');
      expect(text).not.toContain('www.');
    }
  });

  it('answers a disabled, unknown or malformed id with nothing', async () => {
    const reader = catalog(rows, []);
    expect(await reader.appFor(TENANT, CUSTOMER, uuid(2))).toBeNull();
    expect(await reader.appFor(TENANT, CUSTOMER, uuid(99))).toBeNull();
    expect(await reader.appFor(TENANT, CUSTOMER, 'not-a-uuid')).toBeNull();
  });

  it('offers the one service’s existing actions, and the files note only where files exist', async () => {
    const files = record({
      id: uuid(7),
      deliveryKinds: ['SUBSCRIPTION_LINK', 'CONNECTION_FILES'],
      guide: '- [دانلود](https://downloads.example.com/x)',
    });
    const one = await catalog([files], [fact({ filesOffered: true })]).appFor(
      TENANT,
      CUSTOMER,
      uuid(7),
    );
    expect(one).toMatchObject({
      guide: '• دانلود: https://downloads.example.com/x',
      filesNote: true,
      service: { id: uuid(900), link: true, files: true },
      manyServices: false,
    });

    const marzbanOnly = await catalog([files], [fact()]).appFor(TENANT, CUSTOMER, uuid(7));
    expect(marzbanOnly).toMatchObject({ filesNote: false, service: { files: false } });

    const several = await catalog([files], [fact(), fact({ serviceId: uuid(901) })]).appFor(
      TENANT,
      CUSTOMER,
      uuid(7),
    );
    expect(several).toMatchObject({ service: null, manyServices: true });
  });
});

describe('the bot’s guide screens', () => {
  const callbacks = (reply: { buttons?: readonly unknown[] }) =>
    (reply.buttons ?? []).map((button) => {
      const b = button as { data?: string; url?: string };
      return b.data ?? b.url;
    });

  it('keeps answering the buttons already sitting in customers’ chats', () => {
    // `tu:` from the delivery card, and each `to:<platform>` of the five.
    expect(intentOf({ callback_query: { id: 'q', data: 'tu:' } }).intent).toBe('TUTORIAL');
    for (const platform of CONNECTION_GUIDE_PLATFORMS) {
      expect(intentOf({ callback_query: { id: 'q', data: `to:${platform}` } })).toMatchObject({
        intent: 'TUTORIAL_PLATFORM',
        targetId: platform,
      });
    }
    // With nothing configured, a platform is EXACTLY its pre-WP-A10 screen.
    const android = clientAppPlatformScreen('ANDROID', []);
    expect(android.key).toBe('bot.tutorial.android');
    expect(callbacks(android)).toEqual(['tu:', 'mm:']);
  });

  it('routes /apps, «Other» and an app, and refuses a crafted one', () => {
    expect(intentOf({ message: { text: '/apps' } }).intent).toBe('TUTORIAL');
    expect(intentOf({ callback_query: { id: 'q', data: 'to:OTHER' } }).targetId).toBe('OTHER');
    expect(
      intentOf({ callback_query: { id: 'q', data: `${CLIENT_APP_CALLBACK_PREFIX}${uuid(1)}` } }),
    ).toMatchObject({ intent: 'CLIENT_APP', targetId: uuid(1) });
    expect(
      intentOf({ callback_query: { id: 'q', data: `${CLIENT_APP_CALLBACK_PREFIX}1 OR 1=1` } })
        .intent,
    ).toBe('UNSUPPORTED');
    expect(intentOf({ callback_query: { id: 'q', data: 'to:AMIGA' } }).intent).toBe('UNSUPPORTED');
  });

  it('draws the platforms two to a row, and a platform’s apps in the order given', () => {
    const choice = tutorialChoice(CLIENT_APP_PLATFORMS as unknown as ClientAppPlatform[]);
    expect(callbacks(choice)).toEqual([
      'to:ANDROID',
      'to:IOS',
      'to:WINDOWS',
      'to:MACOS',
      'to:LINUX',
      'to:OTHER',
      'mm:',
    ]);
    const list = clientAppPlatformScreen('ANDROID', [
      { id: uuid(2), label: 'B' },
      { id: uuid(1), label: 'A' },
    ]);
    expect(list.key).toBe('bot.apps.platform');
    expect(callbacks(list)).toEqual([`ca:${uuid(2)}`, `ca:${uuid(1)}`, 'tu:', 'mm:']);
    expect(clientAppPlatformScreen('OTHER', []).key).toBe('bot.apps.platform_empty');
  });

  it('draws an app: its links as URL buttons, then the existing service actions', () => {
    const detail = {
      id: uuid(1),
      platform: 'IOS' as const,
      title: '🟢 App',
      description: 'd',
      guide: '• g',
      officialUrl: 'https://downloads.example.com/a',
      alternativeUrl: 'https://store.example.com/a',
      helpUrl: 'https://video.example.com/a',
      filesNote: true,
      service: { id: uuid(900), link: true, files: true },
      manyServices: false,
    };
    const screen = clientAppScreen(detail);
    expect(screen.key).toBe('bot.apps.detail_files');
    expect(screen.values).toEqual({ app: '🟢 App', description: 'd', guide: '• g' });
    expect(callbacks(screen)).toEqual([
      'https://downloads.example.com/a',
      'https://store.example.com/a',
      'https://video.example.com/a',
      `r:${uuid(900)}`,
      `sf:${uuid(900)}`,
      'to:IOS',
      'mm:',
    ]);
    const several = clientAppScreen({
      ...detail,
      alternativeUrl: null,
      helpUrl: null,
      filesNote: false,
      service: null,
      manyServices: true,
    });
    expect(several.key).toBe('bot.apps.detail');
    expect(callbacks(several)).toEqual([
      'https://downloads.example.com/a',
      'sl:1',
      'to:IOS',
      'mm:',
    ]);
    expect(clientAppScreen(null).key).toBe('bot.apps.not_found');
  });
});

describe('what is read about the customer’s services', () => {
  const PANEL = '0191f4a0-2d3c-7c2b-9a41-00000000aaaa';

  function service(n: number, state: ServiceRecord['state'], panelId = PANEL): ServiceRecord {
    return {
      id: uuid(1000 + n),
      panelId,
      state,
      subscriptionUrl: 'https://sub.example.com/s/secret',
    } as unknown as ServiceRecord;
  }

  /** A customer's services, newest first, served a page at a time as the repository does. */
  function source(all: readonly ServiceRecord[], offers: string[] = []) {
    const pagesRead: number[] = [];
    const facts = new ProvisionedServiceFacts({
      services: {
        listForCustomer: (_scope, _customer, limit = 25, cursor = null) => {
          const start = cursor === null ? 0 : Number(cursor as unknown as string);
          pagesRead.push(start);
          const items = all.slice(start, start + limit);
          const next = start + limit < all.length ? String(start + limit) : null;
          return Promise.resolve({ items, nextCursor: next as never });
        },
      },
      panels: {
        findMany: (_scope, ids) =>
          Promise.resolve(
            ids.map(
              (id) =>
                ({
                  panel: {
                    id,
                    providerType: 'marzban',
                    activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['a'] } },
                  },
                }) as never,
            ),
          ),
      },
      subscriptionFiles: {
        offered: (_scope, one) => {
          offers.push(`${String(one.panelId)}|${one.state}`);
          return Promise.resolve(one.state === 'ACTIVE');
        },
      },
    });
    return { facts, pagesRead, offers };
  }

  it('finds an older ACTIVE service behind newer TERMINATED ones (C1)', async () => {
    const all = [
      ...Array.from({ length: 25 }, (_, n) => service(n, 'TERMINATED')),
      service(99, 'ACTIVE'),
    ];
    const read = await source(all).facts.factsFor(TENANT, CUSTOMER);
    expect(read.map((fact) => fact.serviceId)).toEqual([uuid(1099)]);
    expect(read[0]).toMatchObject({ linkDeliverable: true, filesOffered: true });
  });

  it('pages through the cursor, and stops at the live limit or the page bound', async () => {
    const behindAPage = [
      ...Array.from({ length: SERVICE_FACTS_PAGE_SIZE + 10 }, (_, n) => service(n, 'TERMINATED')),
      service(500, 'SUSPENDED'),
    ];
    const one = source(behindAPage);
    expect((await one.facts.factsFor(TENANT, CUSTOMER)).map((f) => f.serviceId)).toEqual([
      uuid(1500),
    ]);
    expect(one.pagesRead).toEqual([0, SERVICE_FACTS_PAGE_SIZE]);

    const manyLive = Array.from({ length: 70 }, (_, n) => service(n, 'ACTIVE'));
    const two = source(manyLive);
    expect(await two.facts.factsFor(TENANT, CUSTOMER)).toHaveLength(SERVICE_FACTS_LIMIT);
    expect(two.pagesRead).toEqual([0]);

    const tooDeep = [
      ...Array.from({ length: SERVICE_FACTS_PAGE_SIZE * SERVICE_FACTS_MAX_PAGES }, (_, n) =>
        service(n, 'TERMINATED'),
      ),
      service(900, 'ACTIVE'),
    ];
    const three = source(tooDeep);
    expect(await three.facts.factsFor(TENANT, CUSTOMER)).toEqual([]);
    expect(three.pagesRead).toHaveLength(SERVICE_FACTS_MAX_PAGES);
  });

  it('asks Package E once per (panel, state), not once per service (C4)', async () => {
    const OTHER_PANEL = '0191f4a0-2d3c-7c2b-9a41-00000000bbbb';
    const offers: string[] = [];
    const all = [
      ...Array.from({ length: 5 }, (_, n) => service(n, 'ACTIVE')),
      service(10, 'SUSPENDED'),
      service(11, 'SUSPENDED'),
      service(12, 'ACTIVE', OTHER_PANEL),
    ];
    const read = await source(all, offers).facts.factsFor(TENANT, CUSTOMER);
    expect(read).toHaveLength(8);
    expect(offers.sort()).toEqual(
      [`${PANEL}|ACTIVE`, `${PANEL}|SUSPENDED`, `${OTHER_PANEL}|ACTIVE`].sort(),
    );
    // Each service still gets its own (shared) answer.
    expect(read.filter((fact) => fact.filesOffered)).toHaveLength(6);
  });
});

describe('who may manage the apps', () => {
  it('is its own pair, edit at the blast radius of every customer’s download link', () => {
    expect(permissionDefinition('client_apps.view').riskLevel).toBe('LOW');
    expect(permissionDefinition('client_apps.edit').riskLevel).toBe('HIGH');
    const holders = (key: string) =>
      ROLE_SEEDS.filter((role) => (role.permissions as readonly string[]).includes(key))
        .map((role) => role.key)
        .sort();
    expect(holders('client_apps.edit')).toEqual(['operator', 'owner']);
    expect(holders('client_apps.view')).toEqual(['observer', 'operator', 'owner', 'support']);
  });
});
