import { describe, expect, it } from 'vitest';
import {
  addressAllowed,
  checkUrl,
  refusalMessage,
  URL_POLICY_REFUSALS,
  type UrlPolicyRefusal,
} from '../../apps/api/src/infrastructure/net/url-policy';
import { infrastructureHosts } from '../../apps/api/src/infrastructure/net/infrastructure-hosts';

/**
 * The SSRF policy, as a table.
 *
 * Panel URLs are typed by an operator and cause server-side requests, so this
 * file is the list of destinations this installation will and will not call.
 * The interesting half is what is ALLOWED: a self-hosted panel on an RFC1918
 * address is the normal Nexa deployment, so the usual "block all private IPs"
 * advice would break the product. Private space is permitted deliberately, and
 * these tests exist so that permitting it stays a decision rather than drifting
 * into permitting everything.
 */
const PROD = { allowLoopback: false };
const TEST = { allowLoopback: true };

const refuse = (raw: string, options = PROD): UrlPolicyRefusal | 'ALLOWED' => {
  const verdict = checkUrl(raw, options);
  return verdict.allowed ? 'ALLOWED' : verdict.refusal;
};

describe('the URL policy — schemes and shape', () => {
  it('allows http and https and nothing else', () => {
    expect(refuse('https://panel.example.com')).toBe('ALLOWED');
    // Plain http to a NAME is allowed only where the name is not public; a
    // bare public-looking name is refused by the plaintext rule, not here.
    expect(refuse('http://192.168.1.10:2053')).toBe('ALLOWED');
    for (const scheme of [
      'file:///etc/passwd',
      'gopher://host/_x',
      'ftp://host/x',
      'data:text/plain,hello',
      'ws://host/x',
      'jar:http://host!/x',
    ]) {
      expect(refuse(scheme), scheme).toBe('SCHEME_NOT_ALLOWED');
    }
  });

  it('refuses a URL that carries credentials, however they are spelled', () => {
    // `new URL` parses these into their own fields, so a check that searched
    // the raw string for `@` would miss the percent-encoded forms.
    expect(refuse('https://admin:hunter2@panel.example.com')).toBe('CREDENTIALS_IN_URL');
    expect(refuse('https://admin@panel.example.com')).toBe('CREDENTIALS_IN_URL');
    expect(refuse('https://a%40b:p%40ss@panel.example.com')).toBe('CREDENTIALS_IN_URL');
  });

  it('refuses what is not a URL at all', () => {
    for (const raw of ['', 'panel.example.com', 'not a url', '://x', 'https://']) {
      expect(['MALFORMED', 'HOST_MISSING']).toContain(refuse(raw));
    }
  });
});

describe('the URL policy — addresses', () => {
  it('ALLOWS private space, because a self-hosted panel is the product', () => {
    for (const host of [
      'http://10.0.0.5:8080',
      'http://172.16.4.1',
      'http://172.31.255.254',
      'http://192.168.0.1:54321',
      'http://100.64.0.1', // CGNAT, which many VPS providers hand out
      'https://[fd00::1]',
    ]) {
      expect(refuse(host), host).toBe('ALLOWED');
    }
  });

  it('refuses every cloud metadata endpoint', () => {
    // The highest-value SSRF target there is: reaching it returns credentials
    // for the hosting account, not for one panel.
    for (const host of [
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.170.2/v2/credentials',
      'https://169.254.169.254',
      'http://[fe80::1]',
      'http://[fe80::a9fe:a9fe]',
    ]) {
      expect(refuse(host), host).toBe('ADDRESS_NOT_ALLOWED');
    }
  });

  it('refuses loopback unless the caller explicitly permits it', () => {
    // The whole 127/8 block, not just 127.0.0.1 — `127.0.0.2` and `127.1`
    // reach the same interface, and `0.0.0.0` is a third spelling of it.
    for (const host of [
      'http://127.0.0.1:3000',
      'http://127.0.0.2',
      'http://127.1',
      'http://0.0.0.0',
      'http://[::1]',
      'http://[::]',
    ]) {
      expect(refuse(host), host).toBe('ADDRESS_NOT_ALLOWED');
    }
    // And permitted where a test says so, which is the only place it is.
    expect(refuse('http://127.0.0.1:3000', TEST)).toBe('ALLOWED');
    expect(refuse('http://[::1]:3000', TEST)).toBe('ALLOWED');
  });

  it('refuses an IPv4 address wearing an IPv6 costume', () => {
    // ::ffff:0:0/96 is how a forbidden IPv4 address is spelled as an IPv6 one.
    // Judged as the IPv4 address it is, in both the dotted and hex forms.
    expect(refuse('http://[::ffff:169.254.169.254]')).toBe('ADDRESS_NOT_ALLOWED');
    expect(refuse('http://[::ffff:a9fe:a9fe]')).toBe('ADDRESS_NOT_ALLOWED');
    expect(refuse('http://[::ffff:127.0.0.1]')).toBe('ADDRESS_NOT_ALLOWED');
    // And still allowed when the address inside is one we allow.
    expect(refuse('http://[::ffff:192.168.1.1]')).toBe('ALLOWED');
  });

  it('refuses multicast and reserved space', () => {
    expect(refuse('http://224.0.0.1')).toBe('ADDRESS_NOT_ALLOWED');
    expect(refuse('http://255.255.255.255')).toBe('ADDRESS_NOT_ALLOWED');
    expect(refuse('http://[ff02::1]')).toBe('ADDRESS_NOT_ALLOWED');
  });

  it('sees through every non-canonical spelling of an address', () => {
    // The WHATWG parser canonicalises the integer, octal and hex forms of an
    // IPv4 address to a dotted quad before this policy ever sees them, so
    // `http://2130706433/` arrives as 127.0.0.1 and is refused by the literal
    // check. Asserted rather than assumed: the alternative — that these arrive
    // as opaque hostnames and are only caught after resolution — was what this
    // test first claimed, and it is worth knowing which of the two is true.
    for (const raw of [
      'http://2130706433',
      'http://0177.0.0.1',
      'http://0x7f.0.0.1',
      'http://127.1',
    ]) {
      expect(refuse(raw), raw).toBe('ADDRESS_NOT_ALLOWED');
    }
    expect(addressAllowed('127.0.0.1', PROD).allowed).toBe(false);
    // A NAME is still only judged after resolution — the policy cannot know
    // where `panel.example.com` points. That is the client's job, and the
    // division of labour is deliberate.
    expect(refuse('https://panel.example.com')).toBe('ALLOWED');
  });
});

