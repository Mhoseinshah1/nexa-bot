import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  APPEARANCE_ERROR_CODES,
  CUSTOM_EMOJI_ID_PATTERN,
  appearanceMarker,
  type AppearanceBotView,
  type AppearanceSlot,
  type AppearanceSlotView,
  type AppearanceTestErrorCode,
  type AppearanceTestOutcome,
} from '@nexa/contracts';
import {
  ApiError,
  fetchAppearance,
  resetAppearanceSlot,
  saveAppearanceSlot,
  testAppearance,
} from '../api/client';
import { formatTimestamp } from '../format';
import { useSubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  Field,
  Ltr,
  PageHead,
  StateSwitch,
  Switch,
  useToast,
  type Tone,
} from '../ui/kit';

/**
 * «🎨 ظاهر ربات» (Premium UI, `docs/premium-ui-audit.md`).
 *
 * Every semantic icon the bot draws, as one row: its Persian name, the catalogue's fallback
 * emoji, the tenant's Telegram custom emoji id, a switch, a preview and a reset. The page
 * cannot render a custom emoji — only Telegram can — so the preview says WHICH of the two
 * the customer will see and shows the fallback beside it, and the real check is the test
 * message: a real send through one bot to the operator's own chat, whose actual answer is
 * recorded per bot and shown here. A bot that has not answered `SENT` draws the fallback.
 *
 * **Buttons are drawn from permissions, and that is a courtesy.** The server charges
 * `settings.view` for the read and `settings.edit` for every save, reset and test.
 */

const SLOT_LABEL: Readonly<Record<AppearanceSlot, WebKey>> = {
  success: 'web.appearance_slot_success',
  error: 'web.appearance_slot_error',
  warning: 'web.appearance_slot_warning',
  info: 'web.appearance_slot_info',
  payment: 'web.appearance_slot_payment',
  wallet: 'web.appearance_slot_wallet',
  purchase: 'web.appearance_slot_purchase',
  service: 'web.appearance_slot_service',
  trial: 'web.appearance_slot_trial',
  referral: 'web.appearance_slot_referral',
  support: 'web.appearance_slot_support',
  ticket: 'web.appearance_slot_ticket',
  renewal: 'web.appearance_slot_renewal',
  traffic: 'web.appearance_slot_traffic',
  time: 'web.appearance_slot_time',
  date: 'web.appearance_slot_date',
  link: 'web.appearance_slot_link',
  user: 'web.appearance_slot_user',
  location: 'web.appearance_slot_location',
  active: 'web.appearance_slot_active',
  inactive: 'web.appearance_slot_inactive',
};

const OUTCOME_LABEL: Readonly<Record<AppearanceTestOutcome, WebKey>> = {
  SENT: 'web.appearance_test_outcome_sent',
  REJECTED: 'web.appearance_test_outcome_rejected',
  UNREACHABLE: 'web.appearance_test_outcome_unreachable',
  RATE_LIMITED: 'web.appearance_test_outcome_rate_limited',
};
const OUTCOME_TONE: Readonly<Record<AppearanceTestOutcome, Tone>> = {
  SENT: 'ok',
  REJECTED: 'danger',
  UNREACHABLE: 'warn',
  RATE_LIMITED: 'warn',
};
const TOAST_LABEL: Readonly<Record<AppearanceTestOutcome, WebKey>> = {
  SENT: 'web.appearance_test_toast_sent',
  REJECTED: 'web.appearance_test_toast_rejected',
  UNREACHABLE: 'web.appearance_test_toast_unreachable',
  RATE_LIMITED: 'web.appearance_test_toast_rate_limited',
};
const ERROR_LABEL: Readonly<Record<AppearanceTestErrorCode, WebKey>> = {
  'appearance.custom_emoji_refused': 'web.appearance_test_error_custom_emoji_refused',
  'appearance.chat_unavailable': 'web.appearance_test_error_chat_unavailable',
  'appearance.telegram_rejected': 'web.appearance_test_error_telegram_rejected',
  'appearance.telegram_unreachable': 'web.appearance_test_error_telegram_unreachable',
  'appearance.rate_limited': 'web.appearance_test_error_rate_limited',
};

/** The page's own refusals in the operator's words; everything else is the shared sentence. */
function appearanceMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === APPEARANCE_ERROR_CODES.ADMIN_NOT_BOUND) {
      return t('web.appearance_test_not_bound');
    }
    if (error.code === APPEARANCE_ERROR_CODES.NOTHING_TO_TEST) {
      return t('web.appearance_test_nothing');
    }
    if (error.code === APPEARANCE_ERROR_CODES.BOT_NOT_ACTIVE) {
      return t('web.appearance_test_no_bot');
    }
  }
  return messageFor(error);
}

