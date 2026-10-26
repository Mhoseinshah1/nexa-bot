import { and, eq } from 'drizzle-orm';
import type { StartCaptchaState, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customerCaptchas } from '../../../../infrastructure/persistence/schema.js';
import type {
  StartCaptchaChallenge,
  StartCaptchaRecord,
  StartCaptchaReissue,
  StartCaptchaRepository,
} from '../application/start-captcha-ports.js';

function toRecord(row: typeof customerCaptchas.$inferSelect): StartCaptchaRecord {
  return {
    customerId: row.customerId,
    state: row.state as StartCaptchaState,
    challengeId: row.challengeId,
    operandA: row.operandA,
    operandB: row.operandB,
    options: row.options,
    answerIndex: row.answerIndex,
    attempts: row.attempts,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    lockedUntil: row.lockedUntil,
    passedAt: row.passedAt,
  };
}

function challengeColumns(challenge: StartCaptchaChallenge) {
  return {
    challengeId: challenge.challengeId,
    operandA: challenge.operandA,
    operandB: challenge.operandB,
    options: [...challenge.options],
    answerIndex: challenge.answerIndex,
  };
}

/** R10 D5 (a): the `/start` captcha rows, in PostgreSQL. Every query carries the tenant. */
export class DrizzleStartCaptchaRepository implements StartCaptchaRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async insert(
    scope: TenantContext,
    row: {
      readonly customerId: string;
      readonly challenge: StartCaptchaChallenge;
      readonly issuedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const written = await this.exec(tx)
      .insert(customerCaptchas)
      .values({
        tenantId,
        customerId: row.customerId,
        state: 'PENDING',
        ...challengeColumns(row.challenge),
        attempts: 0,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        createdAt: row.issuedAt,
        updatedAt: row.issuedAt,
      })
      .onConflictDoNothing({ target: [customerCaptchas.tenantId, customerCaptchas.customerId] })
      .returning({ customerId: customerCaptchas.customerId });
    return written.length === 1;
  }

  async find(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<StartCaptchaRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(customerCaptchas)
      .where(
        and(eq(customerCaptchas.tenantId, tenantId), eq(customerCaptchas.customerId, customerId)),
      )
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async lock(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<StartCaptchaRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.exec(tx)
      .select()
      .from(customerCaptchas)
      .where(
        and(eq(customerCaptchas.tenantId, tenantId), eq(customerCaptchas.customerId, customerId)),
      )
      .for('update')
      .limit(1);
    return row === undefined ? null : toRecord(row);
  }

  async reissue(
    scope: TenantContext,
    customerId: string,
    fromChallengeId: string,
    next: StartCaptchaReissue,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const moved = await this.exec(tx)
      .update(customerCaptchas)
      .set({
        ...challengeColumns(next.challenge),
        attempts: next.attempts,
        issuedAt: next.issuedAt,
        expiresAt: next.expiresAt,
        lockedUntil: next.lockedUntil,
        updatedAt: next.now,
      })
      .where(
        and(
          eq(customerCaptchas.tenantId, tenantId),
          eq(customerCaptchas.customerId, customerId),
          eq(customerCaptchas.state, 'PENDING'),
          eq(customerCaptchas.challengeId, fromChallengeId),
        ),
      )
      .returning({ customerId: customerCaptchas.customerId });
    return moved.length === 1;
  }

  async pass(
    scope: TenantContext,
    customerId: string,
    challengeId: string,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const moved = await this.exec(tx)
      .update(customerCaptchas)
      .set({ state: 'PASSED', passedAt: now, lockedUntil: null, updatedAt: now })
      .where(
        and(
          eq(customerCaptchas.tenantId, tenantId),
          eq(customerCaptchas.customerId, customerId),
          eq(customerCaptchas.state, 'PENDING'),
          eq(customerCaptchas.challengeId, challengeId),
        ),
      )
      .returning({ customerId: customerCaptchas.customerId });
    return moved.length === 1;
  }
}
