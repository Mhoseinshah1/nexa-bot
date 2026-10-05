import {
  SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
  SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
  type OperationalEventRecorder,
  type ScopeContext,
  type SupportAiProvider,
} from '@nexa/contracts';
import type { DrizzleSupportAiCredentialStore } from '../infrastructure/drizzle-support-ai.repository.js';

export interface CredentialAlertDeps {
  readonly credentials: Pick<
    DrizzleSupportAiCredentialStore,
    'markRejected' | 'clearRejected' | 'rejection'
  >;
  /** Whether ONE subject's condition is open, addressed by its dedupe key. */
  readonly conditions: {
    conditionIsOpen(scope: ScopeContext, dedupeKey: string): Promise<boolean>;
  };
  readonly opsLog: OperationalEventRecorder;
}

export const credentialRejectedDedupeKey = (provider: SupportAiProvider): string =>
  `${SUPPORT_AI_CREDENTIAL_REJECTED_CODE}:${provider}`;

/**
 * TB4 — the `credential_rejected` alert follows the credential row's `rejected_at` (TB0
 * amendment 4), for the chain and for the operator's connection test alike.
 *
 * The state and the alert are two writes, not one transaction: the state is a pool write made
 * after a provider call, and a process can die between the two. So the alert is SELF-HEALING
 * rather than written once and trusted: a call that finds this key rejected with no open
 * condition raises it again, and a real answer that finds this key accepted with the condition
 * still open closes it. Both are idempotent at the ops log (it dedupes by key), so the extra
 * write in a race is a counter, not a second alert. Every read and write is bound to the key
 * VERSION the call was made with, so nothing here acts for a key an operator has replaced.
 */
export class SupportAiCredentialAlert {
  constructor(private readonly deps: CredentialAlertDeps) {}

  /** The provider refused this key (`AUTH_FAILED`). */
  async rejected(
    scope: ScopeContext,
    input: {
      readonly provider: SupportAiProvider;
      readonly keySetAt: Date;
      readonly quota: boolean;
      readonly code: string;
      readonly message: string;
      readonly now: Date;
    },
  ): Promise<void> {
    const dedupeKey = credentialRejectedDedupeKey(input.provider);
    const transitioned = await this.deps.credentials.markRejected(
      scope,
      input.provider,
      input.keySetAt,
      input.now,
    );
    if (
      !transitioned &&
      ((await this.deps.conditions.conditionIsOpen(scope, dedupeKey)) ||
        (await this.deps.credentials.rejection(scope, input.provider, input.keySetAt)) !==
          'REJECTED')
    ) {
      return;
    }
    await this.deps.opsLog.record(scope, {
      code: SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
      severity: 'ERROR',
      message: input.message,
      dedupeKey,
      context: { provider: input.provider, quota: input.quota, code: input.code },
    });
  }

  /** The provider answered `OK` with this key. Nothing else proves a key works. */
  async accepted(
    scope: ScopeContext,
    input: { readonly provider: SupportAiProvider; readonly keySetAt: Date; readonly now: Date },
  ): Promise<void> {
    const dedupeKey = credentialRejectedDedupeKey(input.provider);
    const transitioned = await this.deps.credentials.clearRejected(
      scope,
      input.provider,
      input.keySetAt,
      input.now,
    );
    if (
      !transitioned &&
      (!(await this.deps.conditions.conditionIsOpen(scope, dedupeKey)) ||
        (await this.deps.credentials.rejection(scope, input.provider, input.keySetAt)) !==
          'ACCEPTED')
    ) {
      return;
    }
    await this.deps.opsLog.record(scope, {
      code: SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE,
      severity: 'INFO',
      message: 'An AI provider accepted its key again.',
      dedupeKey: `${SUPPORT_AI_CREDENTIAL_ACCEPTED_CODE}:${input.provider}`,
      recoversCode: SUPPORT_AI_CREDENTIAL_REJECTED_CODE,
      recoversDedupeKey: dedupeKey,
      context: { provider: input.provider },
    });
  }
}
