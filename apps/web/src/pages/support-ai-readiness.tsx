import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SupportAiConfigResponse,
  SupportReadinessCheck,
  SupportReadinessDetail,
  SupportReadinessResponse,
} from '@nexa/contracts';
import { fetchSupportReadiness, testSupportAiProvider } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Badge, Banner, Card, Ltr, Num, StateSwitch, useToast } from '../ui/kit';
import { Icon } from '../ui/icons';
import { supportAiFault } from './support-ai';

/**
 * Phase 4 PR-5 — «آمادگی دستیار»: eight lines, each ✅ or ⚠️ with a one-line Persian fix.
 *
 * The server states what it SEES (`GET /support-ai/readiness`, `support_ai.configure`): a code
 * per line, never a sentence. This page owns the sentence and the fix. Nothing here changes
 * anything; the one button runs the capability test through the same call the connection test
 * uses, for the provider the chain names first.
 */

export const READINESS_LABELS: Readonly<Record<SupportReadinessCheck, WebKey>> = {
  BUSINESS_CONNECTION: 'web.sair_check_business_connection',
  SUPPORT_HANDLE: 'web.sair_check_support_handle',
  PROVIDER_KEY: 'web.sair_check_provider_key',
  STRUCTURED_OUTPUT: 'web.sair_check_structured_output',
  ASSISTANT_ROLE: 'web.sair_check_assistant_role',
  TOPICS: 'web.sair_check_topics',
  KNOWLEDGE: 'web.sair_check_knowledge',
  VISION: 'web.sair_check_vision',
};

/** What each code means, as a sentence. `{n}` is the line's count. */
export const READINESS_SENTENCES: Readonly<Record<SupportReadinessDetail, WebKey>> = {
  CONNECTED: 'web.sair_connected',
  NO_CONNECTION: 'web.sair_no_connection',
  CONNECTION_DISABLED: 'web.sair_connection_disabled',
  CANNOT_REPLY: 'web.sair_cannot_reply',
  HANDLE_MATCHES: 'web.sair_handle_matches',
  HANDLE_MISSING: 'web.sair_handle_missing',
  HANDLE_MISMATCH: 'web.sair_handle_mismatch',
  HANDLE_UNVERIFIED: 'web.sair_handle_unverified',
  KEY_OK: 'web.sair_key_ok',
  NO_PRIMARY: 'web.sair_no_primary',
  NO_KEY: 'web.sair_no_key',
  KEY_REJECTED: 'web.sair_key_rejected',
  BREAKER_OPEN: 'web.sair_breaker_open',
  TEST_PASSED: 'web.sair_test_passed',
  NOT_TESTED: 'web.sair_not_tested',
  TEST_FAILED: 'web.sair_test_failed',
  UNSUPPORTED: 'web.sair_unsupported',
  RUNNING: 'web.sair_running',
  NEVER_STARTED: 'web.sair_never_started',
  STOPPED: 'web.sair_stopped',
  RESTARTING: 'web.sair_restarting',
  STALLED: 'web.sair_stalled',
  TOPICS_SELECTED: 'web.sair_topics_selected',
  NO_TOPICS: 'web.sair_no_topics',
  KNOWLEDGE_READY: 'web.sair_knowledge_ready',
  NO_KNOWLEDGE: 'web.sair_no_knowledge',
  VISION_ON: 'web.sair_vision_on',
  VISION_OFF: 'web.sair_vision_off',
  VISION_UNSUPPORTED: 'web.sair_vision_unsupported',
};

/** The one-line fix of a warning. Absent for the codes that are fine. */
export const READINESS_FIXES: Readonly<Partial<Record<SupportReadinessDetail, WebKey>>> = {
  NO_CONNECTION: 'web.sair_fix_no_connection',
  CONNECTION_DISABLED: 'web.sair_fix_connection_disabled',
  CANNOT_REPLY: 'web.sair_fix_cannot_reply',
  HANDLE_MISSING: 'web.sair_fix_handle_missing',
  HANDLE_MISMATCH: 'web.sair_fix_handle_mismatch',
  HANDLE_UNVERIFIED: 'web.sair_fix_handle_unverified',
  NO_PRIMARY: 'web.sair_fix_no_primary',
  NO_KEY: 'web.sair_fix_no_key',
  KEY_REJECTED: 'web.sair_fix_key_rejected',
  BREAKER_OPEN: 'web.sair_fix_breaker_open',
  NOT_TESTED: 'web.sair_fix_not_tested',
  TEST_FAILED: 'web.sair_fix_test_failed',
  UNSUPPORTED: 'web.sair_fix_unsupported',
  NEVER_STARTED: 'web.sair_fix_never_started',
  STOPPED: 'web.sair_fix_stopped',
  RESTARTING: 'web.sair_fix_restarting',
  STALLED: 'web.sair_fix_stalled',
  NO_TOPICS: 'web.sair_fix_no_topics',
  NO_KNOWLEDGE: 'web.sair_fix_no_knowledge',
  VISION_UNSUPPORTED: 'web.sair_fix_vision_unsupported',
};

