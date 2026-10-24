import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  INLINE_BUTTONS,
  serviceCardLayoutSchema,
  type ServiceCardButton,
  type TemplateViewResponse,
} from '@nexa/contracts';
import { fetchSettings, saveSetting } from '../../api/client';
import { t } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import {
  Badge,
  Banner,
  Button,
  Card,
  StateSwitch,
  Switch,
  useToast,
  useUnsavedChanges,
} from '../../ui/kit';
import { TemplateCard } from '../content';
import { KeptSheet } from '../editor-layout';
import { useReportDirty } from '../ops-b-layout';
import { ErrorReport } from '../settings';
import { INLINE_BUTTON_NAME } from './inline-buttons';
import {
  defaultServiceCardRows,
  effectiveServiceCardRows,
  moveServiceCardAcrossRows,
  moveServiceCardRow,
  moveServiceCardWithinRow,
  setServiceCardEnabled,
  splitServiceCardButton,
  storedServiceCardRows,
  type ServiceCardRows,
} from './service-card-model';

export const SERVICE_CARD_LAYOUT_SETTING = 'bot.service_card_layout';

/** The templates a slot label comes from: switch-off and switch-on share one slot. */
function labelKeysOf(slot: ServiceCardButton): string[] {
  const keys = [slot, ...(slot === 'service.suspend' ? ['service.resume'] : [])];
  return keys.flatMap((key) => {
    const label = INLINE_BUTTONS.find((entry) => entry.key === key)?.label;
    return label === null || label === undefined ? [] : [label as string];
  });
}

/**
 * R8-C3: «چیدمان صفحهٔ سرویس» — the order, the rows (one to three buttons each) and the
 * show/hide switch of the buttons on a customer's service screen.
 *
 * The same two mechanisms as «دکمه‌های شیشه‌ای»: the arrangement is the
 * `bot.service_card_layout` setting (versioned, audited, `settings.edit`, saved with the
 * version this section read), and each label is the button's own template, edited with the
 * texts screen's card. The layout never makes a button appear: the bot draws only the buttons
 * the service is eligible for, then orders and hides them by this value.
 */
