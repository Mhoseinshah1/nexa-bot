import { Inject, Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CONTAINER, type Container } from './container.js';
import { ReadinessProbe } from './surfaces/web/readiness.probe.js';
import { HealthController } from './surfaces/web/health.controller.js';
import { AuthController } from './surfaces/web/auth.controller.js';
import { AdminsController } from './surfaces/web/admins.controller.js';
import { ControlController } from './surfaces/web/control.controller.js';
import { PanelsController } from './surfaces/web/panels.controller.js';
import { SystemController } from './surfaces/web/system.controller.js';
import { TelegramWebhookController } from './surfaces/telegram/webhook.controller.js';
import { CorrelationMiddleware } from './surfaces/web/correlation.middleware.js';
import { securityHeaders } from './surfaces/web/security-headers.middleware.js';
import { DomainErrorFilter } from './surfaces/web/error.filter.js';

/**
 * The API process's module graph.
 *
 * The Telegram webhook controller is registered only when the feature is on, so
 * a deployment that has not configured a bot does not expose the route at all —
 * it returns 404 rather than 401, and there is nothing to probe.
 */
@Module({})
export class AppModule implements NestModule {
  /**
   * The container this module graph was built for.
   *
   * Injected rather than stashed on a static. `isProduction` used to be a
   * mutable class property assigned by `forContainer` and read back in
   * `configure` — process-global state keyed to nothing, so two applications
   * constructed in one process shared it. The second construction rewrote the
   * first's value, and whichever `configure` ran later decided the security
   * headers for BOTH. In a test run that silently swaps HSTS on or off; the
   * shape is the problem regardless of whether production ever does it.
   */
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  static forContainer(container: Container) {
    const controllers = [HealthController];

    // The authenticated admin surface. Registered whenever real authentication
    // is configured — unlike the ping endpoint below, these endpoints check a
    // session and a permission on every call, so there is nothing to gate.
    if (container.config.AUTH_MODE === 'password') {
      controllers.push(
        AuthController as never,
        AdminsController as never,
        ControlController as never,
        PanelsController as never,
      );
    }

    // The system ping endpoint runs the canonical write path over HTTP with no
    // authentication, because Phase 0 has none. That is acceptable as a
    // development affordance and unacceptable anywhere else: it would let an
    // anonymous caller write rows into append-only tables. Registered only in
    // development, the same way the webhook is registered only when configured.
    if (container.config.NODE_ENV === 'development') {
      controllers.push(SystemController as never);
    }

    if (container.config.TELEGRAM_WEBHOOK_ENABLED) {
      controllers.push(TelegramWebhookController as never);
    }

    return {
      module: AppModule,
      controllers,
      providers: [
        { provide: CONTAINER, useValue: container },
        // Shared by the anonymous `/health/ready` and the authenticated
        // readiness detail, so there is one readiness computation rather than
        // two that can disagree.
        ReadinessProbe,
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
    // Read from THIS module's own container, so the answer belongs to this
    // application rather than to whichever one was constructed most recently.
    consumer
      .apply(securityHeaders(this.container.config.NODE_ENV === 'production'))
      .forRoutes('*path');
  }
}
