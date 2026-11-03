import { useState } from 'react';
import { MINIAPP_ROUTES, miniAppMeResponseSchema, type MiniAppMeResponse } from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import {
  botPhonePromptLink,
  contactRequestAvailable,
  openTelegram,
  requestOwnContact,
} from '../telegram.js';
import { PHONE_POLL_ATTEMPTS, PHONE_POLL_INTERVAL_MS } from '../phone.js';
import { Button, Card, Ltr, Message, errorText } from '../ui.js';

/**
 * The bot's four gates, shown where the bot would answer with them: blocked, the `/start`
 * captcha (R10 D5 — answered in the chat only, so this says so and opens the bot), the required
 * channels (with the fresh re-check), the current terms (with their accept button). Only
 * the channels Telegram says are MISSING are listed: the service returns no per-channel
 * "joined" state, so the design's «۱ از ۲», its progress bar and its ticks are not drawn, nor
 * its «عضویت به‌صورت خودکار بررسی می‌شود» line (nothing re-checks by itself; the button does).
 * The layout is the artboard's: the mark, the title and the sentence centred, the channels in
 * one glass card (avatar, @handle, join), the full-width check button under it.
 */
export function Gate({ gate }: { gate: NonNullable<MiniAppMeResponse['gate']> }) {
  const { api, me, refreshMe } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refreshMe();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  if (gate.kind === 'BLOCKED') return <Message text={t('miniapp.gate_blocked')} />;

  if (gate.kind === 'CAPTCHA') {
    return (
      <Message
        text={t('miniapp.gate_captcha')}
        action={
          me.botLink === null ? undefined : (
            <Button primary onClick={() => openTelegram(me.botLink as string)}>
              {t('miniapp.gate_captcha_open_bot')}
            </Button>
          )
        }
      />
    );
  }

  if (gate.kind === 'CHANNELS') {
    return (
      <main className="page">
        <header className="gate-hero">
          <div className="gate-mark" aria-hidden="true">
            <svg
              width="38"
              height="38"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
            >
              <path d="M3 11l18-8-8 18-2-8z" />
            </svg>
          </div>
          <h1 className="title">{t('miniapp.gate_title')}</h1>
          <p>{t('miniapp.gate_channels')}</p>
        </header>
        <Card>
          <ul className="list">
            {gate.channels.map((channel, index) => (
              <li key={channel.joinUrl} className="gate-channel">
                <span className="gate-avatar" aria-hidden="true">
                  {channel.handle === null
                    ? index + 1
                    : (channel.handle.replace(/^@/u, '')[0] ?? '')}
                </span>
                <span className="gate-channel-name">
                  {channel.handle === null ? (
                    t('miniapp.gate_channel_private', { number: index + 1 })
                  ) : (
                    <Ltr>{channel.handle}</Ltr>
                  )}
                </span>
                <Button onClick={() => openTelegram(channel.joinUrl)}>
                  {t('miniapp.gate_join')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
        <button
          type="button"
          className="btn btn-primary btn-wide"
          disabled={busy}
          onClick={() => act(() => api.post(MINIAPP_ROUTES.gateCheck, {}, miniAppMeResponseSchema))}
        >
          {t('miniapp.gate_check')}
        </button>
        {error !== null && <p className="error">{error}</p>}
      </main>
    );
  }

  /*
   * NEXA v095 PR-4 A: the mandatory phone verification. Where the client has it,
   * `requestContact()` shares the customer's own contact with the bot, which verifies it in the
   * chat; the server is then asked until it no longer holds them. Elsewhere, the bot is opened
   * on its contact prompt.
   */
  if (gate.kind === 'PHONE') {
    const share = () =>
      act(async () => {
        const asked = await requestOwnContact();
        if (asked !== 'shared') return;
        for (let attempt = 0; attempt < PHONE_POLL_ATTEMPTS; attempt += 1) {
          const fresh = await api.get(MINIAPP_ROUTES.me, {}, miniAppMeResponseSchema);
          if (fresh.gate?.kind !== 'PHONE') return;
          await new Promise((resolve) => {
            setTimeout(resolve, PHONE_POLL_INTERVAL_MS);
          });
        }
        setError(t('miniapp.gate_phone_pending'));
      });
    return (
      <Message
        text={t('miniapp.gate_phone')}
        action={
          <>
            {contactRequestAvailable() ? (
              <Button primary disabled={busy} onClick={() => void share()}>
                {t('miniapp.gate_phone_share')}
              </Button>
            ) : (
              me.botLink !== null && (
                <Button
                  primary
                  onClick={() => openTelegram(botPhonePromptLink(me.botLink as string))}
                >
                  {t('miniapp.gate_phone_open_bot')}
                </Button>
              )
            )}
            {error !== null && <p className="error">{error}</p>}
          </>
        }
      />
    );
  }

  return (
    <main className="page">
      <Card>
        <h1 className="title">{gate.terms.title}</h1>
        <p className="prose">{gate.terms.body}</p>
        <Button
          primary
          disabled={busy}
          onClick={() =>
            act(() =>
              api.post(MINIAPP_ROUTES.termsAccept, {}, miniAppMeResponseSchema, {
                termsVersionId: gate.terms.versionId,
              }),
            )
          }
        >
          {t('miniapp.gate_terms_accept')}
        </Button>
        {error !== null && <p className="error">{error}</p>}
      </Card>
    </main>
  );
}
