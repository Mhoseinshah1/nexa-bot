import {
  SUPPORT_AI_PAYMENT_CHECK_WINDOW_DAYS,
  SUPPORT_AI_TEMPLATE_KEYS,
  type BusinessOutboundButton,
  type Clock,
  type ScopeContext,
  type SupportAiActionKind,
} from '@nexa/contracts';
import { appearanceFallbackText } from '../../../commerce/messaging/application/appearance-render.js';
import type { TemplateResolver } from '../../templates/application/template-resolver.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  PAYMENT_CHECK_SUMMARY_WORDS,
  deepLinkUrl,
  type ActionPlan,
  type PaymentCheckFact,
} from '../domain/actions.js';
import type { SupportAiToolReader } from './support-ai-tools.js';

/** Phase 4 PR-3: what a tool adds to one reply, prepared before the enqueue. */
export interface PreparedTool {
  readonly toolAction: Exclude<SupportAiActionKind, 'NONE'>;
  /** Server text placed under the model's reply (a link, payment lines); never the model's. */
  readonly extra: string | null;
  /** Whether `extra` goes through the output validator with the reply (a subscription link). */
  readonly validated: boolean;
  /** The links the validator may let through for THIS reply: the customer's own link only. */
  readonly allowLinks: readonly string[];
  readonly button: BusinessOutboundButton | null;
  /** A subscription link or files button sent: re-read in the enqueue, and logged. */
  readonly linkSent: {
    readonly serviceId: string;
    readonly username: string;
    readonly link: string | null;
  } | null;
}

/** Phase 4 PR-3: the label of each deep link's button. */
const DEEP_LINK_LABELS: Readonly<Record<SupportAiActionKind, string>> = {
  NONE: SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot,
  SEND_SUBSCRIPTION_LINK: SUPPORT_AI_TEMPLATE_KEYS.buttonServiceInBot,
  PAYMENT_STATUS: SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot,
  BUY: SUPPORT_AI_TEMPLATE_KEYS.buttonBuy,
  RENEW: SUPPORT_AI_TEMPLATE_KEYS.buttonRenew,
  ADD_TRAFFIC: SUPPORT_AI_TEMPLATE_KEYS.buttonAddTraffic,
  ADD_TIME: SUPPORT_AI_TEMPLATE_KEYS.buttonAddTime,
  CHANGE_LOCATION: SUPPORT_AI_TEMPLATE_KEYS.buttonChangeLocation,
  TRIAL: SUPPORT_AI_TEMPLATE_KEYS.buttonTrial,
  ROTATE_LINK: SUPPORT_AI_TEMPLATE_KEYS.buttonRotate,
  WALLET_TOPUP: SUPPORT_AI_TEMPLATE_KEYS.buttonTopup,
};

/**
 * The ONE place a planned tool becomes text and a button (Phase 4 PR-3, shared by PR-4): the
 * Business auto-reply service and the ticket service both call it, so a ticket reply can never
 * read a service or payment by any rule but the Business chat's. It reads only through the
 * tool reader (tenant and customer in every WHERE) with the customer id the CALLER took from its
 * own conversation or ticket row, never from the model.
 */
export class SupportToolPreparer {
  constructor(
    private readonly deps: {
      readonly reader?: SupportAiToolReader;
      readonly templates?: Pick<TemplateResolver, 'render'>;
      readonly clock: Clock;
    },
  ) {}

  /** A template rendered for the customer, or null when it cannot render (or is empty). */
  async render(
    scope: ScopeContext,
    key: string,
    values: Readonly<Record<string, string>> = {},
    tx?: TransactionScope,
  ): Promise<string | null> {
    try {
      const text = await this.deps.templates?.render(
        scope,
        key as Parameters<TemplateResolver['render']>[1],
        values,
        undefined,
        tx,
      );
      if (text === undefined) return null;
      // A plain-text message: every Appearance marker ({icon:…}) as its emoji.
      const plain = appearanceFallbackText(text).trim();
      return plain === '' ? null : plain;
    } catch {
      return null;
    }
  }

  /** A button whose label is a template; null when the label cannot render. */
  async button(
    scope: ScopeContext,
    labelKey: string,
    target: { readonly url: string } | { readonly callbackData: string },
  ): Promise<BusinessOutboundButton | null> {
    const label = await this.render(scope, labelKey);
    if (label === null) return null;
    return {
      label: label.slice(0, 64),
      url: 'url' in target ? target.url : null,
      callbackData: 'callbackData' in target ? target.callbackData : null,
    };
  }

