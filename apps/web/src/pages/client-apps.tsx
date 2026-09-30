import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CLIENT_APP_DELIVERY_KINDS,
  CLIENT_APP_DESCRIPTION_MAX_LENGTH,
  CLIENT_APP_GUIDE_MAX_LENGTH,
  CLIENT_APP_ICON_MAX_LENGTH,
  CLIENT_APP_IMAGE_MAX_BYTES,
  CLIENT_APP_IMAGE_MIME_TYPES,
  CLIENT_APP_NAME_MAX_LENGTH,
  CLIENT_APP_PLATFORMS,
  CLIENT_APP_PROTOCOLS,
  CLIENT_APP_URL_MAX_LENGTH,
  PROVIDER_DESCRIPTORS,
  clientAppTextProblem,
  inspectClientAppImage,
  neutralizeClientAppBareLinks,
  normalizeClientAppUrl,
  renderClientAppGuide,
  templateDefinition,
  type ClientAppDeliveryKind,
  type ClientAppImageMimeType,
  type ClientAppImageProblem,
  type ClientAppPlatform,
  type ClientAppProtocol,
  type ClientAppResponse,
  type ClientAppStatus,
  type ClientAppTextProblem,
  type ProviderType,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import {
  ApiError,
  clearClientAppImage,
  clientAppImageUrl,
  createClientApp,
  deleteClientApp,
  fetchClientApps,
  setClientAppStatus,
  updateClientApp,
  uploadClientAppImage,
  type ClientAppFields,
} from '../api/client';
import { formatNumber, formatTimestamp, splitBytes } from '../format';
import { useSubmissionKey } from '../submission-key';
import { queryState } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import { sortOrderOf } from './support';
import { TelegramPhone } from './telegram-phone';
import { Icon } from '../ui/icons';
import {
  Disclosure,
  Badge,
  Banner,
  Card,
  ConfirmDialog,
  DataTable,
  Empty,
  Field,
  PageHead,
  RowActions,
  StateSwitch,
  useUnsavedChanges,
  useToast,
  type Column,
} from '../ui/kit';

/**
 * Apps & connection guides (WP-A10) — the client apps the bot recommends, per platform.
 *
 * **Content, not code.** Every link and guide here is sent to customers from the next tap
 * on; nothing is deployed. Nothing is pre-filled either: this installation ships no app
 * and no link, because a default download link is a claim about somebody else's binary.
 *
 * **The same checks as the server, from the same functions.** `normalizeClientAppUrl` and
 * `clientAppTextProblem` come from the contract the service parses with, so the form
 * refuses exactly what the server would — in Persian, before a request is spent — and
 * the preview renders the guide with `renderClientAppGuide`, the function the bot uses.
 * The preview is a text node: whatever the guide contains is shown, never interpreted.
 *
 * **Every write states the version it read**, and a colleague's edit comes back as a
 * conflict with the fresh row on offer — the support page's rule, applied here.
 *
 * `mayEdit` is passed, never derived from `denied`: the page takes `client_apps.view`
 * and writing takes `client_apps.edit`, which the server charges on its own.
 */

const VERSION_CONFLICT = 'control.client_app_version_conflict';
const LIMIT = 'control.client_app_limit';

/**
 * Every write on an entry — save, switch, delete, and the picture's upload and removal —
 * carries this mutation key, and the controls read ONE pending state from it
 * (`useClientAppWriteBusy`). Two writes in flight at once would state the same
 * `expectedVersion`, and one of them would come back a conflict; a text save that lands
 * while a picture is in flight could also close the editor before the picture's refusal
 * is shown. So while any write is in flight, none of the others can start.
 */
const CLIENT_APP_WRITE = ['client-app-write'] as const;

function useClientAppWriteBusy(): boolean {
  return useIsMutating({ mutationKey: CLIENT_APP_WRITE }) > 0;
}

export const PLATFORM_LABELS: Readonly<Record<ClientAppPlatform, WebKey>> = {
  ANDROID: 'web.client_apps_platform_android',
  IOS: 'web.client_apps_platform_ios',
  WINDOWS: 'web.client_apps_platform_windows',
  MACOS: 'web.client_apps_platform_macos',
  LINUX: 'web.client_apps_platform_linux',
  OTHER: 'web.client_apps_platform_other',
};

const DELIVERY_LABELS: Readonly<Record<ClientAppDeliveryKind, WebKey>> = {
  SUBSCRIPTION_LINK: 'web.client_apps_delivery_link',
  CONNECTION_FILES: 'web.client_apps_delivery_files',
};

