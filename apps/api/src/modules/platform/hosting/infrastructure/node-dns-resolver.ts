import { Resolver } from 'node:dns/promises';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type { HostedDnsResolver } from '../application/activation-ports.js';
import type { DnsObservation } from '../domain/hosted-domain.js';

const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'ENOENT', 'NXDOMAIN']);

function clean(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * Phase 6A PR-4 — the domain check's DNS, over `node:dns` with a hard timeout.
 *
 * A fresh `Resolver` per instance with `timeout` and `tries` bounded, and a race against a
 * deadline of its own, so a black-holed name server can never hold a request. "No such name",
 * "no CNAME" and "no addresses" are EMPTY answers (the domain simply does not point here
 * yet); a timeout or a server failure THROWS, which the service reports as a lookup failure
 * rather than as "not pointed" — the owner is told to try again, not that the DNS is wrong.
 */
export class NodeDnsResolver implements HostedDnsResolver {
  private readonly resolver: Resolver;

  constructor(private readonly timeoutMs = 4000) {
    this.resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  }

  async observe(domain: string): Promise<DnsObservation> {
    const [cname, v4, v6] = await Promise.all([
      this.lookup(() => this.resolver.resolveCname(domain)),
      this.lookup(() => this.resolver.resolve4(domain)),
      this.lookup(() => this.resolver.resolve6(domain)),
    ]);
    return { cname: cname.map(clean), addresses: [...v4, ...v6] };
  }

  async addressesOf(hostname: string): Promise<readonly string[]> {
    const [v4, v6] = await Promise.all([
      this.lookup(() => this.resolver.resolve4(hostname)),
      this.lookup(() => this.resolver.resolve6(hostname)),
    ]);
    return [...v4, ...v6];
  }

  private async lookup(run: () => Promise<string[]>): Promise<string[]> {
    assertOutsideTransaction('A hosted-domain DNS lookup');
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('dns deadline'), { code: 'ETIMEOUT' })),
        this.timeoutMs + 1000,
      );
    });
    try {
      return await Promise.race([run(), deadline]);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === 'string' && NO_ANSWER.has(code)) return [];
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
