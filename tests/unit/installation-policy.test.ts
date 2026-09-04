import { describe, expect, it } from 'vitest';
import { panelUrlPolicy } from '../../apps/api/src/infrastructure/net/installation-policy';
import { checkUrl } from '../../apps/api/src/infrastructure/net/url-policy';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * The installation's own data network is denied because compose says which
 * network that is — not because a value in nexa.env happens to match it
 * (Fix B). These are the four states an upgraded installation can be in.
 */

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://nexa:pw@postgres:5432/nexa',
  REDIS_URL: 'redis://:pw@redis:6379',
  SECRETS_KEK: Buffer.from('x'.repeat(32)).toString('base64'),
  SECRETS_KEK_ID: 'k',
  AUTH_MODE: 'password',
  DEPLOYMENT_TOPOLOGY: 'direct',
};

const policyFor = (env: Record<string, string>) =>
  panelUrlPolicy(configSchema.parse({ ...base, ...env }));
const allowed = (policy: ReturnType<typeof policyFor>, url: string) =>
  checkUrl(url, policy).allowed;

describe('the installation policy', () => {
  it('denies a custom data subnet with NOTHING in nexa.env, because compose named it', () => {
    // The upgraded host: an old nexa.env with no PANEL_HTTP_DENIED_SUBNETS at
    // all, and a data subnet that is not the default.
    const policy = policyFor({ NEXA_DATA_SUBNET: '172.31.44.0/24' });
    expect(policy.deniedSubnets).toEqual(['172.31.44.0/24']);
    expect(allowed(policy, 'https://172.31.44.5:5432')).toBe(false);
    expect(allowed(policy, 'https://172.31.44.250:6379')).toBe(false);
    // Legitimate private panels, and the public internet, are unchanged.
    expect(allowed(policy, 'https://10.20.30.40:2053')).toBe(true);
    expect(allowed(policy, 'https://192.168.1.10:8443')).toBe(true);
    expect(allowed(policy, 'https://172.31.45.5:8443')).toBe(true);
    expect(allowed(policy, 'https://panel.example.com')).toBe(true);
  });

  it('keeps the infrastructure hostnames denied by name', () => {
    const policy = policyFor({ NEXA_DATA_SUBNET: '172.31.44.0/24' });
    expect(policy.deniedHosts).toEqual(['postgres', 'redis']);
    expect(allowed(policy, 'https://postgres:5432')).toBe(false);
    expect(allowed(policy, 'https://redis:6379')).toBe(false);
  });

  it("adds the operator's extra networks after the installation subnet, never instead of it", () => {
    const policy = policyFor({
      NEXA_DATA_SUBNET: '172.31.44.0/24',
      PANEL_HTTP_DENIED_SUBNETS: '10.99.0.0/16, 192.168.200.0/24',
    });
    expect(policy.deniedSubnets).toEqual(['172.31.44.0/24', '10.99.0.0/16', '192.168.200.0/24']);
    expect(allowed(policy, 'https://172.31.44.5')).toBe(false);
    expect(allowed(policy, 'https://10.99.4.4')).toBe(false);
    expect(allowed(policy, 'https://10.20.30.40:2053')).toBe(true);
  });

  it('cannot have the installation subnet configured away', () => {
    // An extras list, however long or however empty, does not remove it.
    for (const extras of ['', '10.0.0.0/8']) {
      const policy = policyFor({
        NEXA_DATA_SUBNET: '172.31.44.0/24',
        PANEL_HTTP_DENIED_SUBNETS: extras,
      });
      expect(policy.deniedSubnets?.[0]).toBe('172.31.44.0/24');
    }
  });

  it('denies nothing by subnet when no network is named, and hardcodes no default', () => {
    // Outside compose there is no data network to name. What is NOT here is
    // a built-in 172.29.1.0/24: the protection comes from the deployment
    // naming its network, not from a constant that happens to match one.
    const policy = policyFor({});
    expect(policy.deniedSubnets).toEqual([]);
    expect(allowed(policy, 'https://172.29.1.5')).toBe(true);
  });

  it('refuses a malformed subnet at boot rather than silently denying nothing', () => {
    expect(() => configSchema.parse({ ...base, NEXA_DATA_SUBNET: 'not-a-cidr' })).toThrow(/CIDR/);
    expect(
      configSchema.parse({ ...base, NEXA_DATA_SUBNET: '  ' }).NEXA_DATA_SUBNET,
    ).toBeUndefined();
  });
});
