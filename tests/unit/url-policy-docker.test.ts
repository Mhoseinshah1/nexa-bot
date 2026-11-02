import { describe, expect, it } from 'vitest';
import {
  settingDefinition,
  OUTBOUND_PRIVATE_TARGETS_SETTING_KEY,
  type SettingKey,
} from '@nexa/contracts';
import { addressAllowed, checkUrl } from '../../apps/api/src/infrastructure/net/url-policy';
import {
  DOCKER_DEFAULT_BRIDGE_SUBNETS,
  panelUrlPolicy,
} from '../../apps/api/src/infrastructure/net/installation-policy';
import {
  OutboundAllowList,
  parseOutboundAllowList,
} from '../../apps/api/src/infrastructure/net/outbound-allow-list';
import { configSchema } from '../../apps/api/src/infrastructure/config/config.schema';

/**
 * R12 F2 item 4: panels, payment gateways and custom bridges cannot be pointed at Docker's
 * own networks — the installation's edge network and the default bridge, whose gateways
 * are the HOST — unless the owner allow-lists the target. Private space beyond those stays
 * reachable (a LAN panel is the product), and the data network is never reachable.
 */
const EDGE = '172.29.0.0/24';
const DATA = '172.29.1.0/24';

function policy(allowed: readonly string[] = []) {
  let current = allowed;
  const options = panelUrlPolicy(
    {
      PANEL_HTTP_ALLOW_LOOPBACK: false,
      NEXA_DATA_SUBNET: DATA,
      NEXA_EDGE_SUBNET: EDGE,
      PANEL_HTTP_DENIED_SUBNETS: [],
      DATABASE_URL: 'postgres://nexa:p@postgres:5432/nexa',
      REDIS_URL: 'redis://redis:6379',
    },
    { current: () => current },
  );
  return {
    options,
    allow: (next: readonly string[]) => {
      current = next;
    },
  };
}

describe('the outbound URL policy and Docker networks', () => {
  it('refuses the edge network, its host gateway and the default bridge by default', () => {
    const { options } = policy();
    for (const host of ['172.29.0.1', '172.29.0.5', '172.17.0.1', '172.17.3.4']) {
      const verdict = checkUrl(`http://${host}:2053/`, options);
      expect(verdict, host).toEqual({ allowed: false, refusal: 'INFRASTRUCTURE_TARGET' });
      // And on the dialled address, which is the check DNS cannot get around.
      expect(addressAllowed(host, options).allowed, host).toBe(false);
      expect(addressAllowed(`::ffff:${host}`, options).allowed, host).toBe(false);
    }
    expect(DOCKER_DEFAULT_BRIDGE_SUBNETS).toEqual(['172.17.0.0/16']);
  });

  it('still reaches private space outside them: a LAN panel is the product', () => {
    const { options } = policy();
    for (const host of ['10.0.0.5', '192.168.1.10', '172.16.4.4', '172.18.0.2', '172.29.2.9']) {
      expect(checkUrl(`http://${host}:2053/`, options).allowed, host).toBe(true);
    }
  });

  it('re-opens exactly what the owner lists, and nothing else', () => {
    const { options, allow } = policy(['172.17.0.1']);
    expect(checkUrl('http://172.17.0.1:8000/', options).allowed).toBe(true);
    expect(checkUrl('http://172.17.0.2:8000/', options).allowed).toBe(false);
    expect(checkUrl('http://172.29.0.1:8000/', options).allowed).toBe(false);
    // A CIDR, and a change takes effect on the next check without rebuilding the policy.
    allow(['172.29.0.0/24']);
    expect(addressAllowed('172.29.0.1', options).allowed).toBe(true);
    expect(addressAllowed('172.17.0.1', options).allowed).toBe(false);
  });

  it('never re-opens the data network, the database or Redis, whatever the owner lists', () => {
    const { options } = policy(['172.29.1.0/24', '172.29.0.0/16', '0.0.0.0/0']);
    expect(checkUrl('http://172.29.1.5:5432/', options)).toEqual({
      allowed: false,
      refusal: 'INFRASTRUCTURE_TARGET',
    });
    expect(checkUrl('http://postgres:5432/', options)).toEqual({
      allowed: false,
      refusal: 'INFRASTRUCTURE_TARGET',
    });
    // Link-local (cloud metadata) is not a Docker network and stays refused as well.
    expect(checkUrl('http://169.254.169.254/', options).allowed).toBe(false);
  });

  it('reads the edge subnet from configuration, and leaves it out when unset', () => {
    expect(configSchema.shape.NEXA_EDGE_SUBNET.parse('172.30.0.0/24')).toBe('172.30.0.0/24');
    expect(configSchema.shape.NEXA_EDGE_SUBNET.safeParse('not-a-cidr').success).toBe(false);
    const withoutEdge = panelUrlPolicy({
      PANEL_HTTP_ALLOW_LOOPBACK: false,
      NEXA_DATA_SUBNET: DATA,
      PANEL_HTTP_DENIED_SUBNETS: [],
      DATABASE_URL: 'postgres://nexa:p@postgres:5432/nexa',
      REDIS_URL: 'redis://redis:6379',
    });
    expect(withoutEdge.dockerSubnets).toEqual(['172.17.0.0/16']);
    // Without an allow-list source nothing is re-opened.
    expect(checkUrl('http://172.17.0.1/', withoutEdge).allowed).toBe(false);
  });
});

describe('the owner allow-list setting', () => {
  const schema = settingDefinition(OUTBOUND_PRIVATE_TARGETS_SETTING_KEY as SettingKey).schema;

  it('accepts addresses and CIDRs, empty by default, and refuses anything else', () => {
    expect(settingDefinition(OUTBOUND_PRIVATE_TARGETS_SETTING_KEY as SettingKey).defaultValue).toBe(
      '',
    );
    for (const ok of ['', '172.17.0.1', '172.17.0.1, 172.29.0.0/24', 'fd00::1/64']) {
      expect(schema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['172.17.0.300', 'panel.example.com', '10.0.0.0/33', '1.2.3.4/8/9', ',']) {
      expect(schema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('is held in memory, fails closed, and keeps the last list when a read fails', async () => {
    expect(parseOutboundAllowList(' 172.17.0.1 ,, 10.0.0.0/8 ')).toEqual([
      '172.17.0.1',
      '10.0.0.0/8',
    ]);
    let value: string | null | Error = null;
    const warnings: string[] = [];
    const list = new OutboundAllowList(
      {
        read: async () => {
          if (value instanceof Error) throw value;
          return value;
        },
      },
      { warn: (_context, message) => warnings.push(message) },
    );
    expect(list.current()).toEqual([]);
    await list.refresh();
    expect(list.current()).toEqual([]);
    value = '172.17.0.1';
    await list.refresh();
    expect(list.current()).toEqual(['172.17.0.1']);
    value = new Error('database unreachable');
    await list.refreshQuietly();
    expect(list.current()).toEqual(['172.17.0.1']);
    expect(warnings).toHaveLength(1);
  });
});
