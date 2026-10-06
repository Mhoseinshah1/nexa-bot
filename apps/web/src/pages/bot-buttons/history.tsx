import { useInfiniteQuery } from '@tanstack/react-query';
import {
  type ExplicitMainMenu,
  type MainMenuBuilderItem,
  type MainMenuButtonId,
  type MainMenuRevisionView,
} from '@nexa/contracts';
import { fetchBotMenuRevisions } from '../../api/client';
import { formatTimestamp } from '../../format';
import { t } from '../../i18n/web.fa';
import { Badge, Banner, Drawer, StateSwitch } from '../../ui/kit';
import { fill, labelOf, PreviewKeyboard } from './canvas';
import { configOf, lookOf } from './model';

export const REVISIONS_QUERY_KEY = ['bot-menu-builder', 'revisions'] as const;
const PAGE = 20;

/** Every placed button of a revision, disabled ones marked — what that revision arranged. */
function arrangedRows(
  layout: ExplicitMainMenu,
  items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>,
) {
  return layout.rows.map((row) =>
    row.map((id) => {
      const config = configOf(layout, id);
      const label = labelOf(id, items.get(id));
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
 */
export function HistoryDrawer({
  open,
  onClose,
  publishedRevision,
  items,
  mayEdit,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  publishedRevision: number | null;
  items: ReadonlyMap<MainMenuButtonId, MainMenuBuilderItem>;
  mayEdit: boolean;
  onRestore: (revision: MainMenuRevisionView) => void;
}) {
  const revisions = useInfiniteQuery({
    queryKey: REVISIONS_QUERY_KEY,
    queryFn: ({ pageParam }) =>
      fetchBotMenuRevisions(
        pageParam === undefined ? { limit: PAGE } : { before: pageParam, limit: PAGE },
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: open,
  });
  const all = revisions.data?.pages.flatMap((page) => page.revisions) ?? [];

  return (
    <Drawer open={open} onClose={onClose} title={t('web.bb_history_title')} wide>
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
                    rows={arrangedRows(revision.layout, items)}
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
      {revisions.hasNextPage && (
        <button
          type="button"
          className="btn sm"
          disabled={revisions.isFetchingNextPage}
          onClick={() => void revisions.fetchNextPage()}
        >
          {revisions.isFetchingNextPage ? t('web.loading') : t('web.bb_history_older')}
        </button>
      )}
    </Drawer>
  );
}