export function AppearancePage({ denied, mayEdit }: { denied: boolean; mayEdit: boolean }) {
  const appearance = useQuery({
    queryKey: ['appearance'],
    queryFn: fetchAppearance,
    enabled: !denied,
  });
  const view = appearance.data;

  return (
    <>
      <PageHead title={t('web.appearance_title')} subtitle={t('web.appearance_intro')} />
      <StateSwitch query={appearance} denied={denied} isEmpty={false}>
        {view !== undefined && (
          <>
            <Card title={t('web.appearance_slots_title')} hint={t('web.appearance_slots_hint')}>
              <div className="tbl-wrap">
                <table className="tbl">
                  <caption className="visually-hidden">{t('web.appearance_slots_title')}</caption>
                  <thead>
                    <tr>
                      <th>{t('web.appearance_col_slot')}</th>
                      <th>{t('web.appearance_col_fallback')}</th>
                      <th>{t('web.appearance_col_custom')}</th>
                      <th>{t('web.appearance_col_enabled')}</th>
                      <th>{t('web.appearance_col_preview')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {view.slots.map((slot) => (
                      // Re-seeded from the server whenever the stored row moves on.
                      <SlotRow
                        key={`${slot.slot}:${String(slot.version ?? 0)}`}
                        slot={slot}
                        mayEdit={mayEdit}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <TestCard
              bots={view.bots}
              operatorTelegramBound={view.operatorTelegramBound}
              configured={view.slots.some((slot) => slot.enabled && slot.customEmojiId !== null)}
              mayEdit={mayEdit}
            />
          </>
        )}
      </StateSwitch>
    </>
  );
}

function SlotRow({ slot, mayEdit }: { slot: AppearanceSlotView; mayEdit: boolean }) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [customEmojiId, setCustomEmojiId] = useState(slot.customEmojiId ?? '');
  const [enabled, setEnabled] = useState(slot.enabled);
  const label = t(SLOT_LABEL[slot.slot]);
  const trimmed = customEmojiId.trim();
  const valid = trimmed === '' || CUSTOM_EMOJI_ID_PATTERN.test(trimmed);
  const dirty =
    (trimmed === '' ? null : trimmed) !== slot.customEmojiId || enabled !== slot.enabled;

  const settle = async () => {
    submission.settle();
    await client.invalidateQueries({ queryKey: ['appearance'] });
  };
  const save = useMutation({
    mutationFn: (command: { customEmojiId: string | null; enabled: boolean }) =>
      saveAppearanceSlot({
        slot: slot.slot,
        ...command,
        expectedVersion: slot.version,
        idempotencyKey: submission.current({ slot: slot.slot, ...command, v: slot.version }),
      }),
    onSuccess: async (result) => {
      notify({
        tone: 'ok',
        message: result.changed ? t('web.appearance_saved') : t('web.appearance_unchanged'),
      });
      await settle();
    },
    onError: (error: unknown) => submission.settleOn(error),
  });
  const reset = useMutation({
    mutationFn: () =>
      resetAppearanceSlot({
        slot: slot.slot,
        // The version this row was read at: a stale reset is a conflict, never a deletion.
        expectedVersion: slot.version,
        idempotencyKey: submission.current({ slot: slot.slot, reset: true, v: slot.version }),
      }),
    onSuccess: async () => {
      notify({ tone: 'ok', message: t('web.appearance_reset_done') });
      await settle();
    },
    onError: (error: unknown) => submission.settleOn(error),
  });
  const busy = save.isPending || reset.isPending;
  const failure = save.error ?? reset.error;
  const previewCustom = enabled && trimmed !== '' && valid;

  return (
    <tr data-slot={slot.slot}>
      <td>
        <span className="strong">{label}</span>
        <p className="muted small">
          {t('web.appearance_marker')} <Ltr>{appearanceMarker(slot.slot)}</Ltr>
        </p>
      </td>
      <td>
        <span aria-label={t('web.appearance_col_fallback')}>{slot.fallback}</span>
      </td>
      <td>
        <Field
          label={`${t('web.appearance_col_custom')}: ${label}`}
          hint={t('web.appearance_custom_id_hint')}
          htmlFor={`appearance-${slot.slot}`}
          {...(valid ? {} : { error: t('web.appearance_custom_id_invalid') })}
        >
          <input
            id={`appearance-${slot.slot}`}
            dir="ltr"
            inputMode="numeric"
            value={customEmojiId}
            disabled={!mayEdit || busy}
            onChange={(event) => setCustomEmojiId(event.target.value)}
          />
        </Field>
      </td>
      <td>
        <Switch
          checked={enabled}
          label={`${t('web.appearance_col_enabled')}: ${label}`}
          disabled={!mayEdit || busy}
          onChange={setEnabled}
        />
      </td>
      <td>
        <span className="strong">{slot.fallback}</span>{' '}
        <Badge tone={previewCustom ? 'ok' : 'neutral'}>
          {previewCustom
            ? t('web.appearance_preview_custom')
            : t('web.appearance_preview_fallback')}
        </Badge>
        {previewCustom && (
          <p className="muted small">
            <Ltr>{trimmed}</Ltr>
          </p>
        )}
      </td>
      <td>
        {mayEdit && (
          <div className="btn-group">
            <button
              type="button"
              className="btn primary sm"
              disabled={busy || !valid || !dirty}
              onClick={() =>
                save.mutate({ customEmojiId: trimmed === '' ? null : trimmed, enabled })
              }
            >
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
            {slot.version !== null && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => reset.mutate()}
              >
                {t('web.appearance_reset')}
              </button>
            )}
          </div>
        )}
        {failure !== null && failure !== undefined && (
          <Banner tone="danger">{appearanceMessageFor(failure)}</Banner>
        )}
      </td>
    </tr>
  );
}

function TestCard({
  bots,
  operatorTelegramBound,
  configured,
  mayEdit,
}: {
  bots: readonly AppearanceBotView[];
  operatorTelegramBound: boolean;
  /** Whether at least one slot is switched on with a custom emoji id. */
  configured: boolean;
  mayEdit: boolean;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const active = bots.filter((bot) => bot.status === 'ACTIVE');
  const [botId, setBotId] = useState('');
  const chosenBot = botId !== '' ? botId : (active[0]?.id ?? '');

  const test = useMutation({
    mutationFn: (botInstanceId: string) =>
      testAppearance({
        botInstanceId,
        idempotencyKey: submission.current({ command: 'appearance.test', botInstanceId }),
      }),
    onSuccess: async (result) => {
      submission.settle();
      // The toast says what Telegram ANSWERED, not that a request was made: a refused,
      // unreachable or rate-limited test is not "sent" (Codex, PR #121, finding 9).
      const outcome = result.bot.customEmojiTest?.outcome ?? 'UNREACHABLE';
      notify({
        tone: OUTCOME_TONE[outcome],
        message: `${t(TOAST_LABEL[outcome])} ${t('web.appearance_decorated_slots')} ${String(result.decoratedSlots)}`,
      });
      await client.invalidateQueries({ queryKey: ['appearance'] });
    },
    onError: (error: unknown) => submission.settleOn(error),
  });

  return (
    <Card title={t('web.appearance_test_title')} hint={t('web.appearance_test_hint')}>
      <ul className="small" data-testid="appearance-bots">
        {bots.map((bot) => (
          <li key={bot.id}>
            <Ltr>@{bot.username}</Ltr>{' '}
            {bot.status !== 'ACTIVE' && <Badge tone="warn">{t('web.bot_status_stopped')}</Badge>}{' '}
            {bot.customEmojiTest === null ? (
              <span className="muted">{t('web.appearance_test_never')}</span>
            ) : (
              <>
                <Badge tone={OUTCOME_TONE[bot.customEmojiTest.outcome]}>
                  {t(OUTCOME_LABEL[bot.customEmojiTest.outcome])}
                </Badge>{' '}
                <span className="muted">
                  {t('web.appearance_test_last')} {formatTimestamp(bot.customEmojiTest.testedAt)}
                </span>
                {bot.customEmojiTest.errorCode !== null && (
                  <p className="danger small">{t(ERROR_LABEL[bot.customEmojiTest.errorCode])}</p>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {mayEdit && (
        <>
          {!operatorTelegramBound && (
            <Banner tone="warn">{t('web.appearance_test_not_bound')}</Banner>
          )}
          {!configured && <Banner tone="info">{t('web.appearance_test_nothing')}</Banner>}
          {active.length === 0 ? (
            <Banner tone="warn">{t('web.appearance_test_no_bot')}</Banner>
          ) : (
            <>
              {active.length > 1 && (
                <Field label={t('web.appearance_test_bot')} htmlFor="appearance-test-bot">
                  <select
                    id="appearance-test-bot"
                    value={chosenBot}
                    onChange={(event) => setBotId(event.target.value)}
                  >
                    {active.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        @{bot.username}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div className="toolbar">
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={
                    test.isPending || chosenBot === '' || !operatorTelegramBound || !configured
                  }
                  onClick={() => test.mutate(chosenBot)}
                >
                  {test.isPending
                    ? t('web.appearance_test_sending')
                    : t('web.appearance_test_send')}
                </button>
              </div>
            </>
          )}
          {test.isError && <Banner tone="danger">{appearanceMessageFor(test.error)}</Banner>}
        </>
      )}
    </Card>
  );
}
