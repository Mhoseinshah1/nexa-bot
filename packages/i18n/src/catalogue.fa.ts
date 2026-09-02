import type { TemplateKey } from '@nexa/contracts';

/**
 * The Persian catalogue.
 *
 * Text is stored RAW, with `{token}` placeholders left un-substituted. It is
 * never stored in rendered form: the legacy template editor echoes the
 * RENDERED string — `{first_name}` demonstrably resolves in the viewing
 * admin's own context — so the raw template is not recoverable from that
 * screen, and saving it back would bake the editor's own name into the
 * template for every customer.
 *
 * The rendering is observed (TBR-TXT-004, VERIFIED_BY_UI and VERIFIED_BY_OWNER).
 * The consequence is a HAZARD, not a recorded event: the investigation never
 * sent a single character to that bot, and says so
 * (`docs/research/mirzabotbottextmanagementinvestigationcomplete/`
 * `bot-text-management-knowledge/incidents.md`). The text corruption that DID
 * happen is INCIDENT-FIN-001, where a typed menu label was swallowed by a
 * value-capture prompt and overwrote a production tutorial text.
 *
 * Keys are the identifier. The Persian text is data and may change freely
 * without breaking a single call site — unlike the legacy system, where the
 * Persian caption WAS the key.
 *
 * The product is Persian-only for now. `Locale` exists so that adding a second
 * language is a new catalogue file rather than a refactor.
 */
export const CATALOGUE_FA: Readonly<Record<TemplateKey, string>> = {
  'bot.ping.reply': 'سلام. ربات فعال است. شناسه پیگیری: {correlationId}',
  'bot.unknown_command': 'این دستور شناخته نشد.',
  'error.internal': 'خطایی رخ داد. لطفاً بعداً دوباره تلاش کنید.',
  'error.permission_denied': 'شما به این بخش دسترسی ندارید.',
};
