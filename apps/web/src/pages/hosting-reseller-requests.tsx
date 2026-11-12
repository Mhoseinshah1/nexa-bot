import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RESELLER_BOT_GRACE_DAYS_MAX,
  RESELLER_BOT_GRACE_DAYS_SETTING_KEY,
  RESELLER_BOT_MONTHLY_FEE_SETTING_KEY,
  RESELLER_BOT_REJECT_REASON_MAX,
  RESELLER_BOT_REJECT_REASON_MIN,
  type MoneyWire,
  type ResellerBotRequestAdminView,
  type ResellerBotRequestState,
  type ResolvedSettingResponse,
} from '@nexa/contracts';
import {
  approveResellerBotRequest,
  configureResellerBotActivation,
  fetchResellerBotRequests,
  fetchSettings,
  rejectResellerBotRequest,
  saveSetting,
} from '../api/client';
import { errorText } from '../error-text';
import { currencyLabel, formatMoneyText, formatTimestamp } from '../format';
import { HOSTED_STATE_LABEL } from '../hosting-labels';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  KV,
  Ltr,
  StateSwitch,
  useToast,
} from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { FormDialog } from './form-dialog';
import { CodePromptDialog, HOSTING_BOTS_KEY } from './hosting-parts';
import { CreateDialog } from './hosting-bots';

/**
 * Reseller-phase PR-6: «میزبانی‌ها» → «درخواست‌های نماینده‌ها».
 *
 * The owner's list of resellers' dedicated-bot requests, the two settings that price them, and
 * per request: approve (a fresh code; debits the first month from the reseller's wallet),
 * reject (a reason), create the hosted bot through the EXISTING «ساخت ربات» form pre-filled and
 * linked, and hand the request's sealed token to the bot's activation. The token is never shown.
 */
export const RESELLER_BOT_REQUESTS_KEY = ['hosting', 'reseller-bot-requests'] as const;

const STATE_LABEL: Readonly<
  Record<
    ResellerBotRequestState,
    { readonly label: WebKey; readonly tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info' }
  >
> = {
  PENDING: { label: 'web.rbot_state_pending', tone: 'info' },
  APPROVED: { label: 'web.rbot_state_approved', tone: 'ok' },
  REJECTED: { label: 'web.rbot_state_rejected', tone: 'danger' },
  CANCELLED: { label: 'web.rbot_state_cancelled', tone: 'neutral' },
};

const BILLING_LABEL: Readonly<Record<string, WebKey>> = {
  NONE: 'web.rbot_billing_none',
  PAID: 'web.rbot_billing_paid',
  GRACE: 'web.rbot_billing_grace',
  STOPPED: 'web.rbot_billing_stopped',
};

type Dialog = {
  readonly kind: 'approve' | 'reject' | 'create' | 'configure';
  readonly request: ResellerBotRequestAdminView;
} | null;

export function ResellerBotRequests() {
  const queryClient = useQueryClient();
  const requests = useQuery({
    queryKey: RESELLER_BOT_REQUESTS_KEY,
    queryFn: fetchResellerBotRequests,
  });
  const [dialog, setDialog] = useState<Dialog>(null);
  const toast = useToast();
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: RESELLER_BOT_REQUESTS_KEY });
    await queryClient.invalidateQueries({ queryKey: HOSTING_BOTS_KEY });
  };
  const close = () => setDialog(null);
  const done = (message: WebKey) => {
    setDialog(null);
    toast({ tone: 'ok', message: t(message) });
    void refresh();
  };
  return (
    <div className="stack">
      <ResellerBotSettings />
      <Card title={t('web.rbot_requests_title')} hint={t('web.rbot_requests_hint')}>
        <StateSwitch query={requests}>
          {requests.data !== undefined &&
            (requests.data.requests.length === 0 ? (
              <Empty title={t('web.rbot_requests_empty')} />
            ) : (
              <div className="stack">
                {requests.data.requests.map((request) => (
                  <RequestCard key={request.id} request={request} onAction={setDialog} />
                ))}
              </div>
            ))}
        </StateSwitch>
      </Card>
      {dialog?.kind === 'approve' && (
        <CodePromptDialog
          title={t('web.rbot_approve_title')}
          hint={`${t('web.rbot_approve_hint')} ${formatMoneyText(dialog.request.fee)}`}
          confirmLabel={t('web.rbot_approve')}
          run={({ proof, idempotencyKey }) =>
            approveResellerBotRequest(dialog.request.id, { proof, idempotencyKey })
          }
          onClose={close}
          onDone={() => done('web.rbot_approved_toast')}
        />
      )}
      {dialog?.kind === 'reject' && (
        <RejectDialog
          request={dialog.request}
          onClose={close}
          onDone={() => done('web.rbot_rejected_toast')}
        />
      )}
      {dialog?.kind === 'create' && (
        <CreateDialog
          prefill={{
            resellerBotRequestId: dialog.request.id,
            slug: slugFrom(dialog.request.botUsername),
            displayName: dialog.request.botUsername,
          }}
          onClose={close}
          onDone={() => done('web.rbot_created_toast')}
        />
      )}
      {dialog?.kind === 'configure' && (
        <ConfigureDialog
          request={dialog.request}
          onClose={close}
          onDone={() => done('web.rbot_configured_toast')}
        />
      )}
    </div>
  );
}

