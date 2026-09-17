import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { RECOVERY_ROUTES, type TenantContext } from '@nexa/contracts';
import { AppModule } from './app.module.js';
import {
  TELEGRAM_WEBHOOK_BODY_LIMIT_BYTES,
  TELEGRAM_WEBHOOK_ROUTE_PREFIX,
} from './surfaces/telegram/webhook.controller.js';
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
  //
  // The payment ROUTES this release can operate get the same treatment, and for the
  // same reason (Phase 5C). `PaymentGatewayService` consults them before a top-up is
  // issued, so a tenant with no route answers its customers' next payment attempt with
  // `PAYMENT_GATEWAY_UNAVAILABLE` — a release that silently stops taking money.
  //
  // Through the REPOSITORY rather than the service, deliberately. This is a boot-time
  // reconcile with no actor behind it, exactly like `ensureSystemRoles`, and routing it
  // through the guarded service would have meant either fabricating an actor — which
  // `docs/conventions.md` forbids by name — or widening `SYSTEM_JOB_PERMISSIONS` for a
  // statement no operator asked for. `ensureDefaults` is a conflict-ignoring insert, so
  // a boot that changes nothing costs one statement and a route an operator has tuned
  // is never reset.
  //
  // Migration 0071 covers the installations that upgrade INTO this release; this covers
  // the ones provisioned after it, and a tenant created by a later release that adds a
  // route to the catalogue.
  const scope: TenantContext = { tenantId: primary.id, botInstanceId: null };
  await container.uow.run(scope, async (tx) => {
    await container.admins.lockTenantForAdminChange(scope, tx);
    await container.roles.ensureSystemRoles(scope, tx);
    await container.paymentGatewayProvisioning.ensureDefaults(scope, container.clock.now(), tx);
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

  /*
   * A smaller body limit on the one route an unauthenticated caller can reach.
   *
   * The adapter's 1 MB is sized for Web Admin requests from an operator who has
   * already signed in. The Telegram webhook is different in kind: the secret
   * token is checked inside the handler, which means Fastify has already read
   * and parsed the body by the time the request is rejected. An unauthenticated
   * caller could therefore hand the process a megabyte of JSON per request and
   * pay nothing for the 401 it got back.
   *
   * An `onRoute` hook rather than a guard or a `content-length` check, because
   * this has to bound the READ and not the handler. A hook that inspected
   * `content-length` would be advisory — a chunked request declares no length —
   * whereas `routeOptions.bodyLimit` is what Fastify's own body reader enforces,
   * on the stream, whatever the headers say.
   *
   * Registered before `app.init()`, which is when Nest adds its routes; after it
   * the hook would never see them.
   */
  const fastify = app.getHttpAdapter().getInstance();

  /*
   * A RAW body parser for the recovery upload, and nothing else.
   *
   * Registered for `application/octet-stream` only, and it consumes nothing: the
   * handler reads `request.raw` itself, counting bytes as it writes them to disk.
   * A parser that buffered would defeat the point — the archive format streams
   * precisely because a database does not fit in memory — and a multipart
   * dependency would be a parsing surface bought to decode a wrapper around the
   * one thing being sent.
   *
   * `done(null, undefined)` rather than `done(null, payload)`: handing the stream
   * through as `request.body` would give every future handler a second way to
   * reach it, and there is exactly one endpoint that may.
   */
  fastify.addContentTypeParser(
    'application/octet-stream',
    (_request, _payload, done: (error: Error | null, body?: unknown) => void) => {
      done(null, undefined);
    },
  );

  fastify.addHook('onRoute', (route) => {
    if (route.url.startsWith(TELEGRAM_WEBHOOK_ROUTE_PREFIX)) {
      route.bodyLimit = TELEGRAM_WEBHOOK_BODY_LIMIT_BYTES;
    }
    /*
     * The upload route's own ceiling, raised to the configured maximum.
     *
     * Fastify compares a declared `content-length` against `bodyLimit` BEFORE the
     * handler runs, so without this an archive larger than the adapter's 1 MB
     * would be refused by the framework — with a 413 that says nothing about this
     * installation's actual limit — and the handler's own counter would never see
     * it. The counter is still the authority, because a chunked request declares
     * no length and this check cannot fire for one.
     */
    if (route.url.endsWith(RECOVERY_ROUTES.upload)) {
      route.bodyLimit = config.RECOVERY_UPLOAD_MAX_BYTES;
    }
  });

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
