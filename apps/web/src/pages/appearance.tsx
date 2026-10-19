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
import { useSubmissionKey, type SubmissionKey } from '../submission-key';
import { t, type WebKey } from '../i18n/web.fa';
import { APPEARANCE_SLOT_LABEL as SLOT_LABEL } from '../appearance-labels';
import { messageFor } from './settings';
import { CategoryColorsSection } from './category-colors';
import { QrTemplateSection } from './qr-template';
import {
  Badge,
  Banner,
  Card,
  Drawer,
  Field,
  Ltr,
  PageHead,
  StateSwitch,
  TabPanel,
  Tabs,
  ToggleRow,
  usePagedRows,
  useToast,
  useUnsavedChanges,
  type Tone,
} from '../ui/kit';
import { SummaryPill } from './editor-layout';
import { ErrorRef } from '../ui/technical-details';

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

/** What the operator typed for one slot and has not saved yet. */
interface SlotDraft {
  readonly customEmojiId: string;
  readonly enabled: boolean;
}

/**
 * A draft belongs to the stored row it was typed against: keyed by slot AND version, so a
 * row the server has moved on (a save, a reset, a colleague) starts again from what it holds.
 */
const draftKey = (slot: AppearanceSlotView) => `${slot.slot}:${String(slot.version ?? 0)}`;

const draftOf = (slot: AppearanceSlotView, drafts: Readonly<Record<string, SlotDraft>>) =>
  drafts[draftKey(slot)] ?? { customEmojiId: slot.customEmojiId ?? '', enabled: slot.enabled };

function draftState(slot: AppearanceSlotView, draft: SlotDraft) {
  const trimmed = draft.customEmojiId.trim();
  const valid = trimmed === '' || CUSTOM_EMOJI_ID_PATTERN.test(trimmed);
  const dirty =
    (trimmed === '' ? null : trimmed) !== slot.customEmojiId || draft.enabled !== slot.enabled;
  return { trimmed, valid, dirty, previewCustom: draft.enabled && trimmed !== '' && valid };
}

type AppearanceTab = 'slots' | 'colors' | 'qr';

