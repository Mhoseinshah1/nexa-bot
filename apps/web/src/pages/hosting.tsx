import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HostingServerResponse, HostingStatusResponse } from '@nexa/contracts';
import {
  closeHostingSession,
  fetchHostingServer,
  fetchHostingStatus,
  regenerateHostingRecoveryCodes,
} from '../api/client';
import { errorText } from '../error-text';
import { formatNumber, formatTimestamp, splitBytes } from '../format';
import { t } from '../i18n/web.fa';
import { Banner, Button, Card, Disclosure, KV, Ltr, Meter, PageHead, StateSwitch } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { HostingGate } from './hosting-gate';
import { HostedBots } from './hosting-bots';
import {
  CodePromptDialog,
  HOSTING_STATUS_KEY,
  HOSTING_SERVER_KEY,
  RecoveryCodesReveal,
} from './hosting-parts';

/**
 * «میزبانی‌ها» — the installation owner's creator panel (phase 6A, D1).
 *
 * The page asks the server where the section stands and draws exactly one thing: the gate
 * (enrol, finish activating, or enter a code), the one-time recovery codes, or the panel. A
 * non-owner draws the denied state and issues no request; the server refuses anyone but the
 * owner on every route regardless.
 */
export function HostingPage({ denied }: { denied: boolean }) {
  const status = useQuery({
    queryKey: HOSTING_STATUS_KEY,
    queryFn: fetchHostingStatus,
    enabled: !denied,
  });
  // Codes shown once: held here so the panel does not replace them before they are saved.
  const [reveal, setReveal] = useState<readonly string[] | null>(null);
  const data = status.data;

  return (
    <div className="hosting-page stack">
      <PageHead title={t('web.hosting_title')} subtitle={t('web.hosting_subtitle')} />
      <StateSwitch query={status} denied={denied}>
        {data === undefined ? null : reveal !== null ? (
          <Card title={t('web.hosting_recovery_title')}>
            <RecoveryCodesReveal codes={reveal} onDone={() => setReveal(null)} />
          </Card>
        ) : data.factor !== 'ACTIVE' || data.session === null ? (
          <HostingGate status={data} onActivated={setReveal} />
        ) : (
          <HostingPanel status={data} session={data.session} onRecoveryCodes={setReveal} />
        )}
      </StateSwitch>
    </div>
  );
}

function HostingPanel({
  status,
  session,
  onRecoveryCodes,
}: {
  status: HostingStatusResponse;
  session: { readonly expiresAt: string };
  onRecoveryCodes: (codes: readonly string[]) => void;
}) {
  return (
    <>
      <SessionCard status={status} session={session} onRecoveryCodes={onRecoveryCodes} />
      <ServerCard />
      <HostedBots fallbackCreate={status.create} />
    </>
  );
}

