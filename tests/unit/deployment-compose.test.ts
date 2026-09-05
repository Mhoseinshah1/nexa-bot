import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The production topology's security invariants, asserted against the file
 * that ships rather than against a description of it.
 *
 * These do not need Docker. They are structural properties of the compose
 * definition — what is published, what mounts what, who runs as root — and
 * every one of them is a mistake that would be invisible in a smoke test:
 * a deployment with PostgreSQL on a host port passes every functional check
 * ever written for it.
 *
 * The Ubuntu CI job additionally runs the real thing. This is the part that
 * runs everywhere, on every pull request, in under a second.
 */

// Read as TEXT, not parsed as YAML, and that is a deliberate trade.
//
// A YAML parse would answer "is postgres on the edge network" more precisely.
// It would also require a dependency this repository does not have, and it
// would silently normalise away the thing several of these checks are about:
// an anchor merged into a service, a key at the wrong indent, a value that
// compose interpolates. Anchored regular expressions over the literal file
// keep the assertions close to what a reviewer reads.
//
// The cost is that a check can pass because it matched nothing. Each group
// below therefore carries a positive control — an assertion that fails if the
// helper stops seeing the file at all.
const composePath = join(__dirname, '../../deploy/compose.yml');
const compose = readFileSync(composePath, 'utf8');
const ciPath = join(__dirname, '../../deploy/compose.ci.yml');
const ci = readFileSync(ciPath, 'utf8');

