import { isIP } from 'node:net';

/**
 * What this installation is willing to send a request to.
 *
 * Panel base URLs are operator-controlled and cause server-side HTTP requests,
 * which is the definition of an SSRF surface. The usual advice — block every
 * private address — is WRONG for Nexa and would break its main use case: a
 * self-hosted panel on the operator's own VPS, LAN or private network is the
 * normal deployment, not the exception. So private space is deliberately
 * ALLOWED, and this file is about the destinations that remain forbidden and
 * about the ones that are only reachable by lying about where they are.
 *
 * The policy, stated once:
 *
 *   - **Schemes**: `http` and `https`. Nothing else — no `file:`, no `gopher:`,
 *     no `data:`.
 *   - **Credentials in the URL**: refused. `https://user:pass@host/` puts a
 *     secret somewhere it will be logged, and a panel that needs credentials
 *     has fields for them.
 *   - **Plaintext to a public address**: refused. `http://` to an RFC1918 or
 *     loopback address is the LAN case and is allowed; `http://` to a routable
 *     address puts the panel password on the open internet in clear text, and
 *     no legitimate deployment needs that.
 *   - **Link-local, including every cloud metadata service**: refused.
 *     `169.254.0.0/16` and `fe80::/10` are how an SSRF becomes credentials for
 *     the hosting account.
 *   - **Loopback**: refused unless explicitly permitted. The API runs in a
 *     container, so its loopback is itself — reaching it means reaching Nexa's
 *     own unauthenticated internals, not a panel. Tests permit it; production
 *     does not.
 *   - **Unspecified, multicast, broadcast, and IPv4-mapped IPv6**: refused.
 *     None addresses a panel, and the mapped form is a way to spell a
 *     forbidden IPv4 address as an IPv6 one.
 *   - **Ports**: unrestricted. Panels legitimately live on odd ports, and a
 *     port blocklist would block real deployments while stopping nothing —
 *     the address is what decides reachability, not the port.
 *
 * DNS is where this gets interesting, and it is handled in `safe-client.ts`
 * rather than here: a name that passes this check can resolve differently a
 * moment later. This module answers "may I call this address", and the client
 * makes sure the socket goes to an address that was answered YES.
 */

export const URL_POLICY_REFUSALS = [
  'MALFORMED',
  'SCHEME_NOT_ALLOWED',
  'CREDENTIALS_IN_URL',
  'PLAINTEXT_TO_PUBLIC_HOST',
  'HOST_MISSING',
  'ADDRESS_NOT_ALLOWED',
] as const;
export type UrlPolicyRefusal = (typeof URL_POLICY_REFUSALS)[number];

export interface UrlPolicyOptions {
  /**
   * Whether loopback may be contacted.
   *
   * False everywhere except tests, which need to reach a fake server on
   * 127.0.0.1. It is a constructor argument rather than a global so that
   * permitting it in a test cannot leak into the container's client.
   */
  readonly allowLoopback: boolean;
}

export type UrlPolicyVerdict =
  | { readonly allowed: true; readonly url: URL }
  | { readonly allowed: false; readonly refusal: UrlPolicyRefusal };

/** Whether an address may be connected to. Exported because the client re-checks. */
export type AddressVerdict = { readonly allowed: true } | { readonly allowed: false };

function ipv4Octets(address: string): readonly number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

/**
 * Whether an IPv4 address is one this installation will connect to.
 *
 * The forbidden list is short and each entry earns its place. Everything not
 * named here — including all of RFC1918 — is allowed, because a self-hosted
 * panel on a private network is the product.
 */
function ipv4Allowed(address: string, options: UrlPolicyOptions): boolean {
  const octets = ipv4Octets(address);
  if (octets === null) return false;
  const [a = 0, b = 0] = octets;

  // 0.0.0.0/8 — "this network". 0.0.0.0 in particular is a way to say
  // "localhost" that a naive loopback check spelled as `=== '127.0.0.1'`
  // misses entirely.
  if (a === 0) return false;
  // 127.0.0.0/8 — the whole block, not just 127.0.0.1. `127.0.0.2` and
  // `127.1` reach the same interface.
  if (a === 127) return options.allowLoopback;
  // 169.254.0.0/16 — link-local, and with it 169.254.169.254: the metadata
  // service on AWS, GCP, Azure, DigitalOcean and Oracle. An SSRF that reaches
  // it returns credentials for the hosting account, which is a larger blast
  // radius than anything else in this file.
  if (a === 169 && b === 254) return false;
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, which includes the
  // 255.255.255.255 broadcast address.
  if (a >= 224) return false;
  return true;
}

/**
 * The IPv4 address inside an IPv4-mapped IPv6 one, or null.
 *
 * `::ffff:0:0/96` is how a forbidden IPv4 address is spelled as an IPv6 one,
 * and the URL parser canonicalises the readable `::ffff:169.254.169.254` into
 * the hex `::ffff:a9fe:a9fe` — so both spellings have to be understood.
 *
 * Shared by the allow rule and the plaintext rule deliberately. They had their
 * own handling at first and disagreed: `::ffff:192.168.1.1` was correctly
 * recognised as private space by one and treated as a public address by the
 * other, so plain http to a LAN panel was refused for being on the internet.
 * Two functions answering "which address is this really" is one too many.
 */
