import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOMER_NOTE_MAX_LENGTH,
  CUSTOMER_TAG_COLORS,
  CUSTOMER_TAG_LABEL_MAX_LENGTH,
  normaliseCustomerTagLabel,
  type CustomerTagColor,
  type CustomerTagResponse,
} from '@nexa/contracts';
import {
  ApiError,
  addCustomerNote,
  archiveCustomerTag,
  assignCustomerTag,
  createCustomerTag,
  fetchCustomerNotes,
  fetchCustomerTagCatalogue,
  fetchCustomerTags,
  removeCustomerTag,
  updateCustomerTag,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { c360Message } from './customer-360-sections';
import { NAV_PREFETCH_FRESH_MS, type PageQuery } from '../nav-prefetch';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  IconButton,
  Input,
  Modal,
  Select,
  StateSwitch,
  Textarea,
  useConfirmedClose,
  useToast,
  useUnsavedChanges,
} from '../ui/kit';

/**
 * Customer 360 — notes and tags (program §8, `docs/customer-notes-tags.md`).
 *
 * Operator-only CRM metadata. Every read and write is charged on the server — reading tags
 * `users.view`, a customer's tags `users.tags.assign`, the catalogue `users.tags.manage`,
 * notes `users.notes.view` / `users.notes.write` — so what this file does not draw is a
 * courtesy, never the enforcement. Tags are referenced by id everywhere; a label is text an
 * operator may rename. Notes are append-only: there is no edit and no delete to draw.
 */

/** Persian names for the design system's tones, the only colours a tag may carry. */
export const TAG_COLOR_LABELS: Readonly<Record<CustomerTagColor, WebKey>> = {
  neutral: 'web.crm_tone_neutral',
  info: 'web.crm_tone_info',
  ok: 'web.crm_tone_ok',
  warn: 'web.crm_tone_warn',
  danger: 'web.crm_tone_danger',
  violet: 'web.crm_tone_violet',
  teal: 'web.crm_tone_teal',
};

const CRM_ERRORS: Readonly<Record<string, WebKey>> = {
  'commerce.customer_tag_name_taken': 'web.crm_error_tag_taken',
  'commerce.customer_tag_archived': 'web.crm_error_tag_archived',
  'commerce.customer_tag_limit': 'web.crm_error_tag_limit',
  'commerce.customer_tag_not_found': 'web.crm_error_tag_not_found',
};

export function crmMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const known = CRM_ERRORS[error.code];
    if (known !== undefined) return t(known);
  }
  return c360Message(error);
}

/** One tag as a badge in its own tone; an archived one is outlined and says so. */
export function TagBadge({ tag }: { tag: CustomerTagResponse }) {
  const archived = tag.archivedAt !== null;
  return (
    <Badge tone={tag.color ?? 'neutral'} outline={archived}>
      {tag.label}
      {archived ? ` · ${t('web.crm_tag_archived')}` : ''}
    </Badge>
  );
}

/** The tenant's tag catalogue, built in one place for the list, the 360 and the prefetch. */
export function tagCatalogueQuery(): PageQuery<
  Awaited<ReturnType<typeof fetchCustomerTagCatalogue>>
> {
  return {
    queryKey: ['customer-tag-catalogue'],
    queryFn: fetchCustomerTagCatalogue,
    staleTime: NAV_PREFETCH_FRESH_MS,
  };
}

/** The tenant's catalogue, one cache entry for the list filter, the picker and the editor. */
export function useTagCatalogue(enabled: boolean) {
  return useQuery({ ...tagCatalogueQuery(), enabled });
}

