import {
  opsLogButtonPath,
  type OpsLogButton,
  type OpsLogButtonKind,
  type ScopeContext,
  type SettingKey,
} from '@nexa/contracts';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { OpsButtonResolver } from './ports.js';

/**
 * Round 4 PR-D: the inline URL buttons of an operations log message.
 *
 * A button is stored as WHAT it opens and which record (`OpsLogButton`) and is turned into a
 * link here, when the message is SENT — so the Web Admin's address is never written into a
 * notification, and a message that waited in the queue across a change of host opens the
 * host as it is now.
 *
 * Telegram refuses a message whose button address it cannot open, and a refused message is
 * a lost log line. So an address qualifies only when it is a public https origin; anything
 * else (no address configured, http, localhost, a private range) answers NO buttons and the
 * message goes out without them. The address comes from the `ops.log.admin_base_url` setting
 * and, when that is empty, from the first entry of the installation's `WEB_ADMIN_ORIGINS`.
 */
export class WebAdminButtonResolver implements OpsButtonResolver {
  constructor(
    private readonly deps: {
      readonly settings: Pick<SettingsResolver, 'valueOf'>;
      /** The first `WEB_ADMIN_ORIGINS` entry, or null. */
      readonly defaultOrigin: string | null;
      /** The Persian label of each button (the container binds the catalogue's). */
      readonly labelOf: (kind: OpsLogButtonKind) => string;
    },
  ) {}

  async resolve(
    scope: ScopeContext,
    buttons: readonly OpsLogButton[],
  ): Promise<readonly { readonly text: string; readonly url: string; readonly row: number }[]> {
    const configured = await this.deps.settings.valueOf<string>(
      scope,
      'ops.log.admin_base_url' as SettingKey,
    );
    const origin = publicHttpsOrigin(configured !== '' ? configured : this.deps.defaultOrigin);
    if (origin === null) return [];
    const out: { text: string; url: string; row: number }[] = [];
    for (const button of buttons) {
      const path = opsLogButtonPath(button);
      if (path === null) continue;
      // Two to a row: a log message is read on a phone.
      out.push({
        text: this.deps.labelOf(button.kind),
        url: `${origin}${path}`,
        row: Math.floor(out.length / 2),
      });
    }
    return out;
  }
}

const PRIVATE_V4 = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/;

/** `https://host` for an address Telegram can open, or null. Exported for the unit test. */
export function publicHttpsOrigin(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (host.includes(':') || PRIVATE_V4.test(host)) return null;
  if (!host.includes('.')) return null;
  return url.origin;
}
