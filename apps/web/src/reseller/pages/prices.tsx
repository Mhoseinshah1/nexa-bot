import { useQuery } from '@tanstack/react-query';
import type { ResellerPricesResponse } from '@nexa/contracts';
import { formatMoneyText, formatNumber, formatTrafficGbText } from '../../format';
import { t } from '../../i18n/web.fa';
import { Badge, Button, Empty, StateSwitch, useToast } from '../../ui/kit';
import { fetchPrices } from '../api';
import { RpCard } from '../view';

type Item = ResellerPricesResponse['groups'][number]['items'][number];

function sizeText(item: Item): string {
  const parts: string[] = [];
  if (item.trafficBytes !== null) {
    parts.push(
      BigInt(item.trafficBytes) === 0n
        ? t('web.rp_unlimited')
        : `${formatTrafficGbText(BigInt(item.trafficBytes))} ${t('web.unit_gib')}`,
    );
  }
  if (item.durationDays !== null) {
    parts.push(t('web.rp_days').replace('{n}', formatNumber(item.durationDays)));
  }
  return parts.join(' • ');
}

/**
 * The text «کپی لیست برای مشتری» copies: the tenant's categories in their order, each product
 * with its size and its LIST price. The reseller's own price and discount never appear — the
 * list is for their customer, who pays the list price.
 */
export function customerPriceList(data: ResellerPricesResponse): string {
  const blocks = data.groups
    .filter((group) => group.items.length > 0)
    .map((group) => {
      const heading = group.title ?? t('web.rp_prices_other');
      const lines = group.items.map((item) => {
        const size = sizeText(item);
        return `${item.title}${size === '' ? '' : ` — ${size}`} — ${formatMoneyText(item.listPrice)}`;
      });
      return [heading, ...lines].join('\n');
    });
  return blocks.join('\n\n');
}

/** The price list: list price against the reseller's own, by category. */
export function PricesPage({ tierName }: { tierName: string }) {
  const toast = useToast();
  const query = useQuery({ queryKey: ['reseller', 'prices'], queryFn: fetchPrices });
  const data = query.data;
  const empty = data !== undefined && data.groups.every((group) => group.items.length === 0);

  const copy = () => {
    if (data === undefined) return;
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      toast({ tone: 'danger', message: t('web.copy_failed') });
      return;
    }
    clipboard.writeText(customerPriceList(data)).then(
      () => toast({ tone: 'ok', message: t('web.rp_prices_copied') }),
      () => toast({ tone: 'danger', message: t('web.copy_failed') }),
    );
  };

  return (
    <RpCard
      title={t('web.rp_prices_title')}
      hint={t('web.rp_prices_hint').replace('{tier}', tierName)}
      actions={
        <Button size="sm" disabled={data === undefined || empty} onClick={copy}>
          {t('web.rp_prices_copy')}
        </Button>
      }
    >
      <StateSwitch query={query} isEmpty={empty} empty={<Empty title={t('web.rp_prices_empty')} />}>
        {data?.groups
          .filter((group) => group.items.length > 0)
          .map((group) => (
            <section key={group.categoryId ?? 'other'} className="rp-price-group">
              <h3>{group.title ?? t('web.rp_prices_other')}</h3>
              <div className="rp-table-wrap">
                <table className="rp-table">
                  <thead>
                    <tr>
                      <th>{t('web.rp_prices_col_plan')}</th>
                      <th>{t('web.rp_prices_col_size')}</th>
                      <th>{t('web.rp_prices_col_list')}</th>
                      <th>{t('web.rp_prices_col_yours')}</th>
                      <th>{t('web.rp_prices_col_off')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.items.map((item) => (
                      <tr key={item.productId}>
                        <td>
                          <b>{item.title}</b>
                        </td>
                        <td>{sizeText(item) || '—'}</td>
                        <td className="muted rp-struck">{formatMoneyText(item.listPrice)}</td>
                        <td>
                          <b>{formatMoneyText(item.yourPrice)}</b>
                        </td>
                        <td>
                          <Badge tone={item.discountPercent > 0 ? 'ok' : 'neutral'}>
                            {t('web.rp_percent').replace('{n}', formatNumber(item.discountPercent))}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
      </StateSwitch>
    </RpCard>
  );
}
