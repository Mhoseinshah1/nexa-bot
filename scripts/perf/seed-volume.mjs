#!/usr/bin/env node
/**
 * `node scripts/perf/seed-volume.mjs --database-url postgres://…/nexa_perf_x [--scale 1]`
 *
 * Fills a DISPOSABLE database with a realistic volume of the rows the Web Admin
 * reads — customers, orders, payments, services, wallet entries, audit rows and
 * operational events — so `scripts/perf/web-nav-bench.mjs` measures queries
 * against something other than an empty installation.
 *
 * Not part of `pnpm verify` or CI, and never pointed at a real installation:
 *
 * - the URL is an ARGUMENT, never read from the environment, because the ambient
 *   `DATABASE_URL` of a development shell points at a shared database;
 * - the database name must contain `perf`, and `nexa_dev` / `nexa_test` are refused
 *   outright, as is `NODE_ENV=production`;
 * - it runs AFTER `db:migrate` and `db:seed` (it uses the seed's tenant `acme`,
 *   its bot and its product category) and refuses a database that already holds
 *   seeded volume, so a second run cannot double it.
 *
 * Every row satisfies the schema's own CHECK constraints and triggers — it goes
 * in through plain INSERTs, nothing is disabled — so a query plan measured here
 * is a plan the real schema produces. Money is bigint minor units with a currency.
 * The ids are random v4 uuids; the application mints v7, which only changes the
 * physical order of the primary-key index, not any index the pages page by.
 */
import pg from 'pg';

