import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOM_MENU_BUTTONS_MAX,
  CUSTOM_MENU_CAPTION_MAX,
  CUSTOM_MENU_LABEL_MAX,
  CUSTOM_MENU_TEXT_MAX,
  type CustomMenuBotScope,
  type CustomMenuButtonKind,
  type CustomMenuButtonView,
  type MainMenuIconEligibility,
} from '@nexa/contracts';
import {
  archiveCustomMenuButton,
  createCustomMenuButton,
  fetchCustomMenuButtons,
  setCustomMenuButtonMedia,
  updateCustomMenuButton,
} from '../../api/client';
import { t, type WebKey } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import { queryState } from '../../view-state';
import { FilePicker, formatFileSize } from '../../ui/file-picker';
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Field,
  Input,
  Ltr,
  Modal,
  Radio,
  Textarea,
  useToast,
} from '../../ui/kit';
import { ErrorReport } from '../settings';
import { readReplyFile, type PickedReplyFile } from '../tickets';

/**
 * R10 D2 — where the owner DEFINES his own main-menu buttons: a link, or a stored text, photo
 * or document. They are PLACED (order, on/off, style) in the builder above, from its Available
 * pool; this panel only creates, edits and archives them.
 *
 * The server holds every rule — the permission, the label's uniqueness, the https-only link
 * grammar, the file allow-list, the limits — and answers a coded refusal that the Persian error
 * map renders. This page only spares the operator a request it would refuse, and never shows a
 * Telegram file handle or claims a customer saw anything. The feature flag
 * (`custom_menu_buttons`) is the Features page's switch: while it is off nothing here is drawn
 * on a keyboard, and the page says so.
 */

const KIND_LABEL: Readonly<Record<CustomMenuButtonKind, WebKey>> = {
  LINK: 'web.cmb_kind_link',
  TEXT: 'web.cmb_kind_text',
  PHOTO: 'web.cmb_kind_photo',
  DOCUMENT: 'web.cmb_kind_document',
};

export const CUSTOM_BUTTONS_QUERY_KEY = ['custom-menu-buttons'] as const;

/** Code points, as the server counts them. */
const lengthOf = (text: string) => Array.from(text.trim()).length;

function botsSummary(button: CustomMenuButtonView, bots: readonly MainMenuIconEligibility[]) {
  if (button.botScope === 'ALL') return t('web.cmb_bots_all');
  const names = button.botInstanceIds
    .map((id) => bots.find((bot) => bot.botInstanceId === id)?.username)
    .filter((name): name is string => name !== undefined);
  return names.length === 0
    ? t('web.cmb_bots_none')
    : names.map((name) => `@${name}`).join(t('web.bb_sep'));
}

function contentSummary(button: CustomMenuButtonView): string {
  if (button.kind === 'LINK') return button.url ?? '';
  if (button.kind === 'TEXT') return button.body ?? '';
  return button.media?.fileName ?? '';
}

