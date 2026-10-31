import { useEffect, useState } from 'react';
import { MINIAPP_ROUTES, type QrPayloadKind } from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { Sheet } from '../sheet.js';
import { Button, Ltr } from '../ui.js';

/**
 * QR و لینک: the subscription link as the server's one QR renderer draws it, with the link
 * itself and a copy button. Not drawn: the «کانفیگ تکی» and «فایل» tabs (connection files
 * are sent to the chat as documents; a single config is not a separate read) and «ذخیره
 * تصویر» / «اشتراک‌گذاری» (no reliable save or share inside Telegram's web view).
 */
export function QrSheet({
  serviceId,
  link,
  kinds,
  onClose,
}: {
  serviceId: string;
  link: string;
  /** R11 A4, the QR kind: the QRs the server offers, in order — one, or both. */
  kinds: readonly QrPayloadKind[];
  onClose: () => void;
}) {
  return (
    <Sheet title={t('miniapp.service_qr_title')} onClose={onClose}>
      {kinds.map((kind) => (
        <QrImage
          key={kind}
          serviceId={serviceId}
          kind={kind}
          // A caption only when there is more than one to tell apart.
          captioned={kinds.length > 1}
        />
      ))}
      <p className="sheet-hint">{t('miniapp.service_qr_hint')}</p>
      <CopyLink link={link} onClose={onClose} />
    </Sheet>
  );
}

function QrImage({
  serviceId,
  kind,
  captioned,
}: {
  serviceId: string;
  kind: QrPayloadKind;
  captioned: boolean;
}) {
  const { api } = useApp();
  const [image, setImage] = useState<
    { state: 'loading' } | { state: 'failed' } | { state: 'ready'; src: string }
  >({ state: 'loading' });

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    api.blob(MINIAPP_ROUTES.serviceQrKind, { serviceId, kind }).then(
      (made) => {
        url = made;
        if (live) setImage({ state: 'ready', src: made });
        else URL.revokeObjectURL(made);
      },
      () => live && setImage({ state: 'failed' }),
    );
    return () => {
      live = false;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [api, serviceId, kind]);
  return (
    <>
      {captioned && (
        <p className="sheet-hint">
          {t(kind === 'SINGBOX' ? 'miniapp.service_qr_singbox' : 'miniapp.service_qr_sublink')}
        </p>
      )}
      <div className="qr-frame">
        {image.state === 'loading' && <p className="muted">{t('miniapp.loading')}</p>}
        {image.state === 'failed' && <p className="error">{t('miniapp.service_qr_failed')}</p>}
        {image.state === 'ready' && (
          <img className="qr" src={image.src} alt={t('miniapp.service_qr_alt')} />
        )}
      </div>
    </>
  );
}

function CopyLink({ link, onClose }: { link: string; onClose: () => void }) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopy('copied');
    } catch (error) {
      // A refused or missing clipboard is an answer, not a crash: the link is on screen.
      if (!(error instanceof DOMException) && !(error instanceof TypeError)) throw error;
      setCopy('failed');
    }
  };

  return (
    <>
      <p className="secret">
        <Ltr>{link}</Ltr>
      </p>
      {copy === 'failed' && <p className="error">{t('miniapp.service_copy_failed')}</p>}
      <div className="sheet-actions">
        <Button primary onClick={() => void copyLink()}>
          {copy === 'copied' ? t('miniapp.service_copied') : t('miniapp.service_copy_link')}
        </Button>
        <Button onClick={onClose}>{t('miniapp.sheet_close')}</Button>
      </div>
    </>
  );
}
