import { isIP } from 'node:net';
import type { AppConfig } from './config.schema.js';

/**
 * FIX-04 (S2): what a NON-production process may expose, and when it should say so.
 *
 * `NODE_ENV=development` is a set of affordances, each harmless on a laptop and each a hole
 * on a public domain: the session cookie loses `Secure` and its `__Host-` prefix, an empty
 * `WEB_ADMIN_ORIGINS` switches the CSRF Origin check off, `PASSWORD_HASH_PROFILE=fast` and
 * loopback panels are allowed — and, until this module, the unauthenticated
 * `POST /api/admin/v1/system/ping` was registered on `NODE_ENV` alone, a write into
 * append-only tables open to anyone who could reach `/api/*`.
 *
 * The production image and `deploy/compose.yml` both pin `NODE_ENV=production`, so this is
 * about a host somebody set up by hand. Two answers:
 *
 *   - the system endpoint needs an explicit opt-in (`DEV_SYSTEM_ENDPOINT_ENABLED=true`) AND a
 *     development or test `NODE_ENV`; the config schema refuses the flag in production and
 *     on a configuration that names a public admin origin or a reverse proxy;
 *   - a development process whose configuration LOOKS public is not refused — a staging
 *     host on development settings is a thing owners have run — but it says so, loudly, at
 *     every start (`developmentExposureWarnings`).
 */

/** Hostnames that are never a public deployment: loopback, and the reserved test TLDs. */
const PRIVATE_SUFFIXES = ['.localhost', '.test', '.example', '.invalid', '.local', '.internal'];

function isPrivateAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (family === 6) {
    const lower = host.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd');
  }
  return false;
}

/**
 * Whether an admin origin names a host the internet can reach. Anything that does not parse
 * counts as public: the question is "might this be exposed", and an unreadable answer is
 * not a no.
 */
export function isPublicLookingOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return true;
  }
  if (host === 'localhost' || host === '') return false;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1))) {
    return false;
  }
  if (isIP(host) !== 0) return !isPrivateAddress(host);
  // A bare single-label name (`nexa`, `api`) is a container or LAN name, not a domain.
  return host.includes('.');
}

type ExposureConfig = Pick<
  AppConfig,
  'NODE_ENV' | 'WEB_ADMIN_ORIGINS' | 'DEPLOYMENT_TOPOLOGY' | 'TELEGRAM_WEBHOOK_ENABLED'
>;

/** The evidence that a configuration is reachable from outside the machine it runs on. */
export function publicExposureSignals(
  config: ExposureConfig,
  options: { readonly webhook: boolean } = { webhook: true },
): string[] {
  const signals: string[] = [];
  const publicOrigins = config.WEB_ADMIN_ORIGINS.filter(isPublicLookingOrigin);
  if (publicOrigins.length > 0) {
    signals.push(`WEB_ADMIN_ORIGINS names a public host (${publicOrigins.join(', ')})`);
  }
  if (config.DEPLOYMENT_TOPOLOGY === 'reverse-proxy') {
    signals.push('DEPLOYMENT_TOPOLOGY=reverse-proxy (a proxy publishes this process)');
  }
  if (options.webhook && config.TELEGRAM_WEBHOOK_ENABLED) {
    signals.push('TELEGRAM_WEBHOOK_ENABLED=true (Telegram must reach this process)');
  }
  return signals;
}

/**
 * Warnings for a process running outside production on what looks like a public
 * deployment. Empty in production and on a configuration with no public signal.
 */
export function developmentExposureWarnings(
  config: ExposureConfig & Pick<AppConfig, 'DEV_SYSTEM_ENDPOINT_ENABLED'>,
): string[] {
  if (config.NODE_ENV === 'production') return [];
  const signals = publicExposureSignals(config);
  if (signals.length === 0) return [];
  return [
    `NODE_ENV=${config.NODE_ENV} on a configuration that looks public: ${signals.join('; ')}. ` +
      'Outside production the admin session cookie is issued without Secure and without the ' +
      '__Host- prefix, and an empty WEB_ADMIN_ORIGINS disables the CSRF Origin check. ' +
      'Set NODE_ENV=production for any host reachable from the internet (deploy/compose.yml ' +
      'pins it for every role; see docs/deployment.md).',
  ];
}

/**
 * Whether the unauthenticated development system endpoint is registered. Both conditions,
 * never one: a flag left in a production env file registers nothing (and the schema refuses
 * it outright), and a development `NODE_ENV` alone no longer opens a write path.
 */
export function systemEndpointEnabled(
  config: Pick<AppConfig, 'NODE_ENV' | 'DEV_SYSTEM_ENDPOINT_ENABLED'>,
): boolean {
  return (
    config.DEV_SYSTEM_ENDPOINT_ENABLED &&
    (config.NODE_ENV === 'development' || config.NODE_ENV === 'test')
  );
}
