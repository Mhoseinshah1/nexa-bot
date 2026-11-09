import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataExportsResponse } from '@nexa/contracts';
import { dataExportDownloadHref, fetchDataExports, requestDataExport } from '../api/client';
import { errorText } from '../error-text';
import { t } from '../i18n/web.fa';
import { pollUnlessFinalWhile } from '../polling';
import { RUN_KEY_HELD_MS, useSubmissionKey } from '../submission-key';
import { Banner, Button, Card, PageHead, StateSwitch, useToast } from '../ui/kit';
import { ErrorRef } from '../ui/technical-details';
import { DataExportAbout, DataExportList, hasActiveExport } from './data-export-parts';

const DATA_EXPORT_KEY = ['data-export', 'own'] as const;

/**
 * «خروجی داده» — a hosted bot's owner takes a plain, documented copy of their data
 * (phase 6B PR-3, ADR-0039). One button asks; the worker makes the ZIP through the heavy-job
 * queue; the finished file downloads for 24 hours. The server charges `data.export` on every
 * call, so the denied state here only draws what the server would refuse anyway.
 */
export function DataExportPage({ denied }: { denied: boolean }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const exports = useQuery({
    queryKey: DATA_EXPORT_KEY,
    queryFn: fetchDataExports,
    enabled: !denied,
    // While one is being made the list refreshes itself; once settled it stops.
    refetchInterval: pollUnlessFinalWhile<DataExportsResponse>(4000, (data) =>
      hasActiveExport(data.exports),
    ),
  });
  const submission = useSubmissionKey({ heldForMs: RUN_KEY_HELD_MS });
  const request = useMutation({
    retry: false,
    // One key per submission: a press whose answer was lost is the same command, a press after
    // an answer (or much later) is a new one.
    mutationFn: () => requestDataExport(submission.current('data-export')),
    onError: (error) => submission.settleOn(error),
    onSuccess: () => {
      submission.settle();
      toast({ tone: 'ok', message: t('web.data_export_requested') });
      void queryClient.invalidateQueries({ queryKey: DATA_EXPORT_KEY });
    },
  });
  const active = hasActiveExport(exports.data?.exports);
  return (
    <div className="data-export-page stack">
      <PageHead title={t('web.data_export_title')} subtitle={t('web.data_export_subtitle')} />
      <Card
        title={t('web.data_export_what_title')}
        actions={
          <Button
            variant="primary"
            icon="download"
            disabled={denied || request.isPending || active}
            onClick={() => request.mutate()}
          >
            {request.isPending ? t('web.data_export_requesting') : t('web.data_export_request')}
          </Button>
        }
      >
        <DataExportAbout />
        {request.error !== null && (
          <Banner tone="danger">
            {errorText(request.error)}
            <ErrorRef error={request.error} />
          </Banner>
        )}
      </Card>
      <StateSwitch query={exports} denied={denied}>
        <section className="stack" aria-labelledby="data-export-list-heading">
          <h2 id="data-export-list-heading">{t('web.data_export_list_title')}</h2>
          <DataExportList exports={exports.data?.exports ?? []} hrefFor={dataExportDownloadHref} />
        </section>
      </StateSwitch>
    </div>
  );
}
