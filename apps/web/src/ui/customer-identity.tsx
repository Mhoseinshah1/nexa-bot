import type { MouseEvent } from 'react';
import { t } from '../i18n/web.fa';
import { Ltr } from './kit';

/**
 * A customer, on a LIST row, as an operator knows them (spec §10): the Telegram NUMERIC id
 * first, the `@username` beside it when there is one, linking to the customer's page.
 *
 * Not the internal uuid. That id appears in no support conversation — a customer quotes
 * the number Telegram shows them — and an eight-character uuid prefix in a column headed
 * «مشتری» was the answer to "who is this" every list gave until this release. The uuid is
 * still the LINK target, because it is what the customer page is addressed by; it is
 * never the text.
 *
 * When the server did not send an identity (a response from before the field existed),
 * the link reads "unknown customer" rather than falling back to the uuid.
 */
export function CustomerIdentityLink({
  customerId,
  telegramUserId,
  username,
  onLink,
}: {
  customerId: string;
  telegramUserId: string | null;
  username: string | null;
  onLink: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <span className="nowrap">
      <a href={`/users/${encodeURIComponent(customerId)}`} onClick={onLink}>
        {telegramUserId === null ? (
          <span className="muted">{t('web.customer_identity_unknown')}</span>
        ) : (
          <Ltr>{telegramUserId}</Ltr>
        )}
      </a>
      {username !== null && (
        <>
          {' '}
          <span className="muted small">
            <Ltr mono={false}>{`@${username}`}</Ltr>
          </span>
        </>
      )}
    </span>
  );
}