const fill = (key: WebKey, values: Readonly<Record<string, string>>) =>
  Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, value), t(key));

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function CustomerCrmSection({
  customerId,
  mayViewNotes,
  mayWriteNotes,
  mayAssignTags,
  mayManageTags,
}: {
  customerId: string;
  /** `users.notes.view` */
  mayViewNotes: boolean;
  /** `users.notes.write` */
  mayWriteNotes: boolean;
  /** `users.tags.assign` */
  mayAssignTags: boolean;
  /** `users.tags.manage` */
  mayManageTags: boolean;
}) {
  return (
    <div id="c360-crm" className="stack">
      <CustomerTagsCard
        customerId={customerId}
        mayAssign={mayAssignTags}
        mayManage={mayManageTags}
      />
      <CustomerNotesCard customerId={customerId} mayView={mayViewNotes} mayWrite={mayWriteNotes} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tags on this customer
// ---------------------------------------------------------------------------

function CustomerTagsCard({
  customerId,
  mayAssign,
  mayManage,
}: {
  customerId: string;
  mayAssign: boolean;
  mayManage: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [choice, setChoice] = useState('');
  const [managing, setManaging] = useState(false);
  const tags = useQuery({
    queryKey: ['customer-tags', customerId],
    queryFn: () => fetchCustomerTags(customerId),
  });
  const catalogue = useTagCatalogue(mayAssign);

  const write = useMutation({
    mutationFn: (input: { op: 'assign' | 'remove'; tagId: string }) => {
      const body = { tagId: input.tagId };
      const idempotencyKey = submission.current({ customerId, ...input });
      return input.op === 'assign'
        ? assignCustomerTag(customerId, { ...body, idempotencyKey })
        : removeCustomerTag(customerId, { ...body, idempotencyKey });
    },
    onSuccess: (response) => {
      submission.settle();
      if (!response.changed) notify({ tone: 'info', message: t('web.crm_unchanged') });
      queries.setQueryData(['customer-tags', customerId], { tags: response.tags });
      setChoice('');
      // A tag moves this customer in and out of the list's tag filter.
      void queries.invalidateQueries({ queryKey: ['customers'] });
      void queries.invalidateQueries({ queryKey: ['customer-timeline', customerId] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const assigned = tags.data?.tags ?? [];
  const assignedIds = new Set(assigned.map((tag) => tag.id));
  // Only ACTIVE tags are offered: an archived one is refused by the server anyway.
  const offered = (catalogue.data?.tags ?? []).filter(
    (tag) => tag.archivedAt === null && !assignedIds.has(tag.id),
  );

  return (
    <Card
      title={t('web.crm_tags_title')}
      hint={t('web.crm_tags_hint')}
      actions={
        mayManage ? (
          <Button size="sm" variant="ghost" icon="tag" onClick={() => setManaging(true)}>
            {t('web.crm_tags_manage')}
          </Button>
        ) : undefined
      }
    >
      <StateSwitch query={tags}>
        {assigned.length === 0 ? (
          <Empty variant="compact" title={t('web.crm_tags_empty')} />
        ) : (
          <ul className="crm-tags" aria-label={t('web.crm_tags_title')}>
            {assigned.map((tag) => (
              <li key={tag.id}>
                <TagBadge tag={tag} />
                {mayAssign && (
                  <IconButton
                    icon="x"
                    size="sm"
                    label={fill('web.crm_tag_remove', { label: tag.label })}
                    disabled={write.isPending}
                    onClick={() => write.mutate({ op: 'remove', tagId: tag.id })}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </StateSwitch>

      {mayAssign ? (
        catalogue.data === undefined ? null : offered.length === 0 ? (
          <p className="muted small">{t('web.crm_tags_none_assignable')}</p>
        ) : (
          <div className="crm-assign">
            <Field label={t('web.crm_tag_add_label')} htmlFor={`crm-tag-${customerId}`} compact>
              <Select
                id={`crm-tag-${customerId}`}
                size="sm"
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">{t('web.crm_tag_add_placeholder')}</option>
                {offered.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              size="sm"
              icon="plus"
              disabled={choice === '' || write.isPending}
              onClick={() => write.mutate({ op: 'assign', tagId: choice })}
            >
              {t('web.crm_tag_add')}
            </Button>
          </div>
        )
      ) : (
        <p className="muted small">{t('web.crm_tags_assign_denied')}</p>
      )}
      {write.error !== null && <Banner tone="danger">{crmMessage(write.error)}</Banner>}

      <TagCatalogueModal open={mayManage && managing} onClose={() => setManaging(false)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function CustomerNotesCard({
  customerId,
  mayView,
  mayWrite,
}: {
  customerId: string;
  mayView: boolean;
  mayWrite: boolean;
}) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState('');
  const body = draft.trim();
  const tooLong = Array.from(body).length > CUSTOMER_NOTE_MAX_LENGTH;
  // A note being typed is not lost to a sidebar click.
  useUnsavedChanges(body !== '');

  const notes = useInfiniteQuery({
    queryKey: ['customer-notes', customerId],
    queryFn: ({ pageParam }) => fetchCustomerNotes(customerId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: mayView,
  });

  const add = useMutation({
    mutationFn: (text: string) =>
      addCustomerNote(customerId, {
        body: text,
        idempotencyKey: submission.current({ customerId, body: text }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.crm_note_added') });
      setDraft('');
      void queries.invalidateQueries({ queryKey: ['customer-notes', customerId] });
      void queries.invalidateQueries({ queryKey: ['customer-timeline', customerId] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const all = notes.data?.pages.flatMap((page) => page.notes) ?? [];

  return (
    <Card title={t('web.crm_notes_title')} hint={t('web.crm_notes_hint')}>
      {mayWrite && (
        <div className="crm-note-form">
          <Field
            label={t('web.crm_note_label')}
            htmlFor={`crm-note-${customerId}`}
            {...(tooLong ? { error: t('web.crm_note_too_long') } : {})}
          >
            <Textarea
              id={`crm-note-${customerId}`}
              rows={3}
              value={draft}
              aria-invalid={tooLong}
              onChange={(event) => setDraft(event.target.value)}
            />
          </Field>
          <Button
            size="sm"
            variant="primary"
            disabled={body === '' || tooLong || add.isPending}
            onClick={() => add.mutate(body)}
          >
            {t('web.crm_note_add')}
          </Button>
          {add.error !== null && <Banner tone="danger">{crmMessage(add.error)}</Banner>}
        </div>
      )}
      {!mayView ? (
        <Banner tone="info">{t('web.crm_notes_denied')}</Banner>
      ) : (
        <StateSwitch query={notes}>
          {all.length === 0 ? (
            <Empty variant="compact" title={t('web.crm_notes_empty')} />
          ) : (
            <ol className="crm-notes">
              {all.map((note) => (
                <li key={note.id}>
                  <p className="crm-note-body">{note.body}</p>
                  <p className="muted small">
                    {note.authorLabel} — {formatTimestamp(note.createdAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
          {notes.hasNextPage && (
            <Button
              size="sm"
              variant="ghost"
              disabled={notes.isFetchingNextPage}
              onClick={() => void notes.fetchNextPage()}
            >
              {t('web.crm_notes_more')}
            </Button>
          )}
        </StateSwitch>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The tenant's catalogue (users.tags.manage)
// ---------------------------------------------------------------------------

/** Neutral is sent as null: one stored spelling for "no colour". */
const colorValue = (raw: string): CustomerTagColor | null =>
  raw === '' || raw === 'neutral' ? null : (raw as CustomerTagColor);

function ColorSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <Select id={id} size="sm" value={value} onChange={(event) => onChange(event.target.value)}>
      {CUSTOMER_TAG_COLORS.map((color) => (
        <option key={color} value={color}>
          {t(TAG_COLOR_LABELS[color])}
        </option>
      ))}
    </Select>
  );
}

const labelTooLong = (raw: string) =>
  Array.from(normaliseCustomerTagLabel(raw)).length > CUSTOMER_TAG_LABEL_MAX_LENGTH;

export function TagCatalogueModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notify = useToast();
  const queries = useQueryClient();
  const submission = useSubmissionKey();
  const catalogue = useTagCatalogue(open);
  const [name, setName] = useState('');
  const [color, setColor] = useState('neutral');
  /** The tag being edited, with the values it was opened with. */
  const [editing, setEditing] = useState<{ id: string; label: string; color: string } | null>(null);

  const write = useMutation({
    mutationFn: (
      command:
        | { op: 'create'; label: string; color: CustomerTagColor | null }
        | { op: 'update'; tagId: string; label: string; color: CustomerTagColor | null }
        | { op: 'archive'; tagId: string; archived: boolean },
    ) => {
      const idempotencyKey = submission.current(command);
      switch (command.op) {
        case 'create':
          return createCustomerTag({ label: command.label, color: command.color, idempotencyKey });
        case 'update':
          return updateCustomerTag(command.tagId, {
            label: command.label,
            color: command.color,
            idempotencyKey,
          });
        case 'archive':
          return archiveCustomerTag(command.tagId, { archived: command.archived, idempotencyKey });
      }
    },
    onSuccess: (response, command) => {
      submission.settle();
      const done: Record<typeof command.op, WebKey> = {
        create: 'web.crm_tag_created',
        update: 'web.crm_tag_saved',
        archive:
          command.op === 'archive' && !command.archived
            ? 'web.crm_tag_restored_done'
            : 'web.crm_tag_archived_done',
      };
      notify({
        tone: 'ok',
        message: response.changed ? t(done[command.op]) : t('web.crm_unchanged'),
      });
      if (command.op === 'create') {
        setName('');
        setColor('neutral');
      }
      if (command.op === 'update') setEditing(null);
      void queries.invalidateQueries({ queryKey: ['customer-tag-catalogue'] });
      // A rename or an archive changes how every customer's badge reads.
      void queries.invalidateQueries({ queryKey: ['customer-tags'] });
    },
    onError: (error) => submission.settleOn(error),
  });

  const dirty = name.trim() !== '' || editing !== null;
  const close = () => {
    setName('');
    setColor('neutral');
    setEditing(null);
    write.reset();
    onClose();
  };
  const { requestClose, dialog } = useConfirmedClose(dirty, close);
  const createTooLong = labelTooLong(name);
  const editTooLong = editing !== null && labelTooLong(editing.label);

  return (
    <>
      <Modal open={open} onClose={requestClose} title={t('web.crm_catalogue_title')} size="lg">
        <p className="muted small">{t('web.crm_catalogue_hint')}</p>
        <div className="crm-tag-form">
          <Field
            label={t('web.crm_tag_name')}
            htmlFor="crm-new-tag"
            {...(createTooLong ? { error: t('web.crm_tag_name_too_long') } : {})}
          >
            <Input
              id="crm-new-tag"
              value={name}
              aria-invalid={createTooLong}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('web.crm_tag_color')} htmlFor="crm-new-tag-color">
            <ColorSelect id="crm-new-tag-color" value={color} onChange={setColor} />
          </Field>
          <Button
            size="sm"
            variant="primary"
            icon="plus"
            disabled={name.trim() === '' || createTooLong || write.isPending}
            onClick={() =>
              write.mutate({
                op: 'create',
                label: normaliseCustomerTagLabel(name),
                color: colorValue(color),
              })
            }
          >
            {t('web.crm_tag_create')}
          </Button>
        </div>
        {write.error !== null && <Banner tone="danger">{crmMessage(write.error)}</Banner>}

        <StateSwitch query={catalogue}>
          {(catalogue.data?.tags.length ?? 0) === 0 ? (
            <Empty variant="compact" title={t('web.crm_catalogue_empty')} />
          ) : (
            <ul className="crm-catalogue">
              {(catalogue.data?.tags ?? []).map((tag) =>
                editing !== null && editing.id === tag.id ? (
                  <li key={tag.id} className="crm-tag-form">
                    <Field
                      label={t('web.crm_tag_name')}
                      htmlFor={`crm-edit-${tag.id}`}
                      {...(editTooLong ? { error: t('web.crm_tag_name_too_long') } : {})}
                    >
                      <Input
                        id={`crm-edit-${tag.id}`}
                        value={editing.label}
                        onChange={(event) => setEditing({ ...editing, label: event.target.value })}
                      />
                    </Field>
                    <Field label={t('web.crm_tag_color')} htmlFor={`crm-edit-color-${tag.id}`}>
                      <ColorSelect
                        id={`crm-edit-color-${tag.id}`}
                        value={editing.color}
                        onChange={(next) => setEditing({ ...editing, color: next })}
                      />
                    </Field>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={editing.label.trim() === '' || editTooLong || write.isPending}
                      onClick={() =>
                        write.mutate({
                          op: 'update',
                          tagId: tag.id,
                          label: normaliseCustomerTagLabel(editing.label),
                          color: colorValue(editing.color),
                        })
                      }
                    >
                      {t('web.crm_tag_save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      {t('web.crm_tag_cancel')}
                    </Button>
                  </li>
                ) : (
                  <li key={tag.id}>
                    <TagBadge tag={tag} />
                    <span className="crm-catalogue-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="edit"
                        disabled={write.isPending}
                        onClick={() =>
                          setEditing({
                            id: tag.id,
                            label: tag.label,
                            color: tag.color ?? 'neutral',
                          })
                        }
                      >
                        {t('web.crm_tag_edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={tag.archivedAt === null ? 'archive' : 'undo'}
                        disabled={write.isPending}
                        onClick={() =>
                          write.mutate({
                            op: 'archive',
                            tagId: tag.id,
                            archived: tag.archivedAt === null,
                          })
                        }
                      >
                        {tag.archivedAt === null
                          ? t('web.crm_tag_archive')
                          : t('web.crm_tag_restore')}
                      </Button>
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </StateSwitch>
      </Modal>
      {dialog}
    </>
  );
}
