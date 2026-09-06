import { Inject, Injectable } from '@nestjs/common';
import type { DependencyStatus } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';

/**
 * The Nest-facing handle on readiness. It computes nothing.
 *
 * The computation is `ReadinessService`, in the application layer, and the
 * dependency questions are a port that infrastructure implements. This class
 * exists because both `/health/ready` and the authenticated
 * `system/readiness` need the SAME answer, and a controller injected into a
 * controller is a circular graph waiting to happen — the first attempt at this
 * failed Nest's initialisation outright.
 *
 * It used to be the computation, holding the database handle, the Redis handle
 * and the outbox relay: a surface reaching past the application layer into
 * infrastructure. An earlier pass moved the SQL out and left the handles, which
 * changed what the boundary check could see and nothing about the direction —
 * `check-boundaries.sh` now asserts the direction itself.
 */
@Injectable()
export class ReadinessProbe {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  run(): Promise<{ degraded: boolean; dependencies: DependencyStatus[] }> {
    return this.container.readiness.run();
  }
}
