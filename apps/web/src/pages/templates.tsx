import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TemplateViewResponse } from '@nexa/contracts';
import {
  fetchTemplateRevisions,
  fetchTemplates,
  previewTemplate,
  revertTemplate,
  saveTemplate,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { ErrorReport, messageFor } from './settings';

/**
 * What a sample value has to look like in a text field, per declared type.
 *
 * The server coerces text into the declared type (`coerceTemplateValues`), so
 * the form has to say what it expects. Before that coercion existed, a NUMBER
 * placeholder was rejected on every attempt and a DATETIME or MONEY one could
 * not be supplied at all — the field could only send a string.
 */
const SAMPLE_HINTS: Partial<Record<TemplateViewResponse['placeholders'][number]['type'], WebKey>> =
  {
    NUMBER: 'web.sample_number',
    DURATION_DAYS: 'web.sample_number',
    BYTES: 'web.sample_number',
    DATETIME: 'web.sample_datetime',
    MONEY: 'web.sample_money',
  };

/**
 * The template screen.
 *
 * The editor is populated from `overrideBody` when there is one and from
 * `defaultBody` otherwise — both RAW, both with their placeholders intact.
 * Nothing rendered is ever put in the edit field, which is the entire defence
 * against the legacy screen: there the edit prompt shows the RENDERED text, so
 * `{first_name}` appears as the viewing administrator's own name and saving that
 * view would store it.
 *
 * The preview is a separate, explicitly-labelled call with values the
 * administrator types, and it stores nothing.
 */
export function TemplatesPage({ mayEdit }: { mayEdit: boolean }) {
  const templates = useQuery({ queryKey: ['templates'], queryFn: fetchTemplates });

  return (
    <section>
      <h2>{t('web.templates_title')}</h2>
      <p className="notice">{t('web.templates_intro')}</p>

      {templates.isPending && <p>{t('web.loading')}</p>}
      {templates.isError && <p className="error">{messageFor(templates.error)}</p>}

      {templates.data?.templates.map((template) => (
        <TemplateCard key={template.key} template={template} mayEdit={mayEdit} />
      ))}
    </section>
  );
}

function TemplateCard({ template, mayEdit }: { template: TemplateViewResponse; mayEdit: boolean }) {
  const client = useQueryClient();

  /**
   * The template the draft is based on, held apart from the one the query has.
   *
   * The same rule as the settings screen, for the same reason: once somebody
   * else saves this key the query refetches, and submitting the text on screen
   * against THEIR version would discard their change with nothing to notice it
   * by. The write states the version the draft was actually based on, so a
   * concurrent change comes back as a conflict and the typing survives.
   */
  const [basis, setBasis] = useState<TemplateViewResponse>(template);
  // The RAW body. The override when there is one, otherwise the default — never
  // anything that has been through the renderer.
  const [draft, setDraft] = useState(template.overrideBody ?? template.defaultBody);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  /**
   * The INPUT the last preview was rendered from — the body and the sample
   * values together.
   *
   * Without it the rendered output stays on screen while what it came from is
   * edited away underneath, which is a small version of exactly the legacy
   * confusion this screen exists to end: a preview that is not of the thing you
   * are looking at. Comparing only the body was half a fix: changing
   * `occurrences` from 3 to 10 left a preview of 3 on screen with nothing said.
   */
  const [previewedInput, setPreviewedInput] = useState<string | null>(null);

  const storedBody = template.overrideBody ?? template.defaultBody;
  // Revision AND version. A revert restarts the version at 1, so comparing
  // versions alone reports "unchanged" across a revert-then-save — which is
  // exactly the sequence that silently overwrote the other administrator.
  const changedElsewhere =
    basis.version !== template.version || basis.revision !== template.revision;
  const unsaved = draft !== (basis.overrideBody ?? basis.defaultBody);

  const adopt = (fresh: TemplateViewResponse) => {
    setBasis(fresh);
    setDraft(fresh.overrideBody ?? fresh.defaultBody);
  };

  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: ['templates'] });
    await client.invalidateQueries({ queryKey: ['revisions', template.key] });
  };

  // Two independent submissions on this card, so two keys. Saving and
  // reverting are different commands and must not share one.
  const saving = useSubmissionKey();
  const reverting = useSubmissionKey();

  const save = useMutation({
    // Held across a failure, so a person pressing the button again after a
    // dropped response is asking "did that work?" rather than issuing a second
    // command.
    mutationFn: (idempotencyKey: string) =>
      saveTemplate({
        key: template.key,
        body: draft,
        // The version AND revision the DRAFT was read at, not whatever the
        // list holds now. Both, because a revert deletes the override and the
        // next save starts a new row at version 1 — so a stale version 1 would
        // match a row it has never seen, and the server would accept it.
        expectedVersion: basis.version,
        expectedRevision: basis.revision,
        idempotencyKey,
      }),
    onSuccess: async (result) => {
      saving.settle();
      adopt(result.template);
      await invalidate();
    },
    // A conflict means the cached row is stale, and only a success invalidated
    // it — so `changedElsewhere` stayed false, the reload button was never
    // offered, and every resubmission repeated the same conflict until an
    // unrelated refetch happened. The draft survives; what is refreshed is the
    // row it will be compared against.
    onError: invalidate,
  });

  const undo = useMutation({
    // Only rendered when the DRAFT's row exists, so both expectations are
    // present. The previous version guarded on the freshly-fetched row while
    // submitting the draft's, and fell back to `expectedVersion: 0` — a version
    // that can never exist — under a comment saying the fallback was
    // unreachable. It was reachable: open the card with no override, let
    // somebody else create one, and the refetch drew the button.
    mutationFn: (idempotencyKey: string) =>
      revertTemplate({
        key: template.key,
        expectedVersion: basis.version as number,
        expectedRevision: basis.revision as number,
        idempotencyKey,
      }),
    onSuccess: async (result) => {
      reverting.settle();
      adopt(result.template);
      await invalidate();
    },
    onError: invalidate,
  });

  // The whole input, in a stable order, so a re-render cannot make it look
  // changed when it is not.
  const previewInput = JSON.stringify([draft, Object.entries(sample).sort()]);

  const preview = useMutation({
    mutationFn: () => previewTemplate(template.key, draft, sample),
    onSuccess: () => setPreviewedInput(previewInput),
  });

  const previewStale = preview.isSuccess && previewedInput !== previewInput;

  const revisions = useQuery({
    queryKey: ['revisions', template.key],
    queryFn: () => fetchTemplateRevisions(template.key),
    enabled: showHistory,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(saving.current());
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h3>
        <code>{template.key}</code>
        <span className="tag">{template.format}</span>
        <span className="tag">
          {template.source === 'TENANT' ? t('web.source_tenant') : t('web.source_default')}
        </span>
      </h3>
      <p>{template.description}</p>

      {template.overrideSuppressed && <p className="error">{t('web.override_suppressed')}</p>}

      <label htmlFor={`body-${template.key}`}>{t('web.template_body')}</label>
      <textarea
        id={`body-${template.key}`}
        value={draft}
        rows={4}
        maxLength={template.maxLength}
        onChange={(event) => setDraft(event.target.value)}
        disabled={!mayEdit}
        dir="auto"
      />

      {changedElsewhere && (
        <p className="notice">
          {t('web.changed_elsewhere')}{' '}
          <button type="button" className="link" onClick={() => adopt(template)}>
            {t('web.reload_value')}
          </button>
        </p>
      )}
      {!changedElsewhere && unsaved && (
        <p className="notice">
          {t('web.unsaved_changes')}{' '}
          <button type="button" className="link" onClick={() => setDraft(storedBody)}>
            {t('web.discard')}
          </button>
        </p>
      )}

      {template.source === 'TENANT' && (
        <details>
          {/* Showing the default beside the override is the one thing the
              legacy web surface got right here (WEB-BR-019). */}
          <summary>{t('web.template_default')}</summary>
          <pre dir="auto">{template.defaultBody}</pre>
        </details>
      )}

      <details>
        <summary>{t('web.placeholders')}</summary>
        <table>
          <thead>
            <tr>
              <th>{t('web.key')}</th>
              <th>{t('web.description')}</th>
              <th>{t('web.required')}</th>
            </tr>
          </thead>
          <tbody>
            {template.placeholders.map((placeholder) => (
              <tr key={placeholder.token}>
                <td>
                  <code>{`{${placeholder.token}}`}</code> <small>{placeholder.type}</small>
                </td>
                <td>{placeholder.description}</td>
                <td>{placeholder.required ? '✓' : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>{t('web.preview')}</summary>
        <p className="notice">{t('web.preview_note')}</p>
        {template.placeholders.length > 0 && <h4>{t('web.preview_values')}</h4>}
        {template.placeholders.map((placeholder) => (
          <div key={placeholder.token}>
            <label htmlFor={`sample-${template.key}-${placeholder.token}`}>
              {`{${placeholder.token}}`}
            </label>
            <input
              id={`sample-${template.key}-${placeholder.token}`}
              value={sample[placeholder.token] ?? ''}
              placeholder={hintFor(placeholder.type)}
              onChange={(event) =>
                setSample((current) => ({ ...current, [placeholder.token]: event.target.value }))
              }
            />
          </div>
        ))}
        <button type="button" onClick={() => preview.mutate()} disabled={preview.isPending}>
          {t('web.preview')}
        </button>
        {preview.isError && <ErrorReport error={preview.error} />}
        {preview.data && (
          <>
            {/* The rendered output is of the body it was rendered from, and
                that body may have been edited since. Saying so is cheaper than
                a preview that quietly describes something else. */}
            {previewStale && <p className="notice">{t('web.preview_stale')}</p>}
            <pre dir="auto">{preview.data.rendered}</pre>
            {preview.data.unresolved.length > 0 && (
              <p className="notice">
                {t('web.preview_unresolved')}:{' '}
                {preview.data.unresolved.join(t('web.list_separator'))}
              </p>
            )}
          </>
        )}
      </details>

      <details onToggle={(event) => setShowHistory(event.currentTarget.open)}>
        <summary>{t('web.revisions')}</summary>
        {revisions.data && revisions.data.revisions.length === 0 && <p>{t('web.empty')}</p>}
        {revisions.data && revisions.data.revisions.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>{t('web.revision')}</th>
                <th>{t('web.action')}</th>
                <th>{t('web.template_body')}</th>
                <th>{t('web.updated_at')}</th>
              </tr>
            </thead>
            <tbody>
              {revisions.data.revisions.map((revision) => (
                <tr key={revision.revision}>
                  <td>{revision.revision}</td>
                  <td>
                    {revision.action === 'SET' ? t('web.action_set') : t('web.action_revert')}
                  </td>
                  {/* A REVERT stores no body: reverting goes back to the
                      default rather than copying it. */}
                  <td dir="auto">{revision.body ?? '—'}</td>
                  <td>{formatTimestamp(revision.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </details>

      {mayEdit && (
        <div className="actions">
          <button type="submit" disabled={save.isPending}>
            {save.isPending ? t('web.saving') : t('web.save')}
          </button>
          {template.version !== null && (
            <button
              type="button"
              onClick={() => undo.mutate(reverting.current())}
              disabled={undo.isPending}
            >
              {t('web.revert')}
            </button>
          )}
        </div>
      )}
      {mayEdit && template.version !== null && <p className="notice">{t('web.revert_note')}</p>}

      {/* Which placeholder was wrong, not just that something was. */}
      {save.isError && <ErrorReport error={save.error} />}
      {undo.isError && <ErrorReport error={undo.error} />}
      {/* A no-op says so, exactly as a setting write does. Answering "saved"
          for a save that stored nothing is the legacy pattern verbatim. */}
      {save.isSuccess && (
        <p className="notice">{save.data.changed ? t('web.saved') : t('web.unchanged')}</p>
      )}
    </form>
  );
}

/** The text form a sample value has to take, or nothing for a plain string. */
function hintFor(type: TemplateViewResponse['placeholders'][number]['type']): string | undefined {
  const key = SAMPLE_HINTS[type];
  return key ? t(key) : undefined;
}
