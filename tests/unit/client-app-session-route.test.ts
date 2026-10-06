import { describe, expect, it } from 'vitest';
import { CLIENT_APP_ROUTES } from '@nexa/contracts';
import {
  ClientAppController,
  sessionRoute,
} from '../../apps/api/src/surfaces/web/client-app.controller';

/**
 * C2 (master program 2026-10-06): «افزودن ویدیو از تلگرام» said «این درخواست دیگر وجود ندارد»
 * a few seconds after it opened. The capture session's 15-minute life was never the cause: the
 * server declared its two-parameter routes with the parameters SWAPPED, so the page's first poll
 * looked the app id up as a session id. `route-registration.test.ts` used one id for both
 * segments, so a swapped declaration still answered there. These tests use two different ids
 * and read the path Nest actually registers.
 */

/** Matches a concrete path against a Nest pattern and returns the bound parameters. */
function bind(pattern: string, path: string): Record<string, string> | null {
  const names: string[] = [];
  const source = pattern.replace(/:([A-Za-z]+)/gu, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  const match = new RegExp(`^${source}$`, 'u').exec(path);
  if (match === null) return null;
  return Object.fromEntries(names.map((name, index) => [name, match[index + 1] as string]));
}

/** `@nestjs/common/constants` PATH_METADATA; the package is the API's, not the tests'. */
const PATH_METADATA = 'path';
const APP = 'app-0b1c';
const SESSION = 'session-9f2e';

describe('the client-app video session routes', () => {
  it('declares :id in the app slot and :sessionId in the session slot', () => {
    expect(sessionRoute(CLIENT_APP_ROUTES.videoSession)).toBe(
      '/client-apps/:id/video-sessions/:sessionId',
    );
    expect(sessionRoute(CLIENT_APP_ROUTES.videoSessionCancel)).toBe(
      '/client-apps/:id/video-sessions/:sessionId/cancel',
    );
  });

  it('binds the page’s own URLs to the right parameters, in the routes Nest registered', () => {
    const proto = ClientAppController.prototype as unknown as Record<string, object>;
    const cases = [
      ['videoSession', CLIENT_APP_ROUTES.videoSession(APP, SESSION)],
      ['cancelVideoSession', CLIENT_APP_ROUTES.videoSessionCancel(APP, SESSION)],
    ] as const;
    for (const [handler, path] of cases) {
      const registered = Reflect.getMetadata(PATH_METADATA, proto[handler] as object) as string;
      expect(bind(registered, path), handler).toEqual({ id: APP, sessionId: SESSION });
    }
  });

  it('refuses a builder that does not pass each argument through once', () => {
    expect(() => sessionRoute(() => '/client-apps/x/video-sessions/y')).toThrow();
    expect(() => sessionRoute((id) => `/a/${id}/b/${id}`)).toThrow();
  });
});
