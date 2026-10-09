import { useMemo, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  QR_BACKGROUND_MAX_SIDE,
  QR_BACKGROUND_MIN_SIDE,
  QR_TEMPLATE_MODULE_MIN_PX,
  QR_TEMPLATE_QUIET_ZONE_DEFAULT,
  QR_TEMPLATE_QUIET_ZONE_MAX,
  QR_TEMPLATE_QUIET_ZONE_MIN,
  QR_TEMPLATE_REGION_MIN,
  TENANT_MEDIA_MAX_BYTES,
  QR_TEMPLATE_PREVIEW_MODULES,
  inspectQrBackgroundPng,
  qrEffectiveModulePx,
  qrModuleScale,
  qrTemplatePlacementProblem,
  qrTemplateSchema,
  qrTemplateSettingSchema,
  type QrBackgroundProblem,
  type QrTemplate,
  type QrTemplateFallbackReason,
} from '@nexa/contracts';
import {
  ApiError,
  clearTenantMedia,
  fetchSettings,
  fetchTenantMedia,
  previewDeliveryQr,
  saveSetting,
  uploadTenantMedia,
} from '../api/client';
import { formatTimestamp, splitBytes } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { messageFor } from './settings';
import { Badge, Banner, Button, Card, Field, useToast, useUnsavedChanges } from '../ui/kit';

/**
 * Phase 2 item 4: «پس‌زمینهٔ QR» — the subscription QR drawn on the tenant's own image.
 *
 * Two stored things, each written through the route that already owns its kind: the
 * background is the `QR_BACKGROUND` media slot (upload / remove, `settings.edit`, audited),
 * and the placement is the `delivery.qr_template` setting (versioned, audited). The default
 * — no template — is the plain QR, exactly as before; «بازگشت به پیش‌فرض» clears both.
 *
 * Validation before save is the contract's own: the browser reads the picked file's header
 * with `inspectQrBackgroundPng` and the draft region with `qrTemplateSchema` and
 * `qrTemplatePlacementProblem`, so the form refuses what the server would. The preview is
 * the SERVER's rendering of the draft — the delivered image itself, not a drawing of it.
 */

export const QR_TEMPLATE_SETTING = 'delivery.qr_template';
const SLOT = 'QR_BACKGROUND' as const;
const MEDIA_KEY = ['tenant-media', SLOT] as const;

const PROBLEM_LABEL: Readonly<Record<QrBackgroundProblem, WebKey>> = {
  EMPTY: 'web.qrt_problem_empty',
  TOO_LARGE: 'web.qrt_problem_too_large',
  NOT_PNG: 'web.qrt_problem_not_png',
  UNREADABLE: 'web.qrt_problem_unreadable',
  DIMENSIONS: 'web.qrt_problem_dimensions',
  UNSUPPORTED_FORMAT: 'web.qrt_problem_format',
  DECOMPRESSION_BOUND: 'web.qrt_problem_bomb',
  CORRUPT: 'web.qrt_problem_corrupt',
};

const FALLBACK_LABEL: Readonly<Record<QrTemplateFallbackReason, WebKey>> = {
  NO_TEMPLATE: 'web.qrt_fallback_no_template',
  NO_BACKGROUND: 'web.qrt_fallback_no_background',
  BACKGROUND_UNREADABLE: 'web.qrt_fallback_unreadable',
  OUTSIDE_BACKGROUND: 'web.qrt_fallback_outside',
  MODULE_TOO_SMALL: 'web.qrt_fallback_too_small',
  OUTPUT_TOO_LARGE: 'web.qrt_fallback_too_large',
  CONFIG_UNREADABLE: 'web.qrt_fallback_config_unreadable',
};

/** A server refusal of a background, in the operator's words when the reason is known. */
function uploadMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'commerce.media_invalid') {
    const reason = error.details?.['reason'];
    if (reason === 'TYPE_NOT_ALLOWED') return t('web.qrt_problem_not_png');
    if (typeof reason === 'string' && reason in PROBLEM_LABEL) {
      return t(PROBLEM_LABEL[reason as QrBackgroundProblem]);
    }
  }
  return messageFor(error);
}

