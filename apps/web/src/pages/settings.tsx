import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  CURRENCY_CODES,
  OPS_GROUP_MANAGED_SETTING_KEYS,
  PRODUCT_PAGE_MAX,
  SALES_CURRENCY_CODES,
} from '@nexa/contracts';
import type { CurrencyCode, MoneyWire, ResolvedSettingResponse } from '@nexa/contracts';
import { ApiError, fetchProducts, fetchSettings, saveSetting } from '../api/client';
import { currencyLabel, formatMoneyText, formatNumber, formatTimestamp } from '../format';
import { finalAnswer } from '../polling';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import {
  SETTING_GROUPS,
  SETTING_GROUP_TITLES,
  integerRange,
  settingPresentation,
  type SelectOption,
  type SettingControl,
  type SettingGroup,
} from '../settings-presentation';
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
 * The settings screen (WP-A1: an operator's page, not a developer's).
 *
 * Every row shows a Persian title, a short Persian description, the value in force, a
 * control that fits the value and a save button. The title, description, group and
 * control come from `settings-presentation.ts`, which is total over the registry, so no
 * key reaches this screen titled by its machine key or described in the registry's
 * English. What an engineer needs when something is wrong — the machine key and whether
 * the value is the installation's default or was set here — is kept in a closed
 * "technical information" disclosure under each row, not in the row itself.
 *
 * A save carries the version the row was read at. A stale version comes back as
 * a conflict and is shown as one, rather than quietly discarding whatever the
 * other administrator did.
 *
 * A key whose registry entry declares `consumer: 'PLANNED'` is labelled as
 * stored-but-unread: a screen that answers "saved" for a change with no observable
 * effect is the legacy defect the registry exists to end. That is why `consumer` is a
 * declared field on the frozen registry rather than a list held in this file.
 */
export function SettingsPage({ mayEdit, denied }: { mayEdit: boolean; denied: boolean }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const all = settings.data?.settings ?? [];
  const salesCurrency = sellingCurrencyOf(all);
  // WP-A4: the ops group panel owns these — the manual chat and topic ids under its
  // advanced section, the retired severity cutoff and the internal attempt ceiling nowhere.
  const rows = all.filter(
    (setting) => !(OPS_GROUP_MANAGED_SETTING_KEYS as readonly string[]).includes(setting.key),
  );

  return (
    <>
      <PageHead title={t('web.settings_title')} subtitle={t('web.settings_intro')} maturity="now" />

      <StateSwitch query={settings} denied={denied} isEmpty={rows.length === 0}>
        {grouped(rows).map(({ group, title, members }) => (
          <section key={group} className="settings-group" aria-labelledby={`settings-${group}`}>
            <h2 id={`settings-${group}`} className="settings-group-head">
              {t(title)}
            </h2>
            {members.map((setting) => (
              <SettingRow
                key={setting.key}
                setting={setting}
                mayEdit={mayEdit}
                salesCurrency={salesCurrency}
              />
            ))}
          </section>
        ))}
      </StateSwitch>
    </>
  );
}

/**
 * The currency this installation sells in, as the page's own `sales.currency` row says.
 *
 * Every money setting is compared against it by its consumer, with no conversion: a
 * top-up bound in another currency makes top-up unavailable, a referral minimum in
 * another currency earns no order a commission, and a signup gift in another currency
 * cannot be switched on. So the money editors offer this currency as the choice (F3).
 * `null` when the row is absent — then nothing is narrowed rather than a currency
 * guessed.
 */
function sellingCurrencyOf(rows: readonly ResolvedSettingResponse[]): CurrencyCode | null {
  const value = rows.find((row) => row.key === 'sales.currency')?.value;
  return typeof value === 'string' && (SALES_CURRENCY_CODES as readonly string[]).includes(value)
    ? (value as CurrencyCode)
    : null;
}

/**
 * The currencies a money control offers: the selling currency, plus any currency a stored
 * value already carries, so opening the page never silently rewrites it. Every code the
 * schema accepts when the selling currency is not known.
 */
function currencyChoices(
  sales: CurrencyCode | null,
  stored: readonly string[],
): readonly CurrencyCode[] {
  if (sales === null) return CURRENCY_CODES;
  return [sales, ...CURRENCY_CODES.filter((code) => code !== sales && stored.includes(code))];
}

/** An option's label; a currency other than the selling one says so. */
function currencyOptionLabel(code: CurrencyCode, sales: CurrencyCode | null): string {
  return sales === null || code === sales
    ? currencyLabel(code)
    : `${currencyLabel(code)} — ${t('web.settings_currency_not_sales')}`;
}

/** Whether a stored money value is a non-zero amount outside the selling currency. */
function offCurrency(money: MoneyWire, sales: CurrencyCode | null): boolean {
  return sales !== null && money.currency !== sales && /[1-9]/u.test(money.amountMinor);
}

