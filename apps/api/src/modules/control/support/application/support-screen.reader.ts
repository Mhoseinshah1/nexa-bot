import {
  CONTROL_ERROR_CODES,
  errors,
  supportFaqInputSchema,
  type Clock,
  type IdGenerator,
  type TemplateKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../settings/application/settings-resolver.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { SupportFaqRepository } from './ports.js';

/**
 * The nine approved defaults, by template key, in the order they are offered.
 *
 * Written out as literal pairs rather than built from a counter so the compiler checks
 * each key against `TEMPLATES`: a key built at runtime would reach the catalogue as a
 * string and fail there, on a customer's first tap.
 */
const SEED_TEMPLATES: readonly (readonly [TemplateKey, TemplateKey])[] = [
  ['bot.faq.default_1_question', 'bot.faq.default_1_answer'],
  ['bot.faq.default_2_question', 'bot.faq.default_2_answer'],
  ['bot.faq.default_3_question', 'bot.faq.default_3_answer'],
  ['bot.faq.default_4_question', 'bot.faq.default_4_answer'],
  ['bot.faq.default_5_question', 'bot.faq.default_5_answer'],
  ['bot.faq.default_6_question', 'bot.faq.default_6_answer'],
  ['bot.faq.default_7_question', 'bot.faq.default_7_answer'],
  ['bot.faq.default_8_question', 'bot.faq.default_8_answer'],
  ['bot.faq.default_9_question', 'bot.faq.default_9_answer'],
];

/** Ten apart, so an operator can slot an entry between two defaults without renumbering. */
const SEED_SORT_STEP = 10;

export interface SupportFaqSeederDeps {
  readonly repository: SupportFaqRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly templates: TemplateResolver;
  readonly scopeActivity: ScopeActivityReader;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * Copies the catalogue's nine defaults into a tenant's FAQ, ONCE.
 *
 * Triggered by the first read — the customer's screen or the operator's list — rather
 * than by provisioning, because the text comes from the template resolver and a tenant
 * override of `bot.faq.default_<n>_*` is honoured: it is the tenant's default. From then
 * on the rows are the operator's and the catalogue is not consulted, which is why a
 * tenant that deactivates all nine and reads again gets the empty list.
 *
 * ## Why the marker goes in FIRST
 *
 * Two replicas answering two customers of a fresh tenant both find no seed. The marker's
 * primary key is what makes that produce one seed: `markSeeded` is an `INSERT … ON
 * CONFLICT DO NOTHING`, so the loser's insert WAITS on the winner's transaction and then
 * reports zero rows. That is the unique violation caught by code rather than by a
 * `catch` — a violation raised as an error would have aborted the loser's transaction,
 * and nothing could be re-read inside it. The loser inserts nothing and its caller reads
 * the winner's rows, which READ COMMITTED lets it see on the next statement.
 *
 * ## Why it reads scope activity
 *
 * It is a write, and every write path reads `ScopeActivityReader` inside its
 * transaction. A stopped tenant is not given nine new rows; it is given the empty list.
 */
export class SupportFaqSeeder {
  constructor(private readonly deps: SupportFaqSeederDeps) {}

  async ensureSeeded(scope: TenantContext): Promise<void> {
    // The common case takes no transaction at all: the marker exists and nothing is written.
    if (await this.deps.repository.hasSeed(scope)) return;

    await this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) return;

      const now = this.deps.clock.now();
      const claimed = await this.deps.repository.markSeeded(scope, now, tx);
      if (!claimed) return;

      for (const [index, [questionKey, answerKey]] of SEED_TEMPLATES.entries()) {
        const [question, answer] = await Promise.all([
          this.deps.templates.render(scope, questionKey, {}, undefined, tx),
          this.deps.templates.render(scope, answerKey, {}, undefined, tx),
        ]);
        /*
         * The same bounds the operator's editor applies, so a tenant override of a
         * default that outgrew the column is refused HERE, naming the key, rather than
         * by the table's CHECK constraint as an unexplained failure on a customer's tap.
         */
        const parsed = supportFaqInputSchema.safeParse({
          question,
          answer,
          sortOrder: (index + 1) * SEED_SORT_STEP,
        });
        if (!parsed.success) {
          throw errors.validation(
            CONTROL_ERROR_CODES.INVALID_VALUE,
            `The rendered default FAQ entry ${String(index + 1)} does not fit an FAQ row.`,
            { keys: [questionKey, answerKey], issues: parsed.error.issues },
          );
        }
        await this.deps.repository.insert(
          scope,
          { ...parsed.data, id: this.deps.ids.uuid(), status: 'ACTIVE', now },
          tx,
        );
      }
    });
  }
}

/** What the customer's support screen is composed from. */
export interface SupportScreen {
  readonly faqs: readonly { readonly question: string; readonly answer: string }[];
  /** `https://t.me/<handle>` for the FIRST configured support account, or null when none. */
  readonly supportUrl: string | null;
}

export interface SupportScreenReaderDeps {
  readonly repository: SupportFaqRepository;
  readonly seeder: SupportFaqSeeder;
  readonly settings: SettingsResolver;
}

/**
 * The customer's support screen: the active FAQ, in order, and where to write.
 *
 * No permission check, and that is deliberate rather than an omission — the rule
 * `PaymentGatewayService.offer` states. The caller is a customer's own tap, there is no
 * `ActorContext` for a customer in this product, and what bounds this instead is that it
 * writes nothing an operator did not configure and reads only facts about the tenant the
 * scope already names.
 */
export class SupportScreenReader {
  constructor(private readonly deps: SupportScreenReaderDeps) {}

  async screenFor(scope: TenantContext): Promise<SupportScreen> {
    await this.deps.seeder.ensureSeeded(scope);
    const [rows, handles] = await Promise.all([
      this.deps.repository.list(scope, { status: 'ACTIVE' }),
      this.deps.settings.valueOf<readonly string[]>(scope, 'support.accounts'),
    ]);
    return {
      faqs: rows.map((row) => ({ question: row.question, answer: row.answer })),
      supportUrl: supportUrlFor(handles),
    };
  }
}

/**
 * The first support account as a Telegram link. THIS tenant's setting, read through the
 * resolver so a tenant that configured none gets the default — an empty list — and not
 * another tenant's handle. The handle is stored with its `@`; the URL form has none.
 */
export function supportUrlFor(handles: readonly string[]): string | null {
  const first = handles[0];
  if (first === undefined) return null;
  return `https://t.me/${first.replace(/^@/u, '')}`;
}