type Picked =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'INVALID'; readonly message: string }
  | {
      readonly kind: 'READY';
      readonly name: string;
      readonly byteLength: number;
      readonly contentBase64: string;
      readonly width: number;
      readonly height: number;
    };

type Ready = Extract<Picked, { readonly kind: 'READY' }>;

/** Reads the file and checks its header in the browser, before a byte is uploaded. */
function readPicked(file: File): Promise<Picked> {
  if (file.size > TENANT_MEDIA_MAX_BYTES) {
    return Promise.resolve({ kind: 'INVALID', message: t('web.qrt_problem_too_large') });
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve({ kind: 'INVALID', message: t('web.qrt_problem_unreadable') });
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      const comma = url.indexOf(',');
      if (comma < 0) {
        resolve({ kind: 'INVALID', message: t('web.qrt_problem_unreadable') });
        return;
      }
      const contentBase64 = url.slice(comma + 1);
      const binary = atob(contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const header = inspectQrBackgroundPng(bytes);
      if (!header.ok) {
        resolve({ kind: 'INVALID', message: t(PROBLEM_LABEL[header.problem]) });
        return;
      }
      resolve({
        kind: 'READY',
        name: file.name,
        byteLength: file.size,
        contentBase64,
        width: header.width,
        height: header.height,
      });
    };
    reader.readAsDataURL(file);
  });
}

interface Draft {
  readonly x: string;
  readonly y: string;
  readonly size: string;
  readonly quiet: string;
}

const toDraft = (template: QrTemplate): Draft => ({
  x: String(template.x),
  y: String(template.y),
  size: String(template.size),
  quiet: String(template.quietZoneModules),
});

