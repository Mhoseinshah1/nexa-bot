import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CurrencyCode, MoneyWire, ResolvedSettingResponse } from '@nexa/contracts';
import { ApiError, fetchSettings, saveSetting } from '../api/client';
import { currencyLabel, formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { queryState } from './dashboard';
import {
  Badge,
  Banner,
  Card,
  Field,
  ListEditor,
  Ltr,
  MaturityBadge,
  PageHead,
  StateSwitch,
  Switch,
} from '../ui/kit';

/**
 * The settings screen.
 *
 * Every row shows its value, where the value came from, and what zero or empty
 * means for that key — the three things roughly fifteen legacy settings screens
 * never show, where "the only way to read a price is to overwrite it".
 *
 * A save carries the version the row was read at. A stale version comes back as
 * a conflict and is shown as one, rather than quietly discarding whatever the
 * other administrator did.
 *
 * New in Phase 3D: a key whose registry entry declares `consumer: 'PLANNED'` is
 * labelled as stored-but-unread. Four of the nine keys are in that state — the
 * store currency, the support accounts, the channels and the top-up minimum —
 * and an operator who configures required channel membership needs to know that
 * nothing enforces it yet. That is the whole reason `consumer` is a declared
 * field on the frozen registry rather than a list held in this file.
 */
export function SettingsPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const rows = settings.data?.settings ?? [];

  return (
    <>
      <PageHead title={t('web.settings_title')} subtitle={t('web.settings_intro')} maturity="now" />

      <StateSwitch
        state={denied ? 'denied' : queryState(settings, rows.length === 0)}
        onRetry={() => void settings.refetch()}
      >
        {rows.map((setting) => (
          <SettingRow key={setting.key} setting={setting} mayEdit={mayEdit} />
        ))}
      </StateSwitch>
    </>
  );
}

const ZERO_MEANING_KEYS: Record<ResolvedSettingResponse['zeroMeaning'], WebKey> = {
  DISABLES: 'web.zero_disables',
  UNLIMITED: 'web.zero_unlimited',
  LITERAL: 'web.zero_literal',
  NOT_APPLICABLE: 'web.zero_not_applicable',
};

