import { Body, Controller, Inject, Post } from '@nestjs/common';
import { API_PREFIX, systemContext, systemJobActor } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { currentCorrelationId, newCorrelationId } from '../../infrastructure/logging/logger.js';
import type { RecordPingResult } from '../../modules/platform/system/application/record-ping.service.js';

/**
 * The HTTP entry to the canonical write path.
 *
 * A controller is presentation: authenticate, build the command, call the
 * application service, map the result. No SQL, no business branching, no
 * customer-facing string literals. The Telegram surface calls the same service
 * with the same command — they do not share logic, they are both clients of it.
 */
@Controller(`${API_PREFIX}/system`)
export class SystemController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Post('ping')
  async ping(@Body() body: unknown): Promise<RecordPingResult> {
    const correlationId = currentCorrelationId() ?? newCorrelationId(this.container.ids.uuid());

    // Runs as system work rather than as an administrator, and deliberately
    // takes no session: a fabricated identity in an audit row is worse than no
    // endpoint at all. That is why `AppModule` registers this controller only
    // in development — an unauthenticated write into append-only tables is a
    // development affordance and nothing else.
    //
    // It said "Phase 0 has no authentication" until Phase 1 gave it some, at
    // which point the sentence was true of nothing. The registration guard,
    // not this comment, is what keeps the endpoint off a real deployment.
    const actor = systemJobActor('http:system.ping', correlationId);

    return this.container.recordPing.execute(systemContext('http-admin'), actor, body);
  }
}
