import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CONTAINER, type Container } from './container.js';
import { HealthController } from './surfaces/web/health.controller.js';
import { SystemController } from './surfaces/web/system.controller.js';
import { TelegramWebhookController } from './surfaces/telegram/webhook.controller.js';
import { CorrelationMiddleware } from './surfaces/web/correlation.middleware.js';
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
  static forContainer(container: Container) {
    const controllers = [HealthController];

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
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*path');
  }
}
