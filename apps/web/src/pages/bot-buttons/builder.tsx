import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  customerRowsOf,
  explicitMainMenuSchema,
  explicitMainMenusEqual,
  type BotMenuBuilderResponse,
  type ExplicitMainMenu,
  type MainMenuBuilderItem,
  type MainMenuBuilderMutationResponse,
  type MainMenuButtonId,
  type MainMenuDraftView,
  type MainMenuResetSeed,
  type MainMenuRevisionView,
} from '@nexa/contracts';
import {
  ApiError,
  publishBotMenu,
  resetBotMenuDraft,
  restoreBotMenuRevision,
  saveBotMenuDraft,
} from '../../api/client';
import { t, type WebKey } from '../../i18n/web.fa';
import { useSubmissionKey } from '../../submission-key';
import {
  Badge,
  Banner,
  ButtonGroup,
  Card,
  ConfirmDialog,
  Ltr,
  Modal,
  Radio,
  useFocusAfterWrite,
  useToast,
  useUnsavedChanges,
  type Tone,
} from '../../ui/kit';
import { Icon } from '../../ui/icons';
import { ErrorReport } from '../settings';
import { TelegramPhone } from '../telegram-phone';
import {
  EditableKeyboard,
  fill,
  labelOf,
  Pool,
  PreviewKeyboard,
  type ChipContext,
  type PreviewKey,
} from './canvas';
import { usePointerDrag, type DragSource, type DropTarget } from './dnd';
import { HistoryDrawer, REVISIONS_QUERY_KEY } from './history';
import { Inspector } from './inspector';
import {
  applyDrop,
  diffLayouts,
  gateAnswersOf,
  lookOf,
  moveEarlier,
  moveLater,
  moveToNextRow,
  moveToPreviousRow,
  placeInNewRow,
  positionOf,
  removeToPool,
  rowLooksCramped,
  type ButtonChange,
} from './model';

export const BUILDER_QUERY_KEY = ['bot-menu-builder'] as const;
/** Every builder write carries this key, so the page knows one is in flight (Codex #134-1). */
const WRITE_KEY = ['bot-menu-builder', 'write'] as const;

/** What a re-read returned: fresh data, or an error beside the data cached before it. */
export interface BuilderRead {
  readonly data: BotMenuBuilderResponse | undefined;
  readonly isError: boolean;
  readonly error: unknown;
}

type Action = 'save' | 'publish' | 'reset' | 'restore';

/** What the draft on this page is, against what the server has. */
type BuilderState =
  | 'saving'
  | 'publishing'
  | 'conflict'
  | 'invalid'
  | 'unsaved'
  | 'not_saved'
  | 'differs'
  | 'published';

const STATE_LABEL: Readonly<Record<BuilderState, WebKey>> = {
  saving: 'web.bb_state_saving',
  publishing: 'web.bb_state_publishing',
  conflict: 'web.bb_state_conflict',
  invalid: 'web.bb_state_invalid',
  unsaved: 'web.bb_state_unsaved',
  not_saved: 'web.bb_state_not_saved',
  differs: 'web.bb_state_differs',
  published: 'web.bb_state_published',
};
const STATE_TONE: Readonly<Record<BuilderState, Tone>> = {
  saving: 'info',
  publishing: 'info',
  conflict: 'danger',
  invalid: 'danger',
  unsaved: 'warn',
  not_saved: 'neutral',
  differs: 'violet',
  published: 'ok',
};

const CHANGE_LABEL: Readonly<Record<ButtonChange, WebKey>> = {
  added: 'web.bb_change_added',
  removed: 'web.bb_change_removed',
  moved: 'web.bb_change_moved',
  enabled: 'web.bb_change_enabled',
  disabled: 'web.bb_change_disabled',
  look: 'web.bb_change_style',
};

type Mode = 'edit' | 'customer' | 'live';

function isConflict(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 409 || error.code === 'control.version_conflict')
  );
}

/** The draft the page edits, and the server's draft it was seeded from (its basis). */
interface Seed {
  readonly basis: MainMenuDraftView;
  readonly layout: ExplicitMainMenu;
}

const seedOf = (draft: MainMenuDraftView): Seed => ({ basis: draft, layout: draft.layout });

