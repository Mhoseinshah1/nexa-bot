import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CARD_SWITCH_COOLDOWN_SECONDS_DEFAULT,
  CARD_SWITCH_COOLDOWN_SECONDS_MAX,
  CARD_SWITCH_DISTINCT_CARDS_DEFAULT,
  CARD_SWITCH_DISTINCT_CARDS_MAX,
  CARD_SWITCH_DISTINCT_CARDS_MIN,
  CARD_SWITCH_MAX_SWITCHES_DEFAULT,
  CARD_SWITCH_MAX_SWITCHES_MAX,
  CARD_SWITCH_SETTING_KEYS,
  type PaymentGatewayProvider,
  type ResolvedSettingResponse,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../api/client';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { Banner, Card, Field, Input, StateSwitch } from '../ui/kit';
import { errorText } from '../error-text';
import { ErrorRef } from '../ui/technical-details';

/**
 * «محدودیت تغییر شماره کارت» — R5C-1 item 2, on the card-to-card method's own page.
 *
 * Three registry values, each written through the ordinary settings write (the version it
 * was read at, an idempotency key, audit): how long a customer waits between presses of
 * «🔄 تغییر شماره کارت», how many switches one payment may have, and how many different
 * cards one payment may show. The bot enforces them on the server under the payment's lock;
 * this card only edits the numbers, so it adds no write path of its own.
 *
 * Reading takes `settings.view` and writing `settings.edit`, the keys the server charges.
 */
const FIELDS: readonly {
  readonly key: (typeof CARD_SWITCH_SETTING_KEYS)[keyof typeof CARD_SWITCH_SETTING_KEYS];
  readonly id: string;
  readonly label: WebKey;
  readonly hint: WebKey;
  readonly invalid: WebKey;
  readonly unit: WebKey;
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}[] = [
  {
    key: CARD_SWITCH_SETTING_KEYS.COOLDOWN_SECONDS,
    id: 'card-switch-cooldown',
    label: 'web.card_switch_cooldown',
    hint: 'web.card_switch_cooldown_hint',
    invalid: 'web.card_switch_cooldown_invalid',
    unit: 'web.unit_seconds',
    min: 0,
    max: CARD_SWITCH_COOLDOWN_SECONDS_MAX,
    fallback: CARD_SWITCH_COOLDOWN_SECONDS_DEFAULT,
  },
  {
    key: CARD_SWITCH_SETTING_KEYS.MAX_SWITCHES,
    id: 'card-switch-max',
    label: 'web.card_switch_max',
    hint: 'web.card_switch_max_hint',
    invalid: 'web.card_switch_max_invalid',
    unit: 'web.unit_times',
    min: 0,
    max: CARD_SWITCH_MAX_SWITCHES_MAX,
    fallback: CARD_SWITCH_MAX_SWITCHES_DEFAULT,
  },
  {
    key: CARD_SWITCH_SETTING_KEYS.MAX_DISTINCT_CARDS,
    id: 'card-switch-distinct',
    label: 'web.card_switch_distinct',
    hint: 'web.card_switch_distinct_hint',
    invalid: 'web.card_switch_distinct_invalid',
    unit: 'web.unit_cards',
    min: CARD_SWITCH_DISTINCT_CARDS_MIN,
    max: CARD_SWITCH_DISTINCT_CARDS_MAX,
    fallback: CARD_SWITCH_DISTINCT_CARDS_DEFAULT,
  },
];

type Drafts = Readonly<Record<string, string>>;

/** The stored number, or the registry default while the row is not loaded. */
function valueOf(rows: readonly ResolvedSettingResponse[], field: (typeof FIELDS)[number]): number {
  const row = rows.find((candidate) => candidate.key === field.key);
  return typeof row?.value === 'number' ? row.value : field.fallback;
}

