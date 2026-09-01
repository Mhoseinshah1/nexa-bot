import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.js';
import { createContainer, type Container } from './container.js';
import { loadConfig } from './infrastructure/config/load-config.js';
import { trustProxyOption } from './infrastructure/trusted-proxy.js';
import type { AppConfig } from './infrastructure/config/config.schema.js';

/**
 * Resolves the primary tenant this installation serves.
 *
 * Read once at boot rather than per request: one install serves one customer
 * (ADR-0001), and a tenant id taken from the login request would let a caller
 * choose which tenant to attack. An installation with no tenant yet boots fine
 * and reports a configuration error on the login route — refusing to start
 * would make the health endpoints unreachable during provisioning, exactly when
 * they are most useful.
 */
export async function resolveInstallationTenant(container: Container): Promise<void> {
  const primary = await container.tenants.findPrimary();
  container.setInstallationTenant(primary?.id ?? null);
}

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
  await resolveInstallationTenant(container);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forContainer(container),
    new FastifyAdapter({
      bodyLimit: 1_048_576,
      // A LIST of upstreams, or false. Never `true` — that believes
      // X-Forwarded-For from whoever connected, so a client reaching the port
      // directly could choose its own IP for throttling and audit purposes.
      trustProxy: trustProxyOption(config.TRUSTED_PROXY_IPS),
    }),
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
