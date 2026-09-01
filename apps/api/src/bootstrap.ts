import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import type { AppConfig } from './infrastructure/config/config.schema.js';

export interface ApiApp {
  readonly app: NestFastifyApplication;
  readonly container: Container;
  close(): Promise<void>;
}

/**
 * Builds the API application without listening, so tests can drive it through
 * Fastify's `inject` rather than binding a port.
 */
export async function createApiApp(config: AppConfig = loadConfig()): Promise<ApiApp> {
  const container = createContainer(config, 'api');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forContainer(container),
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
    { logger: false },
  );

  app.enableShutdownHooks();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    container,
    async close() {
      await app.close();
      await container.shutdown();
    },
  };
}
