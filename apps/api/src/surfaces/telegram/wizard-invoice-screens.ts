import type {
  ActorContext,
  Clock,
  PaymentId,
  TelegramWizardStep,
  TenantContext,
} from '@nexa/contracts';
import type { CustomerMessenger } from '../../modules/commerce/messaging/application/ports.js';
import type { TelegramMessageStateService } from '../../modules/commerce/messaging/application/telegram-message-state.js';
import type { GatewayInvoiceRecord } from '../../modules/commerce/payments/application/gateway-invoice-ports.js';
import type { PaymentRecord } from '../../modules/commerce/payments/application/ports.js';
import { editSent, gatewayAttemptScreen } from './bot-runtime.js';
import type { InvoiceScreensPort } from './wizard-state.js';

/**
 * R2 (v0.3.5 real-test item 4): the customer's invoice message, edited in place the moment
 * the attempt it shows has moved on — above all, the moment its provider invoice is READY,
 * so the payment link appears without a tap on «🔄 بررسی وضعیت پرداخت».
 *
 * Called by the gateway worker after it committed an outcome, and by the turn that has just
 * put the loading screen on the message. Both render through `gatewayAttemptScreen` — the
 * one screen function the turn uses too — from the COMMITTED attempt, and both reach the
 * message only through ONE conditional move (`moveAll`): exactly one caller wins each
 * message, and only the winner edits it. That is the whole race argument:
 *
 *   - the worker finishing BEFORE the turn marked the message finds nothing waiting, and
 *     the turn's own read after marking it sees the invoice and edits it;
 *   - the worker finishing AFTER the mark wins the move and edits it — after the loading
 *     screen, because the turn marks only once its loading edit has been asked for;
 *   - both at once: one move wins, the other moves nothing.
 *
 * It decides nothing about money and calls no provider. A payment is CONFIRMED only by the
 * inquiry, under the payment's lock, in `PaymentService.confirmGatewayPayment`; this only
 * shows what was committed. The three TonPays rules stay where they are.
 */
export class WizardInvoiceScreens implements InvoiceScreensPort {
  constructor(
    private readonly deps: {
      readonly state: Pick<TelegramMessageStateService, 'moveAll'>;
      readonly payments: {
        findById(scope: TenantContext, id: PaymentId): Promise<PaymentRecord | null>;
      };
      readonly invoices: {
        invoiceForPayment(
          scope: TenantContext,
          paymentId: PaymentId,
        ): Promise<GatewayInvoiceRecord | null>;
      };
      readonly messenger: CustomerMessenger;
      readonly clock: Clock;
      /** `SYSTEM_JOB`: this is background presentation work on the customer's behalf. */
      readonly actor: () => ActorContext;
    },
  ) {}

  async refresh(scope: TenantContext, paymentId: string): Promise<void> {
    const payment = await this.deps.payments.findById(scope, paymentId as PaymentId);
    if (payment === null || payment.method !== 'GATEWAY') return;
    const invoice = await this.deps.invoices.invoiceForPayment(scope, payment.id);
    if (invoice === null) return;
    const screen = gatewayAttemptScreen(
      { payment, invoice },
      payment.orderId,
      this.deps.clock.now(),
    );
    // Still being created: the loading screen stays, and this is called again when it is not.
    if (screen.wizard?.invoicePending === true || screen.key === null) return;
    const step = screen.wizard?.step ?? 'NOTICE';
    /*
     * A READY invoice replaces only a loading screen; an END (confirmed, failed, closed,
     * unknown) replaces the invoice too, so a message still offering the pay button for an
     * attempt that is over says so.
     */
    const from: readonly TelegramWizardStep[] =
      step === 'INVOICE' ? ['INVOICE_PENDING'] : ['INVOICE_PENDING', 'INVOICE'];
    const moved = await this.deps.state.moveAll(
      scope,
      this.deps.actor(),
      { paymentId: payment.id },
      from,
      step,
    );
    for (const wizard of moved) {
      await editSent(
        this.deps.messenger,
        scope,
        {
          chatId: wizard.chatId,
          messageId: wizard.messageId,
          botInstanceId: wizard.botInstanceId,
          templateKey: screen.key,
          values: screen.values,
          buttons: screen.buttons,
        },
        false,
      );
    }
  }

  /**
   * R2 (item 11): closes every open screen of one order's wizard — the pre-invoice, the
   * method chooser, the invoice — by taking their buttons off; the text stays as the record
   * of what was paid. The renewal lane calls it right before it sends the renewal's own
   * result, so the result is a new message after a closed payment message. One conditional
   * move decides which messages this call closes; a message already CLOSED is left alone.
   */
  async closeOrder(scope: TenantContext, orderId: string): Promise<void> {
    const moved = await this.deps.state.moveAll(
      scope,
      this.deps.actor(),
      { subjectId: orderId },
      OPEN_ORDER_STEPS,
      'CLOSED',
    );
    const clear = this.deps.messenger.clearButtons;
    if (clear === undefined) return;
    for (const wizard of moved) {
      await clear.call(this.deps.messenger, scope, {
        chatId: wizard.chatId,
        messageId: wizard.messageId,
        botInstanceId: wizard.botInstanceId,
      });
    }
  }
}

/** The screens of an order's wizard that still carry buttons. */
const OPEN_ORDER_STEPS: readonly TelegramWizardStep[] = [
  'USERNAME',
  'DISCOUNT',
  'PREINVOICE',
  'AWAITING_PAYMENT',
  'METHODS',
  'INVOICE_PENDING',
  'INVOICE',
  'NOTICE',
];
