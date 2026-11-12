import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MoneyWire, ResellerAutoRenew } from '@nexa/contracts';
import { errorText } from '../../error-text';
import { formatMoneyText } from '../../format';
import { t } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import { Banner, Button, Field, Select, Switch, useToast } from '../../ui/kit';
import { Modal } from '../../ui/overlays';
import { fetchAutoRenew, saveAutoRenew } from '../api';

export function autoRenewKey(serviceId: string) {
  return ['reseller', 'auto-renew', serviceId] as const;
}

/** Every list that draws a switch reads again after one changes. */
const AFTER_CHANGE: readonly (readonly string[])[] = [
  ['reseller', 'services'],
  ['reseller', 'client-services'],
  ['reseller', 'auto-renew'],
];

/**
 * The reason a switch is not offered, in words (null while it is offered). An imported service
 * with plans to choose from is NOT unavailable: its switch opens the plan picker, and the
 * reason «برای روشن کردن، پلن تمدید را انتخاب کنید» is drawn beside it.
 */
export function autoRenewReason(state: ResellerAutoRenew): string | null {
  if (state.enabled) return null;
  if (state.unavailable === 'PLAN_REQUIRED') return t('web.rp_ar_plan_required');
  if (state.unavailable === 'FEATURE_OFF') return t('web.rp_ar_off_feature');
  if (state.unavailable === 'NOT_AVAILABLE') return t('web.rp_ar_unavailable');
  return null;
}

/**
 * One service's auto-renew switch (Round 10 D1): the consent, the price ceiling at opt-in and
 * the sweep are the API's; this draws the state it answers and sends the figure it showed.
 *
 * `initial` is the state a list already holds (the clients book returns it with each service);
 * without it the switch reads its own. An imported service is switched on through a plan
 * picker — the reseller chooses the plan to renew into, and that plan's price is the ceiling.
 */
export function AutoRenewSwitch({
  serviceId,
  username,
  initial,
}: {
  serviceId: string;
  username: string;
  initial?: ResellerAutoRenew;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: autoRenewKey(serviceId),
    queryFn: () => fetchAutoRenew(serviceId),
    ...(initial === undefined ? {} : { initialData: initial, staleTime: 30_000 }),
  });
  const state = query.data;
  const [picking, setPicking] = useState(false);
  const [planId, setPlanId] = useState('');
  const submission = useSubmissionKey();

  const save = useMutation({
    mutationFn: (input: { enabled: boolean; expected: MoneyWire | null; planId: string | null }) =>
      saveAutoRenew(serviceId, input, submission.current({ serviceId, ...input })),
    onSuccess: (next, input) => {
      submission.settle();
      client.setQueryData(autoRenewKey(serviceId), next);
      setPicking(false);
      toast({ tone: 'ok', message: t(input.enabled ? 'web.rp_ar_on' : 'web.rp_ar_off') });
      for (const key of AFTER_CHANGE) void client.invalidateQueries({ queryKey: [...key] });
    },
    onError: (error) => {
      submission.settleOn(error);
      toast({ tone: 'danger', message: errorText(error), error });
    },
  });

  if (state === undefined) return <span className="muted small">…</span>;

  const reason = autoRenewReason(state);
  const chosenPlan = state.plans.find((plan) => plan.planId === planId);
  const choosesPlan = !state.enabled && state.imported && state.plans.length > 0;
  const switchable = state.enabled || state.offered || choosesPlan;

  function toggle(next: boolean) {
    if (!next) {
      save.mutate({ enabled: false, expected: null, planId: null });
    } else if (choosesPlan) {
      setPlanId('');
      setPicking(true);
    } else {
      save.mutate({ enabled: true, expected: state?.price ?? null, planId: null });
    }
  }

  return (
    <div className="rp-ar">
      <Switch
        checked={state.enabled}
        onChange={toggle}
        disabled={!switchable || save.isPending}
        label={t('web.rp_ar_label').replace('{user}', username)}
      />
      {state.enabled && state.imported && state.planId !== null && (
        <span className="muted small">
          {t('web.rp_ar_plan_line').replace(
            '{plan}',
            state.plans.find((plan) => plan.planId === state.planId)?.title ?? '—',
          )}
        </span>
      )}
      {reason !== null && <span className="muted small">{reason}</span>}
      <Modal
        open={picking}
        onClose={() => setPicking(false)}
        title={t('web.rp_ar_pick_title')}
        size="md"
        foot={
          <>
            <Button onClick={() => setPicking(false)}>{t('web.rp_ar_cancel')}</Button>
            <Button
              variant="primary"
              disabled={chosenPlan === undefined || save.isPending}
              onClick={() => {
                if (chosenPlan !== undefined) {
                  save.mutate({ enabled: true, expected: chosenPlan.price, planId });
                }
              }}
            >
              {t('web.rp_ar_enable')}
            </Button>
          </>
        }
      >
        <div className="rp-stack">
          <Banner tone="info">{t('web.rp_ar_pick_hint')}</Banner>
          <Field label={t('web.rp_ar_plan')} htmlFor={`rp-ar-plan-${serviceId}`}>
            <Select
              id={`rp-ar-plan-${serviceId}`}
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
            >
              <option value="">{t('web.rp_ar_plan_ph')}</option>
              {state.plans.map((plan) => (
                <option key={plan.planId} value={plan.planId}>
                  {plan.title} — {formatMoneyText(plan.price)}
                </option>
              ))}
            </Select>
          </Field>
          {chosenPlan !== undefined && (
            <span className="muted small">
              {t('web.rp_ar_ceiling').replace('{price}', formatMoneyText(chosenPlan.price))}
            </span>
          )}
        </div>
      </Modal>
    </div>
  );
}
