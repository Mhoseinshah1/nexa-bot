import { createHash } from 'node:crypto';

/**
 * PR-4 «اعلان ورود جدید»: what "a new device or browser" means — the user agent's FAMILY (the
 * browser and the operating system, never the version or the full string) plus the client's
 * network (/24 for IPv4, /48 for IPv6). Neither a version bump nor a new address inside the
 * same network is a new device; a different browser, system or network is. A raw address is
 * never part of what is stored: the network is.
 */

const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/\bEdg(e|A|iOS)?\//u, 'Edge'],
  [/\b(OPR|Opera)\//u, 'Opera'],
  [/\bSamsungBrowser\//u, 'Samsung Internet'],
  [/\bYaBrowser\//u, 'Yandex'],
  [/\b(Firefox|FxiOS)\//u, 'Firefox'],
  [/\b(Chrome|CriOS|Chromium)\//u, 'Chrome'],
  [/\bSafari\//u, 'Safari'],
];

const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/\bAndroid\b/u, 'Android'],
  [/\b(iPhone|iPad|iPod)\b/u, 'iOS'],
  [/\bWindows\b/u, 'Windows'],
  [/\b(Macintosh|Mac OS X)\b/u, 'macOS'],
  [/\bCrOS\b/u, 'ChromeOS'],
  [/\bLinux\b/u, 'Linux'],
];

/** «Chrome on Android»; «Unknown» parts when the string says nothing recognisable. */
export function deviceLabelOf(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Browser';
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Unknown';
  return `${browser} on ${system}`;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u;
const IPV6 = /^[0-9a-f:]+$/iu;

function isIP(address: string): 0 | 4 | 6 {
  if (IPV4.test(address)) return 4;
  if (address.includes(':') && IPV6.test(address) && (address.match(/::/gu) ?? []).length <= 1) {
    return 6;
  }
  return 0;
}

/** `203.0.113.x` or `2001:db8:1::/48`; null for no or an unparseable address. */
export function networkOf(ip: string | null): string | null {
  if (ip === null) return null;
  const address = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.');
    return `${a}.${b}.${c}.x`;
  }
  if (family === 6) {
    const groups = expandIpv6(address).slice(0, 3);
    return `${groups.map((group) => group.replace(/^0+(?=.)/u, '')).join(':')}::/48`;
  }
  return null;
}

function expandIpv6(address: string): string[] {
  const [head = '', tail = ''] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const missing = address.includes('::') ? 8 - left.length - right.length : 0;
  return [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map((group) =>
    group.toLowerCase().padStart(4, '0'),
  );
}

/** The stored fingerprint: a hash of the two, so the row reads as neither. */
export function deviceFingerprint(label: string, network: string | null): string {
  return createHash('sha256')
    .update(`nexa.reseller_web_device.v1\n${label}\n${network ?? '-'}`, 'utf8')
    .digest('hex');
}