function sameServerDraft(a: MainMenuDraftView, b: MainMenuDraftView): boolean {
  return (
    a.version === b.version &&
    a.legacyBaselineVersion === b.legacyBaselineVersion &&
    a.legacyChangedSinceDraft === b.legacyChangedSinceDraft &&
    a.differsFromPublished === b.differsFromPublished &&
    explicitMainMenusEqual(a.layout, b.layout)
  );
}

/** Whether `read` is a draft from before `held` (a stale answer to an earlier read). */
function olderThan(read: MainMenuDraftView, held: MainMenuDraftView): boolean {
  if (held.version === null) return false;
  return read.version === null || read.version < held.version;
}

/**
 * Round T: the button builder — the customer main menu as explicit rows and a style per
 * button (the button icon was retired on 2026-10-02), around a DRAFT that changes nothing a customer sees until it is
 * published. Reads `GET /bot-menu/builder`; writes through the four builder endpoints, each
 * with an idempotency key and the versions it read. Gates are the server's answers
 * (`items[].gateOpen`), passed to the contract's `customerRowsOf` — never decided here.
 */
export function MenuBuilder({
  view,
  mayEdit,
  mayViewTemplates,
  onEditLabel,
  refetch,
}: {
  view: BotMenuBuilderResponse;
  mayEdit: boolean;
  mayViewTemplates: boolean;
  onEditLabel: (id: MainMenuButtonId) => void;
  refetch: () => Promise<BuilderRead>;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [seed, setSeed] = useState<Seed>(() => seedOf(view.draft));
  const [selected, setSelected] = useState<MainMenuButtonId | null>(null);
  const [mode, setMode] = useState<Mode>('edit');
  const [announcement, setAnnouncement] = useState('');
  const [conflict, setConflict] = useState<'save' | 'publish' | 'reset' | 'restore' | null>(null);
  const [asking, setAsking] = useState<
    | { kind: 'publish' }
    | { kind: 'reset'; seed: MainMenuResetSeed }
    | { kind: 'restore'; revision: MainMenuRevisionView }
    | { kind: 'reload' }
    | null
  >(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const focusChip = useRef<MainMenuButtonId | null>(null);
  const publishRef = useRef<HTMLButtonElement>(null);

  const items = useMemo(
    () => new Map<MainMenuButtonId, MainMenuBuilderItem>(view.items.map((item) => [item.id, item])),
    [view.items],
  );

  const layout = seed.layout;
  const dirty = !explicitMainMenusEqual(layout, seed.basis.layout);
  const valid = explicitMainMenuSchema.safeParse(layout).success;
  // The server's draft moved while this page held its own: adopt it when nothing would be
  // lost, and otherwise SAY so — a save would then be refused (409), never overwrite. A read
  // OLDER than the draft this page already holds (one that started before this page's own
  // write and answered after it) is not a move: every draft write raises the version.
  //
  // A write's ANSWER outranks the query snapshot that was on screen when it was adopted,
  // whatever the versions say: a publish does not raise the draft version, so that older
  // snapshot carries the same version and would otherwise be adopted back over the answer
  // (Codex #134-2). Only a NEW read (a different snapshot object) can move the page again.
  const latestRead = useRef(view.draft);
  latestRead.current = view.draft;
  const [answered, setAnswered] = useState<MainMenuDraftView | null>(null);
  const serverMoved =
    view.draft !== answered &&
    !sameServerDraft(view.draft, seed.basis) &&
    !olderThan(view.draft, seed.basis);
  useEffect(() => {
    if (serverMoved && !dirty) {
      setSeed(seedOf(view.draft));
      // A refusal answered by this fresh read is no longer the page's state.
      setConflict(null);
    }
  }, [serverMoved, dirty, view.draft]);

  useUnsavedChanges(mayEdit && dirty, t('web.bb_unsaved_leave'));

  // While a write is in flight nothing is editable: its answer replaces the draft, and an
  // edit made meanwhile would be silently thrown away by it (Codex #134-1).
  const writing = useIsMutating({ mutationKey: WRITE_KEY }) > 0;
  const editable = mayEdit && !writing;
  const [lastAction, setLastAction] = useState<Action | null>(null);
  const [reloadError, setReloadError] = useState<unknown>(null);
  const say = (text: string) => setAnnouncement(text);

  const adopt = (response: MainMenuBuilderMutationResponse) => {
    setAnswered(latestRead.current);
    setSeed(seedOf(response.head.draft));
    setConflict(null);
    setReloadError(null);
  };
  const refreshAll = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: BUILDER_QUERY_KEY }),
      client.invalidateQueries({ queryKey: ['bot-menu'] }),
    ]);
  };

  // --- edits ------------------------------------------------------------------------

  const describePlace = (next: ExplicitMainMenu, id: MainMenuButtonId): string => {
    const label = labelOf(id, items.get(id));
    const at = positionOf(next, id);
    return at === null
      ? fill(t('web.bb_announce_pool'), { label })
      : fill(t('web.bb_announce_moved'), { label, row: at.row + 1, index: at.index + 1 });
  };
  const onMove = (id: MainMenuButtonId, op: (l: ExplicitMainMenu) => ExplicitMainMenu) => {
    if (!editable) return;
    const next = op(layout);
    if (explicitMainMenusEqual(next, layout)) return;
    setSeed({ basis: seed.basis, layout: next });
    setSelected(id);
    focusChip.current = id;
    say(describePlace(next, id));
  };
  const onChange = (op: (l: ExplicitMainMenu) => ExplicitMainMenu, text: string) => {
    if (!editable) return;
    setSeed({ basis: seed.basis, layout: op(layout) });
    say(text);
  };

  // After a move the selected chip may have been re-mounted in another row, and the control
  // pressed may now be disabled: focus goes back to the chip, never to the page body.
  useEffect(() => {
    const id = focusChip.current;
    if (id === null) return;
    focusChip.current = null;
    const active = document.activeElement;
    const lost =
      active === null ||
      active === document.body ||
      (active instanceof HTMLButtonElement && active.disabled) ||
      active.closest('[data-chip]') !== null;
    if (lost) {
      document.querySelector<HTMLElement>(`[data-chip-button="${id}"]`)?.focus();
    }
  });

  /**
   * A drop: the model's `applyDrop` decides what it does — the same primitives as every
   * other move — and a drop that would change nothing (the same place, a row onto a key)
   * changes nothing and says nothing.
   */
  const onDrop = (source: DragSource, target: DropTarget) => {
    if (!editable) return;
    const next = applyDrop(layout, source, target);
    if (next === null) return;
    if (source.kind === 'row') {
      setSeed({ basis: seed.basis, layout: next });
      say(fill(t('web.bb_announce_row'), { from: source.row + 1 }));
      return;
    }
    onMove(source.id, () => next);
  };
  const drag = usePointerDrag(editable, onDrop);

  /**
   * Keyboard moves on a focused button — the same primitives the Inspector calls. Alt with
   * the arrows: up and down change row; the arrow pointing to the start of the line (right,
   * in Persian) moves earlier. Delete takes the button back to the pool.
   */
  const onKey = (id: MainMenuButtonId, event: KeyboardEvent<HTMLButtonElement>) => {
    if (!editable) return;
    const rtl = document.documentElement.dir !== 'ltr';
    const placed = positionOf(layout, id) !== null;
    let op: ((l: ExplicitMainMenu) => ExplicitMainMenu) | null = null;
    if (event.altKey && event.key === 'ArrowUp') op = (l) => moveToPreviousRow(l, id);
    else if (event.altKey && event.key === 'ArrowDown') op = (l) => moveToNextRow(l, id);
    else if (event.altKey && event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) {
      op = (l) => moveEarlier(l, id);
    } else if (event.altKey && event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) {
      op = (l) => moveLater(l, id);
    } else if (placed && (event.key === 'Delete' || event.key === 'Backspace')) {
      op = (l) => removeToPool(l, id);
    } else if (!placed && event.altKey && event.key === 'Enter') {
      op = (l) => placeInNewRow(l, id, l.rows.length);
    }
    if (op === null) return;
    event.preventDefault();
    onMove(id, op);
  };

  const context: ChipContext = {
    layout,
    items,
    selected,
    editable,
    drag,
    onSelect: (id) => setSelected(id),
    onKey,
  };

  // --- writes -----------------------------------------------------------------------

  const saveKey = useSubmissionKey();
  const save = useMutation({
    mutationKey: WRITE_KEY,
    onMutate: () => setLastAction('save'),
    mutationFn: (command: {
      expectedDraftVersion: number | null;
      legacyBaselineVersion: number | null;
      layout: ExplicitMainMenu;
    }) => saveBotMenuDraft({ ...command, idempotencyKey: saveKey.current(command) }),
    onSuccess: async (response) => {
      saveKey.settle();
      adopt(response);
      toast({
        tone: response.changed ? 'ok' : 'info',
        message: t(response.changed ? 'web.bb_saved' : 'web.unchanged'),
      });
      await client.invalidateQueries({ queryKey: BUILDER_QUERY_KEY });
    },
    onError: (error: unknown) => {
      saveKey.settleOn(error);
      if (isConflict(error)) setConflict('save');
    },
  });
  const onSave = () => {
    if (!valid || !editable) return;
    save.mutate({
      expectedDraftVersion: seed.basis.version,
      // The `bot.main_menu` version this page's draft was seeded from: the first save
      // stores it as the draft's baseline; later saves leave the stored one alone.
      legacyBaselineVersion: seed.basis.legacyBaselineVersion,
      layout,
    });
  };

  const publishKey = useSubmissionKey();
  const publish = useMutation({
    mutationKey: WRITE_KEY,
    onMutate: () => setLastAction('publish'),
    mutationFn: (command: {
      expectedDraftVersion: number;
      expectedPublishedRevision: number | null;
    }) => publishBotMenu({ ...command, idempotencyKey: publishKey.current(command) }),
    onSuccess: async (response) => {
      publishKey.settle();
      adopt(response);
      toast({
        tone: response.changed ? 'ok' : 'info',
        message: t(response.changed ? 'web.bb_published' : 'web.unchanged'),
      });
      await Promise.all([
        refreshAll(),
        client.invalidateQueries({ queryKey: REVISIONS_QUERY_KEY }),
      ]);
    },
    onError: async (error: unknown) => {
      publishKey.settleOn(error);
      if (isConflict(error)) {
        setConflict('publish');
        // Nothing local is at stake (a publish needs a saved draft): re-read, so the page
        // shows WHICH thing moved — another save, another publish, or the live keyboard.
        await client.invalidateQueries({ queryKey: BUILDER_QUERY_KEY });
      }
    },
  });
  const armPublishFocus = useFocusAfterWrite(publish.isPending, () => publishRef.current);

  const resetKey = useSubmissionKey();
  const reset = useMutation({
    mutationKey: WRITE_KEY,
    onMutate: () => setLastAction('reset'),
    mutationFn: (command: { expectedDraftVersion: number | null; seed: MainMenuResetSeed }) =>
      resetBotMenuDraft({
        ...command,
        confirm: true,
        idempotencyKey: resetKey.current(command),
      }),
    onSuccess: async (response) => {
      resetKey.settle();
      adopt(response);
      toast({ tone: 'ok', message: t('web.bb_reset_done') });
      await client.invalidateQueries({ queryKey: BUILDER_QUERY_KEY });
    },
    onError: (error: unknown) => {
      resetKey.settleOn(error);
      if (isConflict(error)) setConflict('reset');
    },
  });

  const restoreKey = useSubmissionKey();
  const restore = useMutation({
    mutationKey: WRITE_KEY,
    onMutate: () => setLastAction('restore'),
    mutationFn: (command: { revisionId: string; expectedDraftVersion: number | null }) =>
      restoreBotMenuRevision({ ...command, idempotencyKey: restoreKey.current(command) }),
    onSuccess: async (response) => {
      restoreKey.settle();
      adopt(response);
      toast({ tone: 'ok', message: t('web.bb_restored') });
      await client.invalidateQueries({ queryKey: BUILDER_QUERY_KEY });
    },
    onError: (error: unknown) => {
      restoreKey.settleOn(error);
      if (isConflict(error)) setConflict('restore');
    },
  });

  const reload = async () => {
    const read = await refetch();
    // A failed re-read resolves with the data cached BEFORE the conflict: adopting it would
    // drop the edit for a stale draft and call the conflict solved (Codex #134-4).
    if (read.isError || read.data === undefined) {
      setReloadError(read.error ?? new Error('reload'));
      return;
    }
    setReloadError(null);
    setAnswered(null);
    setSeed(seedOf(read.data.draft));
    setConflict(null);
    save.reset();
    say(t('web.bb_reloaded'));
  };

  const pending = save.isPending || publish.isPending || reset.isPending || restore.isPending;
  // Only the LATEST write's refusal is the page's state: an earlier one a later write has
  // since answered is history (Codex #134-3).
  const latest = { save, publish, reset, restore }[lastAction ?? 'save'];
  const lastError = lastAction !== null && latest.isError ? latest.error : undefined;
  const serverInvalid =
    lastAction === 'save' && lastError instanceof ApiError && lastError.status === 400;

  // A reset or a restore REPLACES the draft: until its answer is adopted the page must not
  // keep reporting the state from before it (round-T QA-6 read «published» right after a
  // restore was confirmed).
  const state: BuilderState =
    save.isPending || reset.isPending || restore.isPending
      ? 'saving'
      : publish.isPending
        ? 'publishing'
        : conflict !== null
          ? 'conflict'
          : !valid || serverInvalid
            ? 'invalid'
            : dirty
              ? 'unsaved'
              : seed.basis.version === null
                ? 'not_saved'
                : seed.basis.differsFromPublished || view.superseded || view.publishedUnreadable
                  ? 'differs'
                  : 'published';

  const publishable =
    editable &&
    !dirty &&
    valid &&
    !pending &&
    seed.basis.version !== null &&
    !seed.basis.legacyChangedSinceDraft &&
    (seed.basis.differsFromPublished || view.superseded || view.publishedUnreadable);
  const publishBlocker: WebKey | null = !editable
    ? null
    : dirty
      ? 'web.bb_publish_save_first'
      : seed.basis.version === null
        ? 'web.bb_publish_nothing_saved'
        : seed.basis.legacyChangedSinceDraft
          ? 'web.bb_publish_reseed_first'
          : null;

  // --- previews ---------------------------------------------------------------------

  const gates = gateAnswersOf(view.items);
  const toPreview = (rows: ReturnType<typeof customerRowsOf>): PreviewKey[][] =>
    rows.map((row) =>
      row.map((one) => ({
        key: one.button,
        label: labelOf(one.button, items.get(one.button)),
        look: lookOf(one),
      })),
    );
  const customerRows = toPreview(customerRowsOf(layout, gates));
  // The live keyboard: the server's rendered labels, row by row. While an explicit layout
  // is what customers get, each key's style is that PUBLISHED layout's, drawn by
  // the same rule with the server's gate answers — used only when it lines up key for key
  // with the server's rows, so nothing is drawn that the server did not say (Codex #134-5).
  const publishedRows =
    view.source === 'EXPLICIT' && view.published?.layout !== null && view.published !== null
      ? customerRowsOf(view.published.layout, gates)
      : null;
  const aligned =
    publishedRows !== null &&
    publishedRows.length === view.live.rows.length &&
    publishedRows.every((row, at) => row.length === view.live.rows[at]?.length);
  const liveRows: PreviewKey[][] = view.live.rows.map((row, at) =>
    row.map((label, index) => {
      const drawn = aligned ? publishedRows[at]?.[index] : undefined;
      return {
        key: `${String(at)}-${String(index)}`,
        label,
        look: drawn === undefined ? 'default' : lookOf(drawn),
      };
    }),
  );
  const wide = (id: MainMenuButtonId) => items.get(id)?.wide ?? false;
  const crampedRows = layout.rows
    .map((row, at) => (rowLooksCramped(row, wide) ? at + 1 : null))
    .filter((n): n is number => n !== null);
  const bot =
    view.iconEligibility.find((one) => one.status === 'ACTIVE') ?? view.iconEligibility[0];
  const phoneTitle =
    bot === undefined ? (
      t('web.bot_buttons_preview_title')
    ) : (
      <Ltr mono={false}>@{bot.username}</Ltr>
    );

  // --- render -----------------------------------------------------------------------

  return (
    <Card
      title={t('web.bb_title')}
      hint={t('web.bb_hint')}
      className="bb-card"
      actions={
        <div className="bb-toolbar">
          <Badge tone={STATE_TONE[state]} dot>
            <span data-testid="bb-state" data-status={state}>
              {t(STATE_LABEL[state])}
            </span>
          </Badge>
          <button type="button" className="btn sm" onClick={() => setHistoryOpen(true)}>
            <Icon name="clock" />
            {t('web.bb_history')}
          </button>
          {mayEdit && (
            <>
              <button
                type="button"
                className="btn sm"
                disabled={pending}
                onClick={() => setAsking({ kind: 'reset', seed: 'DEFAULT' })}
              >
                <Icon name="undo" />
                {t('web.bb_reset')}
              </button>
              <button
                type="button"
                className="btn sm"
                disabled={pending || !dirty || !valid}
                onClick={onSave}
              >
                <Icon name="check" />
                {save.isPending ? t('web.saving') : t('web.bb_save_draft')}
              </button>
              <button
                ref={publishRef}
                type="button"
                className="btn sm primary"
                disabled={!publishable}
                onClick={() => setAsking({ kind: 'publish' })}
              >
                <Icon name="send" />
                {publish.isPending ? t('web.bb_state_publishing') : t('web.bb_publish')}
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="visually-hidden" role="status" aria-live="polite" data-testid="bb-live">
        {announcement}
      </div>
      <Banner tone="info">{t('web.bb_draft_note')}</Banner>
      <p className="muted small" data-testid="bb-source">
        {view.source === 'EXPLICIT' && view.published !== null
          ? fill(t('web.bb_source_explicit'), { n: view.published.revision })
          : t('web.bb_source_legacy')}
      </p>
      {!mayEdit && <Banner tone="info">{t('web.bb_read_only')}</Banner>}
      {view.publishedUnreadable && (
        <Banner tone="danger">{t('web.bb_published_unreadable')}</Banner>
      )}
      {view.superseded && <Banner tone="warn">{t('web.bb_superseded')}</Banner>}
      {seed.basis.legacyChangedSinceDraft && (
        <Banner
          tone="warn"
          {...(mayEdit
            ? {
                action: (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={pending}
                    onClick={() => setAsking({ kind: 'reset', seed: 'LIVE' })}
                  >
                    {t('web.bb_reseed_live')}
                  </button>
                ),
              }
            : {})}
        >
          {t('web.bb_legacy_changed')}
        </Banner>
      )}
      {seed.basis.storedValueInvalid && <Banner tone="warn">{t('web.bb_stored_invalid')}</Banner>}
      {seed.basis.restoredFrom !== null && (
        <Banner tone="info">
          {fill(t('web.bb_restored_from'), { n: seed.basis.restoredFrom.revision })}
        </Banner>
      )}
      {serverMoved && dirty && (
        <Banner
          tone="warn"
          action={
            <button type="button" className="btn sm" onClick={() => setAsking({ kind: 'reload' })}>
              {t('web.bb_reload')}
            </button>
          }
        >
          {t('web.bb_server_moved')}
        </Banner>
      )}
      {conflict !== null && (
        <Banner
          tone="danger"
          {...(conflict === 'save' || conflict === 'restore' || conflict === 'reset'
            ? {
                action: (
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => (dirty ? setAsking({ kind: 'reload' }) : void reload())}
                  >
                    {t('web.bb_reload')}
                  </button>
                ),
              }
            : {})}
        >
          <span data-testid="bb-conflict">
            {t(conflict === 'publish' ? 'web.bb_conflict_publish' : 'web.bb_conflict')}
          </span>
        </Banner>
      )}
      {!valid && <Banner tone="danger">{t('web.bot_buttons_one_required')}</Banner>}
      {reloadError !== null && <ErrorReport error={reloadError} />}
      {lastError !== undefined && lastError !== null && !isConflict(lastError) && (
        <ErrorReport error={lastError} />
      )}

      <div className="bb-workspace">
        <Pool context={context} />
        <section className="bb-canvas" aria-labelledby="bb-canvas-title">
          <div className="bb-canvas-head">
            <h3 id="bb-canvas-title" className="bb-pane-title">
              {t('web.bb_canvas_title')}
            </h3>
            <ButtonGroup segmented label={t('web.bb_mode_label')}>
              {(['edit', 'customer', 'live'] as const).map((one) => (
                <button
                  key={one}
                  type="button"
                  className="btn sm"
                  aria-pressed={mode === one}
                  onClick={() => setMode(one)}
                >
                  {t(
                    one === 'edit'
                      ? 'web.bb_mode_edit'
                      : one === 'customer'
                        ? 'web.bb_mode_customer'
                        : 'web.bb_mode_live',
                  )}
                </button>
              ))}
            </ButtonGroup>
          </div>
          <TelegramPhone
            title={phoneTitle}
            keyboard={
              mode === 'edit' ? (
                <EditableKeyboard context={context} />
              ) : mode === 'customer' ? (
                <PreviewKeyboard
                  rows={customerRows}
                  label={t('web.bb_mode_customer')}
                  testId="bb-customer-preview"
                />
              ) : (
                <PreviewKeyboard
                  rows={liveRows}
                  label={t('web.bb_mode_live')}
                  testId="bb-live-preview"
                />
              )
            }
          >
            <p className="tg-phone-note">
              {t(
                mode === 'edit'
                  ? 'web.bb_mode_edit_note'
                  : mode === 'customer'
                    ? 'web.bb_mode_customer_note'
                    : 'web.bb_mode_live_note',
              )}
            </p>
            {mode === 'customer' && customerRows.length === 0 && (
              <p className="tg-phone-note">{t('web.bot_buttons_preview_empty')}</p>
            )}
          </TelegramPhone>
          {crampedRows.length > 0 && (
            <Banner tone="warn">
              {fill(t('web.bb_rows_cramped'), { rows: crampedRows.join(t('web.bb_sep')) })}
            </Banner>
          )}
          <p className="muted small">{t('web.bb_style_legend')}</p>
          {publishBlocker !== null && (
            <p className="muted small" data-testid="bb-publish-blocker">
              {t(publishBlocker)}
            </p>
          )}
        </section>
        <Inspector
          key={selected ?? 'none'}
          layout={layout}
          id={selected}
          item={selected === null ? undefined : items.get(selected)}
          editable={editable}
          mayViewTemplates={mayViewTemplates}
          onMove={onMove}
          onChange={onChange}
          onEditLabel={onEditLabel}
        />
      </div>

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        publishedRevision={view.published?.revision ?? null}
        items={items}
        mayEdit={mayEdit}
        onRestore={(revision) => {
          setHistoryOpen(false);
          setAsking({ kind: 'restore', revision });
        }}
      />

      {asking?.kind === 'publish' && (
        <PublishDialog
          view={view}
          layout={layout}
          customerRows={customerRows}
          liveRows={liveRows}
          items={items}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            if (seed.basis.version === null) return;
            armPublishFocus();
            publish.mutate({
              expectedDraftVersion: seed.basis.version,
              expectedPublishedRevision: view.published?.revision ?? null,
            });
          }}
        />
      )}
      {asking?.kind === 'reset' && (
        <ResetDialog
          initial={asking.seed}
          dirty={dirty}
          onCancel={() => setAsking(null)}
          onConfirm={(choice) => {
            setAsking(null);
            reset.mutate({ expectedDraftVersion: seed.basis.version, seed: choice });
          }}
        />
      )}
      {asking?.kind === 'restore' && (
        <ConfirmDialog
          title={fill(t('web.bb_restore_title'), { n: asking.revision.revision })}
          question={t('web.bb_restore_question')}
          {...(dirty ? { detail: t('web.bb_discard_detail') } : {})}
          confirmLabel={t('web.bb_restore')}
          cancelLabel={t('web.bb_cancel')}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const revision = asking.revision;
            setAsking(null);
            restore.mutate({ revisionId: revision.id, expectedDraftVersion: seed.basis.version });
          }}
        />
      )}
      {asking?.kind === 'reload' && (
        <ConfirmDialog
          title={t('web.bb_reload')}
          question={t('web.bb_reload_question')}
          confirmLabel={t('web.discard')}
          cancelLabel={t('web.unsaved_stay')}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            void reload();
          }}
        />
      )}
    </Card>
  );
}

