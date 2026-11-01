import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSettings, saveSetting } from '../api/client';
import { t } from '../i18n/web.fa';
import { useSubmissionKey } from '../submission-key';
import { Badge, Banner, Card, useToast } from '../ui/kit';
import { supportAiFault } from './support-ai';

/** The setting this card switches (`support.ai.tickets_enabled`, OFF by default). */
export const TICKETS_SWITCH_KEY = 'support.ai.tickets_enabled';

/**
 * Phase 4 PR-4 — «پاسخ هوش مصنوعی در تیکت‌های ربات».
 *
 * One switch, in the owner's hands and OFF until they turn it on: whether the support AI also
 * writes the first answers inside the bot's tickets and the Mini App's support screen. It is the
 * ordinary setting (`support.ai.tickets_enabled`), saved through the ordinary settings call with
 * the version this card read, so a change made elsewhere is a conflict, never an overwrite. It
 * says in words what the switch does and that it needs the automatic mode; it shows no number
 * it does not have.
 */
export function TicketAiSwitchCard({
  automatic,
  mayEdit,
}: {
  /** The support AI is in the automatic-reply mode (the switch does nothing otherwise). */
  automatic: boolean;
  mayEdit: boolean;
}) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings });
  const row = settings.data?.settings.find((setting) => setting.key === TICKETS_SWITCH_KEY);
  const on = row?.value === true;
  const save = useMutation({
    mutationFn: (command: { value: boolean; expectedVersion: number | null; key: string }) =>
      saveSetting({
        key: TICKETS_SWITCH_KEY,
        value: command.value,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.key,
      }),
    onSuccess: async (result) => {
      submission.settle();
      notify({
        tone: 'ok',
        message: t(
          result.setting.value === true ? 'web.sai_tickets_now_on' : 'web.sai_tickets_now_off',
        ),
      });
      await queries.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (error) => {
      submission.settleOn(error);
      notify({ tone: 'danger', message: supportAiFault(error), error });
      void queries.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  return (
    <Card
      title={t('web.sai_tickets_title')}
      hint={t('web.sai_tickets_hint')}
      actions={
        <Badge tone={on ? 'ok' : 'neutral'}>
          {t(on ? 'web.sai_tickets_on' : 'web.sai_tickets_off')}
        </Badge>
      }
    >
      <div className="stack-sm" data-testid="sai-tickets-switch">
        {on && !automatic && <Banner tone="warn">{t('web.sai_tickets_needs_auto')}</Banner>}
        {settings.isError && <Banner tone="warn">{t('web.sai_tickets_unreadable')}</Banner>}
        <label className="check">
          <input
            type="checkbox"
            checked={on}
            disabled={!mayEdit || row === undefined || save.isPending}
            onChange={(event) => {
              if (row === undefined) return;
              const value = event.target.checked;
              save.mutate({
                value,
                expectedVersion: row.version,
                key: submission.current({ value, version: row.version }),
              });
            }}
          />{' '}
          {t('web.sai_tickets_label')}
        </label>
        <p className="small muted">{t('web.sai_tickets_pause_note')}</p>
        {!mayEdit && <p className="small muted">{t('web.sai_tickets_no_permission')}</p>}
      </div>
    </Card>
  );
}
