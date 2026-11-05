import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  HOSTED_BOT_TRANSITIONS,
  adminDisplayNameSchema,
  adminPasswordSchema,
  adminUsernameSchema,
  hostedBotSlugSchema,
  type CapacityLimitView,
  type HostedBotAction,
  type HostedBotView,
  type HostingCreateRefusal,
} from '@nexa/contracts';
import {
  actOnHostedBot,
  createHostedBot,
  fetchHostedBotPurgePreview,
  fetchHostedBots,
  purgeHostedBot,
  setHostedBotExpiry,
  setHostedBotLimit,
} from '../api/client';
import { errorText } from '../error-text';
import { formatNumber, formatTimestamp } from '../format';
import {
  HOSTED_STATE_LABEL,
  HOSTING_CREATE_REFUSAL_LABEL,
  HOSTING_RESOURCE_LABEL,
  limitText,
} from '../hosting-labels';
import { t } from '../i18n/web.fa';
import { queryState } from '../view-state';
import { DateField } from '../ui/date-field';
import {
  Badge,
  Banner,
  Button,
  Disclosure,
  Empty,
  Field,
  KV,
  Ltr,
  StateSwitch,
  Switch,
  useToast,
} from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { fromLocalInput, toLocalInput } from './incidents';
import { CodePromptDialog, HOSTING_BOTS_KEY, HOSTING_SERVER_KEY } from './hosting-parts';

/**
 * The hosted bots: one card each, and the dialogs behind its actions. Every action asks for a
 * fresh code through `CodePromptDialog`; the server charges the code and the section session
 * again, so nothing here is the security, only the order the owner meets things in.
 */

type Dialog =
  | { readonly kind: 'create' }
  | {
      readonly kind: 'suspend' | 'activate' | 'delete' | 'purge' | 'expiry';
      readonly bot: HostedBotView;
    };

const mayDo = (bot: HostedBotView, action: HostedBotAction): boolean =>
  HOSTED_BOT_TRANSITIONS[action].from.includes(bot.state);

