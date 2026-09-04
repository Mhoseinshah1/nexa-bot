/**
 * The hostnames this installation's own data services answer to.
 *
 * Derived from the connection strings the process was configured with rather
 * than hardcoded, so an installation whose database or cache is somewhere
 * other than the compose default is covered too, and an operator who moves one
 * does not silently lose the protection.
 *
 * This is the TEXTUAL half of the infrastructure carve-out and is never the
 * whole of it: `PANEL_HTTP_DENIED_SUBNETS` refuses the data network after
 * resolution, which is what catches a name that points into it without being
 * one of these. Either alone has a gap — a name absent from this list can
 * still resolve inside the subnet, and a managed database on a public address
 * is in no denied subnet at all.
 *
 * Parsed defensively: a string that is not a URL contributes nothing rather
 * than throwing at boot, because the connection itself will fail with a far
 * better message than anything raised from here.
 */
export function infrastructureHosts(connectionStrings: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const raw of connectionStrings) {
    try {
      const { hostname } = new URL(raw);
      // A bracketed IPv6 literal arrives as `[::1]`; the policy compares
      // hostnames unbracketed.
      if (hostname !== '') hosts.push(hostname.replace(/^\[|\]$/g, ''));
    } catch {
      // Not parseable; the connection will say so far more usefully.
    }
  }
  return hosts;
}
