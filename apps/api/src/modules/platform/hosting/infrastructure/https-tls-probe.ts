import { request } from 'node:https';
import { assertOutsideTransaction } from '../../../../infrastructure/transaction-boundary.js';
import type { HostedTlsProbe, HostedTlsProbeResult } from '../application/activation-ports.js';

const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
  'ERR_SSL_TLSV1_UNRECOGNIZED_NAME',
]);

/**
 * Phase 6A PR-4 — "SSL issued", proved by asking: an HTTPS GET of the domain's own
 * `/health/live` with the certificate VERIFIED against the system's trust store (the default;
 * nothing here ever turns verification off) and the name checked against the domain.
 *
 * The first handshake on a name the edge has no certificate for is what makes the edge's
 * on-demand TLS ask `HOSTED_DOMAIN_CHECK_PATH` and obtain one, so this probe is also what
 * triggers the issuance; it may take several seconds and is simply run again when it is not
 * ready. Redirects are not followed, the body is discarded, and the answer is a closed word.
 */
export class HttpsTlsProbe implements HostedTlsProbe {
  constructor(private readonly timeoutMs = 25_000) {}

  probe(domain: string): Promise<HostedTlsProbeResult> {
    assertOutsideTransaction('A hosted-domain HTTPS probe');
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: HostedTlsProbeResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const req = request(
        {
          host: domain,
          servername: domain,
          port: 443,
          path: '/health/live',
          method: 'GET',
          timeout: this.timeoutMs,
          rejectUnauthorized: true,
          headers: { host: domain, 'user-agent': 'nexa-hosted-activation-probe' },
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? 0;
          finish(
            status >= 200 && status < 300 ? { ok: true } : { ok: false, reason: 'BAD_RESPONSE' },
          );
        },
      );
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, reason: 'UNREACHABLE' });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          reason:
            error.code !== undefined && CERTIFICATE_CODES.has(error.code)
              ? 'CERTIFICATE'
              : 'UNREACHABLE',
        });
      });
      req.end();
    });
  }
}
