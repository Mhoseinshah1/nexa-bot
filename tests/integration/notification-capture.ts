import type { TenantContext } from '@nexa/contracts';
import { createTranslator } from '@nexa/i18n';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type { CustomerMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import type { TestContext } from './harness';

/**
 * The customer notification lane with the REAL readers and a messenger that records, so a
 * suite that produced a money fact can assert the sentence the customer would read.
 *
 * Every reader is the production one over the real tables: a stub would let the lane
 * render a figure the ledger query would not produce. Only the messenger is ours, so an
 * outcome is a fixture rather than a network.
 */
export function capturingLane(ctx: TestContext) {
  const sends: CustomerMessage[] = [];
  const wallet = new DrizzleWalletRepository(ctx.container.database.db);
  const people = new DrizzleCustomerRepository(ctx.container.database.db);
  const service = new CustomerNotificationService({
    notifications: ctx.container.customerNotifications,
    refundFigures: wallet,
    paymentCredits: wallet,
    // The rejection's reason (File 01 §7): the production reader over the real payment row.
    rejectionReasons: new DrizzlePaymentRepository(ctx.container.database.db),
    reminderSnapshots: new DrizzleServiceReminderSnapshotReader(ctx.container.database.db),
    contacts: {
      contactFor: async (scope, customerId, tx) => {
        const found = await people.findById(scope, customerId, tx);
        if (found === null) return { kind: 'NONE' };
        if (found.status !== 'ACTIVE') return { kind: 'BLOCKED' };
        return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
      },
    },
    subjects: { stillHolds: async () => true },
    messenger: {
      send: async (_scope, message) => {
        sends.push(message);
        return { outcome: 'DELIVERED' };
      },
      acknowledge: async () => undefined,
      sendFile: async () => ({ outcome: 'REFUSED' }),
    },
    uow: ctx.container.uow,
    clock: ctx.container.clock,
    scopeIsActive: async () => true,
    logger: { info: () => {}, error: () => {} },
  });
  const translator = createTranslator();
  return {
    sends,
    sweep: (scope: TenantContext) => service.deliverDue(scope, 50),
    /** The built-in Persian sentence each recorded send would render as. */
    rendered: () => sends.map((one) => translator.translate(one.templateKey, one.values)),
  };
}