/**
 * The rows under their groups, groups in a fixed order, rows in the order the server sent.
 *
 * A key this bundle does not know — a tab holding the previous release across a deploy —
 * goes to a last group rather than disappearing: a setting the page cannot name is still
 * a setting the operator must be able to read.
 */
function grouped(
  rows: readonly ResolvedSettingResponse[],
): { group: SettingGroup | 'other'; title: WebKey; members: ResolvedSettingResponse[] }[] {
  const sections = SETTING_GROUPS.map((group) => ({
    group: group as SettingGroup | 'other',
    title: SETTING_GROUP_TITLES[group],
    members: rows.filter((row) => settingPresentation(row.key)?.group === group),
  }));
  sections.push({
    group: 'other',
    title: 'web.settings_group_other',
    members: rows.filter((row) => settingPresentation(row.key) === null),
  });
  return sections.filter((section) => section.members.length > 0);
}

/**
 * Persian names for the feature flags that have one.
 *
 * Only FLAGS now. Every setting's name lives in `settings-presentation.ts`, which is total
 * over the registry; this map stays for the feature-flag screen, which names its flags
 * through `registryLabel` below.
 *
 * A LITERAL map, not a key built from the registry key at runtime: `check:i18n` proves
 * every `web.*` key is rendered somewhere by looking for the key in the source, and a key
 * assembled from `` `web.${kind}_${key}` `` is invisible to it.
 */
const FLAG_LABELS: Readonly<Record<string, WebKey>> = {
  service_expiry_reminders: 'web.flag_service_expiry_reminders',
  service_expired_notice: 'web.flag_service_expired_notice',
  service_usage_reminders: 'web.flag_service_usage_reminders',
  // WP-A9.
  service_expiry_day_reminder: 'web.flag_service_expiry_day_reminder',
  wallet_low_balance_reminders: 'web.flag_wallet_low_balance_reminders',
  payment_pending_reminders: 'web.flag_payment_pending_reminders',
  // HF-A9.
  reminder_quiet_hours: 'web.flag_reminder_quiet_hours',
  trials: 'web.flag_trials',
  customer_link_rotation: 'web.flag_customer_link_rotation',
  referral_signup_gift: 'web.flag_referral_signup_gift',
  custom_service: 'web.flag_custom_service',
};

/**
 * A Persian name for a registry key — a setting's or a flag's — or `undefined` when none
 * has been written.
 *
 * Shared by the settings rows and the feature-flag rows, so one setting cannot end up
 * named one way here and another way there.
 */
export function registryLabel(key: string): string | undefined {
  const setting = settingPresentation(key);
  if (setting !== null) return t(setting.title);
  const flag = FLAG_LABELS[key];
  return flag === undefined ? undefined : t(flag);
}

