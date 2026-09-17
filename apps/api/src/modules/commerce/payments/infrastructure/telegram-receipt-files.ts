import type { ScopeContext } from '@nexa/contracts';
import type { BotInstanceId } from '@nexa/contracts';
import {
  telegramFetchFile,
  type TelegramFileOutcome,
} from '../../../../infrastructure/telegram/fetch-file.js';
import type { PaymentReceiptRecord } from '../application/receipt-ports.js';

/**
 * Which bot's token fetches a file. The ONE read this needs.
 *
 * A narrow port for the reason `CustomerBotReader` is narrow: handing this the tenant
 * repository would also hand it every bot-instance write, and the path an operator's
 * click travels has no business holding one.
 */
export interface BotTokenReader {
  tokenForBotInstance(scope: ScopeContext, botInstanceId: BotInstanceId): Promise<string | null>;
}

/**
 * The bytes of one receipt, fetched with the token of the bot that received it.
 *
 * INFRASTRUCTURE, injected into the controller rather than called from it, so the
 * surface holds no network sink and no token. What the controller gets back is bytes or
 * `UNAVAILABLE`, and it cannot ask for anything else.
 *
 * The bot is taken from the RECEIPT ROW, never from the request. A `file_id` is scoped
 * to the bot that received it, so a tenant with two bots has two namespaces and fetching
 * with the wrong token answers "file not found" — a receipt that exists, reported as
 * missing. `payment_receipts.bot_instance_id` is what makes the pairing a fact rather
 * than an inference.
 */
export class TelegramReceiptFiles {
  constructor(
    private readonly deps: {
      readonly bots: BotTokenReader;
      readonly apiBaseUrl: string;
      /**
       * Where FILES live, which is a different path prefix and — in Telegram's own
       * deployment — may be a different host. Configured separately so a local server
       * standing in for Telegram in a test can serve both from one origin.
       */
      readonly fileBaseUrl: string;
      readonly timeoutMs: number;
    },
  ) {}

  /*
   * `download`, not `fetch`. `check-boundaries.sh` treats `fetch(` as a network sink and
   * must: a method named `fetch` makes every call site indistinguishable from a real
   * one, which is a check defeated by a name.
   */
  async download(scope: ScopeContext, receipt: PaymentReceiptRecord): Promise<TelegramFileOutcome> {
    const token = await this.deps.bots.tokenForBotInstance(scope, receipt.botInstanceId);
    if (token === null) {
      /*
       * No token for that bot: it is STOPPED, it was deleted, or its secret cannot be
       * decrypted under any active key. The first is the likely one and the only
       * reversible one — `tokenForBotInstance` resolves `ACTIVE` rows only, so stopping
       * a bot also stops an operator reading receipts it received. Whether an operator's
       * READ should be exempt from that rule is OQ-5R-02; until it is answered the hint
       * on the card names this cause, because «try again» is not the remedy for it.
       *
       * UNAVAILABLE rather than a 500, because the receipt row is intact and the honest
       * thing to tell a reviewer is that the file cannot be retrieved — which is exactly
       * what the limitation in `packages/contracts/src/payment-receipts.ts` predicts.
       */
      return { outcome: 'UNAVAILABLE', reason: 'this bot has no usable token' };
    }
    return telegramFetchFile({
      token,
      apiBaseUrl: this.deps.apiBaseUrl,
      fileBaseUrl: this.deps.fileBaseUrl,
      timeoutMs: this.deps.timeoutMs,
      fileId: receipt.fileId,
    });
  }
}
