import { useState } from 'react';
import {
  MINIAPP_ROUTES,
  miniAppMeResponseSchema,
  type MiniAppMeResponse,
} from '@nexa/contracts';
import { useApp } from '../app.js';
import { t } from '../i18n/t.js';
import { openTelegram } from '../telegram.js';
import { Button, Card, Message, errorText } from '../ui.js';

/**
 * The bot's three gates, shown where the bot would answer with them: blocked, the required
 * channels (with the fresh re-check), the current terms (with their accept button). Only
 * the channels Telegram says are MISSING are listed: the service returns no per-channel
 * "joined" state, so the design's «۱ از ۲» and its ticks are not drawn.
 */
export function Gate({ gate }: { gate: NonNullable<MiniAppMeResponse['gate']> }) {
  const { api, refreshMe } = useApp();
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

  if (gate.kind === 'CHANNELS') {
    return (
      <main className="page">
        <Card>
          <p>{t('miniapp.gate_channels')}</p>
          <ul className="list">
            {gate.channels.map((channel, index) => (
              <li key={channel.joinUrl} className="list-row">
                <span>{channel.handle ?? t('miniapp.gate_channel_private', { number: index + 1 })}</span>
                <Button onClick={() => openTelegram(channel.joinUrl)}>{t('miniapp.gate_join')}</Button>
              </li>
            ))}
          </ul>
          <Button
            primary
            disabled={busy}
            onClick={() => act(() => api.post(MINIAPP_ROUTES.gateCheck, {}, miniAppMeResponseSchema))}
          >
            {t('miniapp.gate_check')}
          </Button>
          {error !== null && <p className="error">{error}</p>}
        </Card>
      </main>
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