function SettingRow({
  setting,
  mayEdit,
  salesCurrency,
}: {
  setting: ResolvedSettingResponse;
  mayEdit: boolean;
  salesCurrency: CurrencyCode | null;
}) {
  const client = useQueryClient();
  const presentation = settingPresentation(setting.key);
  const title = presentation === null ? t('web.settings_unknown_title') : t(presentation.title);

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
      // Adopt our own write, so the next edit is compared against the row this
      // operator just stored. `changedElsewhere` above is what keeps the row
      // from reporting ITSELF as changed elsewhere while this settles — adopting
      // alone does the opposite, which is what the comment here used to claim.
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

  /**
   * Not while OUR OWN write is settling.
   *
   * `adopt(result.setting)` runs before the awaited `refresh()` resolves, so
   * for the width of that round trip `basis.version` is N+1 while the query
   * still holds N — and the banner told the operator their own save had been
   * made "elsewhere", promising a `VERSION_CONFLICT` that could not happen
   * because `basis.version` was at that moment the newest version there is.
   * The comment in `save.onSuccess` claimed adopting PREVENTED this; adopting
   * is what caused it. Same fix as the panel form.
   */
  const changedElsewhere = !save.isPending && basis.version !== setting.version;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    // Snapshotted HERE, at the click, so the retry cannot see a later edit.
    const command = { value: draft, expectedVersion: basis.version };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  return (
    <Card
      title={title}
      actions={
        <>
          {setting.consumer === 'PLANNED' && <MaturityBadge value="ready" />}
          {setting.mutability === 'RESTART_REQUIRED' && (
            <Badge tone="warn">{t('web.restart_required')}</Badge>
          )}
        </>
      }
    >
      {/* `noValidate`: the server's schema decides what is acceptable and its refusal is
          shown in Persian below. A browser's own validation bubble would speak the
          browser's language and a range the server does not own. */}
      <form onSubmit={onSubmit} noValidate>
        <p className="muted small">
          {presentation === null ? t('web.settings_unknown_desc') : t(presentation.description)}
        </p>
        {setting.configures !== null && (
          <p className="faint small">{t('web.settings_needs_feature')}</p>
        )}

        {/* Stored, and nothing reads it. An operator has to know that a change here
            has no effect yet — the legacy pattern this whole registry exists to end is
            a screen that answers "saved" for a change with no observable effect. */}
        {setting.consumer === 'PLANNED' && (
          <Banner tone="info">{t('web.setting_no_consumer')}</Banner>
        )}

        {/* A stored value the registry no longer accepts. The default is in
            force, and saying so is the difference between this and the legacy
            screens that show a value nothing is using. */}
        {setting.storedValueInvalid && (
          <Banner tone="danger">{t('web.stored_value_invalid')}</Banner>
        )}

        <p className="small">
          <span className="muted">{t('web.settings_current_value')}: </span>
          <CurrentValue control={presentation?.control ?? null} value={setting.value} />
        </p>

        {/* A stored amount outside the selling currency is one its consumer cannot
            compare with anything (F3): said here, not left for the operator to infer. */}
        {presentation?.control.kind === 'money' &&
          offCurrency(asMoney(setting.value), salesCurrency) && (
            <Banner tone="warn">{t('web.settings_money_currency_mismatch')}</Banner>
          )}
        {presentation?.control.kind === 'money_list' &&
          asMoneyList(setting.value).some((money) => offCurrency(money, salesCurrency)) && (
            <Banner tone="warn">{t('web.settings_presets_currency_mismatch')}</Banner>
          )}

        <SettingEditor
          // Remounting on a new basis is what makes "reload value" reset the
          // editor's own internal draft as well as the value above it.
          key={`${setting.key}:${basis.version ?? 0}`}
          setting={basis}
          control={presentation?.control ?? null}
          title={title}
          salesCurrency={salesCurrency}
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

        {setting.updatedAt !== null && (
          <p className="faint small">
            {t('web.updated_at')}: {formatTimestamp(setting.updatedAt)}
          </p>
        )}

        {mayEdit && (
          <button type="submit" className="btn primary" disabled={save.isPending}>
            {save.isPending ? t('web.saving') : t('web.save')}
          </button>
        )}
        {save.isError && <SaveError error={save.error} settingKey={setting.key} />}
        {/* A no-op says so. The legacy screens answer "✅ updated" either way,
            and one of them said it three times while nothing changed. */}
        {save.isSuccess && (
          <Banner tone={save.data.changed ? 'ok' : 'info'}>
            {save.data.changed ? t('web.saved') : t('web.unchanged')}
          </Banner>
        )}

        {/* For troubleshooting only, and closed by default: the machine key an
            engineer or a log names, and whether the value in force is the
            installation's default or was set here. */}
        <details className="settings-technical">
          <summary className="faint small">{t('web.settings_technical')}</summary>
          <dl className="kv">
            <div>
              <dt>{t('web.settings_technical_key')}</dt>
              <dd>
                <Ltr>{setting.key}</Ltr>
              </dd>
            </div>
            <div>
              <dt>{t('web.source')}</dt>
              <dd>
                {setting.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default')}
              </dd>
            </div>
          </dl>
        </details>
      </form>
    </Card>
  );
}

/** Whether a string carries Persian or Arabic script. */
const PERSIAN_SCRIPT = /[\u0600-\u06FF]/u;

/**
 * A refused save, in Persian.
 *
 * `control.invalid_value` arrives two ways. The registry's schema refuses a value with
 * an English sentence and a list of English issues written for a log; the operator is
 * told in Persian that the value was not accepted, and the issues are kept behind a
 * disclosure for whoever has to debug it. A change guard refuses a value that is valid
 * on its own but not in combination (the reminder thresholds) with a sentence written
 * for the operator — shown as it is when it is Persian. The store-currency guard speaks
 * English, so its one refusal has a Persian sentence of its own here.
 *
 * Every other refusal keeps the shared `ErrorReport`.
 */
function SaveError({ error, settingKey }: { error: unknown; settingKey: string }) {
  if (!(error instanceof ApiError) || error.code !== CONTROL_ERROR_CODES.INVALID_VALUE) {
    return <ErrorReport error={error} />;
  }
  const guarded = error.status === 409;
  if (guarded && PERSIAN_SCRIPT.test(error.message)) {
    return <Banner tone="danger">{error.message}</Banner>;
  }
  const sentence =
    guarded && settingKey === 'sales.currency'
      ? t('web.setting_sales_currency_refused')
      : t('web.settings_invalid_value');
  const issues = issuesFrom(error);
  const detail = issues.length > 0 ? issues : [error.message];
  return (
    <>
      <Banner tone="danger">{sentence}</Banner>
      <details className="settings-technical">
        <summary className="faint small">{t('web.settings_technical_issues')}</summary>
        <ul className="danger">
          {detail.map((issue, index) => (
            <li key={`${index}:${issue}`}>
              <Ltr mono={false}>{issue}</Ltr>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

// ---------------------------------------------------------------------------
// The value in force
// ---------------------------------------------------------------------------

/**
 * The stored value, as an operator reads it: a number with its unit, an option's
 * Persian label, an amount with its currency. Shown above the control, so the value in
 * force stays visible while the field below holds an unsaved edit.
 */
function CurrentValue({ control, value }: { control: SettingControl | null; value: unknown }) {
  const unset = <span className="muted">{t('web.settings_value_unset')}</span>;
  if (control === null) {
    return value === null || value === '' ? unset : <Ltr>{toEditable(value)}</Ltr>;
  }
  switch (control.kind) {
    case 'integer':
      if (typeof value !== 'number') return unset;
      return (
        <span className="num">
          {formatNumber(value)}
          {control.unit === undefined ? null : ` ${t(control.unit)}`}
        </span>
      );
    case 'text':
      return typeof value === 'string' && value !== '' ? <Ltr>{value}</Ltr> : unset;
    case 'select': {
      const option = control.options.find((candidate) => candidate.value === value);
      if (option !== undefined) return <>{t(option.label)}</>;
      return typeof value === 'string' ? <Ltr>{value}</Ltr> : unset;
    }
    case 'currency':
      return typeof value === 'string' && (CURRENCY_CODES as readonly string[]).includes(value) ? (
        <>{currencyLabel(value as CurrencyCode)}</>
      ) : (
        unset
      );
    case 'money':
      return <>{formatMoneyText(asMoney(value))}</>;
    case 'money_list': {
      const amounts = asMoneyList(value);
      return amounts.length === 0 ? unset : <>{joined(amounts.map(formatMoneyText))}</>;
    }
    case 'handle_list': {
      const handles = asStringList(value);
      return handles.length === 0 ? unset : <>{joined(handles.map(isolated))}</>;
    }
    case 'channel_list': {
      const channels = asChannelList(value);
      return channels.length === 0 ? unset : <>{joined(channels.map(channelSummary))}</>;
    }
    case 'product':
      return typeof value === 'string' ? <TrialProductName id={value} /> : unset;
  }
}

/**
 * One channel as it behaves (F1): who it is, whether membership is required, and the
 * link a customer is sent to. Two channels differing only in `mandatory` or `joinUrl`
 * behave differently, so they must not read the same.
 */
function channelSummary(channel: Channel): ReactNode {
  return (
    <>
      <Ltr>{channel.handle ?? channel.chatId ?? ''}</Ltr>
      {channel.handle !== undefined && channel.chatId !== undefined && (
        <>
          {' '}
          <Ltr>{`(${channel.chatId})`}</Ltr>
        </>
      )}
      {' — '}
      {channel.mandatory ? t('web.channel_mandatory') : t('web.channel_optional')}
      {channel.joinUrl !== undefined && (
        <>
          {' — '}
          {t('web.channel_join_url')}: <Ltr>{channel.joinUrl}</Ltr>
        </>
      )}
    </>
  );
}

function isolated(text: string): ReactNode {
  return <Ltr>{text}</Ltr>;
}

function joined(items: readonly ReactNode[]): ReactNode {
  return items.map((item, index) => (
    // Position is the identity: these are the items of one stored list, in order.
    <span key={index}>
      {index > 0 && t('web.list_separator')}
      {item}
    </span>
  ));
}

/** The trial product's title, from the same query the picker below makes. */
function TrialProductName({ id }: { id: string }) {
  const products = useTrialProducts();
  // "Not in the active list" is a fact only a SUCCESSFUL and COMPLETE read can establish
  // (F4, Codex #2). While the list is loading, when it cannot be read (no catalogue
  // permission), or when the product may be on a later page, the stored id is what is
  // known, and that is what is shown.
  if (products.isPending) return <span className="muted">{t('web.loading')}</span>;
  if (products.isError) return <Ltr>{id}</Ltr>;
  const found = products.data.products.find((product) => product.id === id);
  if (found !== undefined) return <>{found.title}</>;
  return products.data.nextCursor === null ? (
    <>{t('web.trial_product_unlisted')}</>
  ) : (
    <Ltr>{id}</Ltr>
  );
}

function useTrialProducts() {
  return useQuery({
    queryKey: ['products', 'trial-picker'],
    queryFn: () => fetchProducts({ status: 'ACTIVE', limit: TRIAL_PICKER_LIMIT }),
  });
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

/**
 * The control for a key, chosen by its presentation entry.
 *
 * A list of support accounts is not a JSON blob an operator should have to type
 * — revision 22 asks for add, remove, reorder and validate, and none of those
 * is expressible in a text field. A number gets a numeric field with its range,
 * a closed set a select, money an amount and a currency. The raw text field is
 * left only for a key this bundle does not know.
 */
function SettingEditor({
  setting,
  control,
  title,
  salesCurrency,
  value,
  onChange,
  disabled,
}: {
  setting: ResolvedSettingResponse;
  control: SettingControl | null;
  title: string;
  salesCurrency: CurrencyCode | null;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const id = `setting-${setting.key}`;
  if (control === null) {
    return (
      <RawEditor id={id} title={title} setting={setting} onChange={onChange} disabled={disabled} />
    );
  }
  switch (control.kind) {
    case 'integer':
      return (
        <IntegerEditor
          id={id}
          title={title}
          settingKey={setting.key}
          unit={control.unit}
          optional={control.optional === true}
          initial={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'text':
      return (
        <TextEditor id={id} title={title} value={value} onChange={onChange} disabled={disabled} />
      );
    case 'select':
      return (
        <SelectEditor
          id={id}
          title={title}
          options={control.options}
          value={value}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'currency':
      return (
        <CurrencyEditor
          id={id}
          title={title}
          value={String(value)}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'money':
      return (
        <MoneyEditor
          id={id}
          title={title}
          salesCurrency={salesCurrency}
          value={asMoney(value)}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'money_list':
      return (
        <TopupPresetEditor
          title={title}
          salesCurrency={salesCurrency}
          value={asMoneyList(value)}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'handle_list':
      return (
        <HandleListEditor value={asStringList(value)} onChange={onChange} disabled={disabled} />
      );
    case 'channel_list':
      return (
        <ChannelListEditor value={asChannelList(value)} onChange={onChange} disabled={disabled} />
      );
    case 'product':
      return (
        <TrialProductEditor
          id={id}
          title={title}
          value={typeof value === 'string' ? value : null}
          onChange={onChange}
          disabled={disabled}
        />
      );
  }
}

/**
 * A label a screen reader announces and a sighted operator does not need: the card's
 * own title already names the one control under it, and printing it twice reads as two
 * things.
 */
function HiddenLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label className="visually-hidden" htmlFor={htmlFor}>
      {children}
    </label>
  );
}

/**
 * Persian and Arabic-Indic digits as the Latin digits they mean, grouping marks dropped.
 *
 * `minorOf`'s rule from the gateways page: those are ways of WRITING the same number, so
 * an operator typing Persian sixty means 60. Anything else — a sign, a decimal point, a
 * letter — is left as typed, for the server's schema to refuse rather than for a field
 * to reinterpret. Shared by the whole-number field and every money amount (F5).
 */
function latinDigits(text: string): string {
  return text
    .trim()
    .replace(/[\s,\u066C\u2009\u202F']/gu, '')
    .replace(/[\u06F0-\u06F9]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/gu, (d) => String(d.charCodeAt(0) - 0x0660));
}

/**
 * A whole number, or `null` when the text does not spell one. Any SAFE integer (F2): a
 * digit cap would refuse a schema-valid topic id and send it as a string.
 */
function wholeNumberOf(text: string): number | null {
  const latin = latinDigits(text);
  if (!/^[0-9]+$/u.test(latin)) return null;
  const parsed = Number(latin);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * A whole-number setting.
 *
 * Holds its own STRING while the row above holds the parsed value, because a
 * half-typed number is a string that is not yet a number: converting on every
 * keystroke turns `-` into NaN and `1.` into `1`, and the operator's cursor
 * lands somewhere else.
 *
 * The range under the field is the key's own schema (`settingIntegerRange`), so what
 * the field says it accepts and what the server enforces are one declaration.
 */
function IntegerEditor({
  id,
  title,
  settingKey,
  unit,
  optional,
  initial,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  settingKey: string;
  unit: WebKey | undefined;
  optional: boolean;
  initial: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() => (typeof initial === 'number' ? String(initial) : ''));
  const range = integerRange(settingKey);
  const hints = [
    ...(range === null
      ? []
      : [
          `${t('web.settings_range_from')} ${formatNumber(range.min)} ${t('web.settings_range_to')} ${formatNumber(range.max)}`,
        ]),
    ...(optional ? [t('web.settings_optional_empty')] : []),
  ];
  return (
    <div className="field">
      <HiddenLabel htmlFor={id}>{title}</HiddenLabel>
      <div className="input-group">
        <input
          id={id}
          className="input ltr num"
          inputMode="numeric"
          value={text}
          disabled={disabled}
          onChange={(event) => {
            const typed = event.target.value;
            setText(typed);
            if (typed.trim() === '') {
              // Empty is null where the schema allows "not set", and otherwise
              // sent as it is for the schema to refuse — never guessed as zero.
              onChange(optional ? null : typed);
              return;
            }
            onChange(wholeNumberOf(typed) ?? typed);
          }}
        />
        {unit !== undefined && <span className="addon">{t(unit)}</span>}
      </div>
      {hints.length > 0 && (
        <span className="muted small">{hints.join(t('web.list_separator'))}</span>
      )}
    </div>
  );
}

/** A free-form identifier, left to right. Empty is an ordinary value here. */
function TextEditor({
  id,
  title,
  value,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  value: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <div className="field">
      <HiddenLabel htmlFor={id}>{title}</HiddenLabel>
      <input
        id={id}
        className="input ltr mono"
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * A closed set. A stored value that is not one of the options is kept as an option of
 * its own, so opening the page never silently changes the value — the trial picker's
 * rule, for the same reason.
 */
function SelectEditor({
  id,
  title,
  options,
  value,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  options: readonly SelectOption[];
  value: unknown;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const current = typeof value === 'string' ? value : '';
  const listed = options.some((option) => option.value === current);
  return (
    <div className="field">
      <HiddenLabel htmlFor={id}>{title}</HiddenLabel>
      <select
        id={id}
        className="input"
        value={current}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {listed ? null : <option value={current}>{current}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.label)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The generic editor, for a key this bundle does not know. The value as text; the
 * server's schema is what decides whether it is acceptable.
 */
function RawEditor({
  id,
  title,
  setting,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  setting: ResolvedSettingResponse;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() => toEditable(setting.value));
  return (
    <div className="field">
      <HiddenLabel htmlFor={id}>{title}</HiddenLabel>
      <input
        id={id}
        className="input ltr mono"
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          onChange(fromEditable(event.target.value, setting.value));
        }}
      />
    </div>
  );
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
          {/*
            The position is part of the label. Three rows all announced as
            "support handle" leave somebody using a screen reader unable to tell
            which field they are in — and the ordinal is exactly the thing that
            distinguishes them, since order is meaningful here.
          */}
          <label className="visually-hidden" htmlFor={`support-${index}`}>
            {`${t('web.support_handle')} ${formatNumber(index + 1)}`}
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
  readonly handle?: string;
  readonly chatId?: string;
  readonly joinUrl?: string;
  readonly mandatory: boolean;
}

/** An emptied optional field is ABSENT, not an empty string the schema would refuse. */
function withOptional(
  item: Channel,
  field: 'handle' | 'chatId' | 'joinUrl',
  value: string,
): Channel {
  const next: Record<string, unknown> = { ...item };
  if (value === '') delete next[field];
  else next[field] = value;
  return next as unknown as Channel;
}

/**
 * Revision 23: channels — add, remove, reorder, and a required-membership flag.
 * Package B: a numeric id and a join link, for a private channel, and the enforcement hint.
 */
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
    <>
      <p className="muted small">{t('web.channel_enforcement_hint')}</p>
      <ListEditor
        items={value}
        onChange={(next) => onChange([...next])}
        addLabel={t('web.channel_add')}
        emptyHint={t('web.channel_empty')}
        disabled={disabled}
        // `mandatory: false` rather than nothing. The flag is required by the
        // schema precisely so that a channel cannot exist without an answer.
        onAdd={(): Channel => ({ mandatory: false })}
        renderRow={(item, index, update) => (
          <div className="channel-row">
            <label className="visually-hidden" htmlFor={`channel-${index}`}>
              {`${t('web.channel_handle')} ${formatNumber(index + 1)}`}
            </label>
            <input
              id={`channel-${index}`}
              className="input ltr mono grow"
              value={item.handle ?? ''}
              placeholder="@example"
              disabled={disabled}
              onChange={(event) => update(withOptional(item, 'handle', event.target.value))}
            />
            <label className="visually-hidden" htmlFor={`channel-id-${index}`}>
              {`${t('web.channel_chat_id')} ${formatNumber(index + 1)}`}
            </label>
            <input
              id={`channel-id-${index}`}
              className="input ltr mono"
              value={item.chatId ?? ''}
              placeholder="-1001234567890"
              disabled={disabled}
              onChange={(event) => update(withOptional(item, 'chatId', event.target.value))}
            />
            <label className="visually-hidden" htmlFor={`channel-url-${index}`}>
              {`${t('web.channel_join_url')} ${formatNumber(index + 1)}`}
            </label>
            <input
              id={`channel-url-${index}`}
              className="input ltr mono grow"
              value={item.joinUrl ?? ''}
              placeholder="https://t.me/+invite"
              disabled={disabled}
              onChange={(event) => update(withOptional(item, 'joinUrl', event.target.value))}
            />
            <Switch
              checked={item.mandatory}
              disabled={disabled}
              label={`${t('web.channel_mandatory')} ${formatNumber(index + 1)}`}
              onChange={(next) => update({ ...item, mandatory: next })}
            />
            <span className="muted small nowrap">
              {item.mandatory ? t('web.channel_mandatory') : t('web.channel_optional')}
            </span>
          </div>
        )}
      />
    </>
  );
}

/**
 * An amount AND a currency (revision 24), for every money setting: the top-up minimum
 * and maximum, the referral minimum and the signup gift.
 *
 * Never a bare number. The legacy financial surface has no exchange rate on any
 * of its seven gateways and Toman implicit everywhere, which is the failure
 * this shape prevents at the type level.
 *
 * Each input's accessible name carries the setting's title: four money settings share
 * this page, and four fields all announced as "amount" are indistinguishable to
 * anything that navigates by label.
 */
function MoneyEditor({
  id,
  title,
  salesCurrency,
  value,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  salesCurrency: CurrencyCode | null;
  value: MoneyWire;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <div className="input-group">
      <Field label={t('web.amount_minor')} htmlFor={`${id}-amount`}>
        <input
          id={`${id}-amount`}
          aria-label={`${t('web.amount_minor')} — ${title}`}
          className="input ltr mono"
          inputMode="numeric"
          value={value.amountMinor}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, amountMinor: latinDigits(event.target.value) })}
        />
      </Field>
      <Field label={t('web.currency')} htmlFor={`${id}-currency`}>
        <select
          id={`${id}-currency`}
          aria-label={`${t('web.currency')} — ${title}`}
          className="input"
          value={value.currency}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, currency: event.target.value })}
        >
          {/*
            The SELLING currency, plus the stored one when it differs (F3). Every
            consumer of these keys compares them with the selling currency and
            converts nothing, so any other choice silently switches the rule off,
            or the feature with it. The stored currency stays an option because
            a controlled select with no matching option shows its first one, and
            saving would then rewrite a value nobody chose to change.
          */}
          {currencyChoices(salesCurrency, [value.currency]).map((code) => (
            <option key={code} value={code}>
              {currencyOptionLabel(code, salesCurrency)}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/**
 * Revision 1: the currency every amount in this admin inherits. The options are the
 * contract's `SALES_CURRENCY_CODES`, the same list the server refuses against.
 */
function CurrencyEditor({
  id,
  title,
  value,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  value: string;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <div className="field">
      <HiddenLabel htmlFor={id}>{`${t('web.currency')} — ${title}`}</HiddenLabel>
      <select
        id={id}
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {SALES_CURRENCY_CODES.map((code) => (
          <option key={code} value={code}>
            {currencyLabel(code)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * WP6-A: the trial product, chosen from the ACTIVE products rather than typed as an id.
 *
 * An id pasted into a text field is how a typo becomes a configured trial nobody can
 * take; the server's `TrialProductGuard` refuses an id that is not a product, and this
 * is the half that makes the right one easy to pick. A product without a price is
 * listed too — that is the usual trial product, kept out of the catalogue by having
 * none.
 *
 * The stored id is always an option, even when it is not in the list (inactive since,
 * or beyond the first page), so opening the page never silently changes the value.
 * An operator who may not read the catalogue gets the plain text field instead of an
 * empty picker.
 */
function TrialProductEditor({
  id,
  title,
  value,
  onChange,
  disabled,
}: {
  id: string;
  title: string;
  value: string | null;
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  const products = useTrialProducts();
  if (products.isError) {
    return (
      <div className="field">
        <HiddenLabel htmlFor={id}>{title}</HiddenLabel>
        <input
          id={id}
          className="input"
          dir="ltr"
          value={value ?? ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        />
      </div>
    );
  }
  const items = products.data?.products ?? [];
  const listed = value === null || items.some((product) => product.id === value);
  return (
    <div className="field">
      <HiddenLabel htmlFor={id}>{title}</HiddenLabel>
      <select
        id={id}
        className="input"
        value={value ?? ''}
        disabled={disabled || products.isPending}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">{t('web.trial_product_none')}</option>
        {/* The stored id is always an option, so the select shows what is stored. It is
            called "not in the active list" only when the list read is complete; on a
            partial page it may simply be further on, and is named by its id. */}
        {listed ? null : (
          <option value={value}>
            {products.data?.nextCursor === null
              ? t('web.trial_product_unlisted')
              : `${t('web.trial_product_current')} (${value})`}
          </option>
        )}
        {items.map((product) => (
          <option key={product.id} value={product.id}>
            {product.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/** One page of the picker; the stored value is shown even when it falls beyond it. */
const TRIAL_PICKER_LIMIT = PRODUCT_PAGE_MAX;

/**
 * The top-up amounts a customer may choose. 5B.
 *
 * A list, in the order offered, each with its own currency — the same shape the setting
 * stores, so what is saved is what a customer sees. Only presets in the SELLING currency
 * are offered to a customer, so that is the currency each row offers and a new row
 * starts in; a row already stored in another currency keeps it as an option, for
 * `MoneyEditor`'s reason (F3).
 */
function TopupPresetEditor({
  title,
  salesCurrency,
  value,
  onChange,
  disabled,
}: {
  title: string;
  salesCurrency: CurrencyCode | null;
  value: readonly MoneyWire[];
  onChange: (next: unknown) => void;
  disabled: boolean;
}) {
  return (
    <ListEditor
      items={value}
      onChange={(next) => onChange([...next])}
      addLabel={t('web.topup_preset_add')}
      emptyHint={t('web.topup_preset_empty')}
      disabled={disabled}
      // An empty amount rather than a number: the field is text, the schema refuses a
      // non-positive value, and pre-filling a figure would be this screen inventing a
      // price.
      onAdd={() => ({ amountMinor: '', currency: salesCurrency ?? 'IRT' })}
      renderRow={(item, index, update) => (
        <div className="input-group">
          {/*
            The setting's own name is IN the accessible name, not just the index. The
            support-account list's finding applies here too: several inputs whose label
            is a bare number are indistinguishable to anything that navigates by label,
            and this screen has several money editors on it.
          */}
          <label className="visually-hidden" htmlFor={`preset-${index}`}>
            {`${title} — ${t('web.amount_minor')} ${formatNumber(index + 1)}`}
          </label>
          <input
            id={`preset-${index}`}
            className="input ltr mono grow"
            inputMode="numeric"
            value={item.amountMinor}
            disabled={disabled}
            onChange={(event) => update({ ...item, amountMinor: latinDigits(event.target.value) })}
          />
          <label className="visually-hidden" htmlFor={`preset-currency-${index}`}>
            {`${t('web.currency')} ${formatNumber(index + 1)}`}
          </label>
          <select
            id={`preset-currency-${index}`}
            className="input"
            value={item.currency}
            disabled={disabled}
            onChange={(event) => update({ ...item, currency: event.target.value as CurrencyCode })}
          >
            {currencyChoices(salesCurrency, [item.currency]).map((code) => (
              <option key={code} value={code}>
                {currencyOptionLabel(code, salesCurrency)}
              </option>
            ))}
          </select>
        </div>
      )}
    />
  );
}

function asMoneyList(value: unknown): readonly MoneyWire[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    return [
      {
        amountMinor: typeof record['amountMinor'] === 'string' ? record['amountMinor'] : '',
        currency: typeof record['currency'] === 'string' ? record['currency'] : 'IRT',
      } as MoneyWire,
    ];
  });
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
    // Package B: an absent optional field stays absent, so a round-trip does not add an
    // empty string the schema would refuse.
    const text = (field: 'handle' | 'chatId' | 'joinUrl') =>
      typeof record[field] === 'string' && record[field] !== '' ? { [field]: record[field] } : {};
    return [
      {
        ...text('handle'),
        ...text('chatId'),
        ...text('joinUrl'),
        mandatory: record['mandatory'] === true,
      } as Channel,
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
  // THREE shapes reach here, and only two were handled. `parseSettingValue`
  // returns strings; template validation returns `{ kind, detail }`; and the
  // global error filter returns `{ path, message }` for anything the REQUEST
  // schema rejects. That third one fell through to `JSON.stringify`, so an
  // operator saw `{"path":"value.0","message":"..."}` in their error list.
  return issues.map((issue) => {
    if (typeof issue === 'string') return issue;
    const shaped = issue as { detail?: string; message?: string; path?: string };
    if (shaped.detail !== undefined) return shaped.detail;
    if (shaped.message !== undefined) {
      return shaped.path ? `${shaped.path}: ${shaped.message}` : shaped.message;
    }
    return JSON.stringify(issue);
  });
}

/**
 * The reseller refusals (WP9-B), said in the operator's language.
 *
 * The server's message for these is a sentence about the RULE, written for a log; what an
 * operator needs is which of their inputs to change — a tier that is gone, a customer
 * who already has a row. Two of the five (`NOT_ENTITLED`, `TERMS_CHANGED`) are order
 * refusals no Web Admin command produces today; they are mapped here anyway, because this
 * is the one place a code becomes a sentence and a refusal that reaches it later should
 * not arrive in English.
 */
const RESELLER_MESSAGES: Readonly<Record<string, WebKey>> = {
  [COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED]: 'web.error_reseller_not_entitled',
  [COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED]: 'web.error_reseller_terms_changed',
  [COMMERCE_ERROR_CODES.RESELLER_NOT_FOUND]: 'web.error_reseller_not_found',
  [COMMERCE_ERROR_CODES.RESELLER_ALREADY_REGISTERED]: 'web.error_reseller_already_registered',
  [COMMERCE_ERROR_CODES.RESELLER_TIER_NOT_FOUND]: 'web.error_reseller_tier_not_found',
};

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    const reseller = RESELLER_MESSAGES[error.code];
    if (reseller !== undefined) return t(reseller);
    if (error.code === 'control.version_conflict') return t('web.conflict');
    if (error.code === 'control.destination_not_configured') return t('web.destination_missing');
    if (error.code === 'commerce.referral_gift_terms_invalid')
      return t('web.referral_gift_terms_invalid');
    if (error.code === 'commerce.media_invalid') return t('web.referral_banner_invalid');
    if (error.status === 403) return t('web.no_permission');
    // The server's message names the offending field and is written for an
    // operator. Replacing it with a generic sentence here would throw away the
    // only part of the response that says what to change.
    return error.message;
  }
  /*
   * A THIRD copy of the same decision, and it had the same arm wrong.
   *
   * `post()` schema-parses a mutation's response, so a mutation can throw a
   * `ZodError` — the deploy-skew case — and this returned "خطا در ارتباط با
   * سرور" for it: the server answered, the transport was fine, and the
   * sentence blamed the connection. `errorCopy` collapsed the two query-view
   * sites into one rule and did not reach here, which is the same "fixed at
   * the site the author was looking at" shape one layer down.
   *
   * The `ApiError` branch above stays as it is: for a mutation the server's
   * own message names the offending field, and that is more use to an operator
   * than any sentence written here. What is corrected is the fall-through,
   * where there is no message and the old text asserted a cause.
   */
  return finalAnswer(error) ? t('web.rejected') : t('web.error');
}