describe('the URL policy — plaintext', () => {
  it('refuses http to a public address and allows it to a private one', () => {
    // The rule that keeps a panel password off the open internet without
    // breaking the LAN deployment it is normally used in.
    expect(refuse('http://203.0.113.10')).toBe('PLAINTEXT_TO_PUBLIC_HOST');
    expect(refuse('http://panel.example.com')).toBe('PLAINTEXT_TO_PUBLIC_HOST');
    expect(refuse('https://panel.example.com')).toBe('ALLOWED');
    expect(refuse('http://10.1.2.3')).toBe('ALLOWED');
  });

  it('allows any port, because panels legitimately use odd ones', () => {
    for (const port of [443, 2053, 8080, 54321, 65535]) {
      expect(refuse(`https://panel.example.com:${port}`), String(port)).toBe('ALLOWED');
    }
  });
});

describe('what a refusal is allowed to say', () => {
  it('has a message for every refusal', () => {
    for (const refusal of URL_POLICY_REFUSALS) {
      expect(refusalMessage(refusal).length).toBeGreaterThan(10);
    }
  });

  it('never names an address, a resolver answer or a rule id', () => {
    // A blocked-target message that named what the host resolved to would turn
    // this endpoint into a port scanner with a friendly error format: submit a
    // URL, read back whether the name resolved and where to.
    for (const refusal of URL_POLICY_REFUSALS) {
      const message = refusalMessage(refusal);
      expect(message).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
      expect(message).not.toMatch(/169\.254|127\.0\.0|RFC1918|fe80/i);
    }
  });
});

/**
 * Nexa's own data network.
 *
 * The SSRF policy allows RFC1918 deliberately, because a self-hosted panel on a
 * private network is the ordinary case. That decision also handed an operator
 * with `panels.edit` a route to the API container's own bridge, where
 * PostgreSQL and Redis live: bodies never come back, but unreachable, refused
 * and timed out are three distinguishable answers, which is a port scanner.
 *
 * These prove the carve-out refuses this installation's network WITHOUT
 * refusing private space generally — the two halves are the whole point, so
 * both are asserted every time.
 */
