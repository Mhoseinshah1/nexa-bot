import { useEffect, useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppCaptchaResultSchema,
  type MiniAppCaptchaResult,
  type MiniAppMeResponse,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { Button, Card, Message, errorText } from '../ui.js';

type Question = NonNullable<
  Extract<NonNullable<MiniAppMeResponse['gate']>, { kind: 'CAPTCHA' }>['question']
>;

/**
 * `captcha.kind` IMAGE_NUMBER at the mini app's gate: the picture of the session's pending
 * question (fetched with the session, never cached), a digit input, and «🔄 تصویر جدید».
 * Judged by the server exactly as a typed answer in the chat is; nothing is decided here.
 * An expired question is renewed by asking for a new picture; a cooldown is only reported.
 */
export function CaptchaImageGate({ question }: { question: Question }) {
  const { api, refreshMe } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [image, setImage] = useState<
    { state: 'loading' } | { state: 'failed' } | { state: 'ready'; src: string }
  >({ state: 'loading' });
  const current = question.state === 'CURRENT';

  // An expired question is renewed (a new picture), then the gate is read again.
  useEffect(() => {
    if (question.state !== 'EXPIRED') return;
    void api
      .post(MINIAPP_ROUTES.captchaRefresh, {}, miniAppCaptchaResultSchema)
      .then(() => refreshMe())
      .catch(() => setImage({ state: 'failed' }));
  }, [api, question.state, refreshMe]);

  useEffect(() => {
    if (!current) return;
    let live = true;
    let url: string | null = null;
    setImage({ state: 'loading' });
    api.blob(MINIAPP_ROUTES.captchaImage, {}).then(
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
  }, [api, current, version]);

  const run = async (call: () => Promise<MiniAppCaptchaResult>) => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await call();
      if (result.result === 'WRONG') {
        setNotice(t('miniapp.gate_captcha_wrong', { remaining: result.remaining ?? 1 }));
      }
      setText('');
      setVersion((previous) => previous + 1);
      await refreshMe();
    } catch (failure) {
      setNotice(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  if (question.state === 'LOCKED') return <Message text={t('miniapp.gate_captcha_locked')} />;

  return (
    <main className="page">
      <Card>
        <h1 className="title">{t('miniapp.gate_captcha_image_title')}</h1>
        <p>{t('miniapp.gate_captcha_image')}</p>
        {image.state === 'ready' && (
          <img src={image.src} width={320} height={120} alt={t('miniapp.gate_captcha_alt')} />
        )}
        {image.state === 'failed' && (
          <p className="error">{t('miniapp.gate_captcha_image_failed')}</p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() === '' || busy) return;
            void run(() =>
              api.post(MINIAPP_ROUTES.captchaAnswer, {}, miniAppCaptchaResultSchema, { text }),
            );
          }}
        >
          <input
            type="text"
            inputMode="numeric"
            autoComplete="off"
            dir="ltr"
            maxLength={16}
            value={text}
            aria-label={t('miniapp.gate_captcha_input')}
            placeholder={t('miniapp.gate_captcha_input')}
            onChange={(event) => setText(event.target.value)}
          />
          <Button primary type="submit" disabled={busy || text.trim() === ''}>
            {t('miniapp.gate_captcha_submit')}
          </Button>
        </form>
        {question.refreshesLeft > 0 && (
          <Button
            disabled={busy}
            onClick={() =>
              void run(() =>
                api.post(MINIAPP_ROUTES.captchaRefresh, {}, miniAppCaptchaResultSchema),
              )
            }
          >
            {t('miniapp.gate_captcha_refresh')}
          </Button>
        )}
        {notice !== null && <p className="error">{notice}</p>}
      </Card>
    </main>
  );
}
