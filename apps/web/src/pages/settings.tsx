import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResolvedSettingResponse } from '@nexa/contracts';
import { ApiError, fetchSettings, saveSetting } from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
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
  const [draft, setDraft] = useState(() => toEditable(setting.value));

  const changedElsewhere = basis.version !== setting.version;

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['settings'] });
    await client.invalidateQueries({ queryKey: ['features'] });
  };

  const adopt = (fresh: ResolvedSettingResponse) => {
    setBasis(fresh);
    setDraft(toEditable(fresh.value));
  };

  const submission = useSubmissionKey();

  const save = useMutation({
    // The key is a VARIABLE of the mutation, minted once per submission below.
    // react-query hands the same variables back on every retry, so a retry
    // after a dropped connection carries the key the first attempt used — which
    // is the only way an idempotency key protects anything.
    mutationFn: (idempotencyKey: string) =>
      saveSetting({
        key: setting.key,
        value: fromEditable(draft, basis.value),
        // The version the DRAFT was read at, not whatever the list holds now.
        expectedVersion: basis.version,
        idempotencyKey,
      }),
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
    onError: refresh,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(submission.current());
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

      {/* A stored value the registry no longer accepts. The default is in
          force, and saying so is the difference between this and the legacy
          screens that show a value nothing is using. */}
      {setting.storedValueInvalid && <p className="error">{t('web.stored_value_invalid')}</p>}

      <label htmlFor={`value-${setting.key}`}>{t('web.value')}</label>
      <input
        id={`value-${setting.key}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!mayEdit}
      />

      {changedElsewhere && (
        <p className="notice">
          {t('web.changed_elsewhere')}{' '}
          <button type="button" className="link" onClick={() => adopt(setting)}>
            {t('web.reload_value')}
          </button>
        </p>
      )}

      <dl className="meta">
        <dt>{t('web.source')}</dt>
        <dd>{setting.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default')}</dd>
        <dt>{t('web.zero_meaning')}</dt>
        <dd>{t(ZERO_MEANING_KEYS[setting.zeroMeaning])}</dd>
        {setting.updatedAt && (
          <>
            <dt>{t('web.updated_at')}</dt>
            <dd>{formatTimestamp(setting.updatedAt)}</dd>
          </>
        )}
      </dl>

      {mayEdit && (
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? t('web.saving') : t('web.save')}
        </button>
      )}
      {save.isError && <ErrorReport error={save.error} />}
      {/* A no-op says so. The legacy screens answer "✅ updated" either way,
          and one of them said it three times while nothing changed. */}
      {save.isSuccess && (
        <p className="notice">{save.data.changed ? t('web.saved') : t('web.unchanged')}</p>
      )}
    </form>
  );
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
      <p className="error">{messageFor(error)}</p>
      {issues.length > 0 && (
        <ul className="error">
          {issues.map((issue, index) => (
            // The index is part of the key: two schema issues can carry the
            // same sentence, and React's own warning for a duplicate key says
            // children "may be duplicated and/or omitted" — which is a good
            // enough reason not to find out which.
            <li key={`${index}:${issue}`}>{issue}</li>
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
