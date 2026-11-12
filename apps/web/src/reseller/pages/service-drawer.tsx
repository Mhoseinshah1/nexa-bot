import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MiniAppServiceAction, MoneyWire, ResellerServiceDetail } from '@nexa/contracts';
import { ApiError } from '../../api/client';
import { errorText } from '../../error-text';
import { formatMoneyText, formatNumber } from '../../format';
import { t } from '../../i18n/web.fa';
import {
  Banner,
  Button,
  CopyButton,
  Empty,
  Field,
  Input,
  Skeleton,
  TabPanel,
  Tabs,
  useToast,
} from '../../ui/kit';
import { Drawer } from '../../ui/overlays';
import { queryState } from '../../view-state';
import {
  fetchConnectionFiles,
  fetchOffer,
  fetchServiceDetail,
  newIdempotencyKey,
  payOrderFromWallet,
  quoteService,
  rotateLink,
  saveServiceNote,
  sendConnection,
  sendConnectionFiles,
  serviceFileUrl,
  serviceFilesZipUrl,
  serviceQrUrl,
} from '../api';
import { SCREEN_PATHS, goTo } from '../route';
import { Expiry, StateBadge, Usage } from '../view';

export type DrawerTab = 'link' | 'renew' | 'traffic';

/**
 * How often an open drawer re-reads its service while a change is in flight (`working`: a
 * rotation, a suspension or a move the worker has not finished), so the link and the QR it
 * shows are the ones the panel holds once the change lands.
 */
export const SERVICE_WORKING_POLL_MS = 2000;

/**
 * A short name of the link a QR encodes, for the image address: a rotated link is a new
 * address, so the browser fetches the new picture instead of showing the one it holds.
 */
function linkVersion(link: string): string {
  let hash = 5381;
  for (let index = 0; index < link.length; index += 1) {
    hash = ((hash << 5) + hash + link.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

/** Every query a purchase or a note touches, so the lists behind the drawer stay true. */
function useRefreshPanelData() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['reseller'] });
}

/**
 * The «مدیریت» drawer: connection (link, QR, files), renewal and extra traffic or time, and the
 * service's note. Everything is read from `GET /services/:id`; what that answer does not offer
 * (`subscriptionUrl`, `qrKinds`, `filesOffered`, `canRotateLink`, `actions`) is not drawn.
 */
export function ServiceDrawer({
  serviceId,
  initialTab = 'link',
  onClose,
}: {
  serviceId: string;
  initialTab?: DrawerTab;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['reseller', 'service', serviceId],
    queryFn: () => fetchServiceDetail(serviceId),
    // Codex on #469: «لینک تازه» only schedules the rotation; the drawer keeps reading until
    // the worker has finished it, then draws the new link and QR.
    refetchInterval: (current) =>
      current.state.data?.working === true ? SERVICE_WORKING_POLL_MS : false,
  });
  const detail = query.data;
  const [tab, setTab] = useState<DrawerTab>(initialTab);

  const tabs: { id: DrawerTab; label: string }[] = [{ id: 'link', label: t('web.rp_tab_link') }];
  if (detail?.actions.includes('RENEW') === true) {
    tabs.push({ id: 'renew', label: t('web.rp_tab_renew') });
  }
  if (detail?.actions.some((action) => action !== 'RENEW') === true) {
    tabs.push({ id: 'traffic', label: t('web.rp_tab_traffic') });
  }
  const active = tabs.some((one) => one.id === tab) ? tab : 'link';

  return (
    <Drawer
      open
      onClose={onClose}
      title={
        detail === undefined ? t('web.rp_drawer_label') : <span dir="ltr">{detail.username}</span>
      }
    >
      {detail === undefined ? (
        queryState(query) === 'error' ? (
          <Empty variant="error" title={errorText(query.error)} />
        ) : (
          <Skeleton rows={4} cols={2} />
        )
      ) : (
        <div className="rp-drawer">
          <div className="rp-drawer-head">
            <span className="muted small">
              {[detail.product, detail.location].filter((part) => part !== null).join(' • ')}
            </span>
            <div className="rp-line">
              <StateBadge value={detail.state} />
              <Expiry row={detail} />
            </div>
            <Usage row={detail} />
          </div>
          <Tabs
            value={active}
            onChange={setTab}
            items={tabs}
            panelId="rp-drawer-panel"
            label={t('web.rp_tabs_label')}
          />
          <TabPanel id="rp-drawer-panel" labelledBy={`rp-drawer-panel-tab-${active}`}>
            {active === 'link' && <ConnectionTab detail={detail} />}
            {active === 'renew' && <OfferTab serviceId={detail.id} kinds={['RENEW']} />}
            {active === 'traffic' && (
              <OfferTab
                serviceId={detail.id}
                kinds={(['ADD_TRAFFIC', 'ADD_TIME'] as const).filter((kind) =>
                  detail.actions.includes(kind),
                )}
              />
            )}
          </TabPanel>
          <NoteEditor detail={detail} />
        </div>
      )}
    </Drawer>
  );
}