export function CustomButtonsPanel({
  bots,
  mayEdit,
  onChanged,
}: {
  /** The tenant's bots: each button is shown on all of them or on the ones chosen. */
  bots: readonly MainMenuIconEligibility[];
  mayEdit: boolean;
  /** The builder's own read is stale once a button changes (its pool and preview). */
  onChanged: () => void;
}) {
  const query = useQuery({ queryKey: CUSTOM_BUTTONS_QUERY_KEY, queryFn: fetchCustomMenuButtons });
  const queries = useQueryClient();
  const notify = useToast();
  const [editing, setEditing] = useState<CustomMenuButtonView | 'new' | null>(null);
  const [archiving, setArchiving] = useState<CustomMenuButtonView | null>(null);
  const archiveKey = useSubmissionKey();

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: CUSTOM_BUTTONS_QUERY_KEY });
    onChanged();
  };
  const archive = useMutation({
    mutationFn: (button: CustomMenuButtonView) =>
      archiveCustomMenuButton(button.id, {
        expectedVersion: button.version,
        idempotencyKey: archiveKey.current({ id: button.id, version: button.version }),
      }),
    onSuccess: () => {
      archiveKey.settle();
      notify({ tone: 'ok', message: t('web.cmb_archived_toast') });
      setArchiving(null);
      refresh();
    },
    onError: (error) => archiveKey.settleOn(error),
  });

  const data = query.data;
  const active = data?.buttons.filter((one) => one.archivedAt === null) ?? [];
  const full = active.length >= CUSTOM_MENU_BUTTONS_MAX;

  return (
    <Card
      title={t('web.cmb_title')}
      hint={t('web.cmb_hint')}
      className="cmb-card"
      actions={
        mayEdit ? (
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            disabled={full || data === undefined}
            onClick={() => setEditing('new')}
          >
            {t('web.cmb_add')}
          </Button>
        ) : undefined
      }
    >
      {queryState(query) === 'error' && <ErrorReport error={query.error} />}
      {data !== undefined && !data.featureEnabled && (
        <Banner tone="warn">
          <span data-testid="cmb-feature-off">{t('web.cmb_feature_off')}</span>
        </Banner>
      )}
      {full && <Banner tone="info">{t('web.cmb_limit_note')}</Banner>}
      {data !== undefined && active.length === 0 && (
        <p className="muted small" data-testid="cmb-empty">
          {t('web.cmb_empty')}
        </p>
      )}
      {active.length > 0 && (
        <ul className="cmb-list" data-testid="cmb-list">
          {active.map((button) => (
            <li key={button.id} className="cmb-item" data-testid={`cmb-item-${button.id}`}>
              <div className="cmb-item-main">
                <strong className="cmb-item-label">{button.label}</strong>{' '}
                <Badge tone="neutral">{t(KIND_LABEL[button.kind])}</Badge>
                <div className="muted small cmb-item-content" dir="auto">
                  {button.kind === 'LINK' ? (
                    <Ltr mono={false}>{contentSummary(button)}</Ltr>
                  ) : (
                    contentSummary(button)
                  )}
                </div>
                <div className="muted small">{botsSummary(button, bots)}</div>
              </div>
              {mayEdit && (
                <div className="cmb-item-actions">
                  <Button size="sm" onClick={() => setEditing(button)}>
                    {t('web.cmb_edit')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => setArchiving(button)}>
                    {t('web.cmb_archive')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {data !== undefined && (
        <p className="muted small" data-testid="cmb-storage">
          {t('web.cmb_storage')
            .replace('{used}', formatFileSize(data.storage.usedBytes))
            .replace('{max}', formatFileSize(data.storage.maxBytes))}
        </p>
      )}

      {editing !== null && (
        <CustomButtonModal
          key={editing === 'new' ? 'new' : editing.id}
          button={editing === 'new' ? null : editing}
          bots={bots}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
      {archiving !== null && (
        <ConfirmDialog
          title={t('web.cmb_archive_title')}
          question={t('web.cmb_archive_question').replace('{label}', archiving.label)}
          detail={archive.isError ? undefined : t('web.cmb_archive_detail')}
          confirmLabel={t('web.cmb_archive')}
          cancelLabel={t('web.cmb_cancel')}
          onCancel={() => {
            archive.reset();
            setArchiving(null);
          }}
          onConfirm={() => archive.mutate(archiving)}
        />
      )}
      {archive.isError && <ErrorReport error={archive.error} />}
    </Card>
  );
}

/** Create (button null) or edit one button. The kind is chosen once and never changes. */
function CustomButtonModal({
  button,
  bots,
  onClose,
  onSaved,
}: {
  button: CustomMenuButtonView | null;
  bots: readonly MainMenuIconEligibility[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const creating = button === null;
  const submission = useSubmissionKey();
  const mediaSubmission = useSubmissionKey();
  /**
   * What an edit is measured against: the button as last SAVED, not as opened. An edit that
   * changes the details and the file is two writes; when the details commit and the file is
   * refused (the storage quota, say), the details' answer becomes the basis, so the retry
   * sends only what is still unsaved — the file — at the version that answer carries.
   * Measured against the button as opened, the retry re-sent the details with the version
   * they had already replaced and was refused as a conflict on every press (Codex #337-1).
   */
  const saved = useRef(button);
  const [label, setLabel] = useState(button?.label ?? '');
  const [kind, setKind] = useState<CustomMenuButtonKind>(button?.kind ?? 'LINK');
  const [url, setUrl] = useState(button?.url ?? '');
  const [body, setBody] = useState(button?.body ?? '');
  const [scope, setScope] = useState<CustomMenuBotScope>(button?.botScope ?? 'ALL');
  const [botIds, setBotIds] = useState<readonly string[]>(button?.botInstanceIds ?? []);
  const [picked, setPicked] = useState<PickedReplyFile>({ kind: 'NONE' });
  const [chosen, setChosen] = useState<File | null>(null);
  // A later pick wins: a read that finishes for an earlier one is discarded.
  const selection = useRef(0);

  const needsFile = kind === 'PHOTO' || kind === 'DOCUMENT';
  const bodyMax =
    kind === 'TEXT' || kind === 'LINK' ? CUSTOM_MENU_TEXT_MAX : CUSTOM_MENU_CAPTION_MAX;
  const labelLength = lengthOf(label);
  const bodyLength = lengthOf(body);
  const labelError =
    labelLength > CUSTOM_MENU_LABEL_MAX
      ? t('web.cmb_label_too_long')
      : label.trim().startsWith('/')
        ? t('web.cmb_label_slash')
        : undefined;
  const bodyError = bodyLength > bodyMax ? t('web.cmb_body_too_long') : undefined;
  const fileBusy = picked.kind === 'READING' || picked.kind === 'INVALID';
  const missing =
    labelLength === 0 ||
    (kind === 'LINK' && url.trim() === '') ||
    (kind === 'TEXT' && bodyLength === 0) ||
    (creating && needsFile && picked.kind !== 'READY') ||
    (scope === 'SELECTED' && botIds.length === 0);
  const blocked = missing || labelError !== undefined || bodyError !== undefined || fileBusy;

  const choose = (file: File | undefined) => {
    selection.current += 1;
    const pick = selection.current;
    setChosen(file ?? null);
    if (file === undefined) {
      setPicked({ kind: 'NONE' });
      return;
    }
    setPicked({ kind: 'READING' });
    void readReplyFile(file).then((result) => {
      if (selection.current === pick) setPicked(result);
    });
  };

  const save = useMutation({
    mutationFn: async () => {
      const bodyValue = body.trim() === '' ? null : body;
      const selected = scope === 'SELECTED' ? [...botIds] : [];
      const basis = saved.current;
      if (basis === null) {
        const file = picked.kind === 'READY' ? picked.attachment : null;
        const payload = {
          label,
          kind,
          url: kind === 'LINK' ? url : null,
          body: bodyValue,
          botScope: scope,
          botInstanceIds: selected,
          file,
        };
        return createCustomMenuButton({
          ...payload,
          idempotencyKey: submission.current({ ...payload, file: file?.contentBase64.length }),
        });
      }
      // An edit sends only what the operator changed; a new file is its own write, after it.
      const changes = {
        ...(label.trim() !== basis.label ? { label } : {}),
        ...(kind === 'LINK' && url.trim() !== (basis.url ?? '') ? { url } : {}),
        ...(bodyValue !== basis.body ? { body: bodyValue } : {}),
        ...(scope !== basis.botScope ||
        JSON.stringify([...selected].sort()) !== JSON.stringify([...basis.botInstanceIds].sort())
          ? { botScope: scope, botInstanceIds: selected }
          : {}),
      };
      let version = basis.version;
      let last: Awaited<ReturnType<typeof updateCustomMenuButton>> | null = null;
      if (Object.keys(changes).length > 0) {
        last = await updateCustomMenuButton(basis.id, {
          ...changes,
          expectedVersion: version,
          idempotencyKey: submission.current({ id: basis.id, version, changes }),
        });
        saved.current = last.button;
        version = last.button.version;
      }
      if (picked.kind === 'READY') {
        last = await setCustomMenuButtonMedia(basis.id, {
          file: picked.attachment,
          expectedVersion: version,
          idempotencyKey: mediaSubmission.current({
            id: basis.id,
            version,
            size: picked.attachment.contentBase64.length,
          }),
        });
      }
      return last;
    },
    onSuccess: () => {
      submission.settle();
      mediaSubmission.settle();
      onSaved();
    },
    onError: (error) => {
      submission.settleOn(error);
      mediaSubmission.settleOn(error);
    },
  });

  const toggleBot = (id: string, on: boolean) =>
    setBotIds((current) =>
      on ? [...new Set([...current, id])] : current.filter((one) => one !== id),
    );

  return (
    <Modal
      open
      onClose={() => {
        if (!save.isPending) onClose();
      }}
      size="lg"
      title={creating ? t('web.cmb_new_title') : t('web.cmb_edit_title')}
      foot={
        <>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            disabled={blocked || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('web.saving') : t('web.cmb_save')}
          </Button>
          <Button size="sm" disabled={save.isPending} onClick={onClose}>
            {t('web.cmb_cancel')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <Field
          label={t('web.cmb_label_label')}
          hint={`${t('web.cmb_label_hint')} (${String(labelLength)}/${String(CUSTOM_MENU_LABEL_MAX)})`}
          htmlFor="cmb-label"
          {...(labelError === undefined ? {} : { error: labelError })}
        >
          <Input
            id="cmb-label"
            dir="auto"
            value={label}
            aria-invalid={labelError !== undefined}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        {creating ? (
          <div role="radiogroup" aria-label={t('web.cmb_kind_label')} className="cmb-kinds">
            {(['LINK', 'TEXT', 'PHOTO', 'DOCUMENT'] as const).map((one) => (
              <Radio
                key={one}
                name="cmb-kind"
                value={one}
                selected={kind}
                label={t(KIND_LABEL[one])}
                onChange={setKind}
              />
            ))}
          </div>
        ) : (
          <p className="muted small">
            {t('web.cmb_kind_fixed').replace('{kind}', t(KIND_LABEL[kind]))}
          </p>
        )}
        {kind === 'LINK' && (
          <Field label={t('web.cmb_url_label')} hint={t('web.cmb_url_hint')} htmlFor="cmb-url">
            <Input
              id="cmb-url"
              type="url"
              dir="ltr"
              inputMode="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </Field>
        )}
        <Field
          label={t(
            kind === 'TEXT'
              ? 'web.cmb_text_label'
              : kind === 'LINK'
                ? 'web.cmb_note_label'
                : 'web.cmb_caption_label',
          )}
          hint={`${String(bodyLength)}/${String(bodyMax)}`}
          htmlFor="cmb-body"
          {...(bodyError === undefined ? {} : { error: bodyError })}
        >
          <Textarea
            id="cmb-body"
            rows={kind === 'TEXT' ? 6 : 3}
            dir="auto"
            value={body}
            aria-invalid={bodyError !== undefined}
            onChange={(event) => setBody(event.target.value)}
          />
        </Field>
        {needsFile && (
          <Field
            label={t('web.cmb_file_label')}
            hint={t(kind === 'PHOTO' ? 'web.cmb_photo_hint' : 'web.cmb_document_hint')}
            htmlFor="cmb-file"
            {...(picked.kind === 'INVALID' ? { error: t(picked.reason) } : {})}
          >
            <FilePicker
              id="cmb-file"
              kind={kind === 'PHOTO' ? 'image' : 'any'}
              extensions={kind === 'PHOTO' ? ['.jpg', '.png'] : ['.pdf', '.txt']}
              accept={
                kind === 'PHOTO'
                  ? 'image/jpeg,image/png,.jpg,.jpeg,.png'
                  : 'application/pdf,text/plain,.pdf,.txt'
              }
              selected={chosen}
              onFiles={(files) => choose(files[0])}
              onClear={() => choose(undefined)}
            />
            {!creating && button?.media != null && picked.kind === 'NONE' && (
              <span className="muted small" data-testid="cmb-current-file">
                {t('web.cmb_current_file').replace('{name}', button.media.fileName)}
              </span>
            )}
          </Field>
        )}
        <fieldset className="cmb-bots">
          <legend>{t('web.cmb_bots_legend')}</legend>
          <div role="radiogroup" aria-label={t('web.cmb_bots_legend')}>
            <Radio
              name="cmb-scope"
              value="ALL"
              selected={scope}
              label={t('web.cmb_bots_all')}
              onChange={setScope}
            />
            <Radio
              name="cmb-scope"
              value="SELECTED"
              selected={scope}
              label={t('web.cmb_bots_selected')}
              onChange={setScope}
            />
          </div>
          {scope === 'SELECTED' &&
            (bots.length === 0 ? (
              <p className="muted small">{t('web.bot_buttons_no_bots')}</p>
            ) : (
              bots.map((bot) => (
                <Checkbox
                  key={bot.botInstanceId}
                  label={<Ltr mono={false}>@{bot.username}</Ltr>}
                  checked={botIds.includes(bot.botInstanceId)}
                  onChange={(on) => toggleBot(bot.botInstanceId, on)}
                />
              ))
            ))}
        </fieldset>
        {save.isError && <ErrorReport error={save.error} />}
      </div>
    </Modal>
  );
}
