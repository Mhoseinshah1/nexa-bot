import type {
  PaymentDestinationSnapshot,
  ScopeContext,
  TemplateKey,
  TemplateValues,
} from '@nexa/contracts';

/**
 * The tenant's rendered text for one key. `TemplateResolver.render`'s signature exactly.
 *
 * A narrow port rather than the template service, so this cannot acquire the ability to
 * read or write an override — it renders four frozen keys and nothing else.
 */
export interface DestinationLineRenderer {
  render(scope: ScopeContext, key: TemplateKey, values: TemplateValues): Promise<string>;
}

/**
 * The four destination lines, in order, with absent fields simply not composed.
 *
 * CARD first and HOLDER second, because that is the order the owner's invoice layout
 * names them in and it is the order a customer uses them: the card number goes into the
 * banking app, and the holder name is what they check it against. Bank and Sheba follow
 * — the bank because an account always has one and a customer transferring wants it,
 * the Sheba because a configured one is a second payment route and dropping it would
 * lose a customer a way to pay.
 *
 * Fixed here rather than configurable. A tenant changes the four line templates to
 * change the wording; what a tenant cannot do is reorder them, which is a deliberate
 * limitation and not an oversight.
 */
const LINES: readonly {
  readonly key: TemplateKey;
  readonly of: (snapshot: PaymentDestinationSnapshot) => string | null;
}[] = [
  { key: 'bot.payment.destination.card', of: (s) => s.cardNumber },
  { key: 'bot.payment.destination.holder', of: (s) => s.holderName },
  { key: 'bot.payment.destination.bank', of: (s) => s.bankName },
  { key: 'bot.payment.destination.sheba', of: (s) => s.iban },
];

/**
 * Composes `{destination}` for `bot.payment.transfer_instructions`.
 *
 * It exists because `renderTemplateBody` substitutes only the tokens it is GIVEN and
 * leaves the rest exactly as written: an optional `{sheba}` placeholder inside the
 * instruction body would put the literal string `{sheba}` in front of a customer whose
 * tenant configured no Sheba. Composing the block from per-line keys is what makes "do
 * not display fields that are absent" expressible at all.
 *
 * It lives in INFRASTRUCTURE because the boundary check forbids a surface from resolving
 * the catalogue: a surface sends a template key, and the catalogue is resolved behind the
 * application layer. `bot-runtime.ts` is handed this as a dependency, the same shape
 * `MainMenuRoutes` takes.
 *
 * The values come from the payment's FROZEN snapshot, never from the account row, so a
 * customer scrolling back to a week-old invoice reads what that invoice said.
 */
export class PaymentDestinationRenderer {
  constructor(private readonly templates: DestinationLineRenderer) {}

  async render(scope: ScopeContext, snapshot: PaymentDestinationSnapshot): Promise<string> {
    const lines: string[] = [];
    for (const line of LINES) {
      const value = line.of(snapshot);
      if (value === null) continue;
      lines.push(await this.templates.render(scope, line.key, { value }));
    }
    return lines.join('\n');
  }
}