export function HostedBots({
  fallbackCreate,
}: {
  fallbackCreate: { enabled: boolean; refusal: HostingCreateRefusal | null };
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const bots = useQuery({ queryKey: HOSTING_BOTS_KEY, queryFn: fetchHostedBots });
  const [dialog, setDialog] = useState<Dialog | null>(null);

  const create = bots.data?.create ?? fallbackCreate;
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: HOSTING_BOTS_KEY });
    void queryClient.invalidateQueries({ queryKey: HOSTING_SERVER_KEY });
  };
  const done = (message?: string): void => {
    setDialog(null);
    refresh();
    if (message !== undefined) toast({ tone: 'ok', message });
  };

  return (
    <section className="hosting-section" aria-labelledby="hosting-bots-heading">
      <header className="hosting-section-head">
        <h2 id="hosting-bots-heading">{t('web.hosting_bots_title')}</h2>
        <Button
          variant="primary"
          icon="plus"
          disabled={!create.enabled}
          aria-describedby={create.enabled ? undefined : 'hosting-create-reason'}
          onClick={() => setDialog({ kind: 'create' })}
        >
          {t('web.hosting_create')}
        </Button>
      </header>
      {!create.enabled && create.refusal !== null && (
        <div id="hosting-create-reason">
          <Banner tone="warn">{t(HOSTING_CREATE_REFUSAL_LABEL[create.refusal])}</Banner>
        </div>
      )}
      <StateSwitch
        query={bots}
        isEmpty={bots.data?.bots.length === 0}
        empty={
          <Empty
            icon="bots"
            title={t('web.hosting_bots_empty_title')}
            hint={t('web.hosting_bots_empty_hint')}
          />
        }
      >
        <div className="hosting-bots">
          {bots.data?.bots.map((bot) => (
            <BotCard
              key={bot.tenantId}
              bot={bot}
              onAction={(kind) => setDialog({ kind, bot })}
              onLimitSaved={refresh}
            />
          ))}
        </div>
      </StateSwitch>

      {dialog?.kind === 'create' && <CreateDialog onClose={() => setDialog(null)} onDone={done} />}
      {dialog !== null &&
        (dialog.kind === 'suspend' || dialog.kind === 'activate' || dialog.kind === 'delete') && (
          <ActionDialog
            kind={dialog.kind}
            bot={dialog.bot}
            onClose={() => setDialog(null)}
            onDone={() => done()}
          />
        )}
      {dialog?.kind === 'purge' && (
        <PurgeDialog
          bot={dialog.bot}
          onClose={() => setDialog(null)}
          onDone={() => done(t('web.hosting_purge_done'))}
        />
      )}
      {dialog?.kind === 'expiry' && (
        <ExpiryDialog bot={dialog.bot} onClose={() => setDialog(null)} onDone={() => done()} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// One bot
// ---------------------------------------------------------------------------------------

const DASH = '—';

function BotCard({
  bot,
  onAction,
  onLimitSaved,
}: {
  bot: HostedBotView;
  onAction: (kind: 'suspend' | 'activate' | 'delete' | 'purge' | 'expiry') => void;
  onLimitSaved: () => void;
}) {
  const state = HOSTED_STATE_LABEL[bot.state];
  const custom = bot.resources.filter((row) => row.limit.source === 'STORED').length;
  const pressure = bot.resources.reduce((sum, row) => sum + row.pressureAlertsLast24h, 0);
  const closed = bot.state === 'PURGED';
  const nameId = useId();
  return (
    <article className="hosting-bot card" aria-labelledby={nameId}>
      <header className="hosting-bot-head">
        <div className="hosting-bot-title">
          <h3 id={nameId}>{bot.displayName}</h3>
          <Ltr>{bot.slug}</Ltr>
        </div>
        <Badge tone={state.tone} dot>
          {t(state.label)}
        </Badge>
      </header>
      <KV
        items={[
          [
            t('web.hosting_expiry'),
            bot.expiresAt === null ? t('web.hosting_expiry_none') : formatTimestamp(bot.expiresAt),
          ],
          [t('web.hosting_customers'), formatNumber(bot.customerCount)],
          [
            t('web.hosting_last_backup'),
            bot.lastBackupAt === null ? DASH : formatTimestamp(bot.lastBackupAt),
          ],
          [
            t('web.hosting_web_admin'),
            bot.webAdmin === null ? DASH : <Ltr key="admin">{bot.webAdmin.username}</Ltr>,
          ],
          [
            t('web.hosting_telegram_bot'),
            bot.telegramBot === null ? (
              t('web.hosting_not_connected')
            ) : (
              <span key="bot" className="hosting-inline">
                <Ltr>{`@${bot.telegramBot.username}`}</Ltr>
                <Badge tone={bot.telegramBot.status === 'ACTIVE' ? 'ok' : 'neutral'}>
                  {t(BOT_STATUS_LABEL[bot.telegramBot.status])}
                </Badge>
              </span>
            ),
          ],
          [
            t('web.hosting_resources'),
            <span key="res" className="hosting-inline">
              <span>
                {t('web.hosting_resources_summary')}: {formatNumber(custom)}
              </span>
              {pressure > 0 && (
                <Badge tone="warn">
                  {formatNumber(pressure)} {t('web.hosting_pressure_summary')}
                </Badge>
              )}
            </span>,
          ],
        ]}
      />
      {!closed && (
        <div className="hosting-actions" role="group" aria-label={t('web.hosting_actions_label')}>
          {mayDo(bot, 'SUSPEND') && (
            <Button size="sm" icon="pause" onClick={() => onAction('suspend')}>
              {t('web.hosting_action_suspend')}
            </Button>
          )}
          {mayDo(bot, 'ACTIVATE') && (
            <Button size="sm" icon="play" onClick={() => onAction('activate')}>
              {t('web.hosting_action_activate')}
            </Button>
          )}
          {bot.state !== 'DELETED' && (
            <Button size="sm" icon="calendar" onClick={() => onAction('expiry')}>
              {t('web.hosting_action_expiry')}
            </Button>
          )}
          {mayDo(bot, 'DELETE') && (
            <Button size="sm" variant="danger" icon="trash" onClick={() => onAction('delete')}>
              {t('web.hosting_action_delete')}
            </Button>
          )}
          {mayDo(bot, 'PURGE') && (
            <Button size="sm" variant="danger" icon="alert" onClick={() => onAction('purge')}>
              {t('web.hosting_action_purge')}
            </Button>
          )}
          <span className="hosting-inline">
            <Button size="sm" icon="external" disabled>
              {t('web.hosting_action_enter')}
            </Button>
            <span className="muted small">{t('web.hosting_enter_later')}</span>
          </span>
        </div>
      )}
      {!closed && (
        <Disclosure summary={t('web.hosting_action_limits')} size="sm">
          <LimitsEditor bot={bot} onSaved={onLimitSaved} />
        </Disclosure>
      )}
    </article>
  );
}

const BOT_STATUS_LABEL = {
  ACTIVE: 'web.bot_status_active',
  STOPPED: 'web.bot_status_stopped',
  DISABLED: 'web.bot_status_disabled',
} as const;

// ---------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------

interface LimitIntent {
  readonly row: CapacityLimitView;
  /** `null` = back to the default. */
  readonly limit: { mode: 'LIMITED'; value: number } | { mode: 'UNLIMITED' } | null;
}

function LimitsEditor({ bot, onSaved }: { bot: HostedBotView; onSaved: () => void }) {
  const [intent, setIntent] = useState<LimitIntent | null>(null);
  return (
    <div className="stack">
      <p className="muted small">{t('web.hosting_limits_hint')}</p>
      <ul className="hosting-limits">
        {bot.resources.map((resource) => (
          <LimitRow
            key={`${resource.limit.resource}:${resource.limit.source}:${limitText(resource.limit.limit)}`}
            view={resource.limit}
            pressure={resource.pressureAlertsLast24h}
            onIntent={(limit) => setIntent({ row: resource.limit, limit })}
          />
        ))}
      </ul>
      {intent !== null && (
        <CodePromptDialog
          title={
            intent.limit === null
              ? t('web.hosting_limit_reset_title')
              : t('web.hosting_limit_set_title')
          }
          hint={`${t('web.hosting_limit_set_hint')} ${bot.displayName} — ${t(HOSTING_RESOURCE_LABEL[intent.row.resource])}: ${
            intent.limit === null ? t('web.hosting_limit_default') : limitText(intent.limit)
          }`}
          confirmLabel={t('web.hosting_limit_save')}
          run={({ proof, idempotencyKey }) =>
            setHostedBotLimit(bot.tenantId, {
              idempotencyKey,
              proof,
              resource: intent.row.resource,
              limit: intent.limit,
            })
          }
          onClose={() => setIntent(null)}
          onDone={() => {
            setIntent(null);
            onSaved();
          }}
        />
      )}
    </div>
  );
}

function LimitRow({
  view,
  pressure,
  onIntent,
}: {
  view: CapacityLimitView;
  pressure: number;
  onIntent: (limit: LimitIntent['limit']) => void;
}) {
  const id = useId();
  const inForce = view.limit;
  const [unlimited, setUnlimited] = useState(inForce.mode === 'UNLIMITED');
  const [value, setValue] = useState(inForce.mode === 'LIMITED' ? String(inForce.value) : '');
  const typed = value.trim() === '' ? Number.NaN : Number(value);
  const inRange = Number.isInteger(typed) && typed >= view.min && typed <= view.max;
  const draft: LimitIntent['limit'] = unlimited
    ? { mode: 'UNLIMITED' }
    : inRange
      ? { mode: 'LIMITED', value: typed }
      : null;
  const changed =
    draft !== null &&
    (draft.mode !== inForce.mode ||
      (draft.mode === 'LIMITED' && inForce.mode === 'LIMITED' && draft.value !== inForce.value));
  return (
    <li className="hosting-limit">
      <div className="hosting-limit-head">
        <strong>{t(HOSTING_RESOURCE_LABEL[view.resource])}</strong>
        <span className="hosting-inline">
          <Badge tone={view.source === 'STORED' ? 'info' : 'neutral'}>
            {view.source === 'STORED'
              ? t('web.hosting_limit_source_stored')
              : t('web.hosting_limit_source_default')}
          </Badge>
          {view.consumer === 'PLANNED' && (
            <Badge tone="neutral" outline>
              {t('web.hosting_limit_planned')}
            </Badge>
          )}
          {pressure > 0 && (
            <Badge tone="warn">
              {formatNumber(pressure)} {t('web.hosting_limit_pressure')}
            </Badge>
          )}
        </span>
      </div>
      <p className="muted small">
        {t('web.hosting_limit_default_is')} {limitText(view.defaultLimit)} ·{' '}
        {t('web.hosting_limit_range')} {formatNumber(view.min)}–{formatNumber(view.max)}
      </p>
      <div className="hosting-limit-edit">
        <Field label={t('web.hosting_limit_value')} htmlFor={`${id}-value`} compact>
          <input
            id={`${id}-value`}
            className="input"
            dir="ltr"
            inputMode="numeric"
            value={unlimited ? '' : value}
            disabled={unlimited}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </Field>
        {view.allowsUnlimited && (
          <span className="hosting-inline">
            <Switch
              checked={unlimited}
              onChange={setUnlimited}
              label={`${t('web.hosting_limit_unlimited')} — ${t(HOSTING_RESOURCE_LABEL[view.resource])}`}
            />
            <span>{t('web.hosting_limit_unlimited')}</span>
          </span>
        )}
        <Button
          size="sm"
          variant="primary"
          disabled={!changed}
          onClick={() => onIntent(draft)}
          aria-label={`${t('web.hosting_limit_save')} — ${t(HOSTING_RESOURCE_LABEL[view.resource])}`}
        >
          {t('web.hosting_limit_save')}
        </Button>
        {view.source === 'STORED' && (
          <Button
            size="sm"
            onClick={() => onIntent(null)}
            aria-label={`${t('web.hosting_limit_reset')} — ${t(HOSTING_RESOURCE_LABEL[view.resource])}`}
          >
            {t('web.hosting_limit_default')}
          </Button>
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------

function CreateDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const id = useId();
  const [form, setForm] = useState({
    slug: '',
    displayName: '',
    adminUsername: '',
    adminDisplayName: '',
    adminPassword: '',
    expires: '',
  });
  const set = (key: keyof typeof form, value: string): void =>
    setForm((current) => ({ ...current, [key]: value }));
  const slugOk = hostedBotSlugSchema.safeParse(form.slug).success;
  const nameOk = form.displayName.trim() !== '' && form.displayName.trim().length <= 120;
  const userOk = adminUsernameSchema.safeParse(form.adminUsername).success;
  const adminNameOk = adminDisplayNameSchema.safeParse(form.adminDisplayName).success;
  const passwordOk = adminPasswordSchema.safeParse(form.adminPassword).success;
  const invalid = (touched: string, ok: boolean): string | undefined =>
    touched !== '' && !ok ? t('web.hosting_field_invalid') : undefined;
  return (
    <CodePromptDialog
      title={t('web.hosting_create_title')}
      hint={t('web.hosting_create_hint')}
      confirmLabel={t('web.hosting_create_submit')}
      valid={slugOk && nameOk && userOk && adminNameOk && passwordOk}
      run={({ proof, idempotencyKey }) =>
        createHostedBot({
          idempotencyKey,
          proof,
          slug: form.slug.trim(),
          displayName: form.displayName.trim(),
          adminUsername: form.adminUsername.trim(),
          adminDisplayName: form.adminDisplayName.trim(),
          adminPassword: form.adminPassword,
          expiresAt: fromLocalInput(form.expires),
        })
      }
      onClose={onClose}
      onDone={() => onDone()}
    >
      <Field
        label={t('web.hosting_field_slug')}
        htmlFor={`${id}-slug`}
        hint={t('web.hosting_field_slug_hint')}
        {...optionalError(invalid(form.slug, slugOk))}
        required
      >
        <input
          id={`${id}-slug`}
          className="input"
          dir="ltr"
          autoCapitalize="none"
          spellCheck={false}
          value={form.slug}
          onChange={(event) => set('slug', event.currentTarget.value)}
        />
      </Field>
      <Field label={t('web.hosting_field_display_name')} htmlFor={`${id}-name`} required>
        <input
          id={`${id}-name`}
          className="input"
          maxLength={120}
          value={form.displayName}
          onChange={(event) => set('displayName', event.currentTarget.value)}
        />
      </Field>
      <Field
        label={t('web.hosting_field_admin_username')}
        htmlFor={`${id}-user`}
        {...optionalError(invalid(form.adminUsername, userOk))}
        required
      >
        <input
          id={`${id}-user`}
          className="input"
          dir="ltr"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          value={form.adminUsername}
          onChange={(event) => set('adminUsername', event.currentTarget.value)}
        />
      </Field>
      <Field
        label={t('web.hosting_field_admin_display_name')}
        htmlFor={`${id}-admin-name`}
        {...optionalError(invalid(form.adminDisplayName, adminNameOk))}
        required
      >
        <input
          id={`${id}-admin-name`}
          className="input"
          value={form.adminDisplayName}
          onChange={(event) => set('adminDisplayName', event.currentTarget.value)}
        />
      </Field>
      <Field
        label={t('web.hosting_field_admin_password')}
        htmlFor={`${id}-password`}
        {...optionalError(invalid(form.adminPassword, passwordOk))}
        required
      >
        <input
          id={`${id}-password`}
          type="password"
          className="input"
          dir="ltr"
          autoComplete="new-password"
          value={form.adminPassword}
          onChange={(event) => set('adminPassword', event.currentTarget.value)}
        />
      </Field>
      <Field
        label={t('web.hosting_field_expiry')}
        htmlFor={`${id}-expiry`}
        hint={t('web.hosting_field_expiry_hint')}
      >
        <DateField
          id={`${id}-expiry`}
          mode="datetime"
          value={form.expires}
          onChange={(next) => set('expires', next)}
        />
      </Field>
    </CodePromptDialog>
  );
}

/** `exactOptionalPropertyTypes`: an absent error is an absent prop, never `undefined`. */
function optionalError(error: string | undefined): { error?: string } {
  return error === undefined ? {} : { error };
}

const ACTION_COPY = {
  suspend: {
    title: 'web.hosting_suspend_title',
    hint: 'web.hosting_suspend_hint',
    submit: 'web.hosting_suspend_submit',
    danger: false,
  },
  activate: {
    title: 'web.hosting_activate_title',
    hint: 'web.hosting_activate_hint',
    submit: 'web.hosting_activate_submit',
    danger: false,
  },
  delete: {
    title: 'web.hosting_delete_title',
    hint: 'web.hosting_delete_hint',
    submit: 'web.hosting_delete_submit',
    danger: true,
  },
} as const;

function ActionDialog({
  kind,
  bot,
  onClose,
  onDone,
}: {
  kind: 'suspend' | 'activate' | 'delete';
  bot: HostedBotView;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const copy = ACTION_COPY[kind];
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const route = kind === 'activate' ? 'activateBot' : kind;
  return (
    <CodePromptDialog
      title={`${t(copy.title)} — ${bot.displayName}`}
      hint={t(copy.hint)}
      confirmLabel={t(copy.submit)}
      danger={copy.danger}
      valid={trimmed.length <= 500}
      run={({ proof, idempotencyKey }) =>
        actOnHostedBot(route, bot.tenantId, {
          idempotencyKey,
          proof,
          ...(trimmed === '' ? {} : { reason: trimmed }),
        })
      }
      onClose={onClose}
      onDone={onDone}
    >
      <Field
        label={t('web.hosting_reason')}
        htmlFor={`${id}-reason`}
        hint={t('web.hosting_reason_hint')}
      >
        <input
          id={`${id}-reason`}
          className="input"
          maxLength={500}
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
        />
      </Field>
    </CodePromptDialog>
  );
}

function PurgeDialog({
  bot,
  onClose,
  onDone,
}: {
  bot: HostedBotView;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState('');
  // Counted fresh each time the dialog opens: a stale count would understate what is erased.
  const preview = useQuery({
    queryKey: ['hosting', 'purge-preview', bot.tenantId],
    queryFn: () => fetchHostedBotPurgePreview(bot.tenantId),
    gcTime: 0,
  });
  const confirmSlug = preview.data?.confirmSlug;
  const counts = preview.data?.counts;
  return (
    <CodePromptDialog
      title={`${t('web.hosting_purge_title')} — ${bot.displayName}`}
      hint={t('web.hosting_purge_hint')}
      confirmLabel={t('web.hosting_purge_submit')}
      danger
      valid={confirmSlug !== undefined && typed.trim() === confirmSlug}
      run={({ proof, idempotencyKey }) =>
        purgeHostedBot(bot.tenantId, { idempotencyKey, proof, confirmSlug: typed.trim() })
      }
      onClose={onClose}
      onDone={onDone}
    >
      {preview.isPending && <p className="muted small">{t('web.loading')}</p>}
      {queryState(preview) === 'error' && (
        <Banner tone="danger">
          {errorText(preview.error)}
          <ErrorRef error={preview.error} />
        </Banner>
      )}
      {counts !== undefined && (
        <section aria-label={t('web.hosting_purge_counts')}>
          <h3 className="hosting-subhead">{t('web.hosting_purge_counts')}</h3>
          <KV
            columns
            items={[
              [t('web.hosting_purge_customers'), formatNumber(counts.customers)],
              [t('web.hosting_purge_orders'), formatNumber(counts.orders)],
              [t('web.hosting_purge_services'), formatNumber(counts.services)],
              [t('web.hosting_purge_payments'), formatNumber(counts.payments)],
              [t('web.hosting_purge_admins'), formatNumber(counts.admins)],
            ]}
          />
        </section>
      )}
      <Field
        label={t('web.hosting_purge_confirm_label')}
        htmlFor={`${id}-slug`}
        {...(confirmSlug === undefined ? {} : { hint: confirmSlug })}
      >
        <input
          id={`${id}-slug`}
          className="input"
          dir="ltr"
          autoCapitalize="none"
          spellCheck={false}
          autoComplete="off"
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
      </Field>
    </CodePromptDialog>
  );
}

function ExpiryDialog({
  bot,
  onClose,
  onDone,
}: {
  bot: HostedBotView;
  onClose: () => void;
  onDone: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(toLocalInput(bot.expiresAt));
  return (
    <CodePromptDialog
      title={`${t('web.hosting_expiry_title')} — ${bot.displayName}`}
      hint={t('web.hosting_expiry_hint')}
      confirmLabel={t('web.hosting_expiry_submit')}
      run={({ proof, idempotencyKey }) =>
        setHostedBotExpiry(bot.tenantId, {
          idempotencyKey,
          proof,
          expiresAt: fromLocalInput(value),
        })
      }
      onClose={onClose}
      onDone={onDone}
    >
      <Field
        label={t('web.hosting_field_expiry')}
        htmlFor={`${id}-expiry`}
        hint={t('web.hosting_field_expiry_hint')}
      >
        <DateField id={`${id}-expiry`} mode="datetime" value={value} onChange={setValue} />
      </Field>
    </CodePromptDialog>
  );
}
