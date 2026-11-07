import { HOSTING_ACTIVATION_ERROR_CODES } from '@nexa/contracts';

/**
 * Phase 6A PR-4 — the domain a hosted owner points at this server.
 *
 * Pure rules, no network: how a name is normalised, which names are refused outright, and
 * how a DNS answer is judged. The resolver and the HTTPS probe are ports (`activation-ports`).
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * A Host header (or any host string) as a bare lowercase name, or null when it is not one a
 * hosted domain could be: a port is dropped, one trailing dot is dropped, an IP literal, an
 * empty string, or anything outside letters, digits, hyphen and dot is refused.
 */
export function normaliseHost(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > 270) return null;
  // `[::1]:3000` and `1.2.3.4` are addresses, never a hosted domain.
  if (host.startsWith('[')) return null;
  const colon = host.lastIndexOf(':');
  if (colon !== -1) {
    if (!/^\d{1,5}$/.test(host.slice(colon + 1))) return null;
    host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length < 4 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  // An address is never a hosted domain: a numeric top-level label is how an IPv4 address (in
  // any spelling) looks, and a colon never survives above.
  if (/^\d+$/.test(labels[labels.length - 1] as string)) return null;
  return host;
}

export type DomainParse =
  | { readonly ok: true; readonly domain: string }
  | {
      readonly ok: false;
      readonly code:
        | typeof HOSTING_ACTIVATION_ERROR_CODES.DOMAIN_INVALID
        | typeof HOSTING_ACTIVATION_ERROR_CODES.DOMAIN_RESERVED;
    };

/** Names that can never be a hosted domain: they would shadow this server's own pages. */
const REFUSED_SUFFIXES = ['.local', '.localhost', '.internal', '.invalid', '.test', '.example'];

/**
 * What the creator typed as a domain: a bare name (an `https://` prefix and a path are NOT
 * accepted, so what is stored is exactly what is verified), not one of the server's own names
 * (`reserved`, already normalised), and not a name that could never be public.
 */
export function parseHostedDomain(raw: string, reserved: ReadonlySet<string>): DomainParse {
  const invalid = { ok: false, code: HOSTING_ACTIVATION_ERROR_CODES.DOMAIN_INVALID } as const;
  if (/[/?#@\s]/.test(raw)) return invalid;
  const domain = normaliseHost(raw);
  if (domain === null || raw.includes(':')) return invalid;
  // The server's own names first: they are refused as RESERVED whatever their top-level label.
  if (reserved.has(domain)) {
    return { ok: false, code: HOSTING_ACTIVATION_ERROR_CODES.DOMAIN_RESERVED };
  }
  if (domain === 'localhost' || REFUSED_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
    return invalid;
  }
  return { ok: true, domain };
}

/** What the resolver saw for the domain, and for the target it should lead to. */
export interface DnsObservation {
  /** CNAME targets of the domain itself (one hop), lowercase, no trailing dot. */
  readonly cname: readonly string[];
  /** The domain's A/AAAA answers (a CNAME chain followed). */
  readonly addresses: readonly string[];
}

export interface DnsExpectation {
  /** The hostname the owner points CNAMEs at, or null. */
  readonly hostname: string | null;
  /** The target hostname's own addresses, plus the configured server addresses. */
  readonly addresses: readonly string[];
}

export type DnsVerdict = 'POINTED' | 'NOT_POINTED';

/**
 * The domain points at this server when its CNAME names the owner's hostname, or when it
 * resolves to addresses and EVERY one of them is one of ours. "Every": a name that also
 * answers somebody else's address is not wholly ours, and a certificate is only safe to
 * issue for a name that is.
 */
export function judgeDns(observed: DnsObservation, expected: DnsExpectation): DnsVerdict {
  if (expected.hostname !== null && observed.cname.includes(expected.hostname)) return 'POINTED';
  if (observed.addresses.length === 0 || expected.addresses.length === 0) return 'NOT_POINTED';
  const ours = new Set(expected.addresses.map((address) => address.toLowerCase()));
  return observed.addresses.every((address) => ours.has(address.toLowerCase()))
    ? 'POINTED'
    : 'NOT_POINTED';
}
