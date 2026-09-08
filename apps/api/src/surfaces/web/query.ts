import { CONTROL_ERROR_CODES, errors } from '@nexa/contracts';

/**
 * The query string, with every parameter proved to be a single value.
 *
 * `@Query()` was typed `Record<string, string | undefined>` in both list
 * controllers and that was a LIE. Fastify's default parser yields an ARRAY
 * when a key repeats, so `?severity=ERROR&severity=WARN` handed
 * `query.severity.split(',')` an array, and the `TypeError` fell through the
 * error filter as a `500 internal.unhandled` — in the very expression that had
 * just been rewritten to stop a bad parameter becoming one. Measured on
 * fastify 5.12.1, with the adapter this application constructs:
 *
 *     {"severity":["ERROR","WARN"],"code":"a","limit":""}
 *
 * Every other parameter survived that input only because it happened to reach
 * a zod schema before anything called a string method on it. That is not a
 * rule, it is luck, and it is the shape of defect this branch keeps finding:
 * correct where the author was looking, absent one expression over.
 *
 * So the type is honest now and this is the only way to get from it to the
 * one the handlers want. A repeated parameter is a malformed request and is
 * refused as one — once, for every parameter, on every list endpoint.
 */
export function singleValued(query: Record<string, unknown>): Record<string, string | undefined> {
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && typeof value !== 'string') {
      throw errors.validation(
        CONTROL_ERROR_CODES.INVALID_VALUE,
        // Names the accepted spelling. `severity` is genuinely multi-valued
        // and takes a COMMA-SEPARATED list, so the repeated-key encoding that
        // `URLSearchParams.append` and most HTTP clients emit is refused here
        // — and a refusal that does not say what to send instead leaves the
        // caller to find the comma form by reading the source.
        `The \`${name}\` query parameter was supplied more than once. ` +
          'Supply it once; a filter that takes several values takes them ' +
          'comma-separated.',
        { [name]: value },
      );
    }
  }
  return query as Record<string, string | undefined>;
}
