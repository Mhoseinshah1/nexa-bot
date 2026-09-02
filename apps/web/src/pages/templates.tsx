import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TemplateViewResponse } from '@nexa/contracts';
import {
  fetchTemplateRevisions,
  fetchTemplates,
  newIdempotencyKey,
  previewTemplate,
  revertTemplate,
  saveTemplate,
} from '../api/client';
import { t } from '../i18n/web.fa';
import { issuesFrom, messageFor } from './settings';

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
  // The RAW body. The override when there is one, otherwise the default — never
  // anything that has been through the renderer.
  const [draft, setDraft] = useState(template.overrideBody ?? template.defaultBody);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);

  const invalidate = async () => {
    await client.invalidateQueries({ queryKey: ['templates'] });
    await client.invalidateQueries({ queryKey: ['revisions', template.key] });
  };

  const save = useMutation({
    mutationFn: () =>
      saveTemplate({
        key: template.key,
        body: draft,
        expectedVersion: template.version,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: invalidate,
  });

  const undo = useMutation({
    mutationFn: () =>
      revertTemplate({
        key: template.key,
        // Only reachable when a version exists, which is exactly when there is
        // an override to remove.
        expectedVersion: template.version ?? 0,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setDraft(template.defaultBody);
      await invalidate();
    },
  });

  const preview = useMutation({
    mutationFn: () => previewTemplate(template.key, draft, sample),
  });

  const revisions = useQuery({
    queryKey: ['revisions', template.key],
    queryFn: () => fetchTemplateRevisions(template.key),
    enabled: showHistory,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
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
              onChange={(event) =>
                setSample((current) => ({ ...current, [placeholder.token]: event.target.value }))
              }
            />
          </div>
        ))}
        <button type="button" onClick={() => preview.mutate()} disabled={preview.isPending}>
          {t('web.preview')}
        </button>
        {preview.isError && (
          <>
            <p className="error">{messageFor(preview.error)}</p>
            <ul className="error">
              {issuesFrom(preview.error).map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </>
        )}
        {preview.data && (
          <>
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
                  <td>{revision.createdAt}</td>
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
            <button type="button" onClick={() => undo.mutate()} disabled={undo.isPending}>
              {t('web.revert')}
            </button>
          )}
        </div>
      )}
      {mayEdit && template.version !== null && <p className="notice">{t('web.revert_note')}</p>}

      {save.isError && (
        <>
          <p className="error">{messageFor(save.error)}</p>
          {/* Which placeholder was wrong, not just that something was. */}
          <ul className="error">
            {issuesFrom(save.error).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </>
      )}
      {undo.isError && <p className="error">{messageFor(undo.error)}</p>}
      {/* A no-op says so, exactly as a setting write does. Answering "saved"
          for a save that stored nothing is the legacy pattern verbatim. */}
      {save.isSuccess && (
        <p className="notice">{save.data.changed ? t('web.saved') : t('web.unchanged')}</p>
      )}
    </form>
  );
}
