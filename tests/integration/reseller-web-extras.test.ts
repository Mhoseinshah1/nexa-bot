import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ResellerTierProgress, ResellerTrialStatus, UserId } from '@nexa/contracts';
import { resellerDailyReportValues } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-reminder-facts.reader';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import { tenantA } from './harness';
import { codeOf, systemActor, useSellingHarness } from './reseller-selling-harness';

/**
 * PR-5 §5.7 / §5.8 and the items carried from PR-4, against the real app over HTTP.
 *
 * Proves: reseller trials are the trial service's claim, a daily quota counted under the
 * customer lock (never exceeded under concurrency), free, never a sale; the tier-progress card
 * is display only behind its flag; the three notification preferences are consumed (the
 * ticket-reply notice is gated, the expiring digest and the daily sales report go once a day
 * and only when on); an operator resets a reseller's two-step sign-in with a reason, audited,
 * and every session ends.
 */
describe('the reseller web panel — trials, tier progress, preferences, 2FA reset (PR-5)', () => {
  const h = useSellingHarness('rwx');

  async function setting(key: string, value: unknown): Promise<void> {
    await h().api.container.settingsService.set(tenantA, h().owner, {
      key: key as never,
      value: value as never,
      expectedVersion: null,
      idempotencyKey: randomUUID(),
    });
  }

  async function enablePanelTrial(): Promise<void> {
    const current = await h().api.container.panelTrials.get(tenantA, h().owner, h().panelId);
    await h().api.container.panelTrials.update(tenantA, h().owner, h().panelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: current.revision,
      enabled: true,
      trafficAmount: '100',
      trafficUnit: 'MB',
      durationHours: 24,
      label: null,
    });
  }

  const notices = async (customerId: UserId, kind: string) =>
    (
      await h()
        .db()
        .execute(
          sql`SELECT subject_id FROM customer_notifications WHERE customer_id = ${customerId}::uuid AND kind = ${kind}`,
        )
    ).rows as { subject_id: string }[];

  // --- §5.7 trials -------------------------------------------------------------------------

  it('trials: off by default; then a daily quota held under concurrency, free and never a sale', async () => {
    const cookie = await h().signedIn();
    const off = (await h().call(cookie, 'GET', '/trial')).json() as ResellerTrialStatus;
    expect(off).toEqual({ enabled: false, quota: 0, usedToday: 0 });
    const refused = await h().call(cookie, 'POST', '/trial');
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('reseller_web.trial_unavailable');

    await enablePanelTrial();
    await setting('reseller.trial_daily_quota', 2);
    await setting('reseller.trial_product', h().panelId);
    expect((await h().call(cookie, 'GET', '/trial')).json()).toEqual({
      enabled: true,
      quota: 2,
      usedToday: 0,
    });

    // Five at once: the quota is decided under the customer's row lock — exactly two.
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => h().call(cookie, 'POST', '/trial')),
    );
    expect(answers.filter((answer) => answer.statusCode === 200)).toHaveLength(2);
    expect(answers.filter((answer) => answer.statusCode === 409)).toHaveLength(3);
    expect((await h().call(cookie, 'GET', '/trial')).json()).toMatchObject({ usedToday: 2 });

    const grants = await h()
      .db()
      .execute(
        sql`SELECT reseller_trial FROM trial_grants WHERE customer_id = ${h().reseller}::uuid`,
      );
    expect(grants.rows).toEqual([{ reseller_trial: true }, { reseller_trial: true }]);
    // Free: zero-total TRIAL orders, no wallet movement, no reseller sale, the own allowance kept.
    const orders = await h()
      .db()
      .execute(
        sql`SELECT purpose, total_amount::text AS total FROM orders WHERE customer_id = ${h().reseller}::uuid`,
      );
    expect(orders.rows).toEqual([
      { purpose: 'TRIAL', total: '0' },
      { purpose: 'TRIAL', total: '0' },
    ]);
    const entries = await h()
      .db()
      .execute(sql`SELECT 1 FROM wallet_entries WHERE customer_id = ${h().reseller}::uuid`);
    expect(entries.rows).toHaveLength(0);
    const dashboard = (await h().call(cookie, 'GET', '/dashboard')).json() as {
      monthSales: { count: number };
    };
    expect(dashboard.monthSales.count).toBe(0);
    const own = await h().api.container.trials.claim(tenantA, systemActor('own'), h().reseller, {
      idempotencyKey: randomUUID(),
      panelId: h().panelId,
    });
    expect(own.outcome).toBe('ISSUED');

    // The drawer's count.
    const drawer = await h().admin('GET', `/resellers/${h().reseller}/web-panel/trials`);
    expect(drawer.json()).toEqual({ today: 2, quota: 2, total: 2 });
  });

  // --- §5.8 tier progress ------------------------------------------------------------------

  it('tier progress: hidden behind its flag and a target, display only — the tier never changes', async () => {
    const cookie = await h().signedIn();
    const hidden = (await h().call(cookie, 'GET', '/tier-progress')).json() as ResellerTierProgress;
    expect(hidden.shown).toBe(false);
    await h().setFlag('reseller_tier_progress', true);
    expect(
      ((await h().call(cookie, 'GET', '/tier-progress')).json() as ResellerTierProgress).shown,
    ).toBe(false);

    const set = await h().admin('PUT', `/reseller-tiers/${h().tierId}/next-target`, {
      target: { kind: 'COUNT', count: 5 },
      idempotencyKey: randomUUID(),
    });
    expect(set.statusCode, set.body).toBe(200);
    await h().delivered(h().reseller);
    await h().delivered(h().reseller);
    const progress = (
      await h().call(cookie, 'GET', '/tier-progress')
    ).json() as ResellerTierProgress;
    expect(progress).toMatchObject({
      shown: true,
      target: { kind: 'COUNT', count: 5 },
      count: 2,
      remainingCount: 3,
    });

    await h().admin('PUT', `/reseller-tiers/${h().tierId}/next-target`, {
      target: { kind: 'AMOUNT', amount: { amountMinor: '1000000', currency: 'IRT' } },
      idempotencyKey: randomUUID(),
    });
    const byAmount = (
      await h().call(cookie, 'GET', '/tier-progress')
    ).json() as ResellerTierProgress;
    expect(byAmount).toMatchObject({
      shown: true,
      amount: { amountMinor: '400000' },
      remainingAmount: { amountMinor: '600000' },
    });
    // Display only: still the same tier.
    const tier = await h()
      .db()
      .execute(sql`SELECT tier_id FROM resellers WHERE customer_id = ${h().reseller}::uuid`);
    expect(tier.rows).toEqual([{ tier_id: h().tierId }]);
  });

  // --- carried: the three preferences --------------------------------------------------------

  it('«پاسخ تیکت» gates the ticket-reply notice to that reseller', async () => {
    const cookie = await h().signedIn();
    await h().api.container.ticketCategories.ensureSeeded(tenantA);
    const [category] = await h().api.container.ticketCategories.activeForCustomer(tenantA);
    const opened = await h().call(cookie, 'POST', '/tickets', {
      categoryId: category?.id,
      text: 'سلام، سؤال دارم',
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const ticketId = (opened.json() as { id: string }).id;
    const reply = (text: string) =>
      h().api.container.tickets.reply(tenantA, h().owner, {
        ticketId,
        text,
        idempotencyKey: randomUUID(),
      });
    await reply('پاسخ اول');
    expect(await notices(h().reseller, 'TICKET_REPLY')).toHaveLength(1);
    await h().call(cookie, 'PUT', '/settings/notifications', { ticketReply: false });
    await reply('پاسخ دوم');
    expect(await notices(h().reseller, 'TICKET_REPLY')).toHaveLength(1);
    await h().call(cookie, 'PUT', '/settings/notifications', { ticketReply: true });
    await reply('پاسخ سوم');
    expect(await notices(h().reseller, 'TICKET_REPLY')).toHaveLength(2);
  });

  it('the expiring digest (on by default) and the daily sales report (off) go once a day, only when on', async () => {
    const cookie = await h().signedIn();
    const service = await h().delivered(h().reseller);
    await h()
      .db()
      .execute(
        sql`UPDATE services SET expires_at = now() + interval '3 days' WHERE id = ${service.id}::uuid`,
      );
    const reports = h().api.container.resellerWeb.dailyReports;
    await reports.runOnce(tenantA);
    await reports.runOnce(tenantA);
    const digests = await notices(h().reseller, 'RESELLER_WEB_EXPIRING_DIGEST');
    expect(digests).toHaveLength(1);
    expect(await notices(h().reseller, 'RESELLER_WEB_DAILY_SALES')).toHaveLength(0);
    // The other reseller has nothing running out: no digest at all.
    expect(await notices(h().other, 'RESELLER_WEB_EXPIRING_DIGEST')).toHaveLength(0);

    const row = (
      await h()
        .db()
        .execute(
          sql`SELECT kind, facts FROM reseller_web_daily_reports WHERE id = ${digests[0]?.subject_id}::uuid`,
        )
    ).rows[0] as { kind: string; facts: Record<string, unknown> };
    expect(resellerDailyReportValues('RESELLER_WEB_EXPIRING_DIGEST', row.kind, row.facts)).toEqual({
      count: 1,
      list: `• ${service.providerUsername}`,
    });

    await h().call(cookie, 'PUT', '/settings/notifications', {
      dailySalesReport: true,
      expiringDigest: false,
    });
    await reports.runOnce(tenantA);
    await reports.runOnce(tenantA);
    expect(await notices(h().reseller, 'RESELLER_WEB_DAILY_SALES')).toHaveLength(1);
  });

  // --- carried: the operator's reset of the reseller's 2FA -----------------------------------

  it('an operator resets the reseller’s two-step sign-in: a reason, audited, every session ended', async () => {
    const cookie = await h().signedIn();
    const enrol = await h().call(cookie, 'POST', '/security/totp/enrol');
    expect(enrol.statusCode, enrol.body).toBe(200);
    const { secret } = enrol.json() as { secret: string };
    const activated = await h().call(cookie, 'POST', '/security/totp/activate', {
      code: totpForStep(secret, totpStepAt(h().api.container.clock.now())),
    });
    expect(activated.statusCode, activated.body).toBe(200);

    const noReason = await h().admin('POST', `/resellers/${h().reseller}/web-panel/totp-reset`, {
      idempotencyKey: randomUUID(),
    });
    expect(noReason.statusCode).toBe(400);
    const reset = await h().admin('POST', `/resellers/${h().reseller}/web-panel/totp-reset`, {
      idempotencyKey: randomUUID(),
      reason: 'نماینده گوشی‌اش را عوض کرده است',
    });
    expect(reset.statusCode, reset.body).toBe(201);
    expect(reset.json()).toMatchObject({ reset: true });
    expect((await h().call(cookie, 'GET', '/me')).statusCode).toBe(401);
    const factors = await h()
      .db()
      .execute(sql`SELECT 1 FROM reseller_web_totp_factors`);
    expect(factors.rows).toHaveLength(0);
    const audited = await h()
      .db()
      .execute<{ after: { reason: string } }>(
        sql`SELECT after FROM audit_logs WHERE action = 'reseller_web.totp_reset'`,
      );
    expect(audited.rows[0]?.after.reason).toBe('نماینده گوشی‌اش را عوض کرده است');
    // A fresh link opens straight into the panel: no code step any more.
    const fresh = await h().signedIn();
    expect((await h().call(fresh, 'GET', '/me')).statusCode).toBe(200);
  });
});
