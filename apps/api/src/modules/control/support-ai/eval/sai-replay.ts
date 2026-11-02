import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { c, ai, evalService, staff, type EvalLine, type EvalScenario } from './corpus.js';
import type { EvalProvider } from './runner.js';
import { runSaiTrial, type SaiConfigChoice, type SaiObserved } from './sai-runner.js';

/**
 * Phase 4 PR-6 — replay of EXPORTED, SCRUBBED, LOCAL-ONLY handed-off chats.
 *
 * The question it answers: of the chats the old configuration handed to a person, how many would
 * the current pipeline answer, and how many would still reach one? The export is the owner's own
 * file on the owner's own machine; it is NEVER committed (`.gitignore` carries the patterns) and
 * this module never writes a line of it anywhere: the report is counts, ids and outcome classes,
 * never a message. A file inside the repository working tree is refused outright, so a chat can
 * not be left next to the code by mistake.
 *
 * The file is a JSON array, or one JSON object per line (JSONL):
 *   { "id": "c1", "linked": true, "lines": [ { "author": "CUSTOMER", "text": "…" }, … ] }
 * Scrub names, phones, cards and links BEFORE exporting; the eval has no account facts for a
 * replayed chat (a linked chat gets one generic synthetic service), so it measures routing and
 * the guards, not the correctness of a figure.
 */

export class ReplayError extends Error {}

export const REPLAY_LIMITS = {
  chats: 500,
  lines: 60,
  textChars: 2_000,
  fileBytes: 5_000_000,
} as const;

const replayChatSchema = z
  .object({
    id: z.string().min(1).max(64),
    linked: z.boolean(),
    lines: z
      .array(
        z
          .object({
            author: z.enum(['CUSTOMER', 'STAFF', 'AI_AUTO']),
            text: z.string().max(REPLAY_LIMITS.textChars),
          })
          .strict(),
      )
      .min(1)
      .max(REPLAY_LIMITS.lines),
  })
  .strict();
export type ReplayChat = z.infer<typeof replayChatSchema>;

/** Whether `file` is inside (or is) `root`: such a path is refused for input and output alike. */
export function isInsideRepository(file: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(file));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseReplayFile(content: string): ReplayChat[] {
  if (content.length > REPLAY_LIMITS.fileBytes)
    throw new ReplayError('the replay file is too large');
  const trimmed = content.trim();
  let raw: unknown[];
  try {
    raw = trimmed.startsWith('[')
      ? (JSON.parse(trimmed) as unknown[])
      : trimmed
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as unknown);
  } catch {
    throw new ReplayError('the replay file is not valid JSON / JSONL');
  }
  if (raw.length === 0 || raw.length > REPLAY_LIMITS.chats) {
    throw new ReplayError(`the replay file must hold 1 to ${String(REPLAY_LIMITS.chats)} chats`);
  }
  return raw.map((entry, index) => {
    const parsed = replayChatSchema.safeParse(entry);
    // Never echo the value: the path and code of the first issue only.
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ReplayError(
        `chat #${String(index + 1)}: ${issue?.path.join('.') ?? ''} (${issue?.code ?? 'invalid'})`,
      );
    }
    return parsed.data;
  });
}

const LINE_OF = { CUSTOMER: c, STAFF: staff, AI_AUTO: ai } as const;

export function scenarioOfChat(chat: ReplayChat): EvalScenario {
  const lines: EvalLine[] = chat.lines.map((line) => LINE_OF[line.author](line.text));
  return {
    id: chat.id,
    category: 'APP_SETUP',
    about: 'replayed chat',
    linked: chat.linked,
    ...(chat.linked ? { services: [evalService()] } : {}),
    transcript: lines,
    expect: {
      decisions: ['REPLY', 'ASK_CLARIFYING_QUESTION', 'HANDOFF'],
      topics: [],
      guard: 'EITHER',
    },
    reference: {
      decision: 'HANDOFF',
      replyText: '',
      topic: 'OTHER',
      confidence: 'LOW',
      factRefs: [],
      knowledgeRefs: [],
      ticketAction: 'NONE',
      summary: '',
      intent: '',
    },
  };
}

