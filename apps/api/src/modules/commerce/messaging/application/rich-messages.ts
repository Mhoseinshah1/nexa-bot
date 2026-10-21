import type { TemplateKey, TenantContext } from '@nexa/contracts';

/**
 * R4 PR-F: what the customer messenger needs to send a screen as a Telegram rich message.
 *
 * Two feature flags decide it — `rich_messages` («دکمه‌های داخل پیام») and
 * `rich_premium_emoji` («ایموجی پریمیوم») — read per tenant through `modeFor`. A flag is a
 * boolean and neither has parameters; everything else about the layout is decided here, in
 * code, per template key.
 */
export interface RichMessageMode {
  /** `rich_messages`: inline-button screens go as `sendRichMessage` with a buttons block. */
  readonly enabled: boolean;
  /**
   * `rich_premium_emoji`: inside a rich message, a custom emoji the SENDING bot may carry
   * (its appearance test succeeded) is drawn as one. Without it every marker is its plain
   * emoji and no inline button carries an icon.
   */
  readonly premiumEmoji: boolean;
  /**
   * `rich_plan_table` («نمایش پلن‌ها به‌صورت جدول», R5C-2 B2): the plan list also carries a
   * table. Inert without `enabled` — a table is a rich-message block — and absent is `false`:
   * the plan list is then the same blocks a tenant that never heard of tables sees.
   */
  readonly planTable?: boolean;
}

/** The mode a tenant is in when nothing can be read: today's behaviour. */
export const RICH_MESSAGES_OFF: RichMessageMode = {
  enabled: false,
  premiumEmoji: false,
  planTable: false,
};

export interface RichMessageSupport {
  modeFor(scope: TenantContext): Promise<RichMessageMode>;
  /** The clock of the refusal's aggregation window (`opsAggregationKey`). */
  now(): Date;
}

/**
 * The operational-event code of a screen Telegram refused as a rich message. A code is
 * schema (CLAUDE.md); it is classified in `OPS_ERROR_EVENTS` (WINDOW: one row per bot per
 * hour) and routed to the ERRORS topic.
 */
export const RICH_MESSAGE_REFUSED_CODE = 'telegram.rich_message_refused';

/**
 * How one screen's text is arranged in a rich message, beyond one paragraph per line.
 *
 * - `heading`: the first line is the section heading of a list screen.
 * - `collapse`: a long text — the rules, a connection guide — shows its first line and keeps
 *   the rest in an expandable details block (`InputRichBlockDetails`), closed by default.
 *
 * A screen not named here keeps one paragraph per line, with the list and divider rules.
 */
export const RICH_SCREEN_LAYOUTS: Readonly<
  Partial<Record<TemplateKey, { readonly heading?: boolean; readonly collapse?: boolean }>>
> = {
  'bot.catalog.heading': { heading: true },
  'bot.catalog.categories_heading': { heading: true },
  'bot.terms.required': { collapse: true },
  'bot.terms.updated': { collapse: true },
  'bot.tutorial.android': { collapse: true },
  'bot.tutorial.ios': { collapse: true },
  'bot.tutorial.windows': { collapse: true },
  'bot.tutorial.macos': { collapse: true },
  'bot.tutorial.linux': { collapse: true },
};
