import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * R12 F2 item 2: `/health/ready` is not reachable from the internet through the edge.
 *
 * Read from the files production deploys, because the property is their ORDER: Caddy's
 * `handle` blocks are first-match, so a refusal placed after `@health path /health/*` would
 * never run, and the readiness probes would stay one anonymous GET away.
 */
describe('the edge keeps /health/ready private', () => {
  const routes = readFileSync(join(__dirname, '../../deploy/caddy/routes.caddy'), 'utf8');
  const compose = parse(readFileSync(join(__dirname, '../../deploy/compose.yml'), 'utf8')) as {
    services: Record<string, { environment?: Record<string, string>; healthcheck?: unknown }>;
    'x-app-common': { environment: Record<string, string> };
  };

  it('answers /health/ready from anywhere but loopback and the edge network with a 404', () => {
    const block =
      /\t@health_ready_public \{\n([\s\S]*?)\n\t\}\n\thandle @health_ready_public \{\n([\s\S]*?)\n\t\}/.exec(
        routes,
      );
    expect(block, 'no refusal block for /health/ready').not.toBeNull();
    const [, matcher = '', handler = ''] = block ?? [];
    expect(matcher).toMatch(/^\t\tpath \/health\/ready$/m);
    expect(matcher).toMatch(
      /^\t\tnot remote_ip 127\.0\.0\.0\/8 ::1 \{\$NEXA_EDGE_SUBNET:172\.29\.0\.0\/24\}$/m,
    );
    expect(handler).toMatch(/^\t\trespond 404$/m);
  });

  it('places the refusal BEFORE the block that proxies /health/*', () => {
    const refusalAt = routes.indexOf('\thandle @health_ready_public {');
    const proxyAt = routes.indexOf('\thandle @health {');
    expect(refusalAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeLessThan(proxyAt);
    // /health/live stays public: the edge's own check and the operator's browser use it.
    expect(routes).not.toMatch(/path \/health\/live/);
  });

  it('gives Caddy the edge subnet from the expression that creates the network', () => {
    expect(compose.services.caddy?.environment?.NEXA_EDGE_SUBNET).toBe(
      '${NEXA_EDGE_SUBNET:-172.29.0.0/24}',
    );
    // And every application role: the outbound URL policy refuses it (item 4).
    expect(compose['x-app-common'].environment.NEXA_EDGE_SUBNET).toBe(
      '${NEXA_EDGE_SUBNET:-172.29.0.0/24}',
    );
  });

  it('keeps the api container check on the API itself, not through the edge', () => {
    expect(JSON.stringify(compose.services.api?.healthcheck)).toContain(
      'http://127.0.0.1:3000/health/ready',
    );
  });
});