/** A whole number inside the field's range, or null. */
function parsed(text: string, field: (typeof FIELDS)[number]): number | null {
  if (!/^[0-9]{1,5}$/u.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= field.min && value <= field.max ? value : null;
}

export function CardSwitchLimitsCard({
  provider,
  maySettingsView,
  maySettingsEdit,
}: {
  provider: PaymentGatewayProvider;
  maySettingsView: boolean;
  maySettingsEdit: boolean;
}) {
  const applies = provider === 'MANUAL_TRANSFER' && maySettingsView;
  const client = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    enabled: applies,
  });
  const all = settings.data?.settings ?? [];
  const editable =
    maySettingsEdit && FIELDS.every((field) => all.some((row) => row.key === field.key));

  const stored: Drafts = Object.fromEntries(
    FIELDS.map((field) => [field.key, String(valueOf(all, field))]),
  );
  const [drafts, setDrafts] = useState<Drafts>(stored);
  // Follow the server when it changes under us (another administrator, a reset).
  const storedSignature = FIELDS.map((field) => stored[field.key]).join('|');
  useEffect(
    () =>
      setDrafts(
        Object.fromEntries(
          storedSignature.split('|').map((value, index) => [FIELDS[index]?.key ?? '', value]),
        ),
      ),
    [storedSignature],
  );

  // One key per field: a lost answer is re-asked with the same key, a changed value is new.
  const submissions = [useSubmissionKey(), useSubmissionKey(), useSubmissionKey()];
  const save = useMutation({
    mutationFn: async (commands: readonly { key: string; value: number }[]) => {
      // One write per changed key, each at the version it was read at.
      for (const command of commands) {
        const row = all.find((candidate) => candidate.key === command.key);
        if (row === undefined) continue;
        const body = { key: command.key, value: command.value, expectedVersion: row.version };
        const submission = submissions[FIELDS.findIndex((field) => field.key === command.key)];
        if (submission === undefined) continue;
        try {
          await saveSetting({ ...body, idempotencyKey: submission.current(body) });
          submission.settle();
        } catch (error) {
          submission.settleOn(error);
          throw error;
        }
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['settings'] }),
  });

  if (!applies) return null;

  const changed = FIELDS.filter((field) => {
    const value = parsed(drafts[field.key] ?? '', field);
    return value !== null && value !== valueOf(all, field);
  });
  const allValid = FIELDS.every((field) => parsed(drafts[field.key] ?? '', field) !== null);

  return (
    <Card title={t('web.card_switch_title')} hint={t('web.card_switch_hint')}>
      <StateSwitch query={settings} denied={false}>
        <form
          className="stack"
          onSubmit={(event) => {
            event.preventDefault();
            if (!allValid || changed.length === 0) return;
            save.mutate(
              changed.map((field) => ({
                key: field.key,
                value: parsed(drafts[field.key] ?? '', field) as number,
              })),
            );
          }}
        >
          {FIELDS.map((field) => {
            const valid = parsed(drafts[field.key] ?? '', field) !== null;
            return (
              <Field
                key={field.key}
                label={`${t(field.label)} (${t(field.unit)})`}
                hint={t(field.hint)}
                htmlFor={field.id}
                {...(valid ? {} : { error: t(field.invalid) })}
              >
                <Input
                  id={field.id}
                  inputMode="numeric"
                  value={drafts[field.key] ?? ''}
                  disabled={!editable}
                  onChange={(event) => {
                    const next = event.target.value;
                    setDrafts((current) => ({ ...current, [field.key]: next }));
                  }}
                />
              </Field>
            );
          })}
          {editable && (
            <div className="btn-group">
              <button
                type="submit"
                className="btn primary"
                disabled={!allValid || changed.length === 0 || save.isPending}
              >
                {t('web.card_switch_save')}
              </button>
            </div>
          )}
          {!maySettingsEdit && <p className="muted small">{t('web.late_credit_read_only')}</p>}
          {save.error !== null && (
            <Banner tone="danger">
              {errorText(save.error)}
              <ErrorRef error={save.error} />
            </Banner>
          )}
        </form>
      </StateSwitch>
    </Card>
  );
}