/** The block of a named service, up to the next service at the same indent. */
function serviceBlock(text: string, name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `no service named ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('the production compose topology', () => {
  it('publishes host ports from the edge and nowhere else', () => {
    // The single most important property in the file. A `ports:` on postgres
    // makes the database reachable from the internet on a host with no
    // firewall, and nothing about the application would look different.
    for (const service of ['postgres', 'redis', 'api', 'worker', 'web-assets']) {
      expect(serviceBlock(compose, service), `${service} publishes a host port`).not.toMatch(
        /^\s+ports:/m,
      );
    }
    // The control for the five assertions above. A `serviceBlock` that
    // returned nothing useful — a changed indent, a renamed service — would
    // make every "does not publish" check pass while proving nothing. This one
    // fails in that case, so the absences above mean something.
    expect(serviceBlock(compose, 'caddy'), 'serviceBlock cannot see a ports: line at all').toMatch(
      /^\s+ports:/m,
    );
  });

  it('keeps the edge off the data network', () => {
    // Caddy is internet-facing. It has no reason to be able to open a socket
    // to PostgreSQL, and the cheapest way to guarantee that is for the two to
    // share no network at all.
    const caddy = serviceBlock(compose, 'caddy');
    expect(caddy).toMatch(/networks:\s*\n\s+- edge\s*\n/);
    expect(caddy, 'the edge can reach the database').not.toMatch(/- data\s*$/m);
  });

  it('keeps the database and Redis off the edge network', () => {
    for (const service of ['postgres', 'redis']) {
      const block = serviceBlock(compose, service);
      expect(block).toMatch(/networks:\s*\n\s+- data\s*\n/);
      expect(block, `${service} is on the edge network`).not.toMatch(/- edge/);
    }
  });

  it('gives the api and the worker a route out', () => {
    // The worker calls the Telegram API. On the internal network alone it
    // would start, pass its checks, and fail every send with a DNS error —
    // an installation that looks healthy while no alert is delivered.
    const anchor = compose.slice(0, compose.indexOf('\nservices:'));
    expect(anchor).toMatch(/networks:[\s\S]*- data[\s\S]*- edge/);
  });

  it('hands the application the SAME data-subnet expression that creates the network', () => {
    // Fix B. The panel HTTP policy denies the installation's own data network
    // because compose tells the process which network that is — from
    // deploy.env, through the one expression below — not because nexa.env
    // carries a copy that an upgrade or an operator has to keep in step.
    const expression = '${NEXA_DATA_SUBNET:-172.29.1.0/24}';
    expect(compose).toContain(`NEXA_DATA_SUBNET: ${expression}`);
    expect(compose).toContain(`- subnet: ${expression}`);
    expect(
      compose.split(expression).length - 1,
      'the expression appears more or fewer than twice',
    ).toBe(2);
    // Through the shared anchor, so api AND worker receive it.
    const anchor = compose.slice(compose.indexOf('x-app-common:'), compose.indexOf('\nservices:'));
    expect(anchor).toContain('NEXA_DATA_SUBNET:');
  });

  it('mounts no Docker socket, uses no host network and runs nothing privileged', () => {
    // Any of these would make a container compromise a host compromise.
    expect(compose).not.toMatch(/docker\.sock/);
    expect(compose).not.toMatch(/network_mode:\s*host/);
    expect(compose).not.toMatch(/privileged:\s*true/);
    expect(compose).not.toMatch(/^\s*pid:\s*host/m);
  });

  it('bind-mounts no source code', () => {
    // A production deployment that mounts the repository is a deployment whose
    // running code is whatever is on the host's disk, which is the legacy
    // `git pull` model wearing a compose file.
    for (const forbidden of ['./apps', './packages', './src', '../apps', '../src', './dist']) {
      expect(compose, `the deployment bind-mounts ${forbidden}`).not.toContain(`${forbidden}:`);
    }
  });

  it('runs the application as a non-root user with no capabilities', () => {
    const anchor = compose.slice(0, compose.indexOf('\nservices:'));
    expect(anchor).toMatch(/cap_drop:\s*\n\s+- ALL/);
    expect(anchor).toMatch(/no-new-privileges:true/);
    // The image's own USER is `node`; nothing in the shared block overrides it.
    expect(anchor, 'the application containers ask for a user').not.toMatch(/^\s+user:/m);
  });

  it('runs exactly one container as root, and it is the asset copy', () => {
    const rootUsers = [...compose.matchAll(/^ {4}user: '0:0'/gm)];
    expect(rootUsers).toHaveLength(1);
    const assets = serviceBlock(compose, 'web-assets');
    expect(assets).toMatch(/user: '0:0'/);
    // It has no network and no configuration: it copies a directory and stops.
    expect(assets).toMatch(/network_mode: none/);
    expect(assets).not.toMatch(/env_file/);
  });

  it('publishes the Web Admin bundle with the publisher, never by clearing the served root', () => {
    const assets = serviceBlock(compose, 'web-assets');
    // The shell one-shot this replaced emptied the directory Caddy was
    // serving and then copied into it, so every request in the window got a
    // 404 for index.html or an index.html naming assets that were not there
    // yet — on every single update. The publisher writes a complete release
    // off to one side and activates it with one rename(2).
    expect(assets).toMatch(/command: \['node', '\/app\/deploy\/bin\/publish-web-assets\.mjs'\]/);
    expect(assets, 'the asset job clears the directory Caddy is serving').not.toMatch(/rm -rf/);
    expect(assets, 'the asset job copies over the served root').not.toMatch(/cp -r/);
    // It still mounts the volume writable, and it is still the only thing
    // that does.
    expect(assets).toMatch(/- webassets:\/srv\/web$/m);
    expect(serviceBlock(compose, 'caddy')).toMatch(/- webassets:\/srv\/web:ro/);
  });

  it('ships the publisher in the image beside the compose file that invokes it', () => {
    // `botctl update` installs a release's compose file and its image
    // together, so the two are always the same release's — an update and a
    // rollback alike. A publisher that lived on the host instead would be one
    // release's script operating another release's bundle.
    const dockerfile = readFileSync(join(__dirname, '../../Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/COPY --from=builder [^\n]*\/src\/deploy \.\/deploy/);
    expect(existsSync(join(__dirname, '../../deploy/bin/publish-web-assets.mjs'))).toBe(true);
  });

  it('drops capabilities on every service, including the data ones', () => {
    // Postgres was the one service with the full default set. Its entrypoint
    // needs five capabilities to create and chown PGDATA and then drop to the
    // postgres user; it has never needed raw sockets, mknod, ptrace or module
    // loading, and the container holding every customer record is a poor place
    // to leave them.
    for (const service of ['postgres', 'redis', 'caddy']) {
      expect(serviceBlock(compose, service), `${service} keeps its capabilities`).toMatch(
        /cap_drop:\s*\n\s+- ALL/,
      );
    }
    const postgres = serviceBlock(compose, 'postgres');
    for (const capability of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETGID', 'SETUID']) {
      expect(postgres).toContain(`- ${capability}`);
    }
    // Nothing beyond those five: an added line here is a decision, not a typo.
    expect([...postgres.matchAll(/^ {6}- [A-Z_]+$/gm)]).toHaveLength(6);
  });

  it('keeps the Redis password out of the process it starts', () => {
    const redis = serviceBlock(compose, 'redis');
    // `--requirepass "$PASSWORD"` puts the password into redis-server's argv,
    // where `docker top`, a `ps` inside the container's PID namespace and
    // /proc/<pid>/cmdline can all read it. A 0600 config file cannot be read
    // that way.
    expect(redis, 'the password is passed on the command line').not.toContain('--requirepass');
    expect(redis).toContain('umask 077');
    expect(redis).toContain('redis-server /tmp/redis.conf');
    // The image's entrypoint drops to the redis user only when the command
    // starts with `redis-server`. Ours starts with `sh`, so it did not, and
    // the whole container ran as uid 0.
    expect(redis, 'redis runs as root').toMatch(/^ {4}user: redis$/m);
  });

  it('takes its image as a digest reference that must be supplied', () => {
    // `:?` makes a missing value a hard error rather than an empty string,
    // which compose would otherwise happily interpolate into an image name.
    const uses = [...compose.matchAll(/image: \$\{NEXA_IMAGE:\?/g)];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(compose, 'the deployment can run a floating tag').not.toMatch(/image:.*:latest/);
  });

  it('pins every third-party image by digest', () => {
    // A tag is a pointer somebody else can move. Three of these images are
    // outside this repository's control entirely.
    const images = [...compose.matchAll(/^\s+image: ([a-z0-9./-]+:[^\s@]+@?[^\s]*)$/gm)].map(
      (m) => m[1] as string,
    );
    const external = images.filter((image) => !image.startsWith('${'));
    expect(external.length).toBeGreaterThanOrEqual(3);
    for (const image of external) {
      expect(image, `${image} is not pinned by digest`).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
  });

  it('restarts the long-running services after a host reboot', () => {
    // The reboot requirement, met by Compose rather than by a systemd unit
    // that could disagree with it.
    for (const service of ['postgres', 'redis', 'caddy']) {
      expect(serviceBlock(compose, service)).toMatch(/restart: unless-stopped/);
    }
    const anchor = compose.slice(0, compose.indexOf('\nservices:'));
    expect(anchor).toMatch(/restart: unless-stopped/);
    // The one-shot must NOT restart: it would loop forever republishing assets.
    expect(serviceBlock(compose, 'web-assets')).toMatch(/restart: 'no'/);
  });

  it('waits for real readiness rather than sleeping', () => {
    expect(compose).toMatch(/condition: service_healthy/);
    expect(compose).toMatch(/condition: service_completed_successfully/);
    expect(compose, 'a dependency is waited for with a sleep').not.toMatch(/sleep \d/);
  });

  it('persists the database and the certificates, and deliberately not Redis', () => {
    expect(serviceBlock(compose, 'postgres')).toMatch(/pgdata:\/var\/lib\/postgresql\/data/);
    expect(serviceBlock(compose, 'caddy')).toMatch(/caddydata:\/data/);
    // Redis holds nothing through Phase 2 — see ADR-0022. A volume would
    // persist an empty dataset and imply a durability guarantee nothing
    // relies on. The command says so rather than leaving it to be inferred.
    const redis = serviceBlock(compose, 'redis');
    expect(redis).toMatch(/--appendonly no/);
    expect(redis).not.toMatch(/redisdata:/);
  });

  it('never writes a secret into the compose file', () => {
    // Every credential arrives through an env_file the Docker daemon reads as
    // root. None is a literal here, and none is a build argument.
    expect(compose).not.toMatch(/POSTGRES_PASSWORD:\s*\S/);
    expect(compose).not.toMatch(/REDIS_PASSWORD:\s*[^$\s]/);
    expect(compose).not.toMatch(/SECRETS_KEK[:=]\s*[^$\s]/);
    expect(compose).toMatch(/env_file:/);
  });
});

describe('the CI compose overlay', () => {
  it('changes only what CI cannot have', () => {
    // If this overlay could relax a security property, every smoke test below
    // it would be testing a topology nobody deploys.
    expect(ci).not.toMatch(/privileged/);
    expect(ci).not.toMatch(/docker\.sock/);
    expect(ci).not.toMatch(/network_mode:\s*host/);
    // It must not publish the database or Redis to make a test easier.
    expect(ci).not.toMatch(/^\s{2}postgres:/m);
    expect(ci).not.toMatch(/^\s{2}redis:/m);
  });

  it('publishes the edge on loopback only', () => {
    // A GitHub runner should not be listening on the world's port 80.
    expect(ci).toMatch(/127\.0\.0\.1:\$\{NEXA_CI_HTTP_PORT:-\d+\}:80/);
    expect(ci).toMatch(/ports: !override/);
  });

  it('uses the CI Caddyfile, which imports the production routes', () => {
    expect(ci).toMatch(/Caddyfile\.ci/);
    const routes = readFileSync(join(__dirname, '../../deploy/caddy/routes.caddy'), 'utf8');
    const prod = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile'), 'utf8');
    const ciCaddy = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile.ci'), 'utf8');
    // One definition, imported twice. A CI edge that restated the routes would
    // let the production file be wrong about the thing the test proves.
    expect(routes).toMatch(/^\(nexa_routes\) \{/m);
    expect(prod).toMatch(/import nexa_routes/);
    expect(ciCaddy).toMatch(/import nexa_routes/);
    // And the production file is the only one that turns HTTPS on.
    expect(ciCaddy).toMatch(/auto_https off/);
    expect(prod).not.toMatch(/auto_https off/);
  });
});

describe('the CI overlay leaves the edge health checks alone', () => {
  const ci = readFileSync(join(__dirname, '../../deploy/compose.ci.yml'), 'utf8');
  const ciCaddyfile = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile.ci'), 'utf8');

  it('does not replace the healthcheck command', () => {
    // It did, and Caddyfile.ci also had no internal health site — so the
    // production healthcheck was executed by NOTHING: not by the smoke tests,
    // not by the unit tests. The regression it exists for (the Web Admin
    // one-shot exiting while the API stays healthy, leaving the edge with
    // nothing to serve) was caught by CI the first time and would not have
    // been caught again.
    const caddyBlock = ci.slice(ci.indexOf('  caddy:'));
    const healthcheck = caddyBlock.slice(caddyBlock.indexOf('healthcheck:'));
    expect(healthcheck, 'the CI overlay overrides the healthcheck command').not.toMatch(
      /^\s+test:/m,
    );
  });

  it('serves the internal health site the production check probes', () => {
    // Plain HTTP on the container's own loopback: something CI genuinely can
    // have, unlike DNS and a certificate. That is why the command above is not
    // overridden.
    expect(ciCaddyfile).toMatch(/http:\/\/127\.0\.0\.1:8080 \{/);
    const site = ciCaddyfile.slice(ciCaddyfile.indexOf('http://127.0.0.1:8080 {'));
    expect(site).toMatch(/import nexa_routes/);
  });
});

describe('the production Caddy routing', () => {
  const routes = readFileSync(join(__dirname, '../../deploy/caddy/routes.caddy'), 'utf8');

  it('matches the API before falling back to the SPA', () => {
    // `handle` blocks are first-match. Reversed, every API call would be
    // answered with index.html and a 200 — the admin panel receiving HTML
    // where it expected JSON, which fails in the least legible way available.
    const apiAt = routes.indexOf('@api path /api/*');
    const healthAt = routes.indexOf('@health path /health/*');
    const fallbackAt = routes.indexOf('try_files {path} /index.html');
    expect(apiAt).toBeGreaterThan(-1);
    expect(healthAt).toBeGreaterThan(-1);
    expect(apiAt).toBeLessThan(fallbackAt);
    expect(healthAt).toBeLessThan(fallbackAt);
  });

  it('routes the Telegram webhook to the API, never to the SPA', () => {
    // The controller is at `/telegram/webhook/:botInstanceId` and there is no
    // global route prefix, so the path is NOT under /api. Without its own
    // handle block it falls to the SPA fallback, which answers index.html
    // with 200 — and 200 is precisely how Telegram is told an update was
    // accepted. Every update would be acknowledged and discarded silently.
    const telegramAt = routes.indexOf('@telegram path /telegram/webhook/*');
    const fallbackAt = routes.indexOf('try_files {path} /index.html');
    expect(telegramAt, 'the webhook path has no handle block').toBeGreaterThan(-1);
    expect(telegramAt).toBeLessThan(fallbackAt);

    // And it must reach the API rather than being served from disk.
    const block = routes.slice(telegramAt, routes.indexOf('@assets path'));
    expect(block).toMatch(/reverse_proxy api:3000/);
    expect(block, 'the webhook block serves files').not.toMatch(/file_server|root \*/);
  });

  it('matches the real controller path, not a guess at it', () => {
    // The route in the Caddyfile and the route in the controller are two
    // copies of one fact. This is the test that notices when one moves.
    const controller = readFileSync(
      join(__dirname, '../../apps/api/src/surfaces/telegram/webhook.controller.ts'),
      'utf8',
    );
    const declared = /@Post\('([^']+)'\)/.exec(controller)?.[1];
    expect(declared, 'the webhook controller no longer declares a @Post path').toBeTruthy();
    // `/telegram/webhook/:botInstanceId` must be covered by the Caddy matcher
    // `/telegram/webhook/*`.
    const prefix = declared!.replace(/\/:[^/]+$/, '');
    expect(routes).toContain(`@telegram path ${prefix}/*`);
  });

  it('proxies to the api service by name, never to a host port', () => {
    expect(routes).toMatch(/reverse_proxy api:3000/);
    expect(routes).not.toMatch(/reverse_proxy .*(127\.0\.0\.1|localhost)/);
  });

  it('adds no headers to proxied API responses', () => {
    // The API sets its own — a `default-src 'none'` CSP correct for JSON,
    // HSTS, nosniff, no-store on authenticated responses. Headers here would
    // duplicate or override the stricter ones.
    const apiBlock = routes.slice(routes.indexOf('@api path'), routes.indexOf('@assets path'));
    expect(apiBlock).not.toMatch(/^\s+header /m);
  });

  it('gives the document a real content security policy', () => {
    expect(routes).toMatch(/Content-Security-Policy .*default-src 'self'/);
    expect(routes).toMatch(/frame-ancestors 'none'/);
    expect(routes).toMatch(/object-src 'none'/);
  });

  it('never caches index.html and always caches hashed assets', () => {
    // index.html names the hashed bundles; a cached copy points at files the
    // next release no longer has.
    expect(routes).toMatch(/Cache-Control "no-store"/);
    expect(routes).toMatch(/Cache-Control "public, max-age=31536000, immutable"/);
  });

  it('health-checks the edge through the real routing, not through Caddy itself', () => {
    const prod = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile'), 'utf8');
    // A loopback request on :80 carries Host: 127.0.0.1, which matches no site
    // block in production — the only site is the operator's domain — so it
    // says nothing about whether the deployment routes. The internal site
    // imports the SAME snippet the public one does.
    expect(prod).toMatch(/http:\/\/127\.0\.0\.1:8080 \{/);
    const internal = prod.slice(prod.indexOf('http://127.0.0.1:8080 {'));
    expect(internal).toMatch(/import nexa_routes/);
    // Loopback INSIDE the container: not published by compose, and not
    // reachable from the other containers on the edge network either.
    expect(prod, 'the health site binds all interfaces').not.toMatch(/^http:\/\/:8080/m);

    const caddy = serviceBlock(compose, 'caddy');
    expect(caddy).toContain('127.0.0.1:8080/');
    expect(caddy, 'the healthcheck still asks Caddy about Caddy').not.toContain(
      '127.0.0.1:80/health/live',
    );
    expect(caddy, 'the healthcheck does not prove the bundle is served').toMatch(
      /127\.0\.0\.1:8080\/ /,
    );
    expect(compose, 'the health port is published').not.toMatch(/['"]8080:8080['"]/);
  });

  it('turns the Caddy admin API off in production as well as in CI', () => {
    const prod = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile'), 'utf8');
    const ci = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile.ci'), 'utf8');
    // Nothing reconfigures Caddy at runtime here — botctl restarts the
    // container — so the admin endpoint has no consumer in this deployment.
    expect(prod).toMatch(/^\s*admin off$/m);
    expect(ci).toMatch(/^\s*admin off$/m);
  });

  it('serves the entry document from the activated release and its assets from the pool', () => {
    // Two roots, and the difference between them is the whole reason the
    // publisher has a pool. `current` is a symlink swapped by one rename(2),
    // so a request for index.html is served entirely out of one release. But
    // loading the Web Admin is index.html AND the assets it names, and a
    // browser that fetched the document a millisecond before a deployment
    // asks for those assets a millisecond after it. Rooting /assets/* at the
    // activated release makes those 404s. The pool holds the union over the
    // retained releases, so both sides of a swap load.
    expect(routes, 'the served root is not the activated release').not.toMatch(
      /^\s*root \* \/srv\/web$/m,
    );
    const assetsAt = routes.indexOf('@assets path /assets/*');
    const fallbackAt = routes.indexOf('try_files {path} /index.html');
    expect(assetsAt).toBeGreaterThan(-1);
    expect(assetsAt).toBeLessThan(fallbackAt);
    expect(routes.slice(assetsAt, fallbackAt)).toMatch(/root \* \/srv\/web\/pool$/m);
    expect(routes.slice(fallbackAt - 400, fallbackAt)).toMatch(/root \* \/srv\/web\/current$/m);
  });

  it('leaves HSTS to the production site block', () => {
    // An HSTS header from the plain-HTTP CI origin would pin `localhost` to
    // HTTPS in the runner's client for a year.
    expect(routes).not.toMatch(/Strict-Transport-Security/);
    const prod = readFileSync(join(__dirname, '../../deploy/caddy/Caddyfile'), 'utf8');
    expect(prod).toMatch(/Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
  });
});