const PROBLEM_LABELS: Readonly<Record<ClientAppTextProblem, WebKey>> = {
  CONTROL: 'web.client_apps_problem_control',
  MARKUP: 'web.client_apps_problem_markup',
  EXECUTABLE_SCHEME: 'web.client_apps_problem_scheme',
  UNSAFE_LINK: 'web.client_apps_problem_link',
};

interface FormState {
  platform: ClientAppPlatform;
  name: string;
  icon: string;
  description: string;
  officialUrl: string;
  alternativeUrl: string;
  helpUrl: string;
  guide: string;
  deliveryKinds: ClientAppDeliveryKind[];
  protocols: ClientAppProtocol[];
  providerTypes: ProviderType[];
  sortOrder: string;
}

const EMPTY_FORM: FormState = {
  platform: 'ANDROID',
  name: '',
  icon: '',
  description: '',
  officialUrl: '',
  alternativeUrl: '',
  helpUrl: '',
  guide: '',
  deliveryKinds: [],
  protocols: [],
  providerTypes: [],
  sortOrder: '0',
};

function formOf(row: ClientAppResponse): FormState {
  return {
    platform: row.platform,
    name: row.name,
    icon: row.icon ?? '',
    description: row.description,
    officialUrl: row.officialUrl,
    alternativeUrl: row.alternativeUrl ?? '',
    helpUrl: row.helpUrl ?? '',
    guide: row.guide,
    deliveryKinds: [...row.deliveryKinds],
    protocols: [...row.protocols],
    providerTypes: [...row.providerTypes],
    sortOrder: String(row.sortOrder),
  };
}

type Editor =
  | { readonly kind: 'closed' }
  | { readonly kind: 'create' }
  | { readonly kind: 'edit'; readonly basis: ClientAppResponse };

type Problems = Partial<Record<keyof FormState, string>>;

/** What in a line of text the server would refuse, as the operator reads it. */
function textProblem(value: string, options: { required: boolean; multiline: boolean }) {
  const trimmed = value.trim();
  if (trimmed === '') return options.required ? t('web.client_apps_required') : undefined;
  if (!options.multiline && /[\r\n]/u.test(trimmed)) return t('web.client_apps_one_line');
  const problem = clientAppTextProblem(trimmed);
  return problem === null ? undefined : t(PROBLEM_LABELS[problem]);
}

function linkProblem(value: string, required: boolean): string | undefined {
  if (value.trim() === '') return required ? t('web.client_apps_required') : undefined;
  return normalizeClientAppUrl(value) === null ? t('web.client_apps_url_invalid') : undefined;
}

/** Every field the server would refuse, keyed by field. Empty when the form can be sent. */
export function formProblems(form: FormState): Problems {
  const problems: Problems = {};
  const put = (field: keyof FormState, message: string | undefined) => {
    if (message !== undefined) problems[field] = message;
  };
  put('name', textProblem(form.name, { required: true, multiline: false }));
  put('description', textProblem(form.description, { required: true, multiline: false }));
  put('guide', textProblem(form.guide, { required: true, multiline: true }));
  const icon = form.icon.trim();
  if (icon !== '') {
    put(
      'icon',
      icon.length > CLIENT_APP_ICON_MAX_LENGTH || /\s/u.test(icon)
        ? t('web.client_apps_icon_invalid')
        : textProblem(icon, { required: false, multiline: false }),
    );
  }
  put('officialUrl', linkProblem(form.officialUrl, true));
  put('alternativeUrl', linkProblem(form.alternativeUrl, false));
  put('helpUrl', linkProblem(form.helpUrl, false));
  if (sortOrderOf(form.sortOrder) === null) put('sortOrder', t('web.client_apps_sort_invalid'));
  return problems;
}

function fieldsOf(form: FormState, sortOrder: number): ClientAppFields {
  const optional = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    platform: form.platform,
    name: form.name.trim(),
    icon: optional(form.icon),
    description: form.description.trim(),
    officialUrl: form.officialUrl.trim(),
    alternativeUrl: optional(form.alternativeUrl),
    helpUrl: optional(form.helpUrl),
    guide: form.guide.trim(),
    deliveryKinds: form.deliveryKinds,
    protocols: form.protocols,
    providerTypes: form.providerTypes,
    sortOrder,
  };
}

function faultOf(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === VERSION_CONFLICT) return t('web.client_apps_conflict');
    if (error.code === LIMIT) return t('web.client_apps_limit');
  }
  return messageFor(error);
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.code === VERSION_CONFLICT;
}

/** Names of the provider types an entry is limited to, or "any". */
function compatibilityOf(row: ClientAppResponse): string {
  const parts: string[] = [];
  if (row.deliveryKinds.length > 0) {
    parts.push(row.deliveryKinds.map((kind) => t(DELIVERY_LABELS[kind])).join(', '));
  }
  if (row.protocols.length > 0) parts.push(row.protocols.join(', '));
  if (row.providerTypes.length > 0) {
    parts.push(
      row.providerTypes
        .map((type) => PROVIDER_DESCRIPTORS.find((d) => d.key === type)?.canonicalName ?? type)
        .join(', '),
    );
  }
  return parts.length === 0 ? t('web.client_apps_compat_any') : parts.join(' · ');
}

