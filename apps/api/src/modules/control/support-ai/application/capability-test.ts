import {
  SUPPORT_AI_DECISION_JSON_SCHEMA,
  type SupportAiConfigInput,
  type SupportContextPayload,
} from '@nexa/contracts';
import type { SupportAiRequest } from './ports.js';
import { decisionOutputTokens } from '../domain/decision.js';
import { SUPPORT_AI_IMAGE_ATTACHED_MARKER, supportSystemPrompt } from '../domain/prompt.js';

/**
 * The provider capability test's request (program §11, A2): the SAME request Assist and Auto
 * Reply send — the real system prompt, `SUPPORT_AI_DECISION_JSON_SCHEMA` under the same schema
 * name, the same output-token budget for the tenant's reply limit — over a FIXED synthetic
 * conversation. Nothing here is any customer's: the facts payload is invented and empty of
 * account data, the transcript is one constant line, and the image is a 16×16 two-colour PNG
 * built into the code.
 *
 * A model that can be LISTED but cannot answer this request is exactly the model the field
 * failure had: the test must say so, not «OK».
 */

/** The synthetic customer line: the PO's own field example, no customer's words. */
export const CAPABILITY_TEST_MESSAGE = 'سلام، سرویس من وصل نمیشه.';
export const CAPABILITY_TEST_IMAGE_MESSAGE = 'این تصویر خطای اتصال من است.';

/** 16×16 PNG, left half red, right half blue (83 bytes). Generated once; no external file. */
export const CAPABILITY_TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAGklEQVR4nGO4o6GBFclV3MGKGEY1jGoYvhoAcAFPEBgM0bsAAAAASUVORK5CYII=';

/** A facts payload of the production shape with no account in it: one invented article. */
export const CAPABILITY_TEST_CONTEXT: SupportContextPayload = {
  generatedAt: '2026-01-01T00:00:00.000Z',
  customer: null,
  services: [],
  orders: [],
  payments: [],
  clientApps: [],
  incidents: [],
  knowledge: [
    {
      alias: 'K1',
      source: 'KNOWLEDGE',
      question: 'سرویس وصل نمی‌شود',
      answer:
        'برنامه را کامل ببندید، اینترنت گوشی را یک بار خاموش و روشن کنید، لینک اشتراک را در برنامه به‌روزرسانی کنید و دوباره وصل شوید.',
    },
  ],
  supportAccounts: [],
  flags: {
    hasUnderReviewPayment: false,
    hasUnreconciledService: false,
    identityLinked: false,
    customerBlocked: false,
  },
};

export function capabilityTestRequest(
  config: Pick<SupportAiConfigInput, 'toneInstructions' | 'maxOutputChars' | 'timeoutMs'>,
  model: string,
  withImage: boolean,
): SupportAiRequest {
  return {
    model,
    timeoutMs: config.timeoutMs,
    system: supportSystemPrompt({
      businessToneInstructions: config.toneInstructions,
      maxReplyChars: config.maxOutputChars,
      contextJson: JSON.stringify(CAPABILITY_TEST_CONTEXT),
      identityLinked: false,
    }),
    messages: withImage
      ? [
          {
            role: 'user',
            text: `${SUPPORT_AI_IMAGE_ATTACHED_MARKER}\n${CAPABILITY_TEST_IMAGE_MESSAGE}`,
            images: [{ mediaType: 'image/png', base64: CAPABILITY_TEST_PNG_BASE64 }],
          },
        ]
      : [{ role: 'user', text: CAPABILITY_TEST_MESSAGE }],
    jsonSchema: SUPPORT_AI_DECISION_JSON_SCHEMA,
    schemaName: 'support_decision',
    maxOutputTokens: decisionOutputTokens(config.maxOutputChars),
  };
}
