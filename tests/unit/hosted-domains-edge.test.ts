import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOSTED_DOMAIN_CHECK_PATH } from '@nexa/contracts';

const caddy = (name: string) => readFileSync(join(__dirname, '../../deploy/caddy', name), 'utf8');

/**
 * Phase 6A PR-4 — the edge's side of a hosted bot's own domain: certificates on demand, gated by
 * the API's `ask` endpoint, and that endpoint kept off the public routes.
 */
describe('the edge for hosted domains', () => {
  const production = caddy('Caddyfile');
  const routes = caddy('routes.caddy');

  it('asks the API before issuing any certificate on demand', () => {
    const ask = /on_demand_tls \{\s*ask (\S+)\s*\}/.exec(production)?.[1];
    expect(ask, 'on-demand TLS without an ask endpoint would issue for any name').toBeDefined();
    // The address is the API on the compose network, at the contract's own path.
    expect(ask).toBe(`http://api:3000${HOSTED_DOMAIN_CHECK_PATH}`);
  });

  it('serves a hosted domain with the same routes, on-demand TLS, in its own site block', () => {
    const block = production.slice(production.indexOf('\nhttps:// {'));
    expect(block).toMatch(/tls \{\s*on_demand\s*\}/);
    expect(block).toMatch(/import nexa_routes/);
    // The owner's own site keeps its managed certificate: that block is separate.
    expect(production).toMatch(/\{\$NEXA_DOMAIN\} \{/);
    // HSTS on a hosted domain does not pin its subdomains.
    expect(block).not.toMatch(/includeSubDomains/);
  });

  it('never routes the ask endpoint, and the CI edge never turns on-demand TLS on', () => {
    expect(routes).not.toContain('/internal');
    expect(routes).not.toContain(HOSTED_DOMAIN_CHECK_PATH);
    expect(caddy('Caddyfile.ci')).not.toMatch(/on_demand/);
  });
});
