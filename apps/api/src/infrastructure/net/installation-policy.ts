import type { AppConfig } from '../config/config.schema.js';
import { infrastructureHosts } from './infrastructure-hosts.js';
import type { UrlPolicyOptions } from './url-policy.js';

/**
 * The URL policy this installation runs, from its configuration.
 *
 * One function, used by the container and by the deployment smoke test alike,
 * so what the process refuses and what the test proves it refuses are the
 * same computation.
 *
 * The installation's own data network is denied FIRST and unconditionally.
 * It reaches the process as `NEXA_DATA_SUBNET`, set by compose from the same
 * file and the same expression that create the network — so an installation
 * whose nexa.env predates the policy is protected on its first start under a
 * compose file that passes it, and an operator who moved the subnet keeps the
 * protection without copying the value into a second file. Whatever extra
 * networks the operator listed in `PANEL_HTTP_DENIED_SUBNETS` come after;
 * nothing in that list can take the installation subnet out. Private space
 * beyond both stays reachable, because a self-hosted panel on a LAN is the
 * product.
 */
export function panelUrlPolicy(
  config: Pick<
    AppConfig,
    | 'PANEL_HTTP_ALLOW_LOOPBACK'
    | 'NEXA_DATA_SUBNET'
    | 'PANEL_HTTP_DENIED_SUBNETS'
    | 'DATABASE_URL'
    | 'REDIS_URL'
  > &
    Partial<Pick<AppConfig, 'NEXA_EDGE_SUBNET'>>,
  allowList?: { current(): readonly string[] },
): UrlPolicyOptions {
  return {
    allowLoopback: config.PANEL_HTTP_ALLOW_LOOPBACK,
    deniedSubnets: [
      ...(config.NEXA_DATA_SUBNET === undefined ? [] : [config.NEXA_DATA_SUBNET]),
      ...config.PANEL_HTTP_DENIED_SUBNETS,
    ],
    deniedHosts: infrastructureHosts([config.DATABASE_URL, config.REDIS_URL]),
    // R12 F2 item 4: Docker's own networks, whose gateways are this host — refused unless
    // the owner allow-lists a target (`security.outbound_private_targets`).
    dockerSubnets: [
      ...(config.NEXA_EDGE_SUBNET === undefined ? [] : [config.NEXA_EDGE_SUBNET]),
      ...DOCKER_DEFAULT_BRIDGE_SUBNETS,
    ],
    ...(allowList === undefined ? {} : { allowedPrivateTargets: () => allowList.current() }),
  };
}

/**
 * Docker's default bridge (`docker0`), whose gateway `172.17.0.1` is the host. Refused by
 * default beside the installation's own edge network; networks other compose projects on
 * this host created can be added to `PANEL_HTTP_DENIED_SUBNETS`.
 */
export const DOCKER_DEFAULT_BRIDGE_SUBNETS: readonly string[] = ['172.17.0.0/16'];