function unmapIpv4(address: string): string | null {
  const mapped = /^::ffff:(.+)$/.exec(address.toLowerCase());
  if (mapped?.[1] === undefined) return null;
  const inner = mapped[1];
  if (isIP(inner) === 4) return inner;
  const hextets = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner);
  if (hextets?.[1] === undefined || hextets[2] === undefined) return null;
  const high = Number.parseInt(hextets[1], 16);
  const low = Number.parseInt(hextets[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function ipv6Allowed(address: string, options: UrlPolicyOptions): boolean {
  const lower = address.toLowerCase();
  // `::` unspecified and `::1` loopback, in any of their spellings.
  const compact = lower.replace(/(^|:)0+(?=[0-9a-f])/g, '$1');
  if (compact === '::' || compact === '0:0:0:0:0:0:0:0') return false;
  if (compact === '::1' || compact === '0:0:0:0:0:0:0:1') return options.allowLoopback;
  // fe80::/10 link-local, and fec0::/10 site-local (deprecated but routable on
  // some networks).
  if (/^fe[89ab]/.test(compact)) return false;
  // ff00::/8 multicast.
  if (compact.startsWith('ff')) return false;
  // An IPv4 address wearing an IPv6 costume is judged as the IPv4 address it
  // is, or `::ffff:169.254.169.254` walks straight through.
  const inner = unmapIpv4(compact);
  if (inner !== null) return ipv4Allowed(inner, options);
  // fc00::/7 unique-local is the IPv6 equivalent of RFC1918 and is ALLOWED,
  // for the same reason: it is where a self-hosted panel lives.
  return true;
}

/**
 * Whether a resolved address may be connected to.
 *
 * Called twice on every request, deliberately: once on the addresses a name
 * resolves to, and again inside the socket factory on the address actually
 * being dialled. The second call is what makes the first one binding.
 */
export function addressAllowed(address: string, options: UrlPolicyOptions): AddressVerdict {
  const family = isIP(address);
  if (family === 4) return { allowed: ipv4Allowed(address, options) };
  if (family === 6) return { allowed: ipv6Allowed(address, options) };
  return { allowed: false };
}

/**
 * Whether a literal address is public — routable on the open internet.
 *
 * Used for one rule only: plaintext HTTP may go to a private network and may
 * not go across the internet.
 */
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = ipv4Octets(address);
    if (octets === null) return false;
    const [a = 0, b = 0] = octets;
    if (a === 10) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false;
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    // The same unwrapping the allow rule does. Without it a LAN panel written
    // as ::ffff:192.168.1.1 reads as a public host and plain http to it is
    // refused for crossing an internet it never touches.
    const inner = unmapIpv4(lower);
    if (inner !== null) return isPublicAddress(inner);
    if (/^f[cd]/.test(lower)) return false; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return false;
    if (lower === '::1' || lower === '::') return false;
    return true;
  }
  // A NAME, not an address. Treated as public: a hostname that resolves into
  // private space is still a name published somewhere, and the plaintext rule
  // is about what crosses the wire in the common case. The resolved-address
  // check below still applies to it.
  return true;
}

/**
 * Parse and judge an operator-supplied URL.
 *
 * Everything here is a property of the URL as written. `ADDRESS_NOT_ALLOWED`
 * is reachable at this stage only when the host is a literal IP; a hostname is
 * judged after resolution.
 */
export function checkUrl(raw: string, options: UrlPolicyOptions): UrlPolicyVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { allowed: false, refusal: 'MALFORMED' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, refusal: 'SCHEME_NOT_ALLOWED' };
  }
  // `new URL` parses these into their own fields, so a check that looked for
  // `@` in the string would miss the encoded forms.
  if (url.username !== '' || url.password !== '') {
    return { allowed: false, refusal: 'CREDENTIALS_IN_URL' };
  }
  if (url.hostname === '') return { allowed: false, refusal: 'HOST_MISSING' };

  // A bracketed IPv6 literal arrives as `[::1]`; strip the brackets before
  // asking whether it is an address, or every IPv6 host reads as a name and
  // skips the address rules entirely.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;

  if (isIP(host) !== 0 && !addressAllowed(host, options).allowed) {
    return { allowed: false, refusal: 'ADDRESS_NOT_ALLOWED' };
  }
  if (url.protocol === 'http:' && isPublicAddress(host)) {
    return { allowed: false, refusal: 'PLAINTEXT_TO_PUBLIC_HOST' };
  }

  return { allowed: true, url };
}

/**
 * The operator-facing reason, with no detail an attacker could mine.
 *
 * Deliberately says what is wrong with the URL and never what the host
 * resolved to. A blocked-target message naming the resolved address turns this
 * endpoint into a port scanner with a friendly error format: submit a URL, read
 * back whether the name resolved and where to.
 */
export function refusalMessage(refusal: UrlPolicyRefusal): string {
  switch (refusal) {
    case 'MALFORMED':
      return 'The panel address is not a valid URL. It must include a scheme, for example https://panel.example.com.';
    case 'SCHEME_NOT_ALLOWED':
      return 'The panel address must use http or https.';
    case 'CREDENTIALS_IN_URL':
      return 'The panel address must not embed a username or password. Set the credentials on the panel instead.';
    case 'PLAINTEXT_TO_PUBLIC_HOST':
      return 'A panel reachable over the public internet must use https, because http would send its credentials in clear text. Plain http is permitted only to a private or loopback address.';
    case 'HOST_MISSING':
      return 'The panel address has no host.';
    case 'ADDRESS_NOT_ALLOWED':
      return 'The panel address points somewhere this installation will not call.';
  }
}