/** A whole number as typed, Persian digits included; NaN when it is not one. */
function whole(text: string): number {
  const latin = text
    .trim()
    .replace(/[\u06F0-\u06F9]/gu, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  return /^\d{1,5}$/u.test(latin) ? Number(latin) : Number.NaN;
}

function parseDraft(draft: Draft): QrTemplate | null {
  const parsed = qrTemplateSchema.safeParse({
    x: whole(draft.x),
    y: whole(draft.y),
    size: whole(draft.size),
    quietZoneModules: whole(draft.quiet),
  });
  return parsed.success ? parsed.data : null;
}

/** A region centred on a background, as large as fits up to 60% of its shorter side. */
function centred(background: { width: number; height: number }): QrTemplate {
  const size = Math.max(
    QR_TEMPLATE_REGION_MIN,
    Math.floor(Math.min(background.width, background.height) * 0.6),
  );
  return {
    x: Math.max(0, Math.floor((background.width - size) / 2)),
    y: Math.max(0, Math.floor((background.height - size) / 2)),
    size,
    // The recommended 4, not the minimum: 0 is allowed, never a default (FIX-06).
    quietZoneModules: QR_TEMPLATE_QUIET_ZONE_DEFAULT,
  };
}

export function QrTemplateSection({ mayEdit }: { mayEdit: boolean }) {
  const client = useQueryClient();
  const notify = useToast();
  const uploadKey = useSubmissionKey();
  const saveKey = useSubmissionKey();
  const revertSettingKey = useSubmissionKey();
  const revertMediaKey = useSubmissionKey();

  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const media = useQuery({ queryKey: MEDIA_KEY, queryFn: () => fetchTenantMedia(SLOT) });
  const setting = settings.data?.settings.find((one) => one.key === QR_TEMPLATE_SETTING);
  const stored = useMemo<QrTemplate | null>(() => {
    const parsed = qrTemplateSettingSchema.safeParse(setting?.value ?? null);
    return parsed.success ? parsed.data : null;
  }, [setting?.value]);
  const current = media.data?.media ?? null;

  const [picked, setPicked] = useState<Picked>({ kind: 'NONE' });
  const [draft, setDraft] = useState<{
    readonly fields: Draft;
    readonly basis: number | null;
  } | null>(null);
  const fields: Draft =
    draft?.fields ??
    toDraft(stored ?? { x: 0, y: 0, size: 400, quietZoneModules: QR_TEMPLATE_QUIET_ZONE_DEFAULT });
  const parsedDraft = parseDraft(fields);

  /*
   * The preview is of what was last ASKED for: the stored template on arrival, then the
   * draft each time «پیش‌نمایش» is pressed — never a request per keystroke.
   */
  const [asked, setAsked] = useState<{ readonly template: QrTemplate | null } | null>(null);
  const previewOf = asked === null ? stored : asked.template;
  const preview = useQuery({
    queryKey: ['delivery-qr-preview', previewOf, current?.version ?? 0],
    queryFn: () => previewDeliveryQr(previewOf),
    enabled: settings.data !== undefined && media.data !== undefined,
  });
  const background = preview.data?.background ?? null;

  const placement =
    parsedDraft === null || background === null
      ? null
      : qrTemplatePlacementProblem(parsedDraft, background);
  /*
   * The module a link of typical length gets in this region, as the customer receives it
   * (Telegram shows a photo at most 1280 px on its longest side) — the server's own rule.
   */
  const tooSmall =
    parsedDraft !== null &&
    background !== null &&
    qrEffectiveModulePx(
      qrModuleScale(parsedDraft.size, QR_TEMPLATE_PREVIEW_MODULES, parsedDraft.quietZoneModules),
      background,
    ) < QR_TEMPLATE_MODULE_MIN_PX;
  const fieldError: string | undefined =
    parsedDraft === null
      ? t('web.qrt_invalid_fields')
      : background === null
        ? t('web.qrt_needs_background')
        : placement !== null
          ? t('web.qrt_outside')
          : tooSmall
            ? t('web.qrt_too_small')
            : undefined;

  /*
   * FIX-06: under the recommended quiet zone — 0 included — a scanner may find the code less
   * reliably. Said, never refused: the value is the operator's to choose. Compared as a
   * number, so 0 warns rather than reading as "nothing typed".
   */
  const quietLow =
    parsedDraft !== null && parsedDraft.quietZoneModules < QR_TEMPLATE_QUIET_ZONE_DEFAULT;

  const unsaved = draft !== null && JSON.stringify(parsedDraft) !== JSON.stringify(stored);
  useUnsavedChanges(mayEdit && unsaved);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['settings'] });
    await client.invalidateQueries({ queryKey: MEDIA_KEY });
    await client.invalidateQueries({ queryKey: ['delivery-qr-preview'] });
  };

  const upload = useMutation({
    mutationFn: (file: Ready) =>
      uploadTenantMedia({
        purpose: SLOT,
        mimeType: 'image/png',
        contentBase64: file.contentBase64,
        idempotencyKey: uploadKey.current({ name: file.name, size: file.byteLength }),
      }),
    onSuccess: async () => {
      uploadKey.settle();
      setPicked({ kind: 'NONE' });
      notify({ tone: 'ok', message: t('web.qrt_uploaded') });
      await refresh();
    },
    onError: (error) => uploadKey.settleOn(error),
  });

  const save = useMutation({
    mutationFn: (command: { value: QrTemplate; expectedVersion: number | null }) =>
      saveSetting({
        key: QR_TEMPLATE_SETTING,
        ...command,
        idempotencyKey: saveKey.current(command),
      }),
    onSuccess: async (result) => {
      saveKey.settle();
      setDraft(null);
      setAsked(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.qrt_saved' : 'web.qrt_unchanged'),
      });
      await refresh();
    },
    onError: (error) => saveKey.settleOn(error),
  });

  /** Back to the plain QR: the template cleared, then the background removed. */
  const revert = useMutation({
    mutationFn: async () => {
      if (setting !== undefined && setting.source === 'TENANT' && stored !== null) {
        await saveSetting({
          key: QR_TEMPLATE_SETTING,
          value: null,
          expectedVersion: setting.version,
          idempotencyKey: revertSettingKey.current({ template: null, v: setting.version }),
        });
      }
      if (current !== null) {
        await clearTenantMedia({
          purpose: SLOT,
          idempotencyKey: revertMediaKey.current({ clear: current.version }),
        });
      }
    },
    onSuccess: async () => {
      revertSettingKey.settle();
      revertMediaKey.settle();
      setDraft(null);
      setAsked(null);
      notify({ tone: 'ok', message: t('web.qrt_reverted') });
      await refresh();
    },
    onError: async (error) => {
      revertSettingKey.settleOn(error);
      revertMediaKey.settleOn(error);
      await refresh();
    },
  });

  const edit = (patch: Partial<Draft>) =>
    setDraft((before) => ({
      fields: { ...(before?.fields ?? fields), ...patch },
      basis: before === null ? (setting?.version ?? null) : before.basis,
    }));

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) {
      setPicked({ kind: 'NONE' });
      return;
    }
    void readPicked(file).then(setPicked);
  };

  const busy = upload.isPending || save.isPending || revert.isPending;
  const active = stored !== null && current !== null;
  const size = current === null ? null : splitBytes(BigInt(current.byteLength));
  const failure = save.error ?? revert.error;

  return (
    <Card
      title={t('web.qrt_title')}
      hint={t('web.qrt_hint')}
      actions={
        <Badge tone={active ? 'ok' : 'neutral'} dot>
          {t(active ? 'web.qrt_status_active' : 'web.qrt_status_default')}
        </Badge>
      }
    >
      <div className="grid-2">
        <section aria-labelledby="qrt-bg-title">
          <h3 id="qrt-bg-title" className="card-subtitle">
            {t('web.qrt_background_title')}
          </h3>
          {current === null ? (
            <p className="muted">{t('web.qrt_no_background')}</p>
          ) : (
            <dl className="kv" data-testid="qrt-background">
              <dt>{t('web.qrt_dimensions')}</dt>
              <dd>
                {background === null
                  ? '—'
                  : `${String(background.width)} × ${String(background.height)}`}
              </dd>
              <dt>{t('web.referral_banner_size')}</dt>
              <dd>
                {size?.value} {size === null ? '' : t(size.unit)}
              </dd>
              <dt>{t('web.referral_banner_version')}</dt>
              <dd>{current.version}</dd>
              <dt>{t('web.referral_banner_updated_at')}</dt>
              <dd className="nowrap">{formatTimestamp(current.updatedAt)}</dd>
            </dl>
          )}
          {mayEdit && (
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                if (picked.kind === 'READY' && !busy) upload.mutate(picked);
              }}
            >
              <Field
                label={t('web.qrt_file')}
                hint={t('web.qrt_file_hint')
                  .replace('{min}', String(QR_BACKGROUND_MIN_SIDE))
                  .replace('{max}', String(QR_BACKGROUND_MAX_SIDE))}
                htmlFor="qrt-file"
                {...(picked.kind === 'INVALID' ? { error: picked.message } : {})}
              >
                <input
                  id="qrt-file"
                  type="file"
                  accept="image/png"
                  onChange={onPick}
                  disabled={busy}
                />
              </Field>
              {picked.kind === 'READY' && (
                <p className="muted small" data-testid="qrt-picked">
                  {`${String(picked.width)} × ${String(picked.height)}`}
                </p>
              )}
              <div className="form-actions">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon="upload"
                  disabled={busy || picked.kind !== 'READY'}
                >
                  {current === null ? t('web.qrt_upload') : t('web.qrt_replace')}
                </Button>
              </div>
              {upload.error != null && <Banner tone="danger">{uploadMessage(upload.error)}</Banner>}
            </form>
          )}
        </section>

        <section aria-labelledby="qrt-place-title">
          <h3 id="qrt-place-title" className="card-subtitle">
            {t('web.qrt_placement_title')}
          </h3>
          <p className="muted small">{t('web.qrt_placement_hint')}</p>
          <div className="grid-2">
            <Field label={t('web.qrt_x')} htmlFor="qrt-x">
              <input
                id="qrt-x"
                inputMode="numeric"
                dir="ltr"
                disabled={!mayEdit || busy}
                value={fields.x}
                onChange={(event) => edit({ x: event.target.value })}
              />
            </Field>
            <Field label={t('web.qrt_y')} htmlFor="qrt-y">
              <input
                id="qrt-y"
                inputMode="numeric"
                dir="ltr"
                disabled={!mayEdit || busy}
                value={fields.y}
                onChange={(event) => edit({ y: event.target.value })}
              />
            </Field>
            <Field
              label={t('web.qrt_size')}
              hint={t('web.qrt_size_hint').replace('{min}', String(QR_TEMPLATE_REGION_MIN))}
              htmlFor="qrt-size"
            >
              <input
                id="qrt-size"
                inputMode="numeric"
                dir="ltr"
                disabled={!mayEdit || busy}
                value={fields.size}
                onChange={(event) => edit({ size: event.target.value })}
              />
            </Field>
            <Field
              label={t('web.qrt_quiet')}
              hint={t('web.qrt_quiet_hint')
                .replace('{min}', String(QR_TEMPLATE_QUIET_ZONE_MIN))
                .replace('{max}', String(QR_TEMPLATE_QUIET_ZONE_MAX))
                .replace('{recommended}', String(QR_TEMPLATE_QUIET_ZONE_DEFAULT))}
              htmlFor="qrt-quiet"
            >
              <input
                id="qrt-quiet"
                inputMode="numeric"
                dir="ltr"
                disabled={!mayEdit || busy}
                value={fields.quiet}
                onChange={(event) => edit({ quiet: event.target.value })}
              />
            </Field>
          </div>
          {quietLow && (
            <p className="muted small" data-testid="qrt-quiet-warning">
              {t('web.qrt_quiet_low').replace(
                '{recommended}',
                String(QR_TEMPLATE_QUIET_ZONE_DEFAULT),
              )}
            </p>
          )}
          {fieldError !== undefined && (
            <p className="danger small" role="alert" data-testid="qrt-field-error">
              {fieldError}
            </p>
          )}
          <div className="form-actions">
            {mayEdit && (
              <Button
                variant="primary"
                size="sm"
                disabled={busy || fieldError !== undefined || parsedDraft === null || !unsaved}
                onClick={() => {
                  if (parsedDraft !== null) {
                    save.mutate({ value: parsedDraft, expectedVersion: draft?.basis ?? null });
                  }
                }}
              >
                {t('web.qrt_save')}
              </Button>
            )}
            <Button
              size="sm"
              disabled={busy || parsedDraft === null}
              onClick={() => setAsked({ template: parsedDraft })}
            >
              {t('web.qrt_preview_draft')}
            </Button>
            {mayEdit && background !== null && (
              <Button size="sm" disabled={busy} onClick={() => edit(toDraft(centred(background)))}>
                {t('web.qrt_centre')}
              </Button>
            )}
            {mayEdit && (stored !== null || current !== null) && (
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                disabled={busy}
                onClick={() => revert.mutate()}
              >
                {t('web.qrt_revert')}
              </Button>
            )}
          </div>
          {failure != null && <Banner tone="danger">{messageFor(failure)}</Banner>}
          {!mayEdit && <p className="muted">{t('web.qrt_read_only')}</p>}
        </section>
      </div>

      <section aria-labelledby="qrt-preview-title">
        <h3 id="qrt-preview-title" className="card-subtitle">
          {t('web.qrt_preview_title')}
        </h3>
        {preview.data !== undefined ? (
          <figure className="qrt-preview">
            <img
              data-testid="qrt-preview"
              src={`data:image/png;base64,${preview.data.pngBase64}`}
              alt={t('web.qrt_preview_alt')}
            />
            <figcaption className="muted small">
              {preview.data.templated
                ? t('web.qrt_preview_templated').replace(
                    '{scale}',
                    String(preview.data.moduleScale),
                  )
                : t(FALLBACK_LABEL[preview.data.fallback ?? 'NO_TEMPLATE'])}
              {preview.data.templated &&
                preview.data.moduleScale < QR_TEMPLATE_MODULE_MIN_PX + 2 && (
                  <> {t('web.qrt_preview_tight')}</>
                )}
            </figcaption>
          </figure>
        ) : preview.isError ? (
          <Banner tone="danger">{messageFor(preview.error)}</Banner>
        ) : (
          <p className="muted">{t('web.qrt_preview_loading')}</p>
        )}
      </section>
    </Card>
  );
}
