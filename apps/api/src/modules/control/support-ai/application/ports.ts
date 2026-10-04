import type {
  SupportAiCapabilities,
  SupportAiOutcome,
  SupportAiProvider,
} from '@nexa/contracts';

/**
 * TB4 — the provider-neutral adapter port (ADR-0034 §2). Each adapter maps its provider's wire
 * shapes onto `SupportAiOutcome`; nothing above this port knows a provider's URL, header, error
 * body or JSON dialect, and the core never branches on a provider name.
 */

/** One image, already fetched, type-checked and size-bounded by the caller (TB6). */
export interface SupportAiImage {
  readonly mediaType: string;
  readonly base64: string;
}

export interface SupportAiMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly images?: readonly SupportAiImage[];
}

export interface SupportAiRequest {
  readonly model: string;
  /** The fixed system policy and the bounded context. Customer text never goes here. */
  readonly system: string;
  readonly messages: readonly SupportAiMessage[];
  /**
   * The JSON Schema the output must satisfy, written in the subset every provider accepts
   * (every object closed with `additionalProperties: false`, every property required, no
   * numeric or length keywords). The CALLER's zod schema is the authority either way.
   */
  readonly jsonSchema: Record<string, unknown>;
  readonly schemaName: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface SupportAiAdapter {
  readonly provider: SupportAiProvider;
  readonly capabilities: SupportAiCapabilities;
  generate(
    credential: SupportAiCredential,
    request: SupportAiRequest,
  ): Promise<SupportAiOutcome>;
  /** The cheapest authenticated call the provider offers. Never a customer's data. */
  testConnection(credential: SupportAiCredential, model: string, timeoutMs: number): Promise<SupportAiOutcome>;
}

/** A decrypted key and its (closed) routing choice. Lives only for the duration of a call. */
export interface SupportAiCredential {
  readonly apiKey: string;
  readonly region: 'INTERNATIONAL' | 'CHINA' | null;
}
