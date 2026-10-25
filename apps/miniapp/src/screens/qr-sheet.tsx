import { useEffect, useState } from 'react';
import { MINIAPP_ROUTES } from '@nexa/contracts';
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
  onClose,
}: {
  serviceId: string;
  link: string;
  onClose: () => void;
}) {
  const { api } = useApp();
  const [image, setImage] = useState<
    { state: 'loading' } | { state: 'failed' } | { state: 'ready'; src: string }
  >({ state: 'loading' });
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    let live = true;
    let url: string | null = null;
    api.blob(MINIAPP_ROUTES.serviceQr, { serviceId }).then(
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
  }, [api, serviceId]);

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
    <Sheet title={t('miniapp.service_qr_title')} onClose={onClose}>
      <div className="qr-frame">
        {image.state === 'loading' && <p className="muted">{t('miniapp.loading')}</p>}
        {image.state === 'failed' && <p className="error">{t('miniapp.service_qr_failed')}</p>}
        {image.state === 'ready' && (
          <img className="qr" src={image.src} alt={t('miniapp.service_qr_alt')} />
        )}
      </div>
      <p className="sheet-hint">{t('miniapp.service_qr_hint')}</p>
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
    </Sheet>
  );
}
