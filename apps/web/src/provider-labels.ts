import { PROVIDER_DESCRIPTORS } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';
import { t } from './i18n/web.fa';

/**
 * The name an operator reads for a panel provider.
 *
 * The catalogue's `canonicalName` is the contract's English name and stays that. The
 * `custom` provider is called «پنل کاستوم» wherever an operator reads it; the internal key
 * is unchanged. Every other provider keeps its catalogue name.
 */
const PERSIAN_PROVIDER_NAMES: Readonly<Record<string, WebKey>> = {
  custom: 'web.provider_name_custom',
};

export function providerDisplayName(key: string, canonicalName: string): string {
  const label = PERSIAN_PROVIDER_NAMES[key];
  return label === undefined ? canonicalName : t(label);
}

/** The same, from a bare provider key; an unknown key is shown as it is. */
export function providerNameOf(key: string): string {
  const descriptor = PROVIDER_DESCRIPTORS.find((one) => one.key === key);
  return descriptor === undefined ? key : providerDisplayName(key, descriptor.canonicalName);
}
