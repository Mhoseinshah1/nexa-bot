import {
  HEALTH_ROUTES,
  healthInfoResponseSchema,
  healthReadyResponseSchema,
  type HealthInfoResponse,
  type HealthReadyResponse,
} from '@nexa/contracts';

/**
 * The typed API client.
 *
 * Responses are PARSED with the same zod schemas the server validates against.
 * A change to a shape in `@nexa/contracts` is therefore a type error here and
 * in the API at the same time — which is the whole reason the seam exists.
 */

async function get<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body: unknown = await response.json();
  // A 503 from readiness is a valid, well-shaped answer, not a transport error.
  if (!response.ok && response.status !== 503) {
    throw new Error(`Request to ${path} failed with ${response.status}`);
  }
  return schema.parse(body);
}

export function fetchReadiness(): Promise<HealthReadyResponse> {
  return get(HEALTH_ROUTES.ready, healthReadyResponseSchema);
}

export function fetchInfo(): Promise<HealthInfoResponse> {
  return get(HEALTH_ROUTES.info, healthInfoResponseSchema);
}