// --- Connection ---------------------------------------------------------------------------

function ConnectionTab({ detail }: { detail: ResellerServiceDetail }) {
  const toast = useToast();
  const client = useQueryClient();
  const [qrKind, setQrKind] = useState<string | null>(null);
  // One key per press of «لینک تازه»; a retry of the SAME press reuses it, a new press starts over.
  const rotateKey = useRef(newIdempotencyKey());
  const send = useMutation({
    mutationFn: () => sendConnection(detail.id),
    onSuccess: () => toast({ tone: 'ok', message: t('web.rp_sent_connection') }),
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const rotate = useMutation({
    mutationFn: () => rotateLink(detail.id, rotateKey.current),
    onSuccess: () => {
      rotateKey.current = newIdempotencyKey();
      toast({ tone: 'ok', message: t('web.rp_rotated') });
      // The rotation is now in flight: re-read the service, which answers `working` and so
      // keeps the drawer reading until the new link exists.
      void client.invalidateQueries({ queryKey: ['reseller', 'service', detail.id] });
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });

  const showLink = !detail.filesOnly && detail.subscriptionUrl !== null;
  const kind = qrKind ?? detail.qrKinds[0] ?? null;
  return (
    <div className="rp-stack">
      {showLink && detail.subscriptionUrl !== null && (
        <>
          {kind !== null && (
            <div className="rp-qr-box">
              {detail.qrKinds.length > 1 && (
                <div className="rp-chips" role="group" aria-label={t('web.rp_qr_alt')}>
                  {detail.qrKinds.map((one) => (
                    <button
                      key={one}
                      type="button"
                      className={`rp-chip${one === kind ? ' on' : ''}`}
                      aria-pressed={one === kind}
                      onClick={() => setQrKind(one)}
                    >
                      {one === 'SINGBOX' ? t('web.rp_qr_singbox') : t('web.rp_qr_sublink')}
                    </button>
                  ))}
                </div>
              )}
              <img
                className="rp-qr"
                src={serviceQrUrl(detail.id, kind, linkVersion(detail.subscriptionUrl))}
                alt={t('web.rp_qr_alt')}
                width={180}
                height={180}
              />
              {kind === 'SINGBOX' && detail.singboxProfileName !== null && (
                <span className="muted small">
                  {t('web.rp_singbox_profile').replace('{name}', detail.singboxProfileName)}
                </span>
              )}
            </div>
          )}
          <div className="rp-link">
            <span dir="ltr" className="rp-mono" aria-label={t('web.rp_link_label')}>
              {detail.subscriptionUrl}
            </span>
            <CopyButton value={detail.subscriptionUrl} />
          </div>
          <div className="rp-line">
            <Button size="sm" disabled={send.isPending} onClick={() => send.mutate()}>
              {t('web.rp_send_connection')}
            </Button>
            {detail.canRotateLink && (
              <Button
                size="sm"
                disabled={rotate.isPending || detail.working}
                onClick={() => rotate.mutate()}
              >
                {t('web.rp_rotate')}
              </Button>
            )}
          </div>
          {detail.canRotateLink && <p className="muted small">{t('web.rp_rotate_hint')}</p>}
          {detail.working && (
            <Banner tone="info" role="status">
              {t('web.rp_rotating')}
            </Banner>
          )}
        </>
      )}
      {detail.filesOnly && <Banner tone="info">{t('web.rp_files_only')}</Banner>}
      {!detail.filesOnly && !showLink && !detail.filesOffered && (
        <Banner tone="info">{t('web.rp_no_link')}</Banner>
      )}
      {detail.filesOffered && <FilesBlock serviceId={detail.id} />}
    </div>
  );
}

/**
 * «فایل‌های اتصال»: fetched from the panel when the block opens, held in memory only (no cache
 * past the screen: `gcTime: 0`), and handed to the browser by plain links so the bytes stream
 * straight from the API — nothing here reads, stores or re-serves a file.
 */
export function FilesBlock({ serviceId }: { serviceId: string }) {
  const toast = useToast();
  const files = useQuery({
    queryKey: ['reseller', 'files', serviceId],
    queryFn: () => fetchConnectionFiles(serviceId),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  // The panel's own refusal (`files_unavailable`, not found) is the sentence shown, so the
  // state is asked of `queryState` and the words are the error's.
  const filesState = queryState(files, files.data?.files.length === 0);
  const send = useMutation({
    mutationFn: () => sendConnectionFiles(serviceId),
    onSuccess: () => toast({ tone: 'ok', message: t('web.rp_sent_files') }),
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  return (
    <section className="rp-mini rp-files" aria-label={t('web.rp_files_title')}>
      <div className="rp-line rp-between">
        <b>{t('web.rp_files_title')}</b>
        <span className="muted small">{t('web.rp_files_hint')}</span>
      </div>
      {filesState === 'loading' && <p className="muted small">{t('web.rp_files_loading')}</p>}
      {filesState === 'error' && <Banner tone="danger">{errorText(files.error)}</Banner>}
      {filesState === 'empty' && <p className="muted small">{t('web.rp_files_empty')}</p>}
      {files.data?.files.map((file) => (
        <div key={file.index} className="rp-file">
          <span dir="ltr" className="rp-mono rp-file-name">
            {file.fileName}
          </span>
          <a
            className="btn sm"
            href={serviceFileUrl(serviceId, file.index)}
            download={file.fileName}
          >
            {t('web.rp_file_download')}
          </a>
        </div>
      ))}
      <div className="rp-line">
        <Button
          size="sm"
          variant="primary"
          disabled={send.isPending || files.data?.files.length === 0}
          onClick={() => send.mutate()}
        >
          {t('web.rp_files_send')}
        </Button>
        {files.data !== undefined && files.data.files.length > 0 && (
          <a className="btn sm" href={serviceFilesZipUrl(serviceId)} download>
            {t('web.rp_files_zip')}
          </a>
        )}
      </div>
      <span className="muted small">{t('web.rp_files_note')}</span>
    </section>
  );
}

// --- Renewal and add-ons --------------------------------------------------------------------

const KIND_HEADING: Readonly<
  Record<MiniAppServiceAction, 'web.rp_offer_traffic' | 'web.rp_offer_time' | null>
> = {
  RENEW: null,
  ADD_TRAFFIC: 'web.rp_offer_traffic',
  ADD_TIME: 'web.rp_offer_time',
};

function OfferTab({
  serviceId,
  kinds,
}: {
  serviceId: string;
  kinds: readonly MiniAppServiceAction[];
}) {
  return (
    <div className="rp-stack">
      {kinds.map((kind) => (
        <OfferPicker key={kind} serviceId={serviceId} kind={kind} />
      ))}
    </div>
  );
}

/** The shortfall a refused wallet payment names, in the order's own currency. */
function shortfallOf(error: unknown, currency: MoneyWire['currency']): MoneyWire | null {
  if (!(error instanceof ApiError) || error.code !== 'commerce.wallet_insufficient_funds') {
    return null;
  }
  const minor = error.details?.['shortfallMinor'];
  return typeof minor === 'string' && /^\d+$/u.test(minor)
    ? { amountMinor: minor, currency }
    : null;
}

function OfferPicker({ serviceId, kind }: { serviceId: string; kind: MiniAppServiceAction }) {
  const toast = useToast();
  const refresh = useRefreshPanelData();
  const offer = useQuery({
    queryKey: ['reseller', 'offer', serviceId, kind],
    queryFn: () => fetchOffer(serviceId, kind),
  });
  const [picked, setPicked] = useState<number | null>(null);
  // Keys belong to ONE attempt at ONE option: pressing pay again after a failure retries it
  // (same keys, so the same draft order and the same settlement), choosing another option or
  // finishing starts a new attempt.
  const keys = useRef({ quote: newIdempotencyKey(), pay: newIdempotencyKey() });
  const [shortfall, setShortfall] = useState<MoneyWire | null>(null);
  useEffect(() => {
    keys.current = { quote: newIdempotencyKey(), pay: newIdempotencyKey() };
    setShortfall(null);
  }, [picked]);

  const options = offer.data?.options ?? [];
  const offerState = queryState(offer, options.length === 0);
  const chosen = picked === null ? undefined : options[picked];
  const pay = useMutation({
    mutationFn: async () => {
      if (chosen === undefined) throw new Error('No option chosen.');
      const order = await quoteService(
        serviceId,
        { kind, addonId: chosen.addonId, planId: chosen.planId },
        keys.current.quote,
      );
      try {
        return await payOrderFromWallet(order.id, keys.current.pay);
      } catch (error) {
        const short = shortfallOf(error, order.total.currency);
        if (short !== null) setShortfall(short);
        throw error;
      }
    },
    onSuccess: () => {
      toast({ tone: 'ok', message: t('web.rp_pay_done') });
      setPicked(null);
      void refresh();
    },
    onError: (error) => {
      if (shortfallOf(error, 'IRT') === null) {
        toast({ tone: 'danger', message: errorText(error), error });
      }
    },
  });

  const heading = KIND_HEADING[kind];
  return (
    <section className="rp-stack" aria-label={heading === null ? undefined : t(heading)}>
      {heading !== null && <h3>{t(heading)}</h3>}
      {offerState === 'loading' && <Skeleton rows={2} cols={2} />}
      {offerState === 'error' && <Banner tone="danger">{errorText(offer.error)}</Banner>}
      {offerState === 'empty' && <p className="muted small">{t('web.rp_offer_none')}</p>}
      {options.length > 0 && (
        <div className="rp-options" role="radiogroup" aria-label={heading ?? t('web.rp_tab_renew')}>
          {options.map((option, index) => (
            <button
              key={`${option.addonId ?? ''}:${option.planId ?? ''}:${index}`}
              type="button"
              role="radio"
              aria-checked={picked === index}
              className={`rp-option${picked === index ? ' on' : ''}`}
              onClick={() => setPicked(index)}
            >
              <span>
                <b>{option.title}</b>
                {option.personalDiscount !== null && (
                  <span className="muted small">
                    {t('web.rp_offer_personal').replace(
                      '{n}',
                      formatNumber(option.personalDiscount.percent),
                    )}
                  </span>
                )}
              </span>
              <b>{formatMoneyText(option.personalDiscount?.price ?? option.price)}</b>
            </button>
          ))}
        </div>
      )}
      {shortfall !== null && (
        <Banner
          tone="warn"
          action={
            <Button size="sm" onClick={() => goTo(SCREEN_PATHS.wallet)}>
              {t('web.rp_pay_charge')}
            </Button>
          }
        >
          {t('web.rp_pay_short').replace('{amount}', formatMoneyText(shortfall))}
        </Banner>
      )}
      {options.length > 0 && (
        <Button
          variant="primary"
          disabled={chosen === undefined || pay.isPending}
          onClick={() => pay.mutate()}
        >
          {kind === 'RENEW' ? t('web.rp_pay_renew') : t('web.rp_pay_traffic')}
        </Button>
      )}
    </section>
  );
}

// --- Note ---------------------------------------------------------------------------------------

function NoteEditor({ detail }: { detail: ResellerServiceDetail }) {
  const toast = useToast();
  const refresh = useRefreshPanelData();
  const [value, setValue] = useState(detail.note ?? '');
  const save = useMutation({
    mutationFn: () => saveServiceNote(detail.id, value.trim() === '' ? null : value.trim()),
    onSuccess: () => {
      toast({ tone: 'ok', message: t('web.rp_note_saved') });
      void refresh();
    },
    onError: (error) => toast({ tone: 'danger', message: errorText(error), error }),
  });
  const dirty = value.trim() !== (detail.note ?? '');
  return (
    <div className="rp-stack">
      <Field label={t('web.rp_note_label')} htmlFor="rp-note">
        <Input
          id="rp-note"
          value={value}
          maxLength={500}
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
      <div>
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {t('web.rp_note_save')}
        </Button>
      </div>
    </div>
  );
}