function toggled<T>(list: readonly T[], member: T, on: boolean): T[] {
  return on
    ? [...list.filter((one) => one !== member), member]
    : list.filter((one) => one !== member);
}

// ---------------------------------------------------------------------------
// HF-A10 — an entry's optional picture
// ---------------------------------------------------------------------------

const IMAGE_MIME_LABELS: Readonly<Record<ClientAppImageMimeType, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

const IMAGE_PROBLEM_LABELS: Readonly<Record<ClientAppImageProblem, WebKey>> = {
  EMPTY: 'web.client_apps_image_empty',
  TOO_LARGE: 'web.client_apps_image_too_large',
  TYPE_MISMATCH: 'web.client_apps_image_mismatch',
  UNREADABLE: 'web.client_apps_image_unreadable',
  DIMENSIONS: 'web.client_apps_image_bad_dimensions',
};

const MEDIA_INVALID = 'commerce.media_invalid';

/** A file read into the shape the upload route takes, or the reason it was not. */
export type PickedImage =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'INVALID'; readonly reason: WebKey }
  | {
      readonly kind: 'READY';
      readonly name: string;
      readonly mimeType: ClientAppImageMimeType;
      readonly byteLength: number;
      readonly contentBase64: string;
      /** A `data:` URL of the file, for the preview before it is sent. */
      readonly dataUrl: string;
      readonly width: number;
      readonly height: number;
    };

type ReadyImage = Extract<PickedImage, { readonly kind: 'READY' }>;

function isImageMimeType(value: string): value is ClientAppImageMimeType {
  return (CLIENT_APP_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Reads the chosen file and runs `inspectClientAppImage` on its bytes — the function the
 * service runs — so a file the server would refuse is refused here, in Persian, before a
 * request is spent. The type and size are checked first, before anything is read. An SVG
 * fails the very first check: its type is not one of the two.
 */
export function readPickedImage(file: File): Promise<PickedImage> {
  if (!isImageMimeType(file.type)) {
    return Promise.resolve({ kind: 'INVALID', reason: 'web.client_apps_image_invalid_type' });
  }
  if (file.size > CLIENT_APP_IMAGE_MAX_BYTES) {
    return Promise.resolve({ kind: 'INVALID', reason: 'web.client_apps_image_too_large' });
  }
  const mimeType = file.type;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve({ kind: 'INVALID', reason: 'web.client_apps_image_unreadable' });
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma < 0) {
        resolve({ kind: 'INVALID', reason: 'web.client_apps_image_unreadable' });
        return;
      }
      const contentBase64 = dataUrl.slice(comma + 1);
      const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
      const inspected = inspectClientAppImage(mimeType, bytes);
      if (!inspected.ok) {
        resolve({ kind: 'INVALID', reason: IMAGE_PROBLEM_LABELS[inspected.problem] });
        return;
      }
      resolve({
        kind: 'READY',
        name: file.name,
        mimeType,
        byteLength: bytes.byteLength,
        contentBase64,
        dataUrl,
        width: inspected.width,
        height: inspected.height,
      });
    };
    reader.readAsDataURL(file);
  });
}

/** The server's refusal of a picture, named by its reason where it gave one. */
function imageFaultOf(error: unknown): string {
  if (error instanceof ApiError && error.code === MEDIA_INVALID) {
    const reason = error.details?.reason;
    return typeof reason === 'string' && reason in IMAGE_PROBLEM_LABELS
      ? t(IMAGE_PROBLEM_LABELS[reason as ClientAppImageProblem])
      : t('web.client_apps_image_invalid_type');
  }
  return faultOf(error);
}

/**
 * The picture of the entry being edited: what is stored (served back from the stored copy,
 * never from what was picked), a file input, and the two writes.
 *
 * Keyed by the entry's id where it is drawn, so switching to another entry starts a fresh
 * card: a file picked, or a refusal raised, for one entry never carries over to the next.
 *
 * Only for an entry that exists — the writes name its id and version. Each answers with the
 * row at its new version, handed to `onChanged` so the editor's basis follows it and the
 * text form, still open, saves against the version it now holds.
 */
