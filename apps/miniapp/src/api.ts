import {
  MINIAPP_API_PREFIX,
  MINIAPP_IDEMPOTENCY_HEADER,
  MINIAPP_ROUTES,
  miniAppErrorSchema,
  miniAppPath,
  miniAppSessionResponseSchema,
} from '@nexa/contracts';

/** A contract schema, structurally: this app depends on `@nexa/contracts`, not on zod. */
export interface Schema<T> {
  parse(value: unknown): T;
}

/**
 * The mini app's one way to the API: the session token, an idempotency key on every write,
 * a contract schema on every answer, and refusals as `ApiError` carrying the server's code.
 * Nothing is ever retried by this layer: a retry is the person tapping again, under a new key.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(code);
  }
}

const TOKEN_KEY = (botId: string) => `nexa.miniapp.session.${botId}`;

/** The bot this document was opened for: `/miniapp/<botInstanceId>/…`. */
export function botIdFromLocation(pathname: string): string | null {
  const match = /^\/miniapp\/([0-9a-f-]{36})(?:\/|$)/u.exec(pathname);
  return match?.[1] ?? null;
}

function newKey(): string {
  return crypto.randomUUID();
}

export class MiniAppApi {
  private token: string | null;

  constructor(private readonly botId: string) {
    this.token = readToken(botId);
  }

  hasSession(): boolean {
    return this.token !== null;
  }

  /** One Telegram launch for one session. A launch already used is refused by the server. */
  async signIn(initData: string): Promise<void> {
    const response = await fetch(
      `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: this.botId })}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ initData }),
      },
    );
    const body = await this.read(response, miniAppSessionResponseSchema);
    this.token = body.token;
    writeToken(this.botId, body.token);
  }

  forget(): void {
    this.token = null;
    writeToken(this.botId, null);
  }

  get<T>(route: string, params: Record<string, string>, schema: Schema<T>, query?: string) {
    return this.send('GET', route, params, schema, undefined, query);
  }

  post<T>(route: string, params: Record<string, string>, schema: Schema<T>, body?: unknown) {
    return this.send('POST', route, params, schema, body ?? {});
  }

  put<T>(route: string, params: Record<string, string>, schema: Schema<T>, body: unknown) {
    return this.send('PUT', route, params, schema, body);
  }

  /** A binary answer (the QR image) as an object URL; the caller revokes it. */
  async blob(route: string, params: Record<string, string>): Promise<string> {
    const response = await fetch(`${MINIAPP_API_PREFIX}${miniAppPath(route, params)}`, {
      headers: this.headers(false),
    });
    if (!response.ok) await this.read(response, { parse: () => null });
    return URL.createObjectURL(await response.blob());
  }

  private async send<T>(
    method: 'GET' | 'POST' | 'PUT',
    route: string,
    params: Record<string, string>,
    schema: Schema<T>,
    body: unknown,
    query?: string,
  ): Promise<T> {
    const url = `${MINIAPP_API_PREFIX}${miniAppPath(route, params)}${query === undefined ? '' : `?${query}`}`;
    const response = await fetch(url, {
      method,
      headers: this.headers(method !== 'GET'),
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    return this.read(response, schema);
  }

  private headers(write: boolean): Record<string, string> {
    return {
      ...(this.token === null ? {} : { authorization: `Bearer ${this.token}` }),
      ...(write
        ? { 'content-type': 'application/json', [MINIAPP_IDEMPOTENCY_HEADER]: newKey() }
        : {}),
    };
  }

  private async read<T>(response: Response, schema: Schema<T>): Promise<T> {
    const text = await response.text();
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    if (!response.ok) {
      const parsed = miniAppErrorSchema.safeParse(json);
      const code = parsed.success ? parsed.data.error.code : 'http.error';
      if (code === 'miniapp.session_invalid') this.forget();
      throw new ApiError(
        response.status,
        code,
        parsed.success ? (parsed.data.error.details ?? {}) : {},
      );
    }
    return schema.parse(json);
  }
}

/** The token lives for the tab: a reload keeps it, a new launch replaces it. */
function readToken(botId: string): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY(botId));
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

function writeToken(botId: string, token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY(botId));
    else sessionStorage.setItem(TOKEN_KEY(botId), token);
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
  }
}
