import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResolvedSettingResponse } from '@nexa/contracts';
import { ApiError, fetchSettings, newIdempotencyKey, saveSetting } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';

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
 */
export function SettingsPage({ mayEdit }: { mayEdit: boolean }) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });

  return (
    <section>
      <h2>{t('web.settings_title')}</h2>
      <p className="notice">{t('web.settings_intro')}</p>

      {settings.isPending && <p>{t('web.loading')}</p>}
      {settings.isError && <p className="error">{messageFor(settings.error)}</p>}

      {settings.data?.settings.map((setting) => (
        <SettingRow key={setting.key} setting={setting} mayEdit={mayEdit} />
      ))}
    </section>
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
  const [draft, setDraft] = useState(() => toEditable(setting.value));

  const save = useMutation({
    mutationFn: () =>
      saveSetting({
        key: setting.key,
        value: fromEditable(draft, setting.value),
        // The version this row was READ at. Required, and null means "I read
        // this as unset" — an expectation like any other.
        expectedVersion: setting.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['settings'] });
      await client.invalidateQueries({ queryKey: ['features'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h3>
        <code>{setting.key}</code>
        {setting.classification === 'SENSITIVE' && (
          <span className="tag">{t('web.sensitive')}</span>
        )}
        {setting.mutability === 'RESTART_REQUIRED' && (
          <span className="tag">{t('web.restart_required')}</span>
        )}
      </h3>
      <p>{setting.description}</p>

      <label htmlFor={`value-${setting.key}`}>{t('web.value')}</label>
      <input
        id={`value-${setting.key}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!mayEdit}
      />

      <dl className="meta">
        <dt>{t('web.source')}</dt>
        <dd>{setting.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default')}</dd>
        <dt>{t('web.zero_meaning')}</dt>
        <dd>{t(ZERO_MEANING_KEYS[setting.zeroMeaning])}</dd>
        {setting.updatedAt && (
          <>
            <dt>{t('web.updated_at')}</dt>
            <dd>{setting.updatedAt}</dd>
          </>
        )}
      </dl>

      {mayEdit && (
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? t('web.saving') : t('web.save')}
        </button>
      )}
      {save.isError && <p className="error">{messageFor(save.error)}</p>}
      {/* A no-op says so. The legacy screens answer "✅ updated" either way,
          and one of them said it three times while nothing changed. */}
      {save.isSuccess && (
        <p className="notice">{save.data.changed ? t('web.saved') : t('web.unchanged')}</p>
      )}
    </form>
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