function ImageCard({
  entry,
  onChanged,
}: {
  entry: ClientAppResponse | null;
  onChanged: (row: ClientAppResponse) => void;
}) {
  const notify = useToast();
  const submission = useSubmissionKey();
  const writeBusy = useClientAppWriteBusy();
  const [picked, setPicked] = useState<PickedImage>({ kind: 'NONE' });
  /*
   * The latest selection. A read that completes after a newer file was picked is
   * discarded, so the preview and the payload are always the file the input shows.
   */
  const selection = useRef(0);

  const upload = useMutation({
    mutationKey: CLIENT_APP_WRITE,
    // The file and the row travel as the VARIABLE, the banner card's reason.
    mutationFn: (input: { file: ReadyImage; row: ClientAppResponse }) =>
      uploadClientAppImage({
        id: input.row.id,
        expectedVersion: input.row.version,
        mimeType: input.file.mimeType,
        contentBase64: input.file.contentBase64,
        /*
         * The CONTENT is part of the fingerprint, not only the name and size. A key held
         * across an ambiguous failure must not be reused for a different file that happens
         * to share both, which the server would refuse as a payload mismatch. The bytes
         * themselves rather than a Web Crypto digest: `crypto.subtle` exists only in a
         * secure context, and an admin reached over plain HTTP would lose the upload.
         */
        idempotencyKey: submission.current({
          image: input.row.id,
          version: input.row.version,
          name: input.file.name,
          size: input.file.byteLength,
          content: input.file.contentBase64,
        }),
      }),
    onSuccess: (row) => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.client_apps_image_uploaded') });
      setPicked({ kind: 'NONE' });
      onChanged(row);
    },
    onError: (error) => submission.settleOn(error),
  });

  const clear = useMutation({
    mutationKey: CLIENT_APP_WRITE,
    mutationFn: (row: ClientAppResponse) =>
      clearClientAppImage({
        id: row.id,
        expectedVersion: row.version,
        idempotencyKey: submission.current({ clearImage: row.id, version: row.version }),
      }),
    onSuccess: (row) => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.client_apps_image_cleared') });
      onChanged(row);
    },
    onError: (error) => submission.settleOn(error),
  });

  if (entry === null) {
    return (
      <Card title={t('web.client_apps_image_title')} hint={t('web.client_apps_image_hint')}>
        <p className="muted">{t('web.client_apps_image_save_first')}</p>
      </Card>
    );
  }

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    selection.current += 1;
    const ticket = selection.current;
    // Nothing is uploadable while the new file is being read.
    setPicked({ kind: 'NONE' });
    const file = event.target.files?.[0];
    if (file === undefined) return;
    void readPickedImage(file).then((result) => {
      if (selection.current === ticket) setPicked(result);
    });
  };

  const busy = writeBusy;
  const failure = upload.error ?? clear.error;
  const stored = entry.image;
  const size = stored === null ? null : splitBytes(BigInt(stored.byteLength));

  return (
    <Card title={t('web.client_apps_image_title')} hint={t('web.client_apps_image_hint')}>
      {stored === null ? (
        <p className="muted">{t('web.client_apps_image_none')}</p>
      ) : (
        <>
          <img
            className="client-app-image"
            src={clientAppImageUrl(entry.id, stored.sha256)}
            alt={t('web.client_apps_image_alt')}
            data-testid="client-app-image-stored"
          />
          <dl className="kv">
            <dt>{t('web.client_apps_image_type')}</dt>
            <dd>{IMAGE_MIME_LABELS[stored.mimeType]}</dd>
            <dt>{t('web.client_apps_image_size')}</dt>
            <dd>{size === null ? null : `${size.value} ${t(size.unit)}`}</dd>
            <dt>{t('web.client_apps_image_dimensions')}</dt>
            <dd>
              <bdi>{`${formatNumber(stored.width)}×${formatNumber(stored.height)}`}</bdi>
            </dd>
          </dl>
        </>
      )}

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (picked.kind === 'READY' && !busy) upload.mutate({ file: picked, row: entry });
        }}
      >
        <Field
          label={t('web.client_apps_image_file')}
          hint={t('web.client_apps_image_file_hint')}
          htmlFor="app-image-file"
          {...(picked.kind === 'INVALID' ? { error: t(picked.reason) } : {})}
        >
          <input
            id="app-image-file"
            type="file"
            accept={CLIENT_APP_IMAGE_MIME_TYPES.join(',')}
            onChange={onPick}
            disabled={busy}
          />
        </Field>
        {picked.kind === 'READY' && (
          <img
            className="client-app-image"
            src={picked.dataUrl}
            alt={t('web.client_apps_image_picked_alt')}
            data-testid="client-app-image-picked"
          />
        )}
        <div className="form-actions">
          <button
            type="submit"
            className="btn primary sm"
            disabled={busy || picked.kind !== 'READY'}
          >
            {upload.isPending
              ? t('web.client_apps_image_uploading')
              : t('web.client_apps_image_upload')}
          </button>
          {stored !== null && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() => clear.mutate(entry)}
            >
              {t('web.client_apps_image_clear')}
            </button>
          )}
        </div>
        {failure != null && <Banner tone="danger">{imageFaultOf(failure)}</Banner>}
      </form>
    </Card>
  );
}

