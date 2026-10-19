import { t } from '../i18n/web.fa';
import { useLinkHandler } from '../router';
import { CopyButton, Ltr } from './kit';

/**
 * Short public codes on the Web Admin (Round 4, PR-C).
 *
 * An order, service, payment or ticket is shown by its 8-character code, a product by
 * `P-102` beside its name, a panel by its name and a customer by the Telegram id — never by
 * the internal uuid. The uuid is still what a page is ADDRESSED by, so it stays the link
 * target; and an operator who needs the value itself (a database query, a support ticket
 * upstream) gets it from «کپی شناسه», which copies it and draws nothing.
 *
 * `CopyIdButton` is the ONE place a record's uuid may reach the page, and only as the
 * clipboard payload. `tests/unit/web-no-uuid-rendered.test.ts` scans every page for an id
 * rendered as text and fails on one outside it.
 */
export function CopyIdButton({ id }: { id: string }) {
  return <CopyButton value={id} label={t('web.copy_id')} />;
}

/** A code as text: left to right, monospace, or an em dash when the row has none yet. */
export function CodeText({ code }: { code: string | null }) {
  return code === null ? <span className="faint">—</span> : <Ltr>{code}</Ltr>;
}

/**
 * A record by its code, linking to its page, with «کپی شناسه» beside it.
 *
 * A row the code backfill has not reached (never once `pnpm db:migrate` completed) reads
 * «مشاهده» rather than falling back to the uuid.
 */
export function RecordLink({
  href,
  id,
  code,
  copy = true,
}: {
  href: string;
  id: string;
  code: string | null;
  copy?: boolean;
}) {
  const onLink = useLinkHandler();
  return (
    <span className="nowrap record-ref">
      <a className="lk" href={href} onClick={onLink}>
        {code === null ? t('web.record_open') : <Ltr>{code}</Ltr>}
      </a>
      {copy && <CopyIdButton id={id} />}
    </span>
  );
}

export const recordHref = {
  order: (id: string) => `/orders/${encodeURIComponent(id)}`,
  service: (id: string) => `/services/${encodeURIComponent(id)}`,
  payment: (id: string) => `/payments/${encodeURIComponent(id)}`,
  ticket: (id: string) => `/tickets/${encodeURIComponent(id)}`,
  product: (id: string) => `/products/${encodeURIComponent(id)}`,
  panel: (id: string) => `/panels/${encodeURIComponent(id)}`,
  customer: (id: string) => `/users/${encodeURIComponent(id)}`,
} as const;

/** A product as an operator says it: «P-102 · name». Either part may be unknown. */
export function productLabel(code: string | null, title: string | null): string {
  if (code !== null && title !== null) return `${code} · ${title}`;
  return code ?? title ?? t('web.record_open');
}

/** A product link, "P-102 · name", with the copy-id action. */
export function ProductLink({
  id,
  code,
  title,
}: {
  id: string;
  code: string | null;
  title: string | null;
}) {
  const onLink = useLinkHandler();
  return (
    <span className="nowrap record-ref">
      <a className="lk" href={recordHref.product(id)} onClick={onLink}>
        {productLabel(code, title)}
      </a>
      <CopyIdButton id={id} />
    </span>
  );
}

/** A panel link by its name, with the copy-id action. */
export function PanelLink({ id, name }: { id: string; name: string | null }) {
  const onLink = useLinkHandler();
  return (
    <span className="nowrap record-ref">
      <a className="lk" href={recordHref.panel(id)} onClick={onLink}>
        {name ?? t('web.record_open')}
      </a>
      <CopyIdButton id={id} />
    </span>
  );
}
