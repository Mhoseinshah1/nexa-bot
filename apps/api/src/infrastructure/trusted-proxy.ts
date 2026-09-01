import { isIP } from 'node:net';

/**
 * Client IP handling behind a reverse proxy.
 *
 * The deployment topology is one self-hosted box with Caddy in front, so the
 * socket address Fastify sees is Caddy's, and the real client is in
 * `X-Forwarded-For`. That header is attacker-controlled unless something
 * decides whose copy of it to believe.
 *
 * Two failure modes, both real, in opposite directions:
 *
 *   - **Trust everyone** (`trustProxy: true`). Anyone who reaches the port
 *     directly sets their own `X-Forwarded-For`. The client IP is then whatever
 *     they say, which defeats per-IP login throttling entirely and writes an
 *     address of the attacker's choosing into the audit log.
 *   - **Trust nobody, while actually behind a proxy.** Every request appears to
 *     come from Caddy. Per-IP throttling then counts all administrators as one
 *     subject and locks out the whole installation on somebody else's failed
 *     logins.
 *
 * The first is a security hole and is prevented by configuration — the config
 * schema takes a LIST of upstreams, never a boolean. The second is a
 * misconfiguration that no list can prevent, so it is detected at the point of
 * use: `ipThrottleSubject` returns null when the client IP is itself a trusted
 * proxy, and the login path skips per-IP throttling rather than throttling
 * everybody as one.
 */

/**
 * The value for Fastify's `trustProxy`.
 *
 * A list, or `false`. Never `true`: Fastify would then believe the header from
 * whoever connected.
 */
export function trustProxyOption(trustedProxyIps: readonly string[]): string[] | false {
  return trustedProxyIps.length === 0 ? false : [...trustedProxyIps];
}

/**
 * The subject to throttle a login attempt by IP against, or null to skip.
 *
 * Null means the address is unusable as a subject — absent, unparseable, or the
 * proxy's own. Throttling on any of those punishes every administrator for one
 * attacker, so per-IP throttling is dropped for that attempt and the per-USERNAME
 * throttle carries the load alone. The username throttle is the one that
 * actually protects an account; the IP throttle limits breadth.
 */
export function ipThrottleSubject(
  clientIp: string | null | undefined,
  trustedProxyIps: readonly string[],
): string | null {
  if (typeof clientIp !== 'string' || clientIp.length === 0) return null;
  if (isIP(clientIp) === 0) return null;

  // The client IP resolving to a configured upstream means the forwarded header
  // was absent or not believed — so this address identifies our own proxy, not
  // a client. Counting failures against it would lock out the installation.
  if (trustedProxyIps.some((entry) => matchesTrustedEntry(clientIp, entry))) return null;

  return clientIp;
}

/**
 * Whether an address matches a trusted-proxy entry.
 *
 * Exact match, or a CIDR whose prefix length is checked bit by bit. Deliberately
 * not a string-prefix comparison: `10.1.1.1` starts with `10.1.1` and so does
 * `10.1.1.10`, and a substring test would also make `192.168.1.1` match
 * `192.168.1.10/32`.
 */
export function matchesTrustedEntry(address: string, entry: string): boolean {
  if (!entry.includes('/')) return address === entry;

  const [network = '', prefixText = ''] = entry.split('/');
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0) return false;

  const addressBytes = toBytes(address);
  const networkBytes = toBytes(network);
  if (addressBytes === null || networkBytes === null) return false;
  if (addressBytes.length !== networkBytes.length) return false;
  if (prefix > addressBytes.length * 8) return false;

  const wholeBytes = prefix >> 3;
  for (let i = 0; i < wholeBytes; i += 1) {
    if (addressBytes[i] !== networkBytes[i]) return false;
  }

  const remainingBits = prefix & 7;
  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((addressBytes[wholeBytes] ?? 0) & mask) === ((networkBytes[wholeBytes] ?? 0) & mask);
}

function toBytes(address: string): number[] | null {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    return parts;
  }
  if (version === 6) return expandIpv6(address);
  return null;
}

/** Expands an IPv6 address, `::` included, to its 16 bytes. */
function expandIpv6(address: string): number[] | null {
  const [head = '', tail, ...rest] = address.split('::');
  if (rest.length > 0) return null;

  const headGroups = head.length === 0 ? [] : head.split(':');
  const tailGroups = tail === undefined || tail.length === 0 ? [] : tail.split(':');

  const missing = 8 - headGroups.length - tailGroups.length;
  if (tail === undefined && missing !== 0) return null;
  if (missing < 0) return null;

  const groups = [
    ...headGroups,
    ...Array.from({ length: tail === undefined ? 0 : missing }, () => '0'),
    ...tailGroups,
  ];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}
