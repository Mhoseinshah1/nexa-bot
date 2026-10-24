import { Readable } from 'node:stream';
import { PayloadTooLargeException } from '@nestjs/common';
import type { FastifyInstance } from 'fastify';

/**
 * The RAW bytes of a gateway webhook, kept beside the parsed body.
 *
 * TetraPay signs `t + "." + raw_body` (`docs/tetrapay-gateway-audit.md` §5.6). A body
 * re-serialised from parsed JSON is not the bytes that were signed - key order, whitespace and
 * number spelling all differ - so the signature can only be checked against what was received.
 * Fastify has already parsed the body by the time a handler runs, so the bytes are captured in
 * a `preParsing` hook for the gateway webhook routes ONLY, and the stream is handed on
 * unchanged for the JSON parser.
 *
 * Bounded: the hook counts bytes as they arrive and refuses past `limit` (413) without
 * buffering the rest, so it is no wider than the route's own body limit. Nothing is stored
 * anywhere but on the request object, for the life of the request.
 */
const RAW_BODY = Symbol('nexa.rawBody');

interface WithRawBody {
  [RAW_BODY]?: Buffer;
}

/** The raw body of a gateway webhook request, or null when none was captured. */
export function rawBodyOf(request: unknown): Buffer | null {
  const kept = (request as WithRawBody | null | undefined)?.[RAW_BODY];
  return kept ?? null;
}

export function installRawBodyCapture(
  fastify: Pick<FastifyInstance, 'addHook'>,
  routePrefix: string,
  limitBytes: number,
): void {
  fastify.addHook('preParsing', async (request, _reply, payload) => {
    const url = request.routeOptions.url ?? '';
    if (!url.startsWith(routePrefix)) return payload;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of payload as AsyncIterable<Buffer | string>) {
      const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += piece.length;
      if (size > limitBytes) {
        // An HttpException, because the application's exception filter maps those to their own
        // status; a bare Error with a `statusCode` field is "unhandled" there and answers 500.
        throw new PayloadTooLargeException('Request body is too large');
      }
      chunks.push(piece);
    }
    const body = Buffer.concat(chunks);
    (request as unknown as WithRawBody)[RAW_BODY] = body;
    const replay = Readable.from([body]);
    // Fastify checks a declared content-length against the bytes the parser received.
    (replay as Readable & { receivedEncodedLength?: number }).receivedEncodedLength = body.length;
    return replay;
  });
}