export function AppearancePage({
  denied,
  mayEdit,
  mayViewCategories = false,
}: {
  denied: boolean;
  mayEdit: boolean;
  /** `catalog.view`: the category list the colour section draws. */
  mayViewCategories?: boolean;
}) {
  const appearance = useQuery({
    queryKey: ['appearance'],
    queryFn: fetchAppearance,
    enabled: !denied,
  });
  const view = appearance.data;
  const [tab, setTab] = useState<AppearanceTab>('slots');
  const [drafts, setDrafts] = useState<Readonly<Record<string, SlotDraft>>>({});
  /*
   * The slot sheet's key lives here, with the drafts, because the sheet unmounts on close: a
   * key kept after an unanswered save or reset (a 5xx that may have committed) must survive a
   * close and reopen, or the retry is a new command answered with a version conflict. The
   * slot is part of every key's payload, so one key never stands for two slots.
   */
  const slotSubmission = useSubmissionKey();
  const [open, setOpen] = useState<AppearanceSlot | null>(null);

  const slots = view?.slots ?? [];
  // The endpoint answers every slot at once (no cursor, no limit): its length is the server's
  // own count of the collection, so the pager may say «۱–۱۰ از ۲۹» as the demo does.
  const { rows: pageSlots, pager: slotPager } = usePagedRows(slots, '', { wholeCollection: true });
  const unsaved = slots.filter((slot) => draftState(slot, draftOf(slot, drafts)).dirty);
  // A slot edited and not saved: leaving the page asks first, whether its sheet is open or not.
  useUnsavedChanges(mayEdit && unsaved.length > 0);
  const opened = open === null ? undefined : slots.find((slot) => slot.slot === open);
  const stored = slots.filter((slot) => slot.customEmojiId !== null).length;
  const custom = slots.filter((slot) => slot.enabled && slot.customEmojiId !== null).length;

  if (denied) {
    return (
      <>
        <PageHead title={t('web.appearance_title')} subtitle={t('web.appearance_intro')} />
        <StateSwitch query={appearance} denied isEmpty={false}>
          {null}
        </StateSwitch>
      </>
    );
  }

  return (
    <>
      <PageHead title={t('web.appearance_title')} subtitle={t('web.appearance_intro')} />
      <Tabs
        value={tab}
        onChange={setTab}
        panelId="appearance-panel"
        items={[
          {
            id: 'slots',
            label: t('web.appearance_slots_title'),
            ...(view === undefined ? {} : { count: view.slots.length }),
          },
          { id: 'colors', label: t('web.cc_title') },
          { id: 'qr', label: t('web.qrt_title') },
        ]}
      />
      {/*
       * Every tab stays MOUNTED and only the chosen one is shown: each section holds its
       * operator's unsaved edits in its own state, and a tab switch must not drop them.
       */}
      <TabPanel id="appearance-panel" labelledBy={`appearance-panel-tab-${tab}`}>
        <div hidden={tab !== 'slots'}>
          <StateSwitch query={appearance} denied={false} isEmpty={false}>
            {view !== undefined && (
              <div className="bx-side-split">
                <Card
                  title={t('web.appearance_slots_title')}
                  hint={t('web.appearance_slots_hint')}
                  actions={
                    <span className="bx-sum">
                      <SummaryPill
                        value={custom}
                        label={t('web.appearance_preview_custom')}
                        tone="ok"
                      />
                      <SummaryPill value={stored} label={t('web.bx_appearance_stored')} />
                      {unsaved.length > 0 && (
                        <SummaryPill
                          value={unsaved.length}
                          label={t('web.ob_unsaved_row')}
                          tone="warn"
                        />
                      )}
                    </span>
                  }
                >
                  <div className="tbl-wrap">
                    <table className="tbl bx-rows">
                      <caption className="visually-hidden">
                        {t('web.appearance_slots_title')}
                      </caption>
                      <thead>
                        <tr>
                          <th>{t('web.appearance_col_fallback')}</th>
                          <th>{t('web.appearance_col_slot')}</th>
                          <th>{t('web.appearance_col_custom')}</th>
                          <th>{t('web.appearance_col_preview')}</th>
                          <th className="bx-chev-col">
                            <span className="visually-hidden">{t('web.appearance_col_open')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageSlots.map((slot) => (
                          <SlotRow
                            key={slot.slot}
                            slot={slot}
                            draft={draftOf(slot, drafts)}
                            onOpen={() => setOpen(slot.slot)}
                          />
                        ))}
                      </tbody>
                    </table>
                    {slotPager}
                  </div>
                </Card>
                <TestCard
                  bots={view.bots}
                  operatorTelegramBound={view.operatorTelegramBound}
                  configured={view.slots.some(
                    (slot) => slot.enabled && slot.customEmojiId !== null,
                  )}
                  mayEdit={mayEdit}
                />
              </div>
            )}
          </StateSwitch>
        </div>
        {/* UX Batch 01, item 2: its own reads, so an appearance failure does not hide it. */}
        <div hidden={tab !== 'colors'}>
          <CategoryColorsSection
            denied={denied}
            mayEdit={mayEdit}
            mayViewCategories={mayViewCategories}
          />
        </div>
        {/* Phase 2 item 4: the subscription QR on the tenant's own background. */}
        <div hidden={tab !== 'qr'}>
          <QrTemplateSection mayEdit={mayEdit} />
        </div>
      </TabPanel>

      {opened !== undefined && (
        <SlotSheet
          key={draftKey(opened)}
          slot={opened}
          draft={draftOf(opened, drafts)}
          mayEdit={mayEdit}
          submission={slotSubmission}
          onDraft={(next) => setDrafts((all) => ({ ...all, [draftKey(opened)]: next }))}
          onSettled={() => {
            setDrafts((all) => {
              const { [draftKey(opened)]: _gone, ...rest } = all;
              return rest;
            });
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/** One slot as a compact row: what the customer sees now, and a way into its sheet. */
function SlotRow({
  slot,
  draft,
  onOpen,
}: {
  slot: AppearanceSlotView;
  draft: SlotDraft;
  onOpen: () => void;
}) {
  const label = t(SLOT_LABEL[slot.slot]);
  const { dirty } = draftState(slot, draft);
  const showsCustom = slot.enabled && slot.customEmojiId !== null;
  return (
    /*
     * The whole row opens the slot's sheet, as the demo's rows do; the label is the real
     * button (keyboard and screen readers), the row's click and chevron are the pointer's.
     */
    <tr data-slot={slot.slot} className="bx-tr" onClick={onOpen}>
      <td>
        <span className="appearance-glyph sm" aria-label={t('web.appearance_col_fallback')}>
          {slot.fallback}
        </span>
      </td>
      <td>
        <button
          type="button"
          className="bx-rowlink"
          aria-haspopup="dialog"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <span className="strong">{label}</span>
        </button>
        <p className="muted small">
          <Ltr>{appearanceMarker(slot.slot)}</Ltr>
        </p>
      </td>
      <td>{slot.customEmojiId === null ? '—' : <Ltr>{slot.customEmojiId}</Ltr>}</td>
      <td>
        <span className="bx-badges">
          <Badge tone={showsCustom ? 'ok' : 'neutral'} dot>
            {showsCustom
              ? t('web.appearance_preview_custom')
              : t('web.appearance_preview_fallback')}
          </Badge>
          {slot.customEmojiId !== null && !slot.enabled && (
            <Badge tone="warn">{t('web.disabled')}</Badge>
          )}
          {dirty && (
            <Badge tone="warn" dot>
              {t('web.ob_unsaved_row')}
            </Badge>
          )}
        </span>
      </td>
      <td className="end">
        <span className="bx-chev" aria-hidden="true">
          ‹
        </span>
      </td>
    </tr>
  );
}

/**
 * One slot's editor, in a side sheet: the custom emoji id, its switch, what the customer will
 * see, and save / reset. The draft lives in the page, so closing the sheet keeps it.
 */
function SlotSheet({
  slot,
  draft,
  mayEdit,
  submission,
  onDraft,
  onSettled,
  onClose,
}: {
  slot: AppearanceSlotView;
  draft: SlotDraft;
  mayEdit: boolean;
  /** Held by the page (see `slotSubmission`). */
  submission: SubmissionKey;
  onDraft: (next: SlotDraft) => void;
  /** A save or reset went through: the draft is spent and the sheet closes. */
  onSettled: () => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const notify = useToast();
  const label = t(SLOT_LABEL[slot.slot]);
  const { trimmed, valid, dirty, previewCustom } = draftState(slot, draft);

  const settle = async () => {
    submission.settle();
    onSettled();
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

  return (
    <Drawer
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={label}
      foot={
        mayEdit ? (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !valid || !dirty}
              onClick={() =>
                save.mutate({
                  customEmojiId: trimmed === '' ? null : trimmed,
                  enabled: draft.enabled,
                })
              }
            >
              {save.isPending ? t('web.saving') : t('web.save')}
            </button>
            {slot.version !== null && (
              <button type="button" className="btn" disabled={busy} onClick={() => reset.mutate()}>
                {t('web.appearance_reset')}
              </button>
            )}
          </>
        ) : undefined
      }
    >
      <div className="stack">
        <div className="bx-prev" data-testid="appearance-preview">
          <span className="bx-glyph" aria-hidden="true">
            {slot.fallback}
          </span>
          <div>
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
          </div>
        </div>
        <dl className="kv">
          <dt>{t('web.appearance_col_fallback')}</dt>
          <dd>
            <span className="appearance-glyph">{slot.fallback}</span>
          </dd>
          <dt>{t('web.appearance_marker')}</dt>
          <dd>
            <Ltr>{appearanceMarker(slot.slot)}</Ltr>
          </dd>
        </dl>
        <Field
          label={t('web.appearance_col_custom')}
          htmlFor={`appearance-${slot.slot}`}
          hint={t('web.appearance_custom_id_hint')}
        >
          <input
            id={`appearance-${slot.slot}`}
            className="input ltr mono appearance-id"
            dir="ltr"
            inputMode="numeric"
            value={draft.customEmojiId}
            disabled={!mayEdit || busy}
            onChange={(event) => onDraft({ ...draft, customEmojiId: event.target.value })}
            {...(valid ? {} : { 'aria-invalid': true })}
          />
        </Field>
        {!valid && (
          <span className="danger small appearance-error" role="alert">
            {t('web.appearance_custom_id_invalid')}
          </span>
        )}
        <ToggleRow
          title={t('web.appearance_col_enabled')}
          checked={draft.enabled}
          disabled={!mayEdit || busy}
          onChange={(enabled) => onDraft({ ...draft, enabled })}
        />
        {failure !== null && failure !== undefined && (
          <Banner tone="danger">
            {appearanceMessageFor(failure)}
            <ErrorRef error={failure} />
          </Banner>
        )}
      </div>
    </Drawer>
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
    <Card title={t('web.appearance_test_title')}>
      <p className="muted small">{t('web.appearance_test_hint')}</p>
      <ul className="appearance-bots small" data-testid="appearance-bots">
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
          {test.isError && (
            <Banner tone="danger">
              {appearanceMessageFor(test.error)}
              <ErrorRef error={test.error} />
            </Banner>
          )}
        </>
      )}
    </Card>
  );
}
