import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataExportsResponse, HostedBotView } from '@nexa/contracts';
import {
  fetchHostedDataExports,
  hostedDataExportDownloadHref,
  requestHostedDataExport,
} from '../api/client';
import { t } from '../i18n/web.fa';
import { pollUnlessFinalWhile } from '../polling';
import { Button, StateSwitch, useToast } from '../ui/kit';
import { DataExportAbout, DataExportList, hasActiveExport } from './data-export-parts';
import { CodePromptDialog } from './hosting-parts';

/**
 * «خروجی داده» inside one hosted bot's card in «میزبانی‌ها» (phase 6B PR-3): the installation
 * owner asks for the bot's ZIP with a FRESH second-factor code, and takes it from the same
 * list. The request is audited in the OWNER's log, never in the hosted bot's (D5). The server
 * charges the section session and the code; nothing here is the security.
 */
export function DataExportSection({ bot }: { bot: HostedBotView }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const key = ['hosting', 'data-export', bot.tenantId] as const;
  const exports = useQuery({
    queryKey: key,
    queryFn: () => fetchHostedDataExports(bot.tenantId),
    refetchInterval: pollUnlessFinalWhile<DataExportsResponse>(4000, (data) =>
      hasActiveExport(data.exports),
    ),
  });
  const active = hasActiveExport(exports.data?.exports);
  return (
    <div className="stack data-export-host">
      <p className="muted small">{t('web.hosting_data_export_hint')}</p>
      <DataExportAbout />
      <div className="btn-group">
        <Button icon="download" disabled={active} onClick={() => setAsking(true)}>
          {t('web.hosting_data_export_request')}
        </Button>
      </div>
      <StateSwitch query={exports}>
        <DataExportList
          exports={exports.data?.exports ?? []}
          hrefFor={(id) => hostedDataExportDownloadHref(bot.tenantId, id)}
        />
      </StateSwitch>
      {asking && (
        <CodePromptDialog
          title={`${t('web.hosting_data_export_title')} — ${bot.displayName}`}
          hint={t('web.hosting_data_export_hint')}
          confirmLabel={t('web.hosting_data_export_submit')}
          pendingLabel={t('web.hosting_data_export_pending')}
          run={({ proof, idempotencyKey }) =>
            requestHostedDataExport(bot.tenantId, { idempotencyKey, proof })
          }
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            toast({ tone: 'ok', message: t('web.data_export_requested') });
            void queryClient.invalidateQueries({ queryKey: key });
          }}
        />
      )}
    </div>
  );
}