export function ClientAppsPage({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();

  const apps = useQuery({
    queryKey: ['client-apps'],
    queryFn: () => fetchClientApps(),
    enabled: !denied,
  });
  const rows = apps.data?.items ?? [];

  const [editor, setEditor] = useState<Editor>({ kind: 'closed' });
  /** The entry the operator asked to delete, awaiting the dialog's answer. */
  const [deleting, setDeleting] = useState<ClientAppResponse | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [touched, setTouched] = useState(false);

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['client-apps'] });
  };
  /*
   * Every change of editor clears the last save's outcome (Codex review #1 of PR #95,
   * C3). `save.error` belongs to the entry it was raised for; carried over, a version
   * conflict on one app drew the conflict notice and its reload control over another.
   */
  const switchEditor = (next: Editor, draft: FormState) => {
    save.reset();
    setEditor(next);
    setForm(draft);
    setTouched(false);
  };
  const close = () => switchEditor({ kind: 'closed' }, EMPTY_FORM);
  const openCreate = () => switchEditor({ kind: 'create' }, EMPTY_FORM);
  const openEdit = (row: ClientAppResponse) =>
    switchEditor({ kind: 'edit', basis: row }, formOf(row));

  /** The WHOLE command is the variable, so a retry resends exactly what was clicked. */
  const save = useMutation({
    mutationKey: CLIENT_APP_WRITE,
    mutationFn: (command: {
      idempotencyKey: string;
      fields: ClientAppFields;
      basis: ClientAppResponse | null;
    }) =>
      command.basis === null
        ? createClientApp({ ...command.fields, idempotencyKey: command.idempotencyKey })
        : updateClientApp({
            ...command.fields,
            id: command.basis.id,
            idempotencyKey: command.idempotencyKey,
            expectedVersion: command.basis.version,
          }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.client_apps_saved') });
      close();
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const toggle = useMutation({
    mutationKey: CLIENT_APP_WRITE,
    mutationFn: (input: { id: string; status: ClientAppStatus; expectedVersion: number }) =>
      setClientAppStatus({ ...input, idempotencyKey: submission.current({ toggle: input }) }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.client_apps_status_done') });
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  const remove = useMutation({
    mutationKey: CLIENT_APP_WRITE,
    mutationFn: (input: { id: string; expectedVersion: number }) =>
      deleteClientApp({ ...input, idempotencyKey: submission.current({ remove: input }) }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.client_apps_deleted') });
      refresh();
    },
    onError: (error) => {
      submission.settleOn(error);
      refresh();
    },
  });

  // Every write on an entry, the picture's included: one pending state for all of them.
  const busy = useClientAppWriteBusy();
  const problems = formProblems(form);
  const formInvalid = Object.keys(problems).length > 0;
  const shown = (field: keyof FormState) => (touched ? problems[field] : undefined);

  const current =
    editor.kind === 'edit' ? rows.find((row) => row.id === editor.basis.id) : undefined;
  /*
   * Dirty-state protection: an open editor whose fields differ from what it was
   * opened with. Leaving the page asks first; closing the editor is the operator's
   * own Cancel and needs no second question.
   */
  const editorDirty =
    editor.kind !== 'closed' &&
    JSON.stringify(form) !==
      JSON.stringify(editor.kind === 'edit' ? formOf(editor.basis) : EMPTY_FORM);
  useUnsavedChanges(mayEdit && editorDirty);
  const changedElsewhere =
    editor.kind === 'edit' &&
    !save.isPending &&
    ((current !== undefined && current.version !== editor.basis.version) ||
      isVersionConflict(save.error));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    const sortOrder = sortOrderOf(form.sortOrder);
    if (formInvalid || sortOrder === null) return;
    const command = {
      fields: fieldsOf(form, sortOrder),
      basis: editor.kind === 'edit' ? editor.basis : null,
    };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const newButton = (
    <button type="button" className="btn primary sm" disabled={busy} onClick={openCreate}>
      <Icon name="plus" />
      {t('web.client_apps_new')}
    </button>
  );

  const columns: readonly Column<ClientAppResponse>[] = [
    {
      key: 'platform',
      header: t('web.client_apps_platform'),
      render: (row) => t(PLATFORM_LABELS[row.platform]),
    },
    {
      key: 'name',
      header: t('web.client_apps_name'),
      render: (row) => (
        <span className="strong">{row.icon === null ? row.name : `${row.icon} ${row.name}`}</span>
      ),
    },
    { key: 'order', header: t('web.client_apps_order'), render: (row) => String(row.sortOrder) },
    {
      key: 'compat',
      header: t('web.client_apps_compat'),
      render: (row) => compatibilityOf(row),
    },
    {
      key: 'status',
      header: t('web.client_apps_status'),
      render: (row) => (
        <Badge tone={row.status === 'ENABLED' ? 'ok' : 'neutral'} dot>
          {t(row.status === 'ENABLED' ? 'web.client_apps_enabled' : 'web.client_apps_disabled')}
        </Badge>
      ),
    },
    {
      key: 'updated',
      header: t('web.client_apps_updated'),
      render: (row) => formatTimestamp(row.updatedAt),
    },
    {
      key: 'actions',
      header: t('web.client_apps_actions'),
      align: 'end',
      render: (row) =>
        !mayEdit ? null : (
          <RowActions>
            <button type="button" className="btn sm" disabled={busy} onClick={() => openEdit(row)}>
              {t('web.client_apps_edit')}
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={() =>
                toggle.mutate({
                  id: row.id,
                  status: row.status === 'ENABLED' ? 'DISABLED' : 'ENABLED',
                  expectedVersion: row.version,
                })
              }
            >
              {t(row.status === 'ENABLED' ? 'web.client_apps_disable' : 'web.client_apps_enable')}
            </button>
            <button
              type="button"
              className="btn ghost danger sm"
              disabled={busy}
              // Asked through the kit's dialog, which names its buttons; the answer
              // deletes the version the operator was looking at when they pressed.
              onClick={() => setDeleting(row)}
            >
              {t('web.client_apps_delete')}
            </button>
          </RowActions>
        ),
    },
  ];

  const sortOrder = sortOrderOf(form.sortOrder);
  const preview = renderTemplateBody(
    templateDefinition(
      form.deliveryKinds.includes('CONNECTION_FILES') ? 'bot.apps.detail_files' : 'bot.apps.detail',
    ),
    CATALOGUE_FA[
      form.deliveryKinds.includes('CONNECTION_FILES') ? 'bot.apps.detail_files' : 'bot.apps.detail'
    ],
    // Neutralised exactly as the bot's read neutralises them (C6), so an entry loaded from a
    // row written around the service previews as the customer would receive it.
    {
      app: neutralizeClientAppBareLinks(
        form.icon.trim() === '' ? form.name.trim() : `${form.icon.trim()} ${form.name.trim()}`,
      ),
      description: neutralizeClientAppBareLinks(form.description.trim()),
      guide: renderClientAppGuide(form.guide),
    },
  );

  return (
    <>
      <PageHead
        title={t('web.client_apps_title')}
        subtitle={t('web.client_apps_subtitle')}
        maturity="now"
      />

      <StateSwitch
        query={apps}
        denied={denied}
        isEmpty={queryState(apps) === 'ready' && rows.length === 0}
        empty={
          <Empty
            title={t('web.client_apps_empty')}
            hint={t('web.client_apps_empty_hint')}
            action={mayEdit && editor.kind === 'closed' ? newButton : undefined}
          />
        }
      >
        <Card
          title={t('web.client_apps_title')}
          hint={t('web.client_apps_hint')}
          actions={mayEdit && editor.kind === 'closed' ? newButton : undefined}
        >
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={t('web.client_apps_title')}
            dense
          />
        </Card>
      </StateSwitch>

      {mayEdit && editor.kind !== 'closed' && (
        <div className="two-col">
          <Card
            title={t(
              editor.kind === 'create' ? 'web.client_apps_creating' : 'web.client_apps_editing',
            )}
            hint={t('web.client_apps_form_hint')}
            tight
          >
            <form onSubmit={submit} noValidate>
              <div className="form-section">
                <h3>{t('web.client_apps_section_identity')}</h3>
                <div className="form-grid">
                  <Field label={t('web.client_apps_platform')} htmlFor="app-platform">
                    <select
                      id="app-platform"
                      className="input"
                      value={form.platform}
                      onChange={(event) =>
                        setForm({ ...form, platform: event.target.value as ClientAppPlatform })
                      }
                    >
                      {CLIENT_APP_PLATFORMS.map((platform) => (
                        <option key={platform} value={platform}>
                          {t(PLATFORM_LABELS[platform])}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={t('web.client_apps_name')}
                    htmlFor="app-name"
                    {...(shown('name') === undefined ? {} : { error: shown('name') as string })}
                  >
                    <input
                      id="app-name"
                      className="input"
                      value={form.name}
                      maxLength={CLIENT_APP_NAME_MAX_LENGTH}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('web.client_apps_icon')}
                    htmlFor="app-icon"
                    hint={t('web.client_apps_icon_hint')}
                    {...(shown('icon') === undefined ? {} : { error: shown('icon') as string })}
                  >
                    <input
                      id="app-icon"
                      className="input"
                      value={form.icon}
                      maxLength={CLIENT_APP_ICON_MAX_LENGTH}
                      onChange={(event) => setForm({ ...form, icon: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('web.client_apps_description')}
                    htmlFor="app-description"
                    {...(shown('description') === undefined
                      ? {}
                      : { error: shown('description') as string })}
                  >
                    <input
                      id="app-description"
                      className="input"
                      value={form.description}
                      maxLength={CLIENT_APP_DESCRIPTION_MAX_LENGTH}
                      onChange={(event) => setForm({ ...form, description: event.target.value })}
                    />
                  </Field>
                </div>
              </div>
              <div className="form-section">
                <h3>{t('web.client_apps_section_links')}</h3>
                <div className="form-grid">
                  <div className="full">
                    <Field
                      label={t('web.client_apps_official_url')}
                      htmlFor="app-official"
                      hint={t('web.client_apps_url_hint')}
                      {...(shown('officialUrl') === undefined
                        ? {}
                        : { error: shown('officialUrl') as string })}
                    >
                      <input
                        id="app-official"
                        className="input ltr"
                        dir="ltr"
                        inputMode="url"
                        value={form.officialUrl}
                        maxLength={CLIENT_APP_URL_MAX_LENGTH}
                        onChange={(event) => setForm({ ...form, officialUrl: event.target.value })}
                      />
                    </Field>
                  </div>
                  <Field
                    label={t('web.client_apps_alternative_url')}
                    htmlFor="app-alternative"
                    hint={t('web.client_apps_optional')}
                    {...(shown('alternativeUrl') === undefined
                      ? {}
                      : { error: shown('alternativeUrl') as string })}
                  >
                    <input
                      id="app-alternative"
                      className="input ltr"
                      dir="ltr"
                      inputMode="url"
                      value={form.alternativeUrl}
                      maxLength={CLIENT_APP_URL_MAX_LENGTH}
                      onChange={(event) => setForm({ ...form, alternativeUrl: event.target.value })}
                    />
                  </Field>
                  <Field
                    label={t('web.client_apps_help_url')}
                    htmlFor="app-help"
                    hint={t('web.client_apps_optional')}
                    {...(shown('helpUrl') === undefined
                      ? {}
                      : { error: shown('helpUrl') as string })}
                  >
                    <input
                      id="app-help"
                      className="input ltr"
                      dir="ltr"
                      inputMode="url"
                      value={form.helpUrl}
                      maxLength={CLIENT_APP_URL_MAX_LENGTH}
                      onChange={(event) => setForm({ ...form, helpUrl: event.target.value })}
                    />
                  </Field>
                </div>
              </div>
              <div className="form-section">
                <Field
                  label={t('web.client_apps_guide')}
                  htmlFor="app-guide"
                  hint={t('web.client_apps_guide_hint')}
                  {...(shown('guide') === undefined ? {} : { error: shown('guide') as string })}
                >
                  <textarea
                    id="app-guide"
                    className="input"
                    rows={8}
                    value={form.guide}
                    maxLength={CLIENT_APP_GUIDE_MAX_LENGTH}
                    onChange={(event) => setForm({ ...form, guide: event.target.value })}
                  />
                </Field>
              </div>
              <div className="form-section">
                <h3>{t('web.client_apps_section_compat')}</h3>
                <div className="client-apps-sets">
                  <fieldset className="field client-apps-set">
                    <legend>{t('web.client_apps_delivery')}</legend>
                    <span className="muted small">{t('web.client_apps_compat_hint')}</span>
                    {CLIENT_APP_DELIVERY_KINDS.map((kind) => (
                      <label key={kind} className="nowrap">
                        <input
                          type="checkbox"
                          checked={form.deliveryKinds.includes(kind)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              deliveryKinds: toggled(
                                form.deliveryKinds,
                                kind,
                                event.target.checked,
                              ),
                            })
                          }
                        />{' '}
                        {t(DELIVERY_LABELS[kind])}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="field client-apps-set">
                    <legend>{t('web.client_apps_protocols')}</legend>
                    {CLIENT_APP_PROTOCOLS.map((protocol) => (
                      <label key={protocol} className="nowrap" dir="ltr">
                        <input
                          type="checkbox"
                          checked={form.protocols.includes(protocol)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              protocols: toggled(form.protocols, protocol, event.target.checked),
                            })
                          }
                        />{' '}
                        {protocol}
                      </label>
                    ))}
                  </fieldset>
                  <fieldset className="field client-apps-set">
                    <legend>{t('web.client_apps_providers')}</legend>
                    {PROVIDER_DESCRIPTORS.map((descriptor) => (
                      <label key={descriptor.key} className="nowrap" dir="ltr">
                        <input
                          type="checkbox"
                          checked={form.providerTypes.includes(descriptor.key)}
                          onChange={(event) =>
                            setForm({
                              ...form,
                              providerTypes: toggled(
                                form.providerTypes,
                                descriptor.key,
                                event.target.checked,
                              ),
                            })
                          }
                        />{' '}
                        {descriptor.canonicalName}
                      </label>
                    ))}
                  </fieldset>
                </div>
              </div>
              <Disclosure
                className="form-section"
                summary={t('web.payment_gateway_section_advanced')}
              >
                <Field
                  label={t('web.client_apps_order')}
                  htmlFor="app-sort"
                  hint={t('web.client_apps_sort_hint')}
                  {...(shown('sortOrder') === undefined
                    ? {}
                    : { error: shown('sortOrder') as string })}
                >
                  <input
                    id="app-sort"
                    className="input ltr"
                    value={form.sortOrder}
                    inputMode="numeric"
                    onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
                  />
                </Field>
              </Disclosure>
              <div className="form-section client-apps-form-foot">
                {changedElsewhere && (
                  <Banner tone="warn">
                    {t('web.changed_elsewhere')}{' '}
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => {
                        save.reset();
                        if (current !== undefined) openEdit(current);
                      }}
                    >
                      {t('web.reload_value')}
                    </button>
                  </Banner>
                )}

                <div className="form-actions">
                  <button
                    type="submit"
                    className="btn primary"
                    disabled={busy || (touched && (formInvalid || sortOrder === null))}
                  >
                    {t('web.client_apps_save')}
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={close}>
                    {t('web.client_apps_cancel')}
                  </button>
                </div>

                {save.error != null && <Banner tone="danger">{faultOf(save.error)}</Banner>}
              </div>
            </form>
          </Card>
          <div className="stack">
            <Card title={t('web.client_apps_preview')} hint={t('web.client_apps_preview_hint')}>
              <TelegramPhone title={t('web.client_apps_preview_chat')}>
                {/* HF-A10: the picture goes out first, as its own message, when there is one. */}
                {editor.kind === 'edit' && editor.basis.image !== null && (
                  <img
                    className="client-app-image tg-phone-photo"
                    src={clientAppImageUrl(editor.basis.id, editor.basis.image.sha256)}
                    alt={t('web.client_apps_image_alt')}
                  />
                )}
                <div className="bot-preview" data-testid="client-app-preview" dir="auto">
                  {preview}
                </div>
                {/* The message's buttons, as the bot attaches them: captions only. */}
                <div className="tg-phone-inline">
                  <span className="tg-phone-key">{CATALOGUE_FA['bot.apps.download_button']}</span>
                  {form.alternativeUrl.trim() !== '' && (
                    <span className="tg-phone-key">
                      {CATALOGUE_FA['bot.apps.alternative_button']}
                    </span>
                  )}
                  {form.helpUrl.trim() !== '' && (
                    <span className="tg-phone-key">{CATALOGUE_FA['bot.apps.help_button']}</span>
                  )}
                </div>
              </TelegramPhone>
            </Card>
            <ImageCard
              key={editor.kind === 'edit' ? editor.basis.id : 'new'}
              entry={editor.kind === 'edit' ? editor.basis : null}
              onChanged={(row) => {
                /*
                 * The picture's writes bump the entry's version. The list is patched with the
                 * returned row BEFORE the editor's basis moves to it, so the two never
                 * disagree and «changed elsewhere» is not raised for the operator's own write.
                 */
                queries.setQueryData<{ items: ClientAppResponse[] }>(['client-apps'], (old) =>
                  old === undefined
                    ? old
                    : { ...old, items: old.items.map((one) => (one.id === row.id ? row : one)) },
                );
                setEditor({ kind: 'edit', basis: row });
                refresh();
              }}
            />
          </div>
        </div>
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={t('web.client_apps_delete_title')}
          question={t('web.client_apps_delete_confirm')}
          detail={deleting.name}
          confirmLabel={t('web.client_apps_delete_yes')}
          cancelLabel={t('web.client_apps_cancel')}
          onConfirm={() => {
            const row = deleting;
            setDeleting(null);
            remove.mutate({ id: row.id, expectedVersion: row.version });
          }}
          onCancel={() => setDeleting(null)}
        />
      )}

      {toggle.error != null && <Banner tone="danger">{faultOf(toggle.error)}</Banner>}
      {remove.error != null && <Banner tone="danger">{faultOf(remove.error)}</Banner>}
    </>
  );
}
