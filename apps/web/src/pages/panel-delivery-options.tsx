import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_QR_KINDS,
  SINGBOX_INTERVAL_MAX_MINUTES,
  SINGBOX_INTERVAL_MIN_MINUTES,
  isSingboxInterval,
  panelDeliversConnectionFiles,
  panelSupportsQrKind,
  providerDeliversConnectionFiles,
  providerDescriptor,
  type PanelAdvancedResponse,
  type PanelQrKind,
  type PanelSummaryResponse,
} from '@nexa/contracts';
import { fetchPanelAdvanced, updatePanel, updatePanelPolicy } from '../api/client';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  Radio,
  Select,
  StateSwitch,
  ToggleRow,
  useToast,
} from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { advancedKey } from './panel-advanced';
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
  // v0.9.5 PR-3: a type whose files each panel must announce (the custom bridge) gets the
  // three-way choice, with the two file options enabled only while the latest health
  // check announced them.
  if (filesAreAnnounced(panel.providerType)) {
    return (
      <AnnouncedChoiceCard
        key={`${panel.id}:${String(panel.filesOnlyDelivery)}`}
        panel={panel}
        mayEdit={mayEdit}
      />
    );
  }
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

/** Whether this type's files are offered per panel, by its health check's announcement. */
function filesAreAnnounced(providerType: string): boolean {
  return providerDescriptor(providerType)?.announcedOnly?.includes('SUBSCRIPTION_FILES') ?? false;
}

type DeliveryChoice = 'BOTH' | 'FILES' | 'LINK';
const CHOICES: readonly {
  readonly value: DeliveryChoice;
  readonly title: WebKey;
  readonly hint: WebKey;
}[] = [
  { value: 'BOTH', title: 'web.delivery_choice_both', hint: 'web.delivery_choice_both_hint' },
  { value: 'FILES', title: 'web.delivery_choice_files', hint: 'web.delivery_choice_files_hint' },
  { value: 'LINK', title: 'web.delivery_choice_link', hint: 'web.delivery_choice_link_hint' },
];

/**
 * v0.9.5 PR-3, the custom panel's «تحویل به مشتری» (approved demo, `panel()`): three
 * options over the two settings that already exist, so nothing new decides delivery:
 *
 *   - «فقط فایل»           `filesOnlyDelivery` on;
 *   - «لینک ساب + فایل‌ها» `filesOnlyDelivery` off, the policy's `SUBSCRIPTION_FILES` on;
 *   - «فقط لینک ساب»       `filesOnlyDelivery` off, the policy's `SUBSCRIPTION_FILES` off —
 *     the switch that already stops the files button and the files after a delivery.
 *
 * The two file options are disabled, with the reason, while the bridge's latest health
 * check does not announce `files` (`panelDeliversConnectionFiles`, the question the server
 * asks before accepting «فقط فایل» and before fetching any file). A save writes «فقط فایل»
 * OFF before the policy and ON after it, so no moment has the link hidden and files off.
 */
function AnnouncedChoiceCard({
  panel,
  mayEdit,
}: {
  panel: PanelSummaryResponse;
  mayEdit: boolean;
}) {
  const advanced = useQuery({
    queryKey: advancedKey(panel.id),
    queryFn: () => fetchPanelAdvanced(panel.id),
  });
  const data = advanced.data;
  return (
    <Card title={t('web.delivery_options_title')} hint={t('web.delivery_options_hint')}>
      <StateSwitch query={advanced}>
        {data !== undefined && (
          <AnnouncedChoice
            key={`${String(data.policy.revision)}:${String(data.policy.readable)}`}
            panel={panel}
            advanced={data}
            mayEdit={mayEdit}
          />
        )}
      </StateSwitch>
    </Card>
  );
}

function filesSwitchOf(advanced: PanelAdvancedResponse): boolean {
  if (!advanced.policy.readable) return false;
  return advanced.policy.policy.actions.SUBSCRIPTION_FILES?.customerEnabled ?? true;
}

