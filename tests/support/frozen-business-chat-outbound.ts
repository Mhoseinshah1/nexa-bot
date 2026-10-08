// The contracts package's own zod, the version the frozen copy below was written against.
import { z } from '../../packages/contracts/node_modules/zod';

/*
 * THE PRE-A4 WEB BUNDLE'S PARSER for a business-chat detail's outbound rows, copied verbatim from
 * `packages/contracts/src/business-chats.ts` on `main` at `862a5418` (before roadmap A4 added
 * `HANDOFF_NOTICE`). A rolling deploy serves a new replica's detail to that bundle, and one row
 * outside this enum fails the WHOLE detail (review of PR #248, CX1). Kept here, not imported, so
 * that widening the live schema cannot quietly widen the "old" one with it.
 */
export const frozenPreA4OutboundView = z.object({
  id: z.string(),
  origin: z.enum(['OPERATOR', 'ASSIST', 'AUTO']),
  state: z.enum(['PENDING', 'DELIVERED', 'UNCONFIRMED', 'FAILED', 'SUPERSEDED']),
  text: z.string().nullable(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  failureCode: z.string().nullable(),
});

/** The part of the pre-A4 detail schema that reads `outbound` (the rest is unchanged by A4). */
export const frozenPreA4DetailOutbound = z.object({
  outbound: z.array(frozenPreA4OutboundView),
});
