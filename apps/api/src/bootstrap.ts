import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TenantContext } from '@nexa/contracts';
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

  if (primary === null) return;

  // Create any system role this installation does not have yet.
  //
  // NOT an upgrade path, and the comment here used to say it was. Phase 2 is
  // the first release to add a permission to a seeded role, which is what made
  // the discrepancy matter: `ensureSystemRoles` leaves an EXISTING role alone
  // and says why — reasserting a seed on every boot would silently restore a
  // permission an operator had deliberately withdrawn, with no audit row and
  // nothing to notice it.
  //
  // So a permission newly added to a seed reaches existing installations
  // through a MIGRATION that says what it is doing, and Phase 2 carries one
  // (`0011_control_plane_guards.sql`). This call covers the other half: an
  // installation that has never had, say, the `observer` role gets it, and a
  // provisioning run that created a tenant before a later release added a seed
  // is not left short of it.
  //
  // Roles an operator created are never touched, and the writes are conflict-
  // ignoring inserts, so a boot that changes nothing costs a few statements.
  //
  // Under the SAME tenant lock every administrator mutation takes, and in one
  // transaction. Without it, a rolling upgrade has a window with teeth: a
  // concurrent `setRoles` reads a role's permissions, passes the
  // no-amplification check against an actor who does not hold the permission
  // this boot is about to add, and assigns the role — and when the seeder
  // commits, the target silently holds authority nobody ever checked. The
  // lock makes role contents unable to change between an authorization and the
  // assignment it authorised.
  const scope: TenantContext = { tenantId: primary.id, botInstanceId: null };
  await container.uow.run(scope, async (tx) => {
    await container.admins.lockTenantForAdminChange(scope, tx);
    await container.roles.ensureSystemRoles(scope, tx);
  });
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