/** Publish, asked first — with what changes against what is published, and both keyboards. */
function PublishDialog({
  view,
  layout,
  customerRows,
  liveRows,
  items,
  onCancel,
  onConfirm,
}: {
  view: BotMenuBuilderResponse;
  layout: ExplicitMainMenu;
  customerRows: readonly (readonly PreviewKey[])[];
  liveRows: readonly (readonly PreviewKey[])[];
  items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const before = view.published?.layout ?? null;
  const unreadable = view.published !== null && before === null;
  const changes = before === null ? null : diffLayouts(before, layout);
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('web.bb_publish_title')}
      size="lg"
      foot={
        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onConfirm}>
            {t('web.bb_publish_confirm')}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            {t('web.bb_cancel')}
          </button>
        </div>
      }
    >
      <p>{t('web.bb_publish_question')}</p>
      {unreadable ? (
        <Banner tone="warn">{t('web.bb_publish_over_unreadable')}</Banner>
      ) : view.superseded ? (
        /*
         * Superseded (T4 F-2): customers see what an older release wrote, not `before`, so a
         * diff against `before` — and above all "no layout change" — would describe a change
         * that is not the one customers get. The two keyboards below are the comparison.
         */
        <Banner tone="warn">{t('web.bb_publish_over_superseded')}</Banner>
      ) : before === null ? (
        <Banner tone="info">{t('web.bb_publish_first')}</Banner>
      ) : changes !== null && changes.length === 0 ? (
        <p className="muted small">{t('web.bb_publish_no_layout_change')}</p>
      ) : (
        <ul className="bb-diff" data-testid="bb-diff">
          {changes?.map((change) => (
            <li key={change.id} data-diff={change.id}>
              <strong>{labelOf(change.id, items.get(change.id))}</strong>
              {': '}
              {change.changes.map((one) => t(CHANGE_LABEL[one])).join(t('web.bb_sep'))}
            </li>
          ))}
        </ul>
      )}
      <div className="bb-diff-keyboards">
        <div>
          <p className="small strong">{t('web.bb_publish_now')}</p>
          <PreviewKeyboard rows={liveRows} label={t('web.bb_publish_now')} />
        </div>
        <div>
          <p className="small strong">{t('web.bb_publish_after')}</p>
          <PreviewKeyboard rows={customerRows} label={t('web.bb_publish_after')} />
        </div>
      </div>
      <p className="muted small">{t('web.bb_publish_gates_note')}</p>
    </Modal>
  );
}

