import type { ReactNode } from 'react';
import type { AttentionItem } from '../attention-view';
import { formatNumber } from '../format';
import { t } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { Badge, Empty } from '../ui/kit';
import { Icon } from '../ui/icons';

/**
 * A list of things waiting for a person (roadmap B5/B6): each row is ONE link — the count,
 * what it counts, and the way to the page that handles it — so the whole row is the touch
 * target and its accessible name says all three. The rows are `attention-view.ts`'s; this
 * draws them and decides nothing.
 */
export function AttentionList({
  items,
  label,
  empty,
}: {
  items: readonly AttentionItem[];
  /** The list's accessible name. */
  label: string;
  /** What is drawn when nothing waits. */
  empty: ReactNode;
}) {
  const onLink = useLinkHandler();
  if (items.length === 0) return <>{empty}</>;
  return (
    <ul className="side-list attn-list" aria-label={label}>
      {items.map((item) => {
        const count = `${formatNumber(item.count)}${item.atLeast ? '+' : ''}`;
        return (
          <li key={item.key} className={`attn-${item.tone}`} data-attention={item.key}>
            <a className="attn-link" href={item.href} onClick={onLink}>
              <Badge tone={item.tone}>
                <span className="num">{count}</span>
              </Badge>
              <span className="grow">
                {t(item.label)}
                {item.atLeast && <span className="faint small"> ({t('web.attn_at_least')})</span>}
              </span>
              <span className="attn-go faint small">
                {t('web.attn_open')}
                <Icon name="chevronLeft" size={14} />
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** The compact empty state both lists share. */
export function AttentionClear({ title, hint }: { title: string; hint?: string }) {
  return (
    <Empty title={title} {...(hint === undefined ? {} : { hint })} icon="check" variant="compact" />
  );
}
