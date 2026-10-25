import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Controller, Get, Inject, Param, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { MINIAPP_ERROR_CODES, MINIAPP_PATH, errors } from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';

/**
 * The mini app's document, served by the API under its own path (Round 9, C5).
 *
 * The built files are read ONCE, at construction, into memory, keyed by their path under
 * the build directory — so a request names a key in a map and never a path on disk: there
 * is no traversal to defend because no request reaches the file system. A file the build
 * did not produce is a 404.
 *
 * Its headers are the document's, not the API's: the API's own `default-src 'none';
 * frame-ancestors 'none'` and `X-Frame-Options: DENY` are right for JSON and would stop
 * Telegram from showing the app at all. So this route replaces them with the Web Admin's
 * policy plus exactly what a Telegram Mini App needs: Telegram's `telegram-web-app.js`
 * script, and being framed by Telegram's web clients (`web.telegram.org` runs a mini app in
 * an iframe; the phone and desktop apps use a web view, which is not a frame).
 */
export const MINIAPP_DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  'frame-ancestors https://web.telegram.org https://*.telegram.org',
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

interface StaticFile {
  readonly bytes: Buffer;
  readonly type: string;
}

/** Every file of the build, by its slash-separated path under `dir`. Source maps are not served. */
export function loadMiniAppBuild(dir: string): ReadonlyMap<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  if (dir === '') return files;
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    const key = relative(dir, full).split(sep).join('/');
    const dot = key.lastIndexOf('.');
    const type = dot === -1 ? undefined : TYPES[key.slice(dot)];
    if (type === undefined) continue;
    files.set(key, { bytes: readFileSync(full), type });
  }
  return files;
}

@Controller(MINIAPP_PATH)
export class MiniAppStaticController {
  private readonly files: ReadonlyMap<string, StaticFile>;

  constructor(@Inject(CONTAINER) private readonly container: Container) {
    this.files = loadMiniAppBuild(container.config.MINIAPP_DIST_DIR);
  }

  /** Hashed names: cached for a year, like the Web Admin's assets. */
  @Get('assets/:name')
  async asset(@Param('name') name: string, @Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, `assets/${name}`, 'public, max-age=31536000, immutable');
  }

  @Get('fonts/:name')
  async font(@Param('name') name: string, @Res() reply: FastifyReply): Promise<void> {
    await this.send(reply, `fonts/${name}`, 'public, max-age=604800');
  }

  /** The app for one bot, at `/miniapp/<botInstanceId>/` and any client route under it. */
  @Get(':botInstanceId')
  async document(
    @Param('botInstanceId') botInstanceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.page(botInstanceId, reply);
  }

  @Get(':botInstanceId/*')
  async deepLink(
    @Param('botInstanceId') botInstanceId: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.page(botInstanceId, reply);
  }

  private async page(botInstanceId: string, reply: FastifyReply): Promise<void> {
    // The same "not available" answer the session route gives an unknown, stopped or
    // switched-off bot: with the flag off the mini app does not exist.
    await this.container.miniApp.sessions.liveBot(botInstanceId);
    const index = this.files.get('index.html');
    if (index === undefined) throw this.missing();
    reply.raw.removeHeader('X-Frame-Options');
    await reply
      .header('Content-Security-Policy', MINIAPP_DOCUMENT_CSP)
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', index.type)
      .send(index.bytes);
  }

  private async send(reply: FastifyReply, key: string, cacheControl: string): Promise<void> {
    const file = this.files.get(key);
    if (file === undefined) throw this.missing();
    await reply
      .header('Cache-Control', cacheControl)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Type', file.type)
      .send(file.bytes);
  }

  private missing() {
    return errors.notFound(
      MINIAPP_ERROR_CODES.MINIAPP_UNAVAILABLE,
      'The mini app is not available.',
    );
  }
}