/** A server command the fix names, drawn left-to-right after the sentence. */
export const READINESS_COMMANDS: Readonly<Partial<Record<SupportReadinessDetail, string>>> = {
  NEVER_STARTED: 'sudo botctl roles enable assistant',
  STOPPED: 'sudo botctl roles enable assistant',
  RESTARTING: 'sudo botctl logs assistant',
  STALLED: 'sudo botctl roles status',
};

/** The line codes whose fix is running the capability test. */
const TESTABLE: ReadonlySet<SupportReadinessDetail> = new Set(['NOT_TESTED', 'TEST_FAILED']);

export function ReadinessCard({ config }: { config: SupportAiConfigResponse }) {
  const readiness = useQuery({
    queryKey: ['support-ai-readiness'],
    queryFn: fetchSupportReadiness,
  });
  return (
    <Card title={t('web.sair_title')} hint={t('web.sair_hint')}>
      <StateSwitch query={readiness}>
        {readiness.data !== undefined && (
          <ReadinessLines readiness={readiness.data} config={config} />
        )}
      </StateSwitch>
    </Card>
  );
}

function ReadinessLines({
  readiness,
  config,
}: {
  readiness: SupportReadinessResponse;
  config: SupportAiConfigResponse;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const testKey = useSubmissionKey();
  const primary = config.config.primary;
  const test = useMutation({
    mutationFn: () => {
      if (primary === null) throw new Error('no primary');
      return testSupportAiProvider({
        provider: primary.provider,
        model: primary.model,
        idempotencyKey: testKey.current({ provider: primary.provider, model: primary.model }),
      });
    },
    onSuccess: (result) => {
      testKey.settle();
      notify({
        tone: result.outcome === 'OK' ? 'ok' : 'warn',
        message: t(result.outcome === 'OK' ? 'web.sair_test_ok' : 'web.sair_test_not_ok'),
      });
      void queries.invalidateQueries({ queryKey: ['support-ai-readiness'] });
      void queries.invalidateQueries({ queryKey: ['support-ai-config'] });
    },
    onError: (error) => {
      testKey.settleOn(error);
      notify({ tone: 'danger', message: supportAiFault(error), error });
    },
  });
  const warnings = readiness.checks.filter((line) => line.status === 'WARN').length;
  return (
    <div className="stack-sm">
      <Banner tone={warnings === 0 ? 'ok' : 'warn'}>
        {warnings === 0 ? (
          t('web.sair_all_ready')
        ) : (
          <>
            <Num value={warnings} /> {t('web.sair_some_warn')}
          </>
        )}
      </Banner>
      <ul className="plain sai-readiness">
        {readiness.checks.map((line) => {
          const fix = READINESS_FIXES[line.detail];
          const command = READINESS_COMMANDS[line.detail];
          return (
            <li
              key={line.check}
              className="sai-readiness-line"
              data-check={line.check}
              data-status={line.status}
            >
              <div className="row">
                <Icon name={line.status === 'OK' ? 'check' : 'alert'} />
                <strong>{t(READINESS_LABELS[line.check])}</strong>
                <Badge tone={line.status === 'OK' ? 'ok' : 'warn'}>
                  {t(line.status === 'OK' ? 'web.sair_ok' : 'web.sair_warn')}
                </Badge>
              </div>
              <p className="small">
                {t(READINESS_SENTENCES[line.detail]).replace(
                  '{n}',
                  line.count === null ? '—' : String(line.count),
                )}{' '}
                {line.handles.length > 0 && <Ltr>{line.handles.join(', ')}</Ltr>}
              </p>
              {line.status === 'WARN' && fix !== undefined && (
                <p className="small muted">
                  <strong>{t('web.sair_fix_label')}</strong> {t(fix)}{' '}
                  {command !== undefined && <Ltr>{command}</Ltr>}
                </p>
              )}
              {TESTABLE.has(line.detail) && primary !== null && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={test.isPending}
                  onClick={() => test.mutate()}
                >
                  <Icon name="play" />
                  {t('web.sair_run_test')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
