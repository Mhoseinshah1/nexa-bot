import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HOSTED_ACTIVATION_STEPS,
  type HostedActivationRunnableStep,
  type HostedActivationStep,
  type HostedActivationStepView,
  type HostedActivationView,
  type HostedBotView,
} from '@nexa/contracts';
import {
  ApiError,
  configureHostedActivation,
  fetchHostedActivation,
  issueHostedActivationLink,
  runHostedActivationStep,
} from '../api/client';
import { errorText } from '../error-text';
import { formatTimestamp } from '../format';
import { RUN_KEY_HELD_MS, useSubmissionKey } from '../submission-key';
import { ACTIVATION_LINK_STATE_LABEL, ACTIVATION_STEP_LABEL } from '../hosting-labels';
import { t } from '../i18n/web.fa';
import {
  Badge,
  Banner,
  Button,
  CopyButton,
  Disclosure,
  Field,
  KV,
  Ltr,
  Modal,
  StateSwitch,
} from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { CodePromptDialog, HOSTING_BOTS_KEY, noteSectionError } from './hosting-parts';

/**
 * The activation of one hosted bot, inside its card (phase 6A PR-4): the token and the domain
 * the OWNER enters on the hosted owner's behalf, then each step's status in Persian with its own
 * «بررسی دوباره», and the one-time activation link.
 *
 * Presentation only. Every refusal, order and check is the server's; this draws what it answers
 * (`HostedActivationView`) and turns the closed error codes into Persian through `errorText`.
 * Setting the token and making the link ask for a fresh code (`CodePromptDialog`); re-running a
 * check does not.
 */

const activationKey = (tenantId: string) => ['hosting', 'activation', tenantId] as const;

/** The steps a person can run again with no input, by the contract's own words. */
const RUNNABLE: Readonly<Partial<Record<HostedActivationStep, HostedActivationRunnableStep>>> = {
  TOKEN: 'token',
  DOMAIN: 'domain',
  SSL: 'ssl',
  WEBHOOK: 'webhook',
};

const STATE_TONE = { DONE: 'ok', PENDING: 'neutral', FAILED: 'danger' } as const;
const STATE_LABEL = {
  DONE: 'web.hosting_act_state_done',
  PENDING: 'web.hosting_act_state_pending',
  FAILED: 'web.hosting_act_state_failed',
} as const;

/** The card's disclosure: mounts the panel (and asks the server) only once it is opened. */
export function ActivationSection({ bot }: { bot: HostedBotView }) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure summary={t('web.hosting_act_title')} size="sm" onToggle={setOpen}>
      {open && <ActivationPanel bot={bot} />}
    </Disclosure>
  );
}