export function ServiceCardLayoutSection({
  mayEdit,
  denied,
  mayViewTemplates,
  mayEditTemplates,
  templates,
  onLabelChanged,
}: {
  mayEdit: boolean;
  denied: boolean;
  mayViewTemplates: boolean;
  mayEditTemplates: boolean;
  templates: readonly TemplateViewResponse[] | undefined;
  onLabelChanged: () => Promise<unknown> | void;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, enabled: !denied });
  const setting = settings.data?.settings.find((one) => one.key === SERVICE_CARD_LAYOUT_SETTING);
  const stored = useMemo<ServiceCardRows>(() => {
    const parsed = serviceCardLayoutSchema.safeParse(setting?.value ?? { rows: [] });
    return effectiveServiceCardRows(parsed.success ? parsed.data.rows : []);
  }, [setting?.value]);
  const invalid = setting?.storedValueInvalid === true;

  // The draft carries the version it was edited from, so a save never states a newer one.
  const [draft, setDraft] = useState<{
    readonly rows: ServiceCardRows;
    readonly basisVersion: number | null;
  } | null>(null);
  const [open, setOpen] = useState<ServiceCardButton | null>(null);
  const rows = draft?.rows ?? stored;
  const unsaved =
    draft !== null && (invalid || JSON.stringify(draft.rows) !== JSON.stringify(stored));
  useUnsavedChanges(mayEdit && unsaved);
  useReportDirty('service-card', mayEdit && unsaved);

  const edit = (next: ServiceCardRows) =>
    setDraft((before) => ({
      rows: next,
      basisVersion: before === null ? (setting?.version ?? null) : before.basisVersion,
    }));

  const save = useMutation({
    mutationFn: (command: {
      value: { rows: ServiceCardRows };
      expectedVersion: number | null;
      idempotencyKey: string;
    }) => saveSetting({ key: SERVICE_CARD_LAYOUT_SETTING, ...command }),
    onSuccess: async (result) => {
      submission.settle();
      setDraft(null);
      notify({
        tone: result.changed ? 'ok' : 'info',
        message: t(result.changed ? 'web.scl_saved' : 'web.scl_unchanged'),
      });
      await client.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error: unknown) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: t('web.scl_failed'), error });
      void client.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const saveNow = () => {
    const command = {
      value: { rows: storedServiceCardRows(rows) },
      expectedVersion: draft === null ? (setting?.version ?? null) : draft.basisVersion,
    };
    save.mutate({ ...command, idempotencyKey: submission.current(command) });
  };

  const nameOf = (slot: ServiceCardButton) => {
    const label = INLINE_BUTTONS.find((entry) => entry.key === slot)?.label;
    const body =
      label === null || label === undefined
        ? undefined
        : templates?.find((one) => one.key === label)?.body;
    return body !== undefined && body !== '' ? body : t(INLINE_BUTTON_NAME[slot]);
  };
  const templateOf = (key: string) => templates?.find((one) => one.key === key);
  const openKeys = open === null ? [] : labelKeysOf(open);

  return (
    <Card title={t('web.scl_title')} hint={t('web.scl_hint')} id="service-card-layout">
      <StateSwitch query={settings} denied={denied} isEmpty={false}>
        {invalid && <Banner tone="warn">{t('web.scl_stored_invalid')}</Banner>}
        {!mayEdit && <Banner tone="info">{t('web.scl_denied_edit')}</Banner>}
        <div data-testid="service-card-layout">
          {rows.map((row, rowIndex) => (
            <div
              key={row.map((entry) => entry.button).join('|')}
              role="group"
              aria-label={`${t('web.scl_row')} ${String(rowIndex + 1)}`}
              className="scl-row"
              data-row={rowIndex + 1}
            >
              <div className="scl-row-head">
                <b>{`${t('web.scl_row')} ${String(rowIndex + 1)}`}</b>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!mayEdit || rowIndex === 0}
                  aria-label={`${t('web.scl_move_row_up')} ${String(rowIndex + 1)}`}
                  onClick={() => edit(moveServiceCardRow(rows, rowIndex, -1))}
                >
                  ↑
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!mayEdit || rowIndex === rows.length - 1}
                  aria-label={`${t('web.scl_move_row_down')} ${String(rowIndex + 1)}`}
                  onClick={() => edit(moveServiceCardRow(rows, rowIndex, 1))}
                >
                  ↓
                </Button>
              </div>
              {row.map((entry, column) => {
                const name = nameOf(entry.button);
                return (
                  <div
                    key={entry.button}
                    className="scl-entry"
                    data-button={entry.button}
                    data-enabled={entry.enabled ? 'true' : 'false'}
                  >
                    <span className="scl-name">{name}</span>
                    {!entry.enabled && <Badge tone="neutral">{t('web.scl_hidden')}</Badge>}
                    <Switch
                      checked={entry.enabled}
                      label={`${t('web.scl_show')} ${name}`}
                      disabled={!mayEdit}
                      onChange={(next) => edit(setServiceCardEnabled(rows, entry.button, next))}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!mayEdit || column === 0}
                      aria-label={`${t('web.scl_earlier')}: ${name}`}
                      onClick={() => edit(moveServiceCardWithinRow(rows, entry.button, -1))}
                    >
                      →
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!mayEdit || column === row.length - 1}
                      aria-label={`${t('web.scl_later')}: ${name}`}
                      onClick={() => edit(moveServiceCardWithinRow(rows, entry.button, 1))}
                    >
                      ←
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!mayEdit}
                      aria-label={`${t('web.scl_row_up')}: ${name}`}
                      onClick={() => edit(moveServiceCardAcrossRows(rows, entry.button, -1))}
                    >
                      ⇡
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!mayEdit}
                      aria-label={`${t('web.scl_row_down')}: ${name}`}
                      onClick={() => edit(moveServiceCardAcrossRows(rows, entry.button, 1))}
                    >
                      ⇣
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!mayEdit || row.length === 1}
                      aria-label={`${t('web.scl_split')}: ${name}`}
                      onClick={() => edit(splitServiceCardButton(rows, entry.button))}
                    >
                      ⊟
                    </Button>
                    {mayViewTemplates && labelKeysOf(entry.button).length > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-haspopup="dialog"
                        aria-label={`${t('web.scl_edit_label')}: ${name}`}
                        onClick={() => setOpen(entry.button)}
                      >
                        {t('web.scl_edit_label')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          <p className="muted small" data-testid="scl-back-fixed">
            {`${t('web.ib_button_service_back_to_list')} — ${t('web.scl_back_fixed')}`}
          </p>
        </div>
        <div className="row">
          {unsaved && <span className="muted small">{t('web.scl_unsaved')}</span>}
          <span className="spacer" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!mayEdit || save.isPending}
            onClick={() => edit(defaultServiceCardRows())}
          >
            {t('web.scl_reset')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!mayEdit || !(unsaved || invalid) || save.isPending || setting === undefined}
            onClick={saveNow}
          >
            {t('web.scl_save')}
          </Button>
        </div>
        {save.isError && <ErrorReport error={save.error} />}
      </StateSwitch>
      {mayViewTemplates && open !== null && (
        <KeptSheet
          open
          onClose={() => setOpen(null)}
          title={nameOf(open)}
          hint={open === 'service.suspend' ? t('web.scl_resume_note') : undefined}
          wide
        >
          {openKeys.map((key) => {
            const template = templateOf(key);
            return template === undefined ? null : (
              <TemplateCard
                key={key}
                template={template}
                mayEdit={mayEditTemplates}
                onChanged={onLabelChanged}
              />
            );
          })}
        </KeptSheet>
      )}
    </Card>
  );
}