function SettingRow({ setting, mayEdit }: { setting: ResolvedSettingResponse; mayEdit: boolean }) {
  const client = useQueryClient();

  /**
   * The row the draft is based on, held separately from the row the query
   * currently has.
   *
   * These two drift apart the moment somebody else saves this key: the query
   * refetches and `setting` becomes their row, while the field still holds what
   * THIS administrator typed. Submitting that text against the refetched
   * version would have overwritten their change without either person seeing
   * anything — precisely the failure the version check exists to prevent,
   * reintroduced one layer above it.
   *
   * So the write states the version the draft was actually based on. A
   * concurrent change therefore comes back as a conflict, which is already
   * shown, and the typing survives to be reapplied.
   */
  const [basis, setBasis] = useState<ResolvedSettingResponse>(setting);
  const [draft, setDraft] = useState<unknown>(setting.value);

  const changedElsewhere = basis.version !== setting.version;

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['settings'] });
    await client.invalidateQueries({ queryKey: ['features'] });
  };

  const adopt = (fresh: ResolvedSettingResponse) => {
    setBasis(fresh);
    setDraft(fresh.value);
  };

  const submission = useSubmissionKey();

  const save = useMutation({
    // The WHOLE command is the mutation's variable, not just its key.
    //
    // react-query hands the variables back unchanged on a retry, which is the
    // only way an idempotency key protects anything — but a `mutationFn` that
    // reads `draft` and `basis` out of the closure defeats that half way: the
    // retry carries the original key and the LATEST payload. Edit the field
    // during the 500 ms retry delay and the same key arrives with different
    // input, which is either a payload mismatch or an edit submitted without
    // anybody clicking save.
    mutationFn: (command: {
      idempotencyKey: string;
      value: unknown;
      expectedVersion: number | null;
    }) => saveSetting({ key: setting.key, ...command }),
    onSuccess: async (result) => {
      // Adopt our own write before the refetch lands, so the row does not
      // report itself as having changed elsewhere.
      submission.settle();
      adopt(result.setting);
      await refresh();
    },
    // A conflict means the cached row is stale, and only a success refreshed
    // it — so `changedElsewhere` stayed false, the reload button was never
    // offered, and every resubmission repeated the same conflict until an
    // unrelated refetch happened. The draft survives; what is refreshed is the
    // row it will be compared against.
    onError: (error: unknown) => {
      submission.settleOn(error);
      void refresh();
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Snapshotted HERE, at the click, so the retry cannot see a later edit.
    const command = { value: draft, expectedVersion: basis.version };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <Card
      title={setting.key}
      actions={
        <>
          {setting.consumer === 'PLANNED' && <MaturityBadge value="ready" />}
          {setting.classification === 'SENSITIVE' && (
            <Badge tone="warn">{t('web.sensitive')}</Badge>
          )}
          {setting.mutability === 'RESTART_REQUIRED' && (
            <Badge tone="warn">{t('web.restart_required')}</Badge>
          )}
        </>
      }
    >
      <form onSubmit={onSubmit}>
        <p className="muted small">{setting.description}</p>

        {/* Stored, and nothing reads it. An operator who configures required
            channel membership has to know that nothing enforces it yet — the
            legacy pattern this whole registry exists to end is a screen that
            answers "saved" for a change with no observable effect. */}
        {setting.consumer === 'PLANNED' && (
          <Banner tone="info">{t('web.setting_no_consumer')}</Banner>
        )}

        {/* A stored value the registry no longer accepts. The default is in
            force, and saying so is the difference between this and the legacy
            screens that show a value nothing is using. */}
        {setting.storedValueInvalid && (
          <Banner tone="danger">{t('web.stored_value_invalid')}</Banner>
        )}

        <SettingEditor
          // Remounting on a new basis is what makes "reload value" reset the
          // editor's own internal draft as well as the value above it.
          key={`${setting.key}:${basis.version ?? 0}`}
          setting={basis}
          value={draft}
          onChange={setDraft}
          disabled={!mayEdit}
        />

        {changedElsewhere && (
          <Banner tone="warn">
            {t('web.changed_elsewhere')}{' '}
            <button type="button" className="btn ghost sm" onClick={() => adopt(setting)}>
              {t('web.reload_value')}
            </button>
          </Banner>
        )}

        <dl className="kv">
          <div>
            <dt>{t('web.source')}</dt>
            <dd>
              {setting.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default')}
            </dd>
          </div>
          <div>
            <dt>{t('web.zero_meaning')}</dt>
            <dd>{t(ZERO_MEANING_KEYS[setting.zeroMeaning])}</dd>
          </div>
          {setting.updatedAt !== null && (
            <div>
              <dt>{t('web.updated_at')}</dt>
              <dd>{formatTimestamp(setting.updatedAt)}</dd>
            </div>
          )}
        </dl>

        {mayEdit && (
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? t('web.saving') : t('web.save')}
          </button>
        )}
        {save.isError && <ErrorReport error={save.error} />}
        {/* A no-op says so. The legacy screens answer "✅ updated" either way,
            and one of them said it three times while nothing changed. */}
        {save.isSuccess && (
          <Banner tone={save.data.changed ? 'ok' : 'info'}>
            {save.data.changed ? t('web.saved') : t('web.unchanged')}
          </Banner>
        )}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

/**
 * The control for a key, chosen by the key.
 *
 * A list of support accounts is not a JSON blob an operator should have to type
 * — revision 22 asks for add, remove, reorder and validate, and none of those
 * is expressible in a text field. The generic editor stays for the scalar keys,
 * where a text field is genuinely the right control.
 */
function SettingEditor({
  setting,
  value,
  onChange,
  disabled,
}: {
  setting: ResolvedSettingResponse;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  if (setting.key === 'support.accounts') {
    return <HandleListEditor value={asStringList(value)} onChange={onChange} disabled={disabled} />;
  }
  if (setting.key === 'telegram.channels') {
    return (
      <ChannelListEditor value={asChannelList(value)} onChange={onChange} disabled={disabled} />
    );
  }
  if (setting.key === 'wallet.topup.minimum') {
    return <MoneyEditor value={asMoney(value)} onChange={onChange} disabled={disabled} />;
  }
  if (setting.key === 'sales.currency') {
    return <CurrencyEditor value={String(value)} onChange={onChange} disabled={disabled} />;
  }
  return <TextEditor setting={setting} onChange={onChange} disabled={disabled} />;
}

/** Revision 22: support accounts — add, remove, reorder, validate. */
function HandleListEditor({
  value,
  onChange,
  disabled,
}: {
  value: readonly string[];
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <ListEditor
      items={value}
      onChange={(next) => onChange([...next])}
      addLabel={t('web.support_add')}
      emptyHint={t('web.support_empty')}
      disabled={disabled}
      onAdd={() => ''}
      renderRow={(item, index, update) => (
        <>
          <label className="visually-hidden" htmlFor={`support-${index}`}>
            {t('web.support_handle')}
          </label>
          <input
            id={`support-${index}`}
            className="input ltr mono"
            value={item}
            placeholder="@example"
            disabled={disabled}
            onChange={(event) => update(event.target.value)}
          />
        </>
      )}
    />
  );
}

interface Channel {
  readonly handle: string;
  readonly mandatory: boolean;
}

/** Revision 23: channels — add, remove, reorder, and a required-membership flag. */
function ChannelListEditor({
  value,
  onChange,
  disabled,
}: {
  value: readonly Channel[];
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <ListEditor
      items={value}
      onChange={(next) => onChange([...next])}
      addLabel={t('web.channel_add')}
      emptyHint={t('web.channel_empty')}
      disabled={disabled}
      // `mandatory: false` rather than nothing. The flag is required by the
      // schema precisely so that a channel cannot exist without an answer.
      onAdd={() => ({ handle: '', mandatory: false })}
      renderRow={(item, index, update) => (
        <div className="input-group">
          <label className="visually-hidden" htmlFor={`channel-${index}`}>
            {t('web.channel_handle')}
          </label>
          <input
            id={`channel-${index}`}
            className="input ltr mono grow"
            value={item.handle}
            placeholder="@example"
            disabled={disabled}
            onChange={(event) => update({ ...item, handle: event.target.value })}
          />
          <Switch
            checked={item.mandatory}
            disabled={disabled}
            label={t('web.channel_mandatory')}
            onChange={(next) => update({ ...item, mandatory: next })}
          />
          <span className="muted small nowrap">
            {item.mandatory ? t('web.channel_mandatory') : t('web.channel_optional')}
          </span>
        </div>
      )}
    />
  );
}

/**
 * Revision 24: the minimum top-up, as an amount AND a currency.
 *
 * Never a bare number. The legacy financial surface has no exchange rate on any
 * of its seven gateways and Toman implicit everywhere, which is the failure
 * this shape prevents at the type level.
 *
 * The per-gateway override the revision also asks for is not here, and the
 * banner says why rather than leaving a gap: no payment gateway is registered
 * anywhere in this system, so there is nothing for an override to be keyed by.
 */
function MoneyEditor({
  value,
  onChange,
  disabled,
}: {
  value: MoneyWire;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <>
      <Banner tone="info" title={t('web.topup_precedence_title')}>
        {t('web.topup_precedence_body')}
      </Banner>
      <div className="input-group">
        <Field label={t('web.amount_minor')} htmlFor="topup-amount">
          <input
            id="topup-amount"
            className="input ltr mono"
            inputMode="numeric"
            value={value.amountMinor}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, amountMinor: event.target.value })}
          />
        </Field>
        <Field label={t('web.currency')} htmlFor="topup-currency">
          <select
            id="topup-currency"
            className="input"
            value={value.currency}
            disabled={disabled}
            onChange={(event) => onChange({ ...value, currency: event.target.value })}
          >
            {(['IRT', 'IRR'] as const).map((code) => (
              <option key={code} value={code}>
                {currencyLabel(code)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </>
  );
}

/** Revision 1: the currency every amount in this admin inherits. */
function CurrencyEditor({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <Field label={t('web.currency')} htmlFor="sales-currency">
      <select
        id="sales-currency"
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {(['IRT', 'IRR'] as const).map((code) => (
          <option key={code} value={code}>
            {currencyLabel(code as CurrencyCode)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * The scalar editor.
 *
 * Holds its own STRING while the row above holds the parsed value, because a
 * half-typed number is a string that is not yet a number: converting on every
 * keystroke turns `-` into NaN and `1.` into `1`, and the operator's cursor
 * lands somewhere else.
 */
function TextEditor({
  setting,
  onChange,
  disabled,
}: {
  setting: ResolvedSettingResponse;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() => toEditable(setting.value));
  return (
    <Field label={t('web.value')} htmlFor={`value-${setting.key}`}>
      <input
        id={`value-${setting.key}`}
        className="input"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          onChange(fromEditable(event.target.value, setting.value));
        }}
      />
    </Field>
  );
}

function asStringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asChannelList(value: unknown): readonly Channel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    return [
      {
        handle: typeof record['handle'] === 'string' ? record['handle'] : '',
        mandatory: record['mandatory'] === true,
      },
    ];
  });
}

function asMoney(value: unknown): MoneyWire {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return {
      amountMinor: typeof record['amountMinor'] === 'string' ? record['amountMinor'] : '0',
      currency: (typeof record['currency'] === 'string'
        ? record['currency']
        : 'IRT') as CurrencyCode,
    };
  }
  return { amountMinor: '0', currency: 'IRT' };
}

/**
 * A rejection, with its structured issues when it has any.
 *
 * The list is rendered only when it is non-empty. An always-present `<ul>` with
 * nothing in it still draws its error styling, which reads as "and something
 * else went wrong too" for every ordinary failure.
 */
export function ErrorReport({ error }: { error: unknown }) {
  const issues = issuesFrom(error);
  return (
    <>
      <Banner tone="danger">{messageFor(error)}</Banner>
      {issues.length > 0 && (
        <ul className="danger">
          {issues.map((issue, index) => (
            // The index is part of the key: two schema issues can carry the
            // same sentence, and React's own warning for a duplicate key says
            // children "may be duplicated and/or omitted" — which is a good
            // enough reason not to find out which.
            <li key={`${index}:${issue}`}>
              <Ltr mono={false}>{issue}</Ltr>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * A value as a text field can hold it.
 *
 * `null` becomes an empty field rather than the string "null", which would be
 * stored as the four characters on the next save.
 */
function toEditable(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The text back into a value, shaped like the one it is replacing.
 *
 * The registry's schema decides what is acceptable and the server enforces it;
 * this only has to avoid turning a number into a string on the way past. An
 * empty field for a value that was not a string means null, so "clear this"
 * remains expressible.
 */
function fromEditable(draft: string, previous: unknown): unknown {
  if (typeof previous === 'string') return draft;
  if (draft.trim() === '') return null;
  if (typeof previous === 'number') {
    const parsed = Number(draft);
    return Number.isNaN(parsed) ? draft : parsed;
  }
  if (typeof previous === 'boolean') return draft === 'true';
  try {
    return JSON.parse(draft) as unknown;
  } catch {
    return draft;
  }
}

/**
 * The structured issues behind a rejection, if there are any.
 *
 * A template body refused for an undeclared placeholder names the token; a
 * setting refused by its schema names the field. Both arrive in the error's
 * `details.issues`, and both are what the person editing needs to see.
 */
export function issuesFrom(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const issues = error.details?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue) =>
    typeof issue === 'string'
      ? issue
      : ((issue as { detail?: string }).detail ?? JSON.stringify(issue)),
  );
}

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'control.version_conflict') return t('web.conflict');
    if (error.code === 'control.confirmation_required') return t('web.confirm_required');
    if (error.code === 'control.destination_not_configured') return t('web.destination_missing');
    if (error.status === 403) return t('web.no_permission');
    // The server's message names the offending field and is written for an
    // operator. Replacing it with a generic sentence here would throw away the
    // only part of the response that says what to change.
    return error.message;
  }
  return t('web.error');
}
