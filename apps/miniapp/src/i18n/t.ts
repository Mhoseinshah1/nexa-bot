import { MINIAPP_FA, type MiniAppKey } from './miniapp.fa.js';

/** A catalogue string with its `{name}` values filled. Values are already formatted text. */
export function t(key: MiniAppKey, values: Readonly<Record<string, string | number>> = {}): string {
  return MINIAPP_FA[key].replace(/\{([a-z]+)\}/gu, (whole, name: string) => {
    const value = values[name];
    return value === undefined ? whole : String(value);
  });
}

export type { MiniAppKey };
