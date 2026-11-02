import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_QR_KINDS,
  SINGBOX_INTERVAL_MAX_MINUTES,
  SINGBOX_INTERVAL_MIN_MINUTES,
  isSingboxInterval,
  panelSupportsQrKind,
  providerDeliversConnectionFiles,
  type PanelQrKind,
  type PanelSummaryResponse,
} from '@nexa/contracts';
import { updatePanel } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Banner, Button, Card, Field, Input, Select, ToggleRow, useToast } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { messageFor } from './settings';

const QR_KIND_LABELS: Readonly<Record<PanelQrKind, WebKey>> = {
  SUB_LINK: 'web.qr_kind_sub_link',
  SINGBOX: 'web.qr_kind_singbox',
  BOTH: 'web.qr_kind_both',
};

/**
 * R11 A4: what a customer of this panel is shown instead of, or as, the subscription link.
 *
 *  - «فقط فایل، بدون لینک ساب»: drawn only where the provider hands over connection files
 *    (`providerDeliversConnectionFiles`, the question the server asks before it accepts).
 *  - «نوع بارکد»: drawn only for a RickPanel (`panelSupportsQrKind`), with the sing-box
 *    refresh interval when the kind includes sing-box.
 *
 * A courtesy: the server refuses both on any other panel with a Persian error of its own.
 * Nothing is sent to any customer by saving this.
 */
export function PanelDeliveryOptionsCard({
  panel,
  mayEdit,
}: {
  panel: PanelSummaryResponse;
  mayEdit: boolean;
}) {
  const offersFilesOnly = providerDeliversConnectionFiles(panel.providerType);
  const offersQrKind = panelSupportsQrKind(panel.providerType);
  if (!offersFilesOnly && !offersQrKind) return null;
  return (
    <Options
      key={`${panel.id}:${String(panel.filesOnlyDelivery)}:${panel.qrKind}:${String(panel.singboxIntervalMinutes)}`}
      panel={panel}
      mayEdit={mayEdit}
      offersFilesOnly={offersFilesOnly}
      offersQrKind={offersQrKind}
    />
  );
}

function Options({
  panel,
  mayEdit,
  offersFilesOnly,
  offersQrKind,
}: {
  panel: PanelSummaryResponse;
  mayEdit: boolean;
  offersFilesOnly: boolean;
  offersQrKind: boolean;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [filesOnly, setFilesOnly] = useState(panel.filesOnlyDelivery);
  const [kind, setKind] = useState<PanelQrKind>(panel.qrKind);
  const [interval, setIntervalText] = useState(String(panel.singboxIntervalMinutes));
  const minutes = Number(interval);
  const intervalOk = isSingboxInterval(minutes);
  const usesSingbox = kind === 'SINGBOX' || kind === 'BOTH';

  const body = {
    id: panel.id,
    ...(offersFilesOnly && filesOnly !== panel.filesOnlyDelivery
      ? { filesOnlyDelivery: filesOnly }
      : {}),
    ...(offersQrKind && kind !== panel.qrKind ? { qrKind: kind } : {}),
    ...(offersQrKind && intervalOk && minutes !== panel.singboxIntervalMinutes
      ? { singboxIntervalMinutes: minutes }
      : {}),
  };
  const dirty = Object.keys(body).length > 1;
  const invalid = offersQrKind && usesSingbox && !intervalOk;

  const save = useMutation({
    mutationFn: () => updatePanel({ ...body, idempotencyKey: submission.current(body) }),
    onSuccess: async () => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.saved') });
      await client.invalidateQueries({ queryKey: ['panel', panel.id] });
      await client.invalidateQueries({ queryKey: ['panels'] });
    },
    onError: (error: unknown) => submission.settleOn(error),
  });
  const editable = mayEdit && !save.isPending;

  return (
    <Card title={t('web.delivery_options_title')} hint={t('web.delivery_options_hint')}>
      <div className="stack-sm">
        {offersFilesOnly && (
          <ToggleRow
            title={t('web.files_only_title')}
            description={t('web.files_only_hint')}
            checked={filesOnly}
            disabled={!editable}
            onChange={setFilesOnly}
          />
        )}
        {offersQrKind && (
          <>
            <Field
              label={t('web.qr_kind_label')}
              hint={t('web.qr_kind_hint')}
              htmlFor="panel-qr-kind"
            >
              <Select
                id="panel-qr-kind"
                value={kind}
                disabled={!editable}
                onChange={(event) => setKind(event.target.value as PanelQrKind)}
              >
                {PANEL_QR_KINDS.map((one) => (
                  <option key={one} value={one}>
                    {t(QR_KIND_LABELS[one])}
                  </option>
                ))}
              </Select>
            </Field>
            {usesSingbox && (
              <Field
                label={t('web.singbox_interval_label')}
                hint={t('web.singbox_interval_hint')
                  .replace('{min}', String(SINGBOX_INTERVAL_MIN_MINUTES))
                  .replace('{max}', String(SINGBOX_INTERVAL_MAX_MINUTES))}
                htmlFor="panel-singbox-interval"
                {...(invalid ? { error: t('web.singbox_interval_invalid') } : {})}
              >
                <Input
                  id="panel-singbox-interval"
                  dir="ltr"
                  inputMode="numeric"
                  value={interval}
                  disabled={!editable}
                  onChange={(event) => setIntervalText(event.target.value)}
                />
              </Field>
            )}
            {filesOnly && offersFilesOnly && (
              <p className="muted small">{t('web.qr_kind_files_only_note')}</p>
            )}
          </>
        )}
        {save.isError && (
          <Banner tone="danger" role="alert">
            {messageFor(save.error)}
            <ErrorRef error={save.error} />
          </Banner>
        )}
        {mayEdit && (
          <div>
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty || invalid || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending ? t('web.working') : t('web.save')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
