import { MINIAPP_ROUTES, miniAppTrialResponseSchema } from '@nexa/contracts';
import { useApp } from '../app.js';
import { useLoad } from '../ui.js';

/**
 * Whether a way into the trial screen is offered. The bot draws its trial button only while
 * a panel offers one; the mini app asks the same endpoint, so the entry is never a door to a
 * screen that can only say «not available». (The referral entry is not conditional: reading
 * the invite mints the customer's link, so it is read when the person opens that screen,
 * never on a screen load — the screen itself says when the program is off.)
 */
export function useTrialOffers() {
  const { api } = useApp();
  return useLoad(() => api.get(MINIAPP_ROUTES.trial, {}, miniAppTrialResponseSchema), [api]);
}