describe('the URL policy — this installation’s own network', () => {
  const DATA_SUBNET = '172.29.1.0/24';
  const guarded = {
    allowLoopback: false,
    deniedSubnets: [DATA_SUBNET],
    deniedHosts: ['postgres', 'redis'],
  };

  it('refuses a literal address inside the data subnet', () => {
    for (const host of ['172.29.1.1', '172.29.1.5', '172.29.1.254']) {
      const verdict = checkUrl(`https://${host}:5432`, guarded);
      expect(verdict.allowed, `${host} was allowed`).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.refusal).toBe('INFRASTRUCTURE_TARGET');
    }
  });

  it('still allows a legitimate private panel outside that subnet', () => {
    // The control, and the one that matters most: a policy that refused all of
    // RFC1918 would pass every test above and break the product.
    for (const host of ['10.20.30.40', '192.168.1.10', '172.29.0.5', '172.30.1.5', '172.16.4.4']) {
      expect(checkUrl(`https://${host}:2053`, guarded).allowed, `${host} was refused`).toBe(true);
    }
  });

  it('refuses the infrastructure hostnames by name', () => {
    for (const host of ['postgres', 'redis', 'POSTGRES', 'redis.']) {
      const verdict = checkUrl(`https://${host}:5432`, guarded);
      expect(verdict.allowed, `${host} was allowed`).toBe(false);
      if (verdict.allowed) return;
      expect(verdict.refusal).toBe('INFRASTRUCTURE_TARGET');
    }
  });

  it('refuses a data-subnet address however it is spelled', () => {
    // The same canonicalisation the rest of the policy relies on, applied to
    // the carve-out: a decimal or IPv4-mapped spelling must not walk past it.
    for (const host of ['2887581957', '::ffff:172.29.1.5', '0254.035.1.5']) {
      const url = host.includes(':') ? `https://[${host}]:5432` : `https://${host}:5432`;
      expect(checkUrl(url, guarded).allowed, `${host} was allowed`).toBe(false);
    }
  });

  it('judges addresses the same way at resolution time', () => {
    // `checkUrl` sees the URL; `addressAllowed` sees what a NAME resolved to,
    // and it is the one the client and the DNS pin both call. A hostname that
    // resolves into the subnet is refused there, so the textual host list is
    // never the only defence.
    expect(addressAllowed('172.29.1.5', guarded).allowed).toBe(false);
    expect(addressAllowed('10.20.30.40', guarded).allowed).toBe(true);
  });

  it('matches a prefix that is not a whole number of bytes', () => {
    const narrow = { allowLoopback: false, deniedSubnets: ['172.29.0.0/23'] };
    expect(addressAllowed('172.29.0.9', narrow).allowed).toBe(false);
    expect(addressAllowed('172.29.1.9', narrow).allowed).toBe(false);
    expect(addressAllowed('172.29.2.9', narrow).allowed).toBe(true);
  });

  it('refuses an IPv6 data network when one is configured', () => {
    const v6 = { allowLoopback: false, deniedSubnets: ['fd00:dead:beef::/48'] };
    expect(addressAllowed('fd00:dead:beef::5', v6).allowed).toBe(false);
    expect(addressAllowed('fd00:dead:beee::5', v6).allowed).toBe(true);
  });

  it('changes nothing when no network is configured', () => {
    // An installation that never sets the key keeps the previous behaviour
    // exactly, so this cannot break an existing deployment by existing.
    const open = { allowLoopback: false };
    expect(addressAllowed('172.29.1.5', open).allowed).toBe(true);
    expect(checkUrl('https://postgres:5432', open).allowed).toBe(true);
  });

  it('names nothing internal in the refusal it shows an operator', () => {
    const message = refusalMessage('INFRASTRUCTURE_TARGET');
    for (const leak of ['172.29', 'postgres', 'redis', 'subnet', '5432', '6379']) {
      expect(message.toLowerCase(), `the message leaks ${leak}`).not.toContain(leak);
    }
  });

  it('leaves the metadata and link-local refusals exactly as they were', () => {
    // The carve-out must not become the only address rule. These are refused
    // whether or not a data subnet is configured.
    for (const options of [guarded, { allowLoopback: false }]) {
      expect(checkUrl('http://169.254.169.254/latest/meta-data/', options).allowed).toBe(false);
      expect(addressAllowed('169.254.169.254', options).allowed).toBe(false);
      expect(addressAllowed('224.0.0.1', options).allowed).toBe(false);
    }
  });
});

describe('the hostnames derived from this installation’s own connection strings', () => {
  it('takes the host of each service it is given', () => {
    expect(
      infrastructureHosts([
        'postgres://nexa:secret@db.internal:5432/nexa',
        'redis://cache.internal:6379',
      ]),
    ).toEqual(['db.internal', 'cache.internal']);
  });

  it('unwraps an IPv6 literal, which the policy compares unbracketed', () => {
    expect(infrastructureHosts(['redis://[fd00::2]:6379'])).toEqual(['fd00::2']);
  });

  it('contributes nothing for a string that is not a URL', () => {
    // A bad connection string must not stop the process booting from HERE. The
    // connection attempt reports it far more usefully.
    expect(infrastructureHosts(['not a url', ''])).toEqual([]);
  });

  it('refuses both derived hosts and nothing else', () => {
    // The end of the derivation: what comes out of the connection strings is
    // what the policy refuses by name. Both sources are covered, and a host
    // that is neither stays reachable.
    const options = {
      allowLoopback: false,
      deniedHosts: infrastructureHosts([
        'postgres://nexa:secret@db.internal:5432/nexa',
        'redis://cache.internal:6379',
      ]),
    };
    expect(checkUrl('https://db.internal:5432', options)).toMatchObject({
      allowed: false,
      refusal: 'INFRASTRUCTURE_TARGET',
    });
    expect(checkUrl('https://cache.internal:6379', options)).toMatchObject({
      allowed: false,
      refusal: 'INFRASTRUCTURE_TARGET',
    });
    expect(checkUrl('https://panel.example.com:2053', options).allowed).toBe(true);
  });
});