function ActivationPanel({ bot }: { bot: HostedBotView }) {
  const queryClient = useQueryClient();
  const key = activationKey(bot.tenantId);
  const query = useQuery({ queryKey: key, queryFn: () => fetchHostedActivation(bot.tenantId) });
  const [dialog, setDialog] = useState<'configure' | 'link' | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const settle = (view: HostedActivationView): void => {
    queryClient.setQueryData(key, view);
    void queryClient.invalidateQueries({ queryKey: HOSTING_BOTS_KEY });
  };
  // A check is a constant command ("look again"): its key is held only briefly after an
  // unanswered failure, so a press much later is a new check, not the lost one re-asked.
  const submission = useSubmissionKey({ heldForMs: RUN_KEY_HELD_MS });
  const run = useMutation({
    retry: false,
    mutationFn: (step: HostedActivationRunnableStep) =>
      runHostedActivationStep(bot.tenantId, step, submission.current({ step })),
    onSuccess: (response) => {
      submission.settle();
      settle(response.activation);
    },
    // A failed check was recorded by the server: read it back for the step's status.
    onError: (error) => {
      submission.settleOn(error);
      noteSectionError(error, queryClient);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const view = query.data;
  const configured = view !== undefined && view.domain !== null;
  return (
    <div className="stack hosting-act">
      <p className="muted small">{t('web.hosting_act_intro')}</p>
      <StateSwitch query={query}>
        {view !== undefined && (
          <>
            <DnsHelp view={view} />
            {configured && (
              <KV
                items={[
                  [t('web.hosting_act_domain_current'), <Ltr key="d">{view.domain}</Ltr>],
                  [
                    t('web.hosting_act_bot_username'),
                    view.botUsername === null ? '—' : <Ltr key="b">{`@${view.botUsername}`}</Ltr>,
                  ],
                ]}
              />
            )}
            <ol className="hosting-act-steps" aria-label={t('web.hosting_act_steps_label')}>
              {HOSTED_ACTIVATION_STEPS.map((step) => (
                <StepRow
                  key={step}
                  step={view.steps.find((entry) => entry.step === step) as HostedActivationStepView}
                  running={run.isPending && run.variables === RUNNABLE[step]}
                  disabled={!configured || run.isPending}
                  onRun={() => {
                    const runnable = RUNNABLE[step];
                    if (runnable !== undefined) run.mutate(runnable);
                  }}
                  onMakeLink={() => setDialog('link')}
                />
              ))}
            </ol>
            {run.isError && (
              <Banner tone="danger">
                {errorText(run.error)}
                <ErrorRef error={run.error} />
              </Banner>
            )}
            <LinkStatus view={view} />
            <div className="hosting-actions">
              <Button size="sm" icon="key" onClick={() => setDialog('configure')}>
                {configured ? t('web.hosting_act_reconfigure') : t('web.hosting_act_configure')}
              </Button>
            </div>
          </>
        )}
      </StateSwitch>
      {dialog === 'configure' && (
        <ConfigureDialog
          bot={bot}
          initialDomain={view?.domain ?? ''}
          onClose={() => setDialog(null)}
          onDone={(next) => {
            settle(next);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'link' && (
        <CodePromptDialog
          title={`${t('web.hosting_act_link_make')} — ${bot.displayName}`}
          hint={t('web.hosting_act_link_hint')}
          confirmLabel={t('web.hosting_act_link_make')}
          run={({ proof, idempotencyKey }) =>
            issueHostedActivationLink(bot.tenantId, { idempotencyKey, proof })
          }
          onClose={() => setDialog(null)}
          onDone={(response) => {
            settle(response.activation);
            setDialog(null);
            setRevealed(response.activationUrl);
          }}
        />
      )}
      {revealed !== null && <LinkReveal url={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function DnsHelp({ view }: { view: HostedActivationView }) {
  const { hostname, addresses } = view.dnsTarget;
  if (hostname === null && addresses.length === 0) return null;
  return (
    <div className="muted small hosting-act-dns">
      {hostname !== null && (
        <p>
          {t('web.hosting_act_dns_help')} <Ltr>{hostname}</Ltr>
        </p>
      )}
      {addresses.length > 0 && (
        <p>
          {t('web.hosting_act_dns_help_ip')} <Ltr>{addresses.join(', ')}</Ltr>
        </p>
      )}
    </div>
  );
}

function StepRow({
  step,
  running,
  disabled,
  onRun,
  onMakeLink,
}: {
  step: HostedActivationStepView;
  running: boolean;
  disabled: boolean;
  onRun: () => void;
  onMakeLink: () => void;
}) {
  const label = ACTIVATION_STEP_LABEL[step.step];
  const done = step.state === 'DONE';
  const isLink = step.step === 'LINK';
  return (
    <li className="hosting-act-step" data-step={step.step} data-status={step.state}>
      <div className="hosting-inline">
        <Badge tone={STATE_TONE[step.state]} dot>
          {t(STATE_LABEL[step.state])}
        </Badge>
        <strong>{t(done ? label.done : label.todo)}</strong>
        {isLink ? (
          <Button size="sm" icon="link" disabled={disabled} onClick={onMakeLink}>
            {done ? t('web.hosting_act_link_remake') : t('web.hosting_act_link_make')}
          </Button>
        ) : (
          <Button size="sm" icon="refresh" disabled={disabled} onClick={onRun}>
            {running
              ? t('web.hosting_act_running')
              : done
                ? t('web.hosting_act_run')
                : t('web.hosting_act_run_first')}
          </Button>
        )}
      </div>
      {step.state === 'FAILED' && step.errorCode !== null && (
        <p className="error small" role="alert">
          {errorText(new ApiError(412, step.errorCode, ''))}
        </p>
      )}
      {done && step.doneAt !== null && (
        <span className="muted small">{formatTimestamp(step.doneAt)}</span>
      )}
    </li>
  );
}

function LinkStatus({ view }: { view: HostedActivationView }) {
  return (
    <div className="stack">
      {view.ownerActivatedAt !== null && (
        <Banner tone="ok">
          {t('web.hosting_act_owner_activated')} — {formatTimestamp(view.ownerActivatedAt)}
        </Banner>
      )}
      {view.link !== null && view.ownerActivatedAt === null && (
        <p className="muted small">
          {t(ACTIVATION_LINK_STATE_LABEL[view.link.state])}
          {view.link.state === 'ACTIVE' && (
            <>
              {' — '}
              {t('web.hosting_act_link_expires')} {formatTimestamp(view.link.expiresAt)}
            </>
          )}
        </p>
      )}
    </div>
  );
}

function ConfigureDialog({
  bot,
  initialDomain,
  onClose,
  onDone,
}: {
  bot: HostedBotView;
  initialDomain: string;
  onClose: () => void;
  onDone: (view: HostedActivationView) => void;
}) {
  const id = useId();
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState(initialDomain);
  return (
    <CodePromptDialog
      title={`${t('web.hosting_act_configure')} — ${bot.displayName}`}
      hint={t('web.hosting_act_configure_hint')}
      confirmLabel={t('web.hosting_act_configure')}
      valid={token.trim().length >= 10 && domain.trim().length > 0}
      run={({ proof, idempotencyKey }) =>
        configureHostedActivation(bot.tenantId, {
          idempotencyKey,
          proof,
          botToken: token.trim(),
          domain: domain.trim(),
        })
      }
      onClose={onClose}
      onDone={(response) => onDone(response.activation)}
    >
      <Field label={t('web.hosting_act_token_label')} htmlFor={`${id}-token`}>
        <input
          id={`${id}-token`}
          className="input"
          dir="ltr"
          type="password"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
        />
      </Field>
      <Field label={t('web.hosting_act_domain_label')} htmlFor={`${id}-domain`}>
        <input
          id={`${id}-domain`}
          className="input"
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="bot.example.com"
          value={domain}
          onChange={(event) => setDomain(event.currentTarget.value)}
        />
      </Field>
    </CodePromptDialog>
  );
}

/** Shown once: the page never has the link again. */
function LinkReveal({ url, onClose }: { url: string | null; onClose: () => void }) {
  return (
    <Modal
      open
      onClose={onClose}
      title={t('web.hosting_act_link_make')}
      foot={
        <button type="button" className="btn primary" onClick={onClose}>
          {t('web.hosting_act_done')}
        </button>
      }
    >
      <div className="stack">
        <Banner tone="warn" title={t('web.hosting_act_link_once_title')}>
          {t('web.hosting_act_link_once_body')}
        </Banner>
        {url !== null && (
          <>
            <code className="hosting-act-link" dir="ltr">
              {url}
            </code>
            <CopyButton value={url} label={t('web.hosting_act_link_copy')} />
          </>
        )}
      </div>
    </Modal>
  );
}
