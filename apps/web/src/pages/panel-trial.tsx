import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PANEL_TRIAL_HOURS_MAX,
  PANEL_TRIAL_HOURS_MIN,
  PANEL_TRIAL_LABEL_MAX_LENGTH,
  TRAFFIC_INPUT_UNITS,
  trafficInputOf,
  updatePanelTrialRequestSchema,
  type PanelTrialResponseBody,
  type TrafficInputUnit,
} from '@nexa/contracts';
import { ApiError, fetchPanelTrial, savePanelTrial } from '../api/client';
import { formatTimestamp } from '../format';
import { t, type WebKey } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Banner, Card, Field, StateSwitch, Switch, useToast } from '../ui/kit';
import { messageFor } from './settings';

const UNIT_LABELS: Readonly<Record<TrafficInputUnit, WebKey>> = {
  GB: 'web.panel_trial_unit_gb',
  MB: 'web.panel_trial_unit_mb',
};

export const panelTrialKey = (panelId: string) => ['panel-trial', panelId] as const;

/** What an unconfigured panel's form starts from: the owner's example, 100 MB for 72 hours. */
const STARTING_DRAFT = { amount: '100', unit: 'MB' as TrafficInputUnit, hours: '72' };

interface Draft {
  readonly enabled: boolean;
  readonly amount: string;
  readonly unit: TrafficInputUnit;
  readonly hours: string;
  readonly label: string;
}

function draftOf(trial: PanelTrialResponseBody): Draft {
  if (trial.trafficBytes === null || trial.durationHours === null) {
    return { enabled: trial.enabled, ...STARTING_DRAFT, label: trial.label ?? '' };
  }
  const traffic = trafficInputOf(BigInt(trial.trafficBytes));
  return {
    enabled: trial.enabled,
    amount: traffic.amount,
    unit: traffic.unit,
    hours: String(trial.durationHours),
    label: trial.label ?? '',
  };
}

/**
 * R1: one panel's free trial — the «سرویس تست» tab on the panel page.
 *
 * Whole, never a patch: the form sends everything it shows with the revision it was drawn
 * from, so a colleague's change in between comes back as a stale refusal rather than being
 * overwritten unseen. The traffic is typed as a figure and a unit (GB or MB) and converted
 * by the server with the ONE parser the contract exports; the form validates with the same
 * schema before sending, and the server's own answer decides.
 */
export function PanelTrialTab({ panelId, mayEdit }: { panelId: string; mayEdit: boolean }) {
  const trial = useQuery({
    queryKey: panelTrialKey(panelId),
    queryFn: () => fetchPanelTrial(panelId),
  });
  return (
    <StateSwitch query={trial}>
      {trial.data !== undefined && (
        // Keyed by the revision, so a save or a colleague's change re-seeds the draft.
        <TrialForm
          key={`${panelId}:${String(trial.data.trial.revision)}`}
          trial={trial.data.trial}
          mayEdit={mayEdit}
        />
      )}
    </StateSwitch>
  );
}

function TrialForm({ trial, mayEdit }: { trial: PanelTrialResponseBody; mayEdit: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const submission = useSubmissionKey();
  const [draft, setDraft] = useState<Draft>(() => draftOf(trial));
  const [invalid, setInvalid] = useState(false);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const save = useMutation({
    mutationFn: (body: Parameters<typeof savePanelTrial>[1]) => savePanelTrial(trial.panelId, body),
    onSuccess: async (result) => {
      submission.settle();
      toast({
        tone: result.changed ? 'ok' : 'info',
        message: result.changed ? t('web.saved') : t('web.unchanged'),
      });
      client.setQueryData(panelTrialKey(trial.panelId), { trial: result.trial });
      await client.invalidateQueries({ queryKey: ['trial-panels'] });
    },
    onError: async (error: unknown) => {
      submission.settleOn(error);
      if (error instanceof ApiError && error.code === 'commerce.trial_config_stale') {
        toast({ tone: 'warn', message: t('web.panel_trial_stale') });
        await client.invalidateQueries({ queryKey: panelTrialKey(trial.panelId) });
        return;
      }
      toast({ tone: 'danger', message: messageFor(error) });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const label = draft.label.trim();
    const command = {
      expectedRevision: trial.revision,
      enabled: draft.enabled,
      trafficAmount: draft.amount.trim(),
      trafficUnit: draft.unit,
      durationHours: Number(draft.hours.trim()),
      label: label === '' ? null : label,
    };
    const parsed = updatePanelTrialRequestSchema.safeParse({
      ...command,
      idempotencyKey: 'validation-only',
    });
    if (!parsed.success) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    save.mutate({
      ...command,
      idempotencyKey: submission.current({
        command: 'panels.trial',
        id: trial.panelId,
        ...command,
      }),
    });
  };

  const editable = mayEdit && !save.isPending;
  const id = (field: string) => `panel-trial-${field}`;
  return (
    <Card title={t('web.panel_trial_title')} hint={t('web.panel_trial_hint')}>
      {trial.revision === 0 && <Banner tone="info">{t('web.panel_trial_unconfigured')}</Banner>}
      <form onSubmit={onSubmit} className="stack-sm">
        <div className="field">
          <div className="row">
            <Switch
              checked={draft.enabled}
              label={t('web.panel_trial_enabled')}
              disabled={!editable}
              onChange={(next) => set('enabled', next)}
            />
            <span>{t('web.panel_trial_enabled')}</span>
          </div>
        </div>
        <Field
          label={t('web.panel_trial_traffic')}
          hint={t('web.panel_trial_traffic_hint')}
          htmlFor={id('amount')}
        >
          <div className="input-group">
            <input
              id={id('amount')}
              className="input ltr mono"
              inputMode="decimal"
              value={draft.amount}
              disabled={!editable}
              onChange={(event) => set('amount', event.target.value)}
            />
            <select
              className="input"
              aria-label={t('web.panel_trial_unit_label')}
              value={draft.unit}
              disabled={!editable}
              onChange={(event) => set('unit', event.target.value as TrafficInputUnit)}
            >
              {TRAFFIC_INPUT_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {t(UNIT_LABELS[unit])}
                </option>
              ))}
            </select>
          </div>
        </Field>
        <Field
          label={t('web.panel_trial_hours')}
          hint={t('web.panel_trial_hours_hint')}
          htmlFor={id('hours')}
        >
          <div className="input-group">
            <input
              id={id('hours')}
              className="input ltr mono"
              type="number"
              inputMode="numeric"
              min={PANEL_TRIAL_HOURS_MIN}
              max={PANEL_TRIAL_HOURS_MAX}
              value={draft.hours}
              disabled={!editable}
              onChange={(event) => set('hours', event.target.value)}
            />
            <span className="muted">{t('web.panel_trial_hours_unit')}</span>
          </div>
        </Field>
        <Field
          label={t('web.panel_trial_label')}
          hint={t('web.panel_trial_label_hint')}
          htmlFor={id('label')}
        >
          <input
            id={id('label')}
            className="input"
            maxLength={PANEL_TRIAL_LABEL_MAX_LENGTH}
            value={draft.label}
            disabled={!editable}
            onChange={(event) => set('label', event.target.value)}
          />
        </Field>
        {invalid && <Banner tone="danger">{t('web.panel_trial_invalid')}</Banner>}
        {trial.updatedAt !== null && (
          <p className="faint small">
            {t('web.panel_trial_updated_at')}: {formatTimestamp(trial.updatedAt)}
          </p>
        )}
        {mayEdit && (
          <div className="btn-group">
            <button type="submit" className="btn primary sm" disabled={!editable}>
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