  /**
   * What one planned tool adds to the reply, read now — or null when it cannot be given (the
   * service has no link, the customer is not eligible for a trial, a label cannot render): the
   * caller treats that as a refused target (`tool_scope`).
   */
  async prepare(
    scope: ScopeContext,
    customerId: string | null,
    plan: Exclude<ActionPlan, { kind: 'none' } | { kind: 'refused' }>,
    botUsername: string | null,
  ): Promise<PreparedTool | null> {
    const reader = this.deps.reader;
    if (reader === undefined) return null;
    const keys = SUPPORT_AI_TEMPLATE_KEYS;
    switch (plan.kind) {
      case 'subscription_link': {
        if (customerId === null) return null;
        const subscription = await reader.subscriptionOf(scope, customerId, plan.serviceId);
        if (subscription === null) return null;
        if (subscription.link !== null) {
          const extra = await this.render(scope, keys.subscriptionLink, {
            service: subscription.username,
            link: subscription.link,
          });
          if (extra === null) return null;
          return {
            toolAction: 'SEND_SUBSCRIPTION_LINK',
            extra,
            validated: true,
            allowLinks: [subscription.link],
            button: null,
            linkSent: {
              serviceId: plan.serviceId,
              username: subscription.username,
              link: subscription.link,
            },
          };
        }
        // R11 A4 «فقط فایل»: never the link — the bot's service card, where «فایل‌ها» sends them.
        if (!subscription.filesOnly || botUsername === null) return null;
        const extra = await this.render(scope, keys.filesInBot, { service: subscription.username });
        const button = await this.button(scope, keys.buttonServiceInBot, {
          url: deepLinkUrl(botUsername, 'service', plan.serviceId),
        });
        if (extra === null || button === null) return null;
        return {
          toolAction: 'SEND_SUBSCRIPTION_LINK',
          extra,
          validated: false,
          allowLinks: [],
          button,
          linkSent: { serviceId: plan.serviceId, username: subscription.username, link: null },
        };
      }
      case 'payment_status': {
        if (customerId === null) return null;
        const payments = await reader.paymentsForCheck(scope, customerId, this.checkSince());
        const extra =
          payments.length === 0
            ? await this.render(scope, keys.paymentStatusNone)
            : await this.paymentLines(scope, payments);
        if (extra === null) return null;
        // Server facts (codes, amounts): never the model's words, so not the validator's.
        return {
          toolAction: 'PAYMENT_STATUS',
          extra,
          validated: false,
          allowLinks: [],
          button: null,
          linkSent: null,
        };
      }
      case 'deep_link': {
        if (botUsername === null) return null;
        let flow = plan.flow;
        let id = plan.id;
        if (plan.trialCheck === true) {
          if (customerId === null || !(await reader.trialEligible(scope, customerId))) return null;
        }
        if (plan.productId !== undefined) {
          const category = await reader.categoryOfProduct(scope, plan.productId);
          if (category !== null) {
            flow = 'category';
            id = category;
          }
        }
        const button = await this.button(scope, DEEP_LINK_LABELS[plan.action], {
          url: deepLinkUrl(botUsername, flow, id),
        });
        if (button === null) return null;
        return {
          toolAction: plan.action as Exclude<SupportAiActionKind, 'NONE'>,
          extra: null,
          validated: false,
          allowLinks: [],
          button,
          linkSent: null,
        };
      }
      case 'open_bot': {
        if (botUsername === null) return null;
        const button = await this.button(scope, SUPPORT_AI_TEMPLATE_KEYS.buttonOpenBot, {
          url: deepLinkUrl(botUsername, null, null),
        });
        if (button === null) return null;
        return {
          toolAction: plan.action as Exclude<SupportAiActionKind, 'NONE'>,
          extra: null,
          validated: false,
          allowLinks: [],
          button,
          linkSent: null,
        };
      }
    }
  }

  /** The customer's payments as status lines (`bot.support.ai_payment_status_line`). */
  private async paymentLines(
    scope: ScopeContext,
    payments: readonly PaymentCheckFact[],
  ): Promise<string | null> {
    const lines: string[] = [];
    for (const payment of payments) {
      const line = await this.render(scope, SUPPORT_AI_TEMPLATE_KEYS.paymentStatusLine, {
        code: payment.code ?? PAYMENT_CHECK_SUMMARY_WORDS.noCode,
        amount: payment.amount,
        state: payment.stateLabel,
        route: payment.route,
      });
      if (line === null) return null;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** Where the payments a check reads begin: `SUPPORT_AI_PAYMENT_CHECK_WINDOW_DAYS` back. */
  checkSince(): Date {
    return new Date(
      this.deps.clock.now().getTime() - SUPPORT_AI_PAYMENT_CHECK_WINDOW_DAYS * 86_400_000,
    );
  }
}
