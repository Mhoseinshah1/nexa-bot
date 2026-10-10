/**
 * FIX-03 (batch 2026-10-10): when a gateway's INQUIRIES keep failing, an operator is told.
 *
 * Before this a transient inquiry failure (`FAILED`: a timeout, a 5xx, the network;
 * `RATE_LIMITED`: the provider's 429) was recorded on the attempt (`last_inquiry_error_code`)
 * and on the gateway-health dashboard, and nowhere an operator is told — so a provider whose
 * check endpoint was down for an hour was a queue of customers who paid and were not
 * credited, discovered when they complained. Only the inquiry decides an approval (CLAUDE.md,
 * TonPays rules), so an inquiry outage is a settlement outage.
 *
 * Per gateway and per PROCESS: `threshold` failures inside `windowMs` with no successful
 * answer between them opens `payments.gateway_inquiry_failing`. The condition is one row per
 * gateway (its dedupe key), so two worker replicas counting separately collapse onto it; a
 * restart starts the count again, which can delay an alarm by one window and never raises a
 * false one. Neutral answers — `NOT_FOUND` (the provider answered) and `CONFIGURATION`
 * (`payments.gateway_misconfigured` already says so) — neither count nor reset.
 *
 * A successful answer closes it with `payments.gateway_inquiry_ok`. The close asks the
 * database whether the condition is open — another replica may have opened it — but at most
 * once per `recheckMs` per gateway unless this process saw failures, so a healthy lane does
 * not read the operations log on every inquiry.
 */
export class GatewayInquiryHealth {
  private readonly failures = new Map<string, number[]>();
  private readonly recordedAt = new Map<string, number>();
  private readonly checkedAt = new Map<string, number>();

  constructor(
    private readonly options: {
      readonly threshold: number;
      readonly windowMs: number;
      readonly recheckMs: number;
    } = GATEWAY_INQUIRY_HEALTH_DEFAULTS,
  ) {}

  /** A failed inquiry. True when the failing condition should be recorded now. */
  failure(provider: string, nowMs: number): boolean {
    const recent = (this.failures.get(provider) ?? []).filter(
      (at) => nowMs - at < this.options.windowMs,
    );
    recent.push(nowMs);
    this.failures.set(provider, recent);
    if (recent.length < this.options.threshold) return false;
    const last = this.recordedAt.get(provider);
    // Re-recorded at most once a window while it lasts: the row's counter grows, and the
    // recorder announces only a NEW or REOPENED condition.
    if (last !== undefined && nowMs - last < this.options.windowMs) return false;
    this.recordedAt.set(provider, nowMs);
    return true;
  }

  /** A successful inquiry. True when the caller should check for an open condition and close it. */
  success(provider: string, nowMs: number): boolean {
    const sawFailures = this.failures.has(provider) || this.recordedAt.has(provider);
    this.failures.delete(provider);
    this.recordedAt.delete(provider);
    const checked = this.checkedAt.get(provider);
    if (!sawFailures && checked !== undefined && nowMs - checked < this.options.recheckMs) {
      return false;
    }
    this.checkedAt.set(provider, nowMs);
    return true;
  }

  /** The open-condition read failed: look again on the next answer, not a minute later. */
  forgetCheck(provider: string): void {
    this.checkedAt.delete(provider);
  }
}

/** Five failed inquiries in ten minutes; an open condition looked for at most once a minute. */
export const GATEWAY_INQUIRY_HEALTH_DEFAULTS = {
  threshold: 5,
  windowMs: 10 * 60_000,
  recheckMs: 60_000,
} as const;
