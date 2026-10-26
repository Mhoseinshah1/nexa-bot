import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  isCustomMenuRef,
  type AnyExplicitMainMenu,
  type CustomMenuButtonView,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuRevisionView,
} from '@nexa/contracts';
import { fetchBotMenuRevisions } from '../../api/client';
import { formatTimestamp } from '../../format';
import { t } from '../../i18n/web.fa';
import { Badge, Banner, CursorPager, Drawer, LIST_PAGE_SIZE, StateSwitch } from '../../ui/kit';
import { fill, labelOf, PreviewKeyboard } from './canvas';
import { configOf, lookOf } from './model';

export const REVISIONS_QUERY_KEY = ['bot-menu-builder', 'revisions'] as const;

/** Every placed button of a revision, disabled ones marked — what that revision arranged. */
function arrangedRows(
  layout: AnyExplicitMainMenu,
  items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>,
  customs: ReadonlyMap<string, CustomMenuButtonView>,
) {
  return layout.rows.map((row) =>
    row.map((id) => {
      const config = configOf(layout, id);
      const label = isCustomMenuRef(id)
        ? labelOf(id, undefined, customs.get(id))
        : labelOf(id, items.get(id));
      return {
        key: id,
        label: config.enabled ? label : `${label} (${t('web.bb_state_off')})`,
        look: lookOf(config),
        iconSlot: config.iconSlot,
      };
    }),
  );
}

/**
 * The published revisions, newest first, a page at a time. Restoring one puts it INTO THE
 * DRAFT — never live; publishing it afterwards is a separate act that makes a new revision.
 *
 * Ten a page with «قبلی / بعدی» (W1.8; PR #285 review, A6), on the server's keyset: `before`
 * is the oldest revision number of the page shown, «بعدی» walks to older revisions and
 * «قبلی» back through the cursors already seen. Never an offset.
 */
export function HistoryDrawer({
  open,
  onClose,
  publishedRevision,
  items,
  customs,
  mayEdit,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  publishedRevision: number | null;
  items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>;
  /** R10 D2: a revision may place a custom button; its label is the owner's. */
  customs: ReadonlyMap<string, CustomMenuButtonView>;
  mayEdit: boolean;
  onRestore: (revision: MainMenuRevisionView) => void;
}) {
  const [trail, setTrail] = useState<readonly number[]>([]);
  const before = trail.length > 0 ? trail[trail.length - 1] : undefined;
  const revisions = useQuery({
    // Under the shared prefix, so a publish or a restore's invalidation reaches every page.
    queryKey: [...REVISIONS_QUERY_KEY, before ?? null],
    queryFn: () =>
      fetchBotMenuRevisions(
        before === undefined ? { limit: LIST_PAGE_SIZE } : { before, limit: LIST_PAGE_SIZE },
      ),
    // The page on screen stays while the next one loads: «بعدی» never empties the drawer.
    placeholderData: keepPreviousData,
    enabled: open,
  });
  const all = revisions.data?.revisions ?? [];
  const nextBefore = revisions.data?.nextBefore ?? null;
  const close = () => {
    setTrail([]);
    onClose();
  };

  return (
    <Drawer open={open} onClose={close} title={t('web.bb_history_title')} wide>
      <p className="muted small">{t('web.bb_history_hint')}</p>
      <StateSwitch
        query={revisions}
        isEmpty={all.length === 0}
        empty={<p className="muted small">{t('web.bb_history_empty')}</p>}
      >
        <ol className="bb-history" data-testid="bb-history">
          {all.map((revision) => (
            <li key={revision.id} className="bb-history-item" data-revision={revision.revision}>
              <div className="bb-history-head">
                <strong>{fill(t('web.bb_revision_n'), { n: revision.revision })}</strong>
                {revision.revision === publishedRevision && (
                  <Badge tone="ok">{t('web.bb_revision_current')}</Badge>
                )}
                <span className="muted small">{formatTimestamp(revision.createdAt)}</span>
              </div>
              {revision.restoredFrom !== null && (
                <p className="muted small">
                  {fill(t('web.bb_revision_restored_from'), { n: revision.restoredFrom.revision })}
                </p>
              )}
              {/* The publisher by name, as the audit log names people (round-T QA-4) — never
                  an id prefix nobody can read. No name, no line. */}
              {revision.createdByAdminName !== null &&
                revision.createdByAdminName !== undefined && (
                  <p className="muted small" data-testid="bb-revision-by">
                    {t('web.bb_revision_by')} <bdi>{revision.createdByAdminName}</bdi>
                  </p>
                )}
              {revision.layout === null ? (
                <Banner tone="warn">{t('web.bb_revision_unreadable')}</Banner>
              ) : (
                <>
                  <PreviewKeyboard
                    rows={arrangedRows(revision.layout, items, customs)}
                    label={fill(t('web.bb_revision_n'), { n: revision.revision })}
                  />
                  {mayEdit && (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => onRestore(revision)}
                      aria-label={`${t('web.bb_restore')}: ${fill(t('web.bb_revision_n'), {
                        n: revision.revision,
                      })}`}
                    >
                      {t('web.bb_restore')}
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ol>
      </StateSwitch>
      {(trail.length > 0 || nextBefore !== null) && (
        <CursorPager
          order="newest-first"
          shown={all.length}
          hasPrevious={trail.length > 0}
          hasNext={nextBefore !== null && !revisions.isPlaceholderData}
          onPrevious={() => setTrail(trail.slice(0, -1))}
          onNext={() => {
            if (nextBefore !== null) setTrail([...trail, nextBefore]);
          }}
        />
      )}
    </Drawer>
  );
}
