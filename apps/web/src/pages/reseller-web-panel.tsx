import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchResellerWebPanel, forceLogoutResellerWebPanel } from '../api/client';
import { errorText } from '../error-text';
import { formatNumber, formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t } from '../i18n/web.fa';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Badge, Banner, Button, Card, Field, KV, StateSwitch, Textarea, useToast } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';

const reasonUsable = (reason: string) => reason.trim().length >= 3 && reason.trim().length <= 500;

/**
 * «پنل وب»: the reseller's web-panel standing in the reseller drawer — the last sign-in, how many
 * sessions are open, whether 2FA is on — and «خروج اجباری از همهٔ دستگاه‌ها» (`resellers.edit`,
 * a written reason, audited by the API). Reading needs only `resellers.view`.
 */
export function ResellerWebPanelCard({
  customerId,
  mayEdit,
}: {
  customerId: string;
  mayEdit: boolean;
}) {
  const toast = useToast();
  const client = useQueryClient();
  const key = ['reseller-web-panel', customerId] as const;
  const query = useQuery({ queryKey: key, queryFn: () => fetchResellerWebPanel(customerId) });
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  // One key per logical attempt: a retry of the same reason re-sends it; an answer retires it.
  const submission = useSubmissionKey();
  const force = useMutation({
    mutationFn: () => {
      const written = reason.trim();
      return forceLogoutResellerWebPanel(customerId, {
        reason: written,
        idempotencyKey: submission.current({ customerId, reason: written }),
      });
    },
    onError: (error) => submission.settleOn(error),
    onSuccess: ({ ended }) => {
      submission.settle();
      setAsking(false);
      setReason('');
      toast({
        tone: 'ok',
        message: t(ended > 0 ? 'web.rp_admin_force_done' : 'web.rp_admin_force_none'),
      });
      void client.invalidateQueries({ queryKey: key });
    },
  });
  const data = query.data;
  return (
    <Card title={t('web.rp_admin_title')}>
      <StateSwitch query={query}>
        {data !== undefined && (
          <>
            <KV
              items={[
                [
                  t('web.rp_admin_title'),
                  data.lastLoginAt === null
                    ? t('web.rp_admin_never')
                    : t('web.rp_admin_last_login').replace(
                        '{at}',
                        formatTimestamp(data.lastLoginAt),
                      ),
                ],
                [t('web.rp_admin_sessions_label'), formatNumber(data.activeSessions)],
                [
                  t('web.rp_admin_2fa_label'),
                  <Badge key="2fa" tone={data.secondFactor ? 'ok' : 'neutral'}>
                    {data.secondFactor ? t('web.rp_2fa_on') : t('web.rp_2fa_off')}
                  </Badge>,
                ],
              ]}
            />
            {mayEdit ? (
              <div className="form-actions">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={data.activeSessions === 0}
                  onClick={() => setAsking(true)}
                >
                  {t('web.rp_admin_force')}
                </Button>
              </div>
            ) : (
              <Banner tone="info">{t('web.reseller_edit_denied')}</Banner>
            )}
          </>
        )}
      </StateSwitch>
      {asking && (
        <ConfirmDialog
          title={t('web.rp_admin_force')}
          question={t('web.rp_admin_force_question')}
          confirmLabel={t('web.rp_admin_force_confirm')}
          cancelLabel={t('web.user_action_cancel')}
          confirmDisabled={!reasonUsable(reason) || force.isPending}
          onConfirm={() => force.mutate()}
          onCancel={() => setAsking(false)}
          extra={
            <div className="stack">
              <Field label={t('web.rp_admin_force_reason')} htmlFor="reseller-web-force-reason">
                <Textarea
                  id="reseller-web-force-reason"
                  rows={3}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              {force.error !== null && (
                <Banner tone="danger">
                  {errorText(force.error)}
                  <ErrorRef error={force.error} />
                </Banner>
              )}
            </div>
          }
        />
      )}
    </Card>
  );
}
