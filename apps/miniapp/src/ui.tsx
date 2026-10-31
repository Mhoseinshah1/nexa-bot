import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { MiniAppListedPersonalDiscount, MoneyWire } from '@nexa/contracts';
import { ApiError } from './api.js';
import { commerceErrorText } from './commerce-errors.js';
import { money } from './format.js';
import { t, type MiniAppKey } from './i18n/t.js';
import { MINIAPP_FA } from './i18n/miniapp.fa.js';
import type { Tab } from './app.js';

/** The mini app's kit: a handful of components every screen is drawn from. */

export function Message({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <main className="message" role="status">
      <p>{text}</p>
      {action}
    </main>
  );
}

/**
 * R11 A9: a listed price the customer's personal discount wins — the price the list showed
 * before, struck through, the discounted price the server's quote will charge, and the tag
 * «تخفیف شخصی N٪». Every figure is the server's (`personalDiscount` comes from the pricing
 * boundary); nothing is computed here. A line it does not win is drawn by the caller exactly
 * as before, so this is used only when `discount` is set.
 */
export function PersonalPrice({
  price,
  discount,
}: {
  price: MoneyWire;
  discount: MiniAppListedPersonalDiscount;
}) {
  return (
    <span className="price personal-price">
      <s className="personal-price-was">{money(price)}</s>
      <strong className="personal-price-now">{money(discount.price)}</strong>
      <span className="personal-price-tag">
        {t('miniapp.personal_discount_tag', { percent: discount.percent })}
      </span>
    </span>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={`glass${className === undefined ? '' : ` ${className}`}`}>
      {children}
    </section>
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={primary === true ? 'btn btn-primary' : 'btn'}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-value">{value}</span>
    </div>
  );
}

/** A technical value (a link, a card number, a code): left to right inside the RTL page. */
export function Ltr({ children }: { children: ReactNode }) {
  return (
    <bdi dir="ltr" className="ltr">
      {children}
    </bdi>
  );
}

/**
 * The usage bar. Its fill is an SVG attribute, never a `style=`: the document's CSP allows
 * no inline style, as the Web Admin's `Progress` does it.
 */
export function UsageBar({ share }: { share: number | null }) {
  if (share === null) return null;
  const width = Math.round(share * 1000) / 10;
  return (
    <svg className="usage" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
      <rect className="usage-track" x="0" y="0" width="100" height="8" rx="4" />
      <rect
        className={share >= 0.9 ? 'usage-fill usage-warn' : 'usage-fill'}
        x="0"
        y="0"
        width={width}
        height="8"
        rx="4"
      />
    </svg>
  );
}

const TABS: readonly { readonly tab: Tab; readonly label: MiniAppKey }[] = [
  { tab: 'home', label: 'miniapp.tab_home' },
  { tab: 'store', label: 'miniapp.tab_store' },
  { tab: 'services', label: 'miniapp.tab_services' },
  { tab: 'wallet', label: 'miniapp.tab_wallet' },
  { tab: 'profile', label: 'miniapp.tab_profile' },
];

export function TabBar({ current, onSelect }: { current: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <nav className="tabbar" aria-label={t('miniapp.app_title')}>
      {TABS.map(({ tab, label }) => (
        <button
          key={tab}
          type="button"
          className={tab === current ? 'tab tab-current' : 'tab'}
          aria-current={tab === current ? 'page' : undefined}
          onClick={() => onSelect(tab)}
        >
          {t(label)}
        </button>
      ))}
    </nav>
  );
}

/** The sentence for a refusal: the mini app's own codes, then the services' common ones. */
const ERROR_TEXT: Readonly<Record<string, MiniAppKey>> = {
  'miniapp.rate_limited': 'miniapp.rate_limited',
  'miniapp.not_found': 'miniapp.not_found',
  'miniapp.session_invalid': 'miniapp.reopen',
  'miniapp.unavailable': 'miniapp.unavailable',
  'miniapp.receipt_upload_failed': 'miniapp.card_receipt_upload_failed',
  'commerce.discount_code_rejected': 'miniapp.checkout_discount_refused',
  'commerce.gift_cards_disabled': 'miniapp.wallet_gift_unavailable',
  // Round 10, D1: one Persian sentence for both automatic-renewal refusals.
  'commerce.auto_renew_disabled': 'miniapp.auto_renew_unavailable',
  'commerce.auto_renew_not_available': 'miniapp.auto_renew_unavailable',
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'miniapp.receipt_refused') {
      const reason = String(error.details['reason'] ?? '');
      const key = `miniapp.card_receipt_refused_${reason}`;
      if (isKey(key)) return t(key);
    }
    const key = ERROR_TEXT[error.code];
    if (key !== undefined) return t(key);
    // R12 F3 item 5: every other commerce refusal is told in the bot's own words.
    const shared = commerceErrorText(error.code);
    if (shared !== null) return shared;
  }
  return t('miniapp.error');
}

function isKey(key: string): key is MiniAppKey {
  return Object.prototype.hasOwnProperty.call(MINIAPP_FA, key);
}

export type Loaded<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly error: unknown }
  | { readonly state: 'ready'; readonly data: T };

/**
 * R12 F3 item 5: «بیشتر» ADDS the next page under the ones already shown. `earlier` is what the
 * pages before this one showed and `current` this page's items; a row both hold (a list that
 * shifted between two reads) is drawn once, from the newer read.
 */
export function appendPage<T extends { readonly id: string }>(
  earlier: readonly T[],
  current: readonly T[],
): readonly T[] {
  const seen = new Set(current.map((item) => item.id));
  return [...earlier.filter((item) => !seen.has(item.id)), ...current];
}

/** One read, re-run when `deps` change, with a `reload` for after a write. */
export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [loaded, setLoaded] = useState<Loaded<T>>({ state: 'loading' });
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setLoaded({ state: 'ready', data }),
      (error: unknown) => live && setLoaded({ state: 'failed', error }),
    );
    return () => {
      live = false;
    };
    // The caller names the inputs; `load` is a fresh closure each render.
  }, [...deps, round]);
  const reload = useCallback(() => setRound((value) => value + 1), []);
  return { loaded, reload };
}

/** A read's three states, drawn the same way everywhere. */
export function Loading<T>({
  loaded,
  reload,
  children,
}: {
  loaded: Loaded<T>;
  reload: () => void;
  children: (data: T) => ReactNode;
}) {
  if (loaded.state === 'loading') return <Message text={t('miniapp.loading')} />;
  if (loaded.state === 'failed') {
    return (
      <Message
        text={errorText(loaded.error)}
        action={<Button onClick={reload}>{t('miniapp.retry')}</Button>}
      />
    );
  }
  return <>{children(loaded.data)}</>;
}