function parseArgs(argv) {
  const out = { url: null, scale: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--database-url') out.url = argv[++i] ?? null;
    else if (argv[i] === '--scale') out.scale = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (out.url === null) throw new Error('--database-url is required.');
  if (!Number.isFinite(out.scale) || out.scale <= 0 || out.scale > 20)
    throw new Error('--scale must be in (0, 20].');
  return out;
}

const TENANT = '01900000-0000-7000-8000-000000000001';
const BOT = '01900000-0000-7000-8000-00000000a001';
const CATEGORY = '01900000-0000-7000-8000-0000000000c1';

async function main() {
  const { url, scale } = parseArgs(process.argv.slice(2));
  const name = new URL(url).pathname.replace(/^\//, '');
  if (process.env.NODE_ENV === 'production') throw new Error('Refused: NODE_ENV=production.');
  if (name === 'nexa_dev' || name === 'nexa_test' || !name.includes('perf'))
    throw new Error(
      `Refused: "${name}" is not a disposable perf database (its name must contain "perf").`,
    );

  const n = (base) => Math.max(1, Math.round(base * scale));
  const counts = {
    customers: n(20_000),
    orders: n(40_000),
    audit: n(200_000),
    events: n(3_000),
  };

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tenant = await client.query('select 1 from tenants where id = $1', [TENANT]);
    if (tenant.rowCount !== 1) throw new Error('Run `db:seed` first: tenant "acme" is missing.');
    const existing = await client.query(
      `select count(*)::int as c from customers where tenant_id = $1 and telegram_user_id like 'perf-%'`,
      [TENANT],
    );
    if (existing.rows[0].c > 0)
      throw new Error('Refused: this database already holds perf volume.');
    const admin = await client.query('select id from admins where tenant_id = $1 limit 1', [
      TENANT,
    ]);
    const adminId = admin.rows[0]?.id ?? null;

    const step = async (label, sql, params = []) => {
      const started = Date.now();
      const result = await client.query(sql, params);
      // Statistics for the rows just written, inside the transaction: the triggers
      // and foreign keys of the next step look these rows up, and a plan made for
      // an empty table turns each lookup into a sequential scan.
      await client.query('analyze');
      console.log(`${label}: ${result.rowCount ?? 0} rows in ${Date.now() - started} ms`);
    };

    await client.query('begin');

    await step(
      'panels',
      `insert into panels (id, tenant_id, name, provider_type, base_url, status, created_at, updated_at, max_services)
       select gen_random_uuid(), $1, 'perf-panel-' || g, 'marzban', 'https://perf-panel-' || g || '.invalid', 'ACTIVE',
              now() - interval '200 days', now() - interval '200 days', 50000
         from generate_series(1, 4) g`,
      [TENANT],
    );
    await step(
      'products',
      `insert into products (id, tenant_id, title, status, sort_order, panel_id, duration_days, traffic_bytes,
                             price_amount, price_currency, category_id, created_at, updated_at)
       select gen_random_uuid(), $1, 'perf-product-' || g, 'ACTIVE', g,
              (select id from panels where tenant_id = $1 and name like 'perf-panel-%' order by name offset (g % 4) limit 1),
              30 * (1 + g % 3), (10 + g * 10)::bigint * 1073741824, (100000 + g * 50000)::bigint, 'IRT', $2,
              now() - interval '200 days', now() - interval '200 days'
         from generate_series(1, 12) g`,
      [TENANT, CATEGORY],
    );
    await step(
      'customers',
      `insert into customers (id, tenant_id, telegram_user_id, username, first_name, last_name, language_code, status,
                              first_bot_instance_id, first_seen_at, last_seen_at, created_at, updated_at)
       select gen_random_uuid(), $1, 'perf-' || (7000000000 + g), 'perf_user_' || g, 'Name' || g,
              case when g % 3 = 0 then null else 'Family' || g end, 'fa', 'ACTIVE', $2,
              t, t + (g % 90) * interval '1 day', t, t
         from generate_series(1, $3::int) g,
              lateral (select now() - ((g % 180) * interval '1 day') - ((g % 1440) * interval '1 minute') as t) s`,
      [TENANT, BOT, counts.customers],
    );

    // Orders: a realistic mix of terminal states, every one of them consistent
    // with the state CHECKs (settled_at for PAID/REFUNDED, cancelled_at for
    // CANCELLED, refunded_at for REFUNDED).
    await step(
      'orders',
      `with c as (select id, row_number() over (order by created_at, id) as rn from customers
                    where tenant_id = $1 and telegram_user_id like 'perf-%'),
            p as (select id, panel_id, title, duration_days, traffic_bytes, price_amount,
                         row_number() over (order by sort_order) - 1 as pn
                    from products where tenant_id = $1 and title like 'perf-product-%'),
            g as (select g, now() - ((g % 180) * interval '1 day') - ((g % 997) * interval '1 minute') as t,
                         case when g % 20 < 14 then 'PAID' when g % 20 < 16 then 'EXPIRED'
                              when g % 20 < 18 then 'CANCELLED' when g % 20 = 18 then 'REFUNDED'
                              else 'AWAITING_PAYMENT' end as state
                    from generate_series(1, $2::int) g)
       insert into orders (id, tenant_id, customer_id, state, product_id, panel_id, line_title, line_duration_days,
                           line_traffic_bytes, line_unit_price_amount, subtotal_amount, discount_amount, total_amount,
                           currency, quote, expires_at, confirmed_at, settled_at, cancelled_at, refunded_at,
                           created_at, updated_at, purpose, line_category_id)
       select gen_random_uuid(), $1, c.id, g.state, p.id, p.panel_id, p.title, p.duration_days, p.traffic_bytes,
              p.price_amount, p.price_amount, 0, p.price_amount, 'IRT',
              -- A quote the API parses (priceQuoteWireSchema): an empty object made GET /orders a 500
              -- ("carries a quote that is not a quote"). One BASE_PRICE step, as checkout writes.
              jsonb_build_object(
                'productId', p.id::text,
                'quotedAt', to_char(g.t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'currency', 'IRT',
                'finalAmount', jsonb_build_object('amountMinor', p.price_amount::text, 'currency', 'IRT'),
                'trace', jsonb_build_array(jsonb_build_object(
                  'step', 'BASE_PRICE', 'effect', 'REPLACES', 'ruleId', null,
                  'ruleLabel', p.title,
                  'amountBefore', jsonb_build_object('amountMinor', p.price_amount::text, 'currency', 'IRT'),
                  'amountAfter', jsonb_build_object('amountMinor', p.price_amount::text, 'currency', 'IRT')))),
              case when g.state = 'AWAITING_PAYMENT' then now() + interval '30 minutes' else g.t + interval '30 minutes' end,
              g.t + interval '1 minute',
              case when g.state in ('PAID', 'REFUNDED') then g.t + interval '5 minutes' end,
              case when g.state = 'CANCELLED' then g.t + interval '10 minutes' end,
              case when g.state = 'REFUNDED' then g.t + interval '20 minutes' end,
              g.t, g.t, 'NEW_SERVICE', $3
         from g
         join c on c.rn = 1 + (g.g::bigint * 7919) % $4::int
         join p on p.pn = g.g % 12`,
      [TENANT, counts.orders, CATEGORY, counts.customers],
    );

    await step(
      'payments',
      `insert into payments (id, tenant_id, customer_id, order_id, state, method, amount, currency, reference,
                             evidence_kind, confirmed_at, confirmed_by_admin_id, expires_at, resolved_at,
                             created_at, updated_at)
       select gen_random_uuid(), o.tenant_id, o.customer_id, o.id,
              case when o.state in ('PAID', 'REFUNDED') then 'CONFIRMED' when o.state = 'AWAITING_PAYMENT' then 'PENDING'
                   when o.state = 'CANCELLED' then 'CANCELLED' else 'EXPIRED' end,
              case when o.state in ('PAID', 'REFUNDED') and (hashtext(o.id::text) % 3) = 0 then 'WALLET' else 'MANUAL_TRANSFER' end,
              o.total_amount, o.currency, 'perf-' || o.id,
              case when o.state in ('PAID', 'REFUNDED')
                   then case when (hashtext(o.id::text) % 3) = 0 then 'WALLET_DEBIT' else 'OPERATOR_REVIEW' end end,
              case when o.state in ('PAID', 'REFUNDED') then o.settled_at end,
              case when o.state in ('PAID', 'REFUNDED') and (hashtext(o.id::text) % 3) <> 0 then $2::uuid end,
              o.expires_at,
              case when o.state in ('CANCELLED', 'EXPIRED') then o.created_at + interval '30 minutes' end,
              o.created_at, o.created_at
         from orders o
        where o.tenant_id = $1 and o.line_title like 'perf-product-%'`,
      [TENANT, adminId],
    );

    await step(
      'services',
      `insert into services (id, tenant_id, customer_id, order_id, panel_id, product_id, state, provider_username,
                             expires_at, traffic_limit_bytes, traffic_used_bytes, usage_synced_at, provisioned_at,
                             terminated_at, delivery_state, delivered_at, created_at, updated_at)
       select gen_random_uuid(), o.tenant_id, o.customer_id, o.id, o.panel_id, o.product_id, s.state,
              'perf' || replace(o.id::text, '-', ''),
              o.settled_at + o.line_duration_days * interval '1 day', o.line_traffic_bytes,
              (o.line_traffic_bytes / 3), o.settled_at + interval '1 hour', o.settled_at + interval '1 minute',
              case when s.state = 'TERMINATED' then o.settled_at + interval '2 days' end,
              'DELIVERED', o.settled_at + interval '2 minutes', o.settled_at, o.settled_at
         from orders o,
              lateral (select case when o.settled_at + o.line_duration_days * interval '1 day' < now() then 'EXPIRED'
                                   when (hashtext(o.id::text) % 25) = 0 then 'SUSPENDED'
                                   when (hashtext(o.id::text) % 41) = 0 then 'TERMINATED'
                                   else 'ACTIVE' end as state) s
        where o.tenant_id = $1 and o.state = 'PAID' and o.line_title like 'perf-product-%'`,
      [TENANT],
    );

    await step(
      'wallet entries',
      `insert into wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference,
                                   order_id, payment_id, created_at)
       select gen_random_uuid(), p.tenant_id, p.customer_id, 'DEBIT', 'PURCHASE', p.amount, p.currency,
              'perf-purchase-' || p.id, p.order_id, p.id, p.confirmed_at
         from payments p
        where p.tenant_id = $1 and p.method = 'WALLET' and p.state = 'CONFIRMED' and p.reference like 'perf-%'
       union all
       select gen_random_uuid(), p.tenant_id, p.customer_id, 'CREDIT', 'ADMIN_CREDIT', p.amount * 2, p.currency,
              'perf-credit-' || p.id, null, null, p.created_at - interval '1 hour'
         from payments p
        where p.tenant_id = $1 and p.method = 'WALLET' and p.state = 'CONFIRMED' and p.reference like 'perf-%'`,
      [TENANT],
    );

    await step(
      'audit logs',
      `insert into audit_logs (id, tenant_id, occurred_at, actor_type, actor_id, actor_label, action, entity_type,
                               entity_id, after, correlation_id, source_surface, result)
       select gen_random_uuid(), $1, now() - ((g % 120) * interval '1 day') - ((g % 86400) * interval '1 second'),
              a.actor_type, a.actor_id, a.actor_label, a.action, a.entity_type, gen_random_uuid()::text,
              jsonb_build_object('seq', g), 'perf-corr-' || g, a.surface,
              case when g % 50 = 0 then 'DENIED' when g % 97 = 0 then 'FAILED' else 'SUCCESS' end
         from generate_series(1, $2::int) g,
              lateral (select (array['CUSTOMER','WEB_ADMIN','SYSTEM_JOB','PROVIDER_SYNC'])[1 + g % 4] as actor_type,
                              case g % 4 when 0 then 'perf-' || (7000000000 + g % 20000)
                                         when 1 then $3::text
                                         when 2 then 'job:telegram-update:' || g
                                         else 'provider-sync' end as actor_id,
                              case g % 4 when 1 then 'perfowner' else null end as actor_label,
                              (array['order.created','order.paid','payment.confirmed','service.provisioned',
                                     'customer.registered','settings.updated','wallet.credited'])[1 + g % 7] as action,
                              (array['order','order','payment','service','customer','setting','wallet'])[1 + g % 7]
                                as entity_type,
                              (array['TELEGRAM','WEB','WORKER','WORKER'])[1 + g % 4] as surface) a`,
      [TENANT, counts.audit, adminId ?? 'perf-admin'],
    );

    await step(
      'operational events',
      `insert into operational_events (id, tenant_id, code, severity, message, dedupe_key, dedupe_scope,
                                       occurrence_count, first_seen_at, last_seen_at, resolved_at)
       select gen_random_uuid(), $1::uuid, (array['panel.unreachable','notification.delivery_failed','payment.unknown_outcome'])[1 + g % 3],
              (array['WARN','ERROR','INFO'])[1 + g % 3], 'perf event ' || g, 'perf-' || g, 'TENANT:' || $1::text,
              1 + g % 5, now() - ((g % 120) * interval '1 day'), now() - ((g % 120) * interval '1 day') + interval '1 hour',
              case when g % 10 = 0 then null else now() - ((g % 120) * interval '1 day') + interval '2 hours' end
         from generate_series(1, $2::int) g`,
      [TENANT, counts.events],
    );

    await client.query('commit');
    await client.query('analyze');
    console.log('Seeded perf volume and analyzed.');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
