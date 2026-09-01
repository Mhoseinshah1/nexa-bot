import type { Clock, Instant } from '@nexa/contracts';

/** The wall clock. The only place in the codebase that may read it. */
export class SystemClock implements Clock {
  now(): Instant {
    return new Date();
  }
}

/** A clock that does not move, for tests. */
export class FixedClock implements Clock {
  constructor(private instant: Instant) {}

  now(): Instant {
    return new Date(this.instant.getTime());
  }

  set(instant: Instant): void {
    this.instant = instant;
  }

  advanceMs(ms: number): void {
    this.instant = new Date(this.instant.getTime() + ms);
  }
}

export const CLOCK = Symbol('CLOCK');
