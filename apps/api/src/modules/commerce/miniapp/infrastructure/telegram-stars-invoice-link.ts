import type { BotInstanceId, TenantContext } from '@nexa/contracts';
import { telegramCreateInvoiceLink } from '../../../../infrastructure/telegram/send-message.js';
import type { StarsInvoiceLinkCreator } from '../application/ports.js';

/** The Stars invoice's own text, from the tenant's templates: the chat invoice's, exactly. */
export interface StarsInvoicePresentation {
  readonly title: string;
  readonly description: string;
  readonly priceLabel: string;
}

/**
 * `createInvoiceLink` for the mini app's in-app Stars payment (R11 B5).
 *
 * Everything the chat invoice is made of, from the same sources: the token of the bot the
 * attempt is bound to (`tokenForBotInstance`, the path the worker's `sendInvoice` takes), the
 * presentation the worker renders, and the request body `telegramSendInvoice` sends minus the
 * chat. Any answer that is not a link — a refusal, a timeout, an unreadable 2xx — is FAILED
 * with its machine code: nothing is charged by a link, so the caller simply has none to hand
 * back, and a later request may ask again with the same payload.
 */
export class TelegramStarsInvoiceLinkCreator implements StarsInvoiceLinkCreator {
  constructor(
    private readonly deps: {
      readonly bots: {
        tokenForBotInstance(scope: TenantContext, id: BotInstanceId): Promise<string | null>;
      };
      readonly presentation: (scope: TenantContext) => Promise<StarsInvoicePresentation>;
      readonly apiBaseUrl: string;
      readonly timeoutMs: number;
      readonly create?: typeof telegramCreateInvoiceLink;
    },
  ) {}

  async create(
    scope: TenantContext,
    input: {
      readonly botInstanceId: BotInstanceId;
      readonly payload: string;
      readonly stars: bigint;
    },
  ): Promise<
    | { readonly outcome: 'CREATED'; readonly link: string }
    | { readonly outcome: 'FAILED'; readonly code: string }
  > {
    const token = await this.deps.bots.tokenForBotInstance(scope, input.botInstanceId);
    if (token === null) return { outcome: 'FAILED', code: 'nexa.credential_missing' };
    const presentation = await this.deps.presentation(scope);
    const create = this.deps.create ?? telegramCreateInvoiceLink;
    const made = await create({
      token,
      apiBaseUrl: this.deps.apiBaseUrl,
      timeoutMs: this.deps.timeoutMs,
      title: presentation.title,
      description: presentation.description,
      priceLabel: presentation.priceLabel,
      payload: input.payload,
      stars: input.stars,
    });
    return made.outcome === 'SUCCEEDED'
      ? { outcome: 'CREATED', link: made.link }
      : { outcome: 'FAILED', code: made.errorCode };
  }
}
