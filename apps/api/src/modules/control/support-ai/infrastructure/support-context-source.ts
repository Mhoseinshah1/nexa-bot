import {
  errors,
  isSystemContext,
  money,
  type ScopeContext,
  type SupportContextPayment,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA, PAYMENT_METHOD_NAMES_FA, formatMoney } from '@nexa/i18n';
import type { SupportContextBuilder } from '../../../commerce/support-context/application/support-context.builder.js';
import type { KnowledgeQuery } from '../../../commerce/support-context/domain/knowledge-relevance.js';
import type { SupportContextSource } from '../application/support-assist.service.js';
import {
  KNOWLEDGE_QUERY_PRIOR_JOBS,
  knowledgeQueryFor,
  type PriorDecisionFact,
} from '../domain/knowledge-query.js';
import type { SupportTranscriptLine } from '../domain/transcript.js';

/** A8: the conversation's latest decided jobs, newest first (`priorDecisions`). */
export interface PriorDecisionReader {
  priorDecisions(
    scope: ScopeContext,
    conversationId: string,
    limit: number,
  ): Promise<readonly PriorDecisionFact[]>;
}

/**
 * TB5 — the Assist service's view of the TB3 support context.
 *
 * The model reads the allowlisted payload as JSON. The operator, beside the draft, reads a
 * short label per alias the draft cited — the service's own username, an order's title, a
 * payment's method and amount — never a row id: the id map (`references`) stays inside TB3.
 */
export class TbSupportContextSource implements SupportContextSource {
  constructor(
    private readonly builder: Pick<SupportContextBuilder, 'build'>,
    /** A8: the earlier decisions the knowledge query reads. Without it, none are read. */
    private readonly prior: PriorDecisionReader | null = null,
  ) {}

  async build(
    scope: ScopeContext,
    customerId: string | null,
    options: {
      readonly query?: string | null;
      readonly conversationId?: string;
      readonly transcript?: readonly SupportTranscriptLine[];
    } = {},
  ) {
    const { payload, knowledgeAvailable } = await this.builder.build(tenantOf(scope), customerId, {
      query: await this.queryFor(scope, options),
    });
    const aliases = new Map<string, string>();
    for (const service of payload.services) aliases.set(service.alias, service.label);
    for (const order of payload.orders) aliases.set(order.alias, order.title);
    for (const payment of payload.payments) {
      aliases.set(payment.alias, paymentLabel(payment));
    }
    // Knowledge is cited apart from the facts (`knowledgeRefs`), and labelled by its question.
    const knowledgeAliases = new Map<string, string>(
      payload.knowledge.map((entry) => [entry.alias, entry.question]),
    );
    return {
      json: JSON.stringify(payload),
      aliases,
      knowledgeAliases,
      linked: payload.flags.identityLinked,
      flags: payload.flags,
      // D2 telemetry: what the budget left of the selected knowledge, and the candidates.
      knowledge: { sent: payload.knowledge.length, available: knowledgeAvailable },
    };
  }

  /**
   * A8 — the weighted knowledge query, built from the transcript and the conversation's latest
   * decided jobs (one bounded, tenant-scoped read); the plain `query` when no transcript is
   * given.
   */
  private async queryFor(
    scope: ScopeContext,
    options: {
      readonly query?: string | null;
      readonly conversationId?: string;
      readonly transcript?: readonly SupportTranscriptLine[];
    },
  ): Promise<KnowledgeQuery | null> {
    if (options.transcript === undefined) return options.query ?? null;
    const prior =
      this.prior === null || options.conversationId === undefined
        ? []
        : await this.prior.priorDecisions(
            scope,
            options.conversationId,
            KNOWLEDGE_QUERY_PRIOR_JOBS,
          );
    return knowledgeQueryFor(options.transcript, prior);
  }
}

/**
 * L2 — a payment as the operator reads it beside a draft: the route's Persian name as the
 * customer's checkout showed it (or the method's, for a wallet payment) and the amount through
 * the one money formatter, in major units with its currency — never `MANUAL_TRANSFER 1500000 IRT`.
 */
export function paymentLabel(
  payment: Pick<SupportContextPayment, 'method' | 'routeLabelKey' | 'amount'>,
): string {
  const route =
    payment.routeLabelKey === null
      ? undefined
      : (CATALOGUE_FA as Readonly<Record<string, string>>)[payment.routeLabelKey as TemplateKey];
  const name = route ?? PAYMENT_METHOD_NAMES_FA[payment.method];
  const amount = formatMoney(money(BigInt(payment.amount.amountMinor), payment.amount.currency));
  return `${name} ${amount}`;
}

function tenantOf(scope: ScopeContext): TenantContext {
  if (isSystemContext(scope)) {
    throw errors.internal('support_ai.scope', 'The support context needs a tenant scope.');
  }
  return scope;
}
