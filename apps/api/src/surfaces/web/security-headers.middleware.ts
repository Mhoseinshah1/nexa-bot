import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Response security headers.
 *
 * Phase 0 shipped none, which was defensible while there was no authentication
 * and nothing to steal. There is now a session cookie, so the headers that stop
 * a page from being framed, sniffed or used to leak a URL are no longer
 * optional.
 *
 * This API serves JSON only. `default-src 'none'` is therefore exactly right
 * and not merely cautious: there is no legitimate script, style, image or frame
 * in any response, so a policy allowing any of them could only ever help an
 * injected one.
 */
export type Middleware = (
  request: FastifyRequest['raw'],
  response: FastifyReply['raw'],
  next: () => void,
) => void;

/** Built with the environment it needs, rather than reading it back at runtime. */
export function securityHeaders(isProduction: boolean): Middleware {
  return (_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    // The full URL of an admin endpoint can carry an entity id. It has no
    // business travelling to whatever a browser navigates to next.
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');

    // Authenticated responses carry administrator data and, on login, a session
    // token. None of it may sit in a shared cache or a browser's back-forward
    // cache after sign-out.
    //
    // Applied unconditionally rather than to /api/ only. Two reasons: this
    // process serves JSON and nothing else, so there is no response worth
    // caching; and the raw request URL seen here is prefix-stripped by the
    // middleware mount, so a path test silently matched nothing — the header
    // was absent from exactly the responses it was written for.
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    response.setHeader('Pragma', 'no-cache');

    // Only over TLS, and only in production: sending it from a plain-HTTP
    // development server would pin a developer's browser to HTTPS on localhost.
    if (isProduction) {
      response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    next();
  };
}