/** Reset the DRAFT — to the default keyboard or from the live one. Asked, never assumed. */
function ResetDialog({
  initial,
  dirty,
  onCancel,
  onConfirm,
}: {
  initial: MainMenuResetSeed;
  dirty: boolean;
  onCancel: () => void;
  onConfirm: (seed: MainMenuResetSeed) => void;
}) {
  const [choice, setChoice] = useState<MainMenuResetSeed>(initial);
  return (
    <Modal
      open
      onClose={onCancel}
      title={t('web.bb_reset_title')}
      foot={
        <div className="dialog-actions">
          <button type="button" className="btn danger solid" onClick={() => onConfirm(choice)}>
            {t('web.bb_reset_confirm')}
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            {t('web.bb_cancel')}
          </button>
        </div>
      }
    >
      <p>{t('web.bb_reset_question')}</p>
      <div className="checks" role="radiogroup" aria-label={t('web.bb_reset_title')}>
        <Radio
          name="bb-reset-seed"
          value="DEFAULT"
          selected={choice}
          onChange={setChoice}
          label={t('web.bb_reset_default')}
        />
        <Radio
          name="bb-reset-seed"
          value="LIVE"
          selected={choice}
          onChange={setChoice}
          label={t('web.bb_reset_live')}
        />
      </div>
      {dirty && <Banner tone="warn">{t('web.bb_discard_detail')}</Banner>}
    </Modal>
  );
}