function AnnouncedChoice({
  panel,
  advanced,
  mayEdit,
}: {
  panel: PanelSummaryResponse;
  advanced: PanelAdvancedResponse;
  mayEdit: boolean;
}) {
  const client = useQueryClient();
  const panelSubmission = useSubmissionKey();
  const policySubmission = useSubmissionKey();
  const toast = useToast();
  const announced = panelDeliversConnectionFiles(
    panel.providerType,
    panel.health.announcedCapabilities,
  );
  const filesSwitch = filesSwitchOf(advanced);
  const stored: DeliveryChoice = panel.filesOnlyDelivery ? 'FILES' : filesSwitch ? 'BOTH' : 'LINK';
  const [choice, setChoice] = useState<DeliveryChoice>(stored);
  const readable = advanced.policy.readable;

  const wantFilesOnly = choice === 'FILES';
  const wantFilesSwitch = choice !== 'LINK';
  const policyChanges = wantFilesSwitch !== filesSwitch;
  const dirty = choice !== stored;

  const writePanel = (filesOnlyDelivery: boolean) => {
    const body = { id: panel.id, filesOnlyDelivery };
    return updatePanel({ ...body, idempotencyKey: panelSubmission.current(body) });
  };
  const writePolicy = () => {
    if (!advanced.policy.readable) return Promise.resolve();
    const policy = {
      ...advanced.policy.policy,
      actions: {
        ...advanced.policy.policy.actions,
        SUBSCRIPTION_FILES: { customerEnabled: wantFilesSwitch },
      },
    };
    return updatePanelPolicy({
      id: panel.id,
      policy,
      expectedRevision: advanced.policy.revision,
      idempotencyKey: policySubmission.current({
        command: 'panels.policy',
        id: panel.id,
        expectedRevision: advanced.policy.revision,
        policy,
      }),
    }).then(() => undefined);
  };

  const save = useMutation({
    mutationFn: async () => {
      // «فقط فایل» OFF first, ON last: the link is never hidden while files are off.
      if (!wantFilesOnly && panel.filesOnlyDelivery) await writePanel(false);
      if (policyChanges) await writePolicy();
      if (wantFilesOnly && !panel.filesOnlyDelivery) await writePanel(true);
    },
    onSuccess: async () => {
      panelSubmission.settle();
      policySubmission.settle();
      toast({ tone: 'ok', message: t('web.saved') });
      await client.invalidateQueries({ queryKey: ['panel', panel.id] });
      await client.invalidateQueries({ queryKey: ['panels'] });
    },
    onError: async (error: unknown) => {
      panelSubmission.settleOn(error);
      policySubmission.settleOn(error);
      toast({ tone: 'danger', message: messageFor(error), error });
      // A half-applied save (the first write landed) is shown as the server now holds it.
      await client.invalidateQueries({ queryKey: ['panel', panel.id] });
      await client.invalidateQueries({ queryKey: ['panels'] });
    },
  });
  const editable = mayEdit && readable && !save.isPending;

  return (
    <div className="stack-sm">
      <fieldset className="stack-sm">
        <legend className="small">{t('web.delivery_choice_label')}</legend>
        {CHOICES.map((one) => (
          <div key={one.value}>
            <Radio
              name={`panel-delivery-${panel.id}`}
              value={one.value}
              selected={choice}
              disabled={!editable || (one.value !== 'LINK' && !announced)}
              onChange={setChoice}
              label={t(one.title)}
            />
            <p className="muted small">{t(one.hint)}</p>
          </div>
        ))}
      </fieldset>
      {!announced && <p className="muted small">{t('web.delivery_files_not_announced')}</p>}
      {!announced && panel.filesOnlyDelivery && (
        <Banner tone="warn" role="alert">
          {t('web.delivery_files_only_stranded')}
        </Banner>
      )}
      {!readable && (
        <Banner tone="warn" role="alert">
          {t('web.delivery_policy_unreadable')}
        </Banner>
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
            disabled={!dirty || !editable}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('web.working') : t('web.save')}
          </Button>
        </div>
      )}
    </div>
  );
}