/** `PIPELINE_HANDOFF` = a guard stops it before any model; `WOULD_ASK_MODEL` (no provider only). */
export type ReplayOutcome = SaiObserved | 'WOULD_ASK_MODEL';

export interface ReplayRow {
  readonly id: string;
  readonly outcome: ReplayOutcome;
  readonly blockedBy: readonly string[];
}

export interface ReplayReport {
  readonly chats: number;
  readonly counts: Readonly<Record<ReplayOutcome, number>>;
  readonly rows: readonly ReplayRow[];
}

const PIPELINE_ONLY: EvalProvider = {
  label: 'pipeline only (no model)',
  paid: false,
  capabilities: { structuredOutput: true, vision: true, maxImageBytes: 0, imageMediaTypes: [] },
  generate: async () => ({ kind: 'FAILED', code: 'pipeline-only' }),
};

/**
 * Replay every chat. With no provider the model is not asked: a chat is either stopped before
 * it (`HANDOFF`, `blockedBy` names the guard) or `WOULD_ASK_MODEL`. With a provider (the live
 * run's) the answer goes through the same pipeline as production.
 */
export async function replayChats(
  chats: readonly ReplayChat[],
  config: SaiConfigChoice,
  provider: EvalProvider | null,
): Promise<ReplayReport> {
  const rows: ReplayRow[] = [];
  for (const chat of chats) {
    const trial = await runSaiTrial(scenarioOfChat(chat), provider ?? PIPELINE_ONLY, {
      guard: config.guard,
    });
    const reachedModelOnly =
      provider === null && trial.providerCalls > 0 && trial.blockedBy.includes('provider');
    rows.push({
      id: chat.id,
      outcome: reachedModelOnly ? 'WOULD_ASK_MODEL' : trial.observed,
      blockedBy: trial.blockedBy.filter((b) => b !== 'provider'),
    });
  }
  const counts: Record<ReplayOutcome, number> = {
    RESOLVED: 0,
    CLARIFYING: 0,
    REFUSAL: 0,
    HANDOFF: 0,
    CLOSED_SILENTLY: 0,
    WOULD_ASK_MODEL: 0,
  };
  for (const row of rows) counts[row.outcome] += 1;
  return { chats: chats.length, counts, rows };
}

export function formatReplay(report: ReplayReport, config: string): string {
  const c = report.counts;
  return [
    `بازپخش ${String(report.chats)} گفتگوی ارجاع‌شده — تنظیمات: ${config} (فقط شمارش؛ متن گفتگو چاپ نمی‌شود)`,
    `  حل‌شده: ${String(c.RESOLVED)}، پرسش شفاف‌کننده: ${String(c.CLARIFYING)}، امتناع: ${String(c.REFUSAL)}، همچنان ارجاع: ${String(c.HANDOFF)}، بسته‌شده بی‌صدا: ${String(c.CLOSED_SILENTLY)}، به مدل می‌رسید: ${String(c.WOULD_ASK_MODEL)}`,
    `Replay of ${String(report.chats)} handed-off chats — config: ${config} (counts only; no chat text is printed)`,
    `  resolved ${String(c.RESOLVED)}, clarifying ${String(c.CLARIFYING)}, refusal ${String(c.REFUSAL)}, still handed off ${String(c.HANDOFF)}, closed silently ${String(c.CLOSED_SILENTLY)}, would reach the model ${String(c.WOULD_ASK_MODEL)}`,
    ...report.rows
      .filter((row) => row.outcome === 'HANDOFF')
      .map((row) => `  handoff ${row.id}: ${row.blockedBy.join(', ') || 'model'}`),
  ].join('\n');
}