function SessionCard({
  status,
  session,
  onRecoveryCodes,
}: {
  status: HostingStatusResponse;
  session: { readonly expiresAt: string };
  onRecoveryCodes: (codes: readonly string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [regenerating, setRegenerating] = useState(false);
  const close = useMutation({
    retry: false,
    mutationFn: closeHostingSession,
    onSuccess: () => {
      // What this session read must not stay cached once the section is closed.
      queryClient.removeQueries({ queryKey: ['hosting', 'bots'] });
      queryClient.removeQueries({ queryKey: HOSTING_SERVER_KEY });
      void queryClient.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
    },
  });
  return (
    <Card
      actions={
        <Button icon="logout" disabled={close.isPending} onClick={() => close.mutate()}>
          {t('web.hosting_session_close')}
        </Button>
      }
      title={t('web.hosting_session_title')}
    >
      <KV
        items={[
          [t('web.hosting_session_until'), formatTimestamp(session.expiresAt)],
          [t('web.hosting_recovery_remaining'), formatNumber(status.recoveryCodesRemaining)],
        ]}
      />
      <p className="muted small">{t('web.hosting_recovery_hint')}</p>
      <div className="btn-group">
        <Button icon="key" onClick={() => setRegenerating(true)}>
          {t('web.hosting_recovery_regenerate')}
        </Button>
      </div>
      {close.error !== null && (
        <Banner tone="danger">
          {errorText(close.error)}
          <ErrorRef error={close.error} />
        </Banner>
      )}
      {regenerating && (
        <CodePromptDialog
          title={t('web.hosting_recovery_regenerate')}
          hint={t('web.hosting_recovery_hint')}
          confirmLabel={t('web.hosting_recovery_regenerate')}
          run={({ proof }) => regenerateHostingRecoveryCodes(proof)}
          onClose={() => setRegenerating(false)}
          onDone={(result) => {
            setRegenerating(false);
            onRecoveryCodes(result.recoveryCodes);
            void queryClient.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
          }}
        />
      )}
    </Card>
  );
}

/** Whole bytes as the figure and unit the admin shows everywhere else. */
function bytesText(bytes: number): string {
  const { value, unit } = splitBytes(BigInt(Math.max(0, Math.trunc(bytes))));
  return `${value} ${t(unit)}`;
}

function ServerCard() {
  const server = useQuery({ queryKey: HOSTING_SERVER_KEY, queryFn: fetchHostingServer });
  return (
    <Card
      title={t('web.hosting_server_title')}
      actions={
        <Button size="sm" icon="refresh" onClick={() => void server.refetch()}>
          {t('web.retry')}
        </Button>
      }
    >
      <StateSwitch query={server}>
        {server.data !== undefined && <ServerFigures server={server.data} />}
      </StateSwitch>
    </Card>
  );
}

function ServerFigures({ server }: { server: HostingServerResponse }) {
  const { cpu, memory, disks, estimate } = server;
  return (
    <div className="stack">
      <div className="hosting-estimate" role="status">
        <p>
          <strong>
            {t('web.hosting_server_est_prefix')} {formatNumber(estimate.moreSmallBots)}{' '}
            {t('web.hosting_server_est_small')}
          </strong>
        </p>
        <p className="muted small">
          {formatNumber(estimate.moreMediumBots)} {t('web.hosting_server_est_medium')} ·{' '}
          {formatNumber(estimate.moreLargeBots)} {t('web.hosting_server_est_large')} ·{' '}
          {t('web.hosting_server_est_note')}
        </p>
        {estimate.blockedBy !== null && (
          <Banner tone="warn">
            {estimate.blockedBy === 'MEMORY'
              ? t('web.hosting_server_blocked_memory')
              : t('web.hosting_server_blocked_disk')}
          </Banner>
        )}
      </div>
      <div className="hosting-meters">
        <div className="stack-sm">
          <Meter
            label={t('web.hosting_server_cpu')}
            used={`${formatNumber(Math.round(cpu.loadPercent))}%`}
            total={`${formatNumber(cpu.cores)} ${t('web.hosting_server_cpu_detail')} ${cpu.loadAverage1m.toFixed(2)}`}
            value={cpu.loadPercent}
            max={100}
          />
        </div>
        <div className="stack-sm">
          {memory.availableBytes === null ? (
            <KV
              items={[[t('web.hosting_server_memory'), t('web.hosting_server_memory_unknown')]]}
            />
          ) : (
            <Meter
              label={t('web.hosting_server_memory')}
              used={bytesText(memory.availableBytes)}
              total={bytesText(memory.totalBytes)}
              value={memory.totalBytes - memory.availableBytes}
              max={memory.totalBytes}
            />
          )}
        </div>
        {disks.map((disk) => (
          <div className="stack-sm" key={disk.path}>
            <Meter
              label={`${t('web.hosting_server_disk')} ${disk.path}`}
              used={`${formatNumber(Math.round(disk.usedPercent))}% ${t('web.hosting_server_disk_used')}`}
              total={bytesText(disk.totalBytes)}
              value={disk.usedPercent}
              max={100}
            />
          </div>
        ))}
      </div>
      <Disclosure summary={t('web.hosting_server_formula')} size="sm">
        <KV
          columns
          items={[
            [t('web.hosting_server_budget'), formatNumber(estimate.budgetConcurrentCustomers)],
            [t('web.hosting_server_owner'), formatNumber(estimate.ownerReserved)],
            [t('web.hosting_server_live'), formatNumber(estimate.liveHostedBots)],
            [t('web.hosting_server_headroom'), formatNumber(estimate.headroom)],
          ]}
        />
        <pre className="hosting-formula-text">
          <Ltr>{estimate.formula}</Ltr>
        </pre>
        <p className="muted small">
          {t('web.hosting_server_measured')} {formatTimestamp(server.measuredAt)}
        </p>
      </Disclosure>
    </div>
  );
}
