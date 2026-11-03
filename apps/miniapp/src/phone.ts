import { COMMERCE_ERROR_CODES, MINIAPP_ROUTES, miniAppMeResponseSchema } from '@nexa/contracts';
import { ApiError, type MiniAppApi } from './api.js';
import { requestOwnContact } from './telegram.js';

/**
 * NEXA v095 PR-4 C: what became of a payment request a route's verified-phone rule refused.
 *
 * - `DONE` — the request went through, first time or after the number was verified;
 * - `CANCELLED` — the customer closed Telegram's contact dialog;
 * - `UNSUPPORTED` — this client has no `requestContact()`: the caller sends them to the bot;
 * - `PENDING` — they shared it, and the server has not verified it yet (it may still).
 */
export type PhoneGatedResult<T> =
  | { readonly kind: 'DONE'; readonly value: T }
  | { readonly kind: 'CANCELLED' | 'UNSUPPORTED' | 'PENDING'; readonly refusal: unknown };

export interface PhoneGateDeps {
  /** `Telegram.WebApp.requestContact()`, as `requestOwnContact` wraps it. */
  readonly requestContact: () => Promise<'shared' | 'cancelled' | 'unsupported'>;
  /** Whether the server now has a verified number (`/me.phoneVerified`). */
  readonly phoneVerified: () => Promise<boolean>;
  readonly wait: (ms: number) => Promise<void>;
}

/** How often, and how long, the server is asked whether the shared contact was verified. */
export const PHONE_POLL_INTERVAL_MS = 1000;
export const PHONE_POLL_ATTEMPTS = 10;

/**
 * Runs `work`; when a route's verified-phone rule refuses it (nothing was created — the
 * refusal comes before any payment exists), asks for the contact, waits for the SERVER to
 * report the number verified, and runs the same `work` again: the same order or top-up, the
 * same route, decided afresh by the server. Any other refusal is thrown as it came.
 */
export async function withPhoneVerification<T>(
  work: () => Promise<T>,
  deps: PhoneGateDeps,
): Promise<PhoneGatedResult<T>> {
  try {
    return { kind: 'DONE', value: await work() };
  } catch (failure) {
    if (
      !(failure instanceof ApiError) ||
      failure.code !== COMMERCE_ERROR_CODES.PHONE_VERIFICATION_REQUIRED
    ) {
      throw failure;
    }
    const asked = await deps.requestContact();
    if (asked === 'unsupported') return { kind: 'UNSUPPORTED', refusal: failure };
    if (asked === 'cancelled') return { kind: 'CANCELLED', refusal: failure };
    for (let attempt = 0; attempt < PHONE_POLL_ATTEMPTS; attempt += 1) {
      if (await deps.phoneVerified()) return { kind: 'DONE', value: await work() };
      await deps.wait(PHONE_POLL_INTERVAL_MS);
    }
    return { kind: 'PENDING', refusal: failure };
  }
}

/** The production dependencies: Telegram's dialog, `/me`, and a real timer. */
export function phoneGateDeps(api: MiniAppApi): PhoneGateDeps {
  return {
    requestContact: requestOwnContact,
    phoneVerified: async () =>
      (await api.get(MINIAPP_ROUTES.me, {}, miniAppMeResponseSchema)).phoneVerified,
    wait: (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