/** A hosted-bot slug suggested from the Telegram username: lowercase, hyphens, 3–48. */
function slugFrom(username: string): string {
  const slug = username
    .toLowerCase()
    .replace(/_?bot$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length >= 3 ? slug : `${slug}-bot`;
}

function RequestCard({
  request,
  onAction,
}: {
  request: ResellerBotRequestAdminView;
  onAction: (dialog: Dialog) => void;
}) {
  const state = STATE_LABEL[request.state];
  const hosted =
    request.hostedBot.state === null ? null : HOSTED_STATE_LABEL[request.hostedBot.state];
  const items: [ReactNode, ReactNode][] = [
    [
      t('web.rbot_reseller'),
      request.customer.displayName ?? request.customer.telegramUserId ?? '—',
    ],
    [t('web.rbot_fee'), formatMoneyText(request.fee)],
    [t('web.rbot_token'), <Ltr key="token">{request.tokenMasked}</Ltr>],
    [
      t('web.rbot_domain'),
      request.domain === null ? '—' : <Ltr key="domain">{request.domain}</Ltr>,
    ],
    [t('web.rbot_created_at'), formatTimestamp(request.createdAt)],
    [t('web.rbot_billing'), t(BILLING_LABEL[request.billing.state] ?? 'web.rbot_billing_none')],
  ];
  if (request.billing.paidThrough !== null) {
    items.push([t('web.rbot_paid_through'), formatTimestamp(request.billing.paidThrough)]);
  }
  if (request.billing.stopsAt !== null) {
    items.push([t('web.rbot_stops_at'), formatTimestamp(request.billing.stopsAt)]);
  }
  if (hosted !== null) {
    items.push([
      t('web.rbot_hosted_state'),
      <Badge key="hosted" tone={hosted.tone}>
        {t(hosted.label)}
      </Badge>,
    ]);
  }
  if (request.rejectReason !== null) {
    items.push([t('web.rbot_reject_reason'), request.rejectReason]);
  }
  return (
    <Card
      tight
      title={
        <>
          {t('web.rbot_request_number')} <Ltr>{request.number}</Ltr> ·{' '}
          <Ltr>@{request.botUsername}</Ltr>
        </>
      }
      actions={<Badge tone={state.tone}>{t(state.label)}</Badge>}
    >
      <KV columns items={items} />
      <div className="btn-group">
        {request.state === 'PENDING' && (
          <>
            <Button
              icon="check"
              variant="primary"
              onClick={() => onAction({ kind: 'approve', request })}
            >
              {t('web.rbot_approve')}
            </Button>
            <Button icon="x" variant="danger" onClick={() => onAction({ kind: 'reject', request })}>
              {t('web.rbot_reject')}
            </Button>
          </>
        )}
        {request.state === 'APPROVED' && request.hostedTenantId === null && (
          <Button
            icon="plus"
            variant="primary"
            onClick={() => onAction({ kind: 'create', request })}
          >
            {t('web.rbot_create_bot')}
          </Button>
        )}
        {request.state === 'APPROVED' && request.hostedTenantId !== null && (
          <Button icon="key" onClick={() => onAction({ kind: 'configure', request })}>
            {t('web.rbot_configure')}
          </Button>
        )}
      </div>
    </Card>
  );
}

function RejectDialog({
  request,
  onClose,
  onDone,
}: {
  request: ResellerBotRequestAdminView;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const submission = useSubmissionKey();
  const trimmed = reason.trim();
  const valid =
    trimmed.length >= RESELLER_BOT_REJECT_REASON_MIN &&
    trimmed.length <= RESELLER_BOT_REJECT_REASON_MAX;
  const mutation = useMutation({
    retry: false,
    mutationFn: (idempotencyKey: string) =>
      rejectResellerBotRequest(request.id, { idempotencyKey, reason: trimmed }),
    onSuccess: () => {
      submission.settle();
      onDone();
    },
    onError: (error) => submission.settleOn(error),
  });
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!valid || mutation.isPending) return;
    mutation.mutate(submission.current({ reason: trimmed }));
  };
  return (
    <FormDialog
      open
      danger
      title={t('web.rbot_reject_title')}
      dirty={reason !== ''}
      onClose={onClose}
      foot={
        <Button variant="danger" disabled={!valid || mutation.isPending} onClick={() => submit()}>
          {t('web.rbot_reject')}
        </Button>
      }
    >
      <form onSubmit={submit} className="stack">
        <Field
          label={t('web.rbot_reject_reason')}
          htmlFor={`${id}-reason`}
          hint={t('web.rbot_reject_reason_hint')}
          required
        >
          <textarea
            id={`${id}-reason`}
            className="input"
            rows={3}
            maxLength={RESELLER_BOT_REJECT_REASON_MAX}
            value={reason}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </Field>
        {mutation.error !== null && (
          <Banner tone="danger">
            {errorText(mutation.error)}
            <ErrorRef error={mutation.error} />
          </Banner>
        )}
      </form>
    </FormDialog>
  );
}

function ConfigureDialog({
  request,
  onClose,
  onDone,
}: {
  request: ResellerBotRequestAdminView;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [domain, setDomain] = useState(request.domain ?? '');
  return (
    <CodePromptDialog
      title={t('web.rbot_configure')}
      hint={t('web.rbot_configure_hint')}
      confirmLabel={t('web.rbot_configure')}
      valid={domain.trim() !== ''}
      run={({ proof, idempotencyKey }) =>
        configureResellerBotActivation(request.id, { proof, idempotencyKey, domain: domain.trim() })
      }
      onClose={onClose}
      onDone={onDone}
    >
      <Field label={t('web.rbot_domain')} htmlFor={`${id}-domain`} required>
        <input
          id={`${id}-domain`}
          className="input"
          dir="ltr"
          autoCapitalize="none"
          spellCheck={false}
          value={domain}
          onChange={(event) => setDomain(event.currentTarget.value)}
        />
      </Field>
    </CodePromptDialog>
  );
}

// ---------------------------------------------------------------------------------------
// The two owner-only settings
// ---------------------------------------------------------------------------------------

function ResellerBotSettings() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const settingOf = (key: string) => settings.data?.settings.find((one) => one.key === key);
  const selling = (settingOf('sales.currency')?.value ?? 'IRT') as string;
  return (
    <Card title={t('web.rbot_settings_title')} hint={t('web.rbot_settings_hint')}>
      <StateSwitch query={settings}>
        {settings.data !== undefined && (
          <div className="stack">
            <SettingRow
              setting={settingOf(RESELLER_BOT_MONTHLY_FEE_SETTING_KEY)}
              label={t('web.setting_reseller_bot_monthly_fee')}
              hint={t('web.setting_reseller_bot_monthly_fee_desc')}
              unit={currencyLabel(selling as never)}
              read={(value) => (value as MoneyWire | undefined)?.amountMinor ?? '0'}
              write={(draft) => ({ amountMinor: draft, currency: selling })}
              max={null}
            />
            <SettingRow
              setting={settingOf(RESELLER_BOT_GRACE_DAYS_SETTING_KEY)}
              label={t('web.setting_reseller_bot_grace_days')}
              hint={t('web.setting_reseller_bot_grace_days_desc')}
              unit={t('web.unit_days')}
              read={(value) => String(value ?? '')}
              write={(draft) => Number(draft)}
              max={RESELLER_BOT_GRACE_DAYS_MAX}
            />
          </div>
        )}
      </StateSwitch>
    </Card>
  );
}

function SettingRow({
  setting,
  label,
  hint,
  unit,
  read,
  write,
  max,
}: {
  setting: ResolvedSettingResponse | undefined;
  label: string;
  hint: string;
  unit: string;
  read: (value: unknown) => string;
  write: (draft: string) => unknown;
  max: number | null;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const toast = useToast();
  const stored = read(setting?.value);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? stored;
  const submission = useSubmissionKey();
  const valid = /^\d{1,19}$/.test(value.trim()) && (max === null || Number(value) <= max);
  const save = useMutation({
    retry: false,
    mutationFn: (command: { idempotencyKey: string; value: unknown }) =>
      saveSetting({
        key: setting?.key ?? '',
        value: command.value,
        expectedVersion: setting?.version ?? null,
        idempotencyKey: command.idempotencyKey,
      }),
    onSuccess: async () => {
      submission.settle();
      setDraft(null);
      toast({ tone: 'ok', message: t('web.rbot_setting_saved') });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      await queryClient.invalidateQueries({ queryKey: RESELLER_BOT_REQUESTS_KEY });
    },
    onError: (error) => submission.settleOn(error),
  });
  if (setting === undefined) return null;
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || draft === null) return;
    const next = write(value.trim().replace(/^0+(?=\d)/, ''));
    save.mutate({ idempotencyKey: submission.current({ next }), value: next });
  };
  return (
    <form onSubmit={onSubmit} className="stack-sm">
      <Field label={label} htmlFor={`${id}-value`} hint={hint}>
        <div className="input-group">
          <input
            id={`${id}-value`}
            className="input"
            dir="ltr"
            inputMode="numeric"
            value={value}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <span className="input-group-text">{unit}</span>
        </div>
      </Field>
      {!valid && <p className="muted small">{t('web.rbot_setting_invalid')}</p>}
      <div className="btn-group">
        <Button
          type="submit"
          variant="primary"
          disabled={!valid || draft === null || save.isPending}
        >
          {t('web.rbot_setting_save')}
        </Button>
        {stored === '0' && setting.key === RESELLER_BOT_MONTHLY_FEE_SETTING_KEY && (
          <span className="muted small">{t('web.rbot_not_offered')}</span>
        )}
      </div>
      {save.error !== null && (
        <Banner tone="danger">
          {errorText(save.error)}
          <ErrorRef error={save.error} />
        </Banner>
      )}
    </form>
  );
}
