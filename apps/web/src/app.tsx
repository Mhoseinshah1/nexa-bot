import { useEffect, useState, type FormEvent, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SessionResponse } from '@nexa/contracts';
import { finalAnswer, pollSession } from './polling';
import { ApiError, fetchSession, signIn, signOut } from './api/client';
import { t } from './i18n/web.fa';
import { match, navigate, useDocumentTitle, useLinkHandler, useRoute, type Route } from './router';
import { useTheme } from './theme';
import { Icon } from './ui/icons';
import { Empty, LeaveGuardHost, ToastProvider } from './ui/kit';
import { NAV, navPermitted } from './nav';
import { useNavCounters } from './nav-counters';
import { CommandSearch, Sidebar, Topbar, useCommandShortcut } from './shell';
import { DashboardPage } from './pages/dashboard';
import { PanelsPage, PanelDetailPage, NewPanelPage, ProvidersPage } from './pages/panels';
import { SettingsPage } from './pages/settings';
import { BotButtonsPage } from './pages/bot-buttons';
import { FeaturesPage } from './pages/features';
import { ContentPage } from './pages/content';
import { RemindersPage } from './pages/reminders';
import { AlertsPage, NotificationsPage } from './pages/alerts';
import { OpsGroupPage } from './pages/ops-group';
import { AppearancePage } from './pages/appearance';
import { SystemPage } from './pages/system';
import { RecoveryPage } from './pages/recovery';
import { PlannedPage, PLANNED_SURFACES, type PlannedKey } from './pages/planned';
import { PaymentsPage, PaymentDetailPage } from './pages/payments';
import { CompensationsPage } from './pages/compensations';
import { PaymentAccountsPage } from './pages/payment-accounts';
import { BotsPage } from './pages/bots';
import { PaymentGatewaysPage } from './pages/payment-gateways';
import { SupportPage } from './pages/support';
import { ClientAppsPage } from './pages/client-apps';
import { TicketDetailPage, TicketsPage } from './pages/tickets';
import { BroadcastDetailPage, BroadcastNewPage, BroadcastsPage } from './pages/broadcasts';
import {
  BulkOperationDetailPage,
  BulkOperationNewPage,
  BulkOperationsPage,
} from './pages/bulk-operations';
import { ProductDetailPage, ProductsPage } from './pages/products';
import { ProductCategoriesPage } from './pages/product-categories';
import { ExtraDevicesPage } from './pages/extra-devices';
import { ServiceLocationsPage } from './pages/service-locations';
import { OrderDetailPage, OrdersPage } from './pages/orders';
import { ServiceDetailPage, ServicesPage } from './pages/services';
import { UsersPage, UserDetailPage } from './pages/users';
import { TrialsPage } from './pages/trials';
import { DiscountsPage } from './pages/discounts';
import { CampaignDetailPage, CampaignNewPage, CampaignsPage } from './pages/campaigns';
import { CustomServicePage } from './pages/custom-service';
import { ReferralsPage } from './pages/referrals';
import { ReportsPage } from './pages/business';
import { isSuperAdmin, mayExportReports } from './report-view';
import { ResellersPage } from './pages/resellers';
import { ResellerTiersPage } from './pages/reseller-tiers';
import { ResellerPlansPage } from './pages/reseller-plans';

/**
 * The Web Admin shell.
 *
 * Nothing here is fake. Every screen behind it either calls a real endpoint or
 * says, in the same vocabulary everywhere, that the capability does not exist
 * yet. `permission` decides what is DRAWN and never what is allowed: the server
 * re-checks every call, and this component would be exactly as safe if it drew
 * all of it. In the legacy system "enforcement" may well have meant nothing
 * more than menu hiding (UNK-ADM-001).
 */

/**
 * Which of four states the session query is in.
 *
 * A pure function, and separate from the component, because the distinction it
 * makes is a rule rather than a rendering detail: `fetchSession` resolves to
 * `null` ONLY for a 401 — the server saying there is no session — and rejects
 * for everything else. Collapsing those two into "show the sign-in form" told
 * an administrator holding a good cookie that they were signed out, and invited
 * them to open a second session to fix a problem that was never theirs.
 */
export function sessionView(query: {
  isPending: boolean;
  isError: boolean;
  data?: SessionResponse | null | undefined;
  // REQUIRED, though it may be `undefined`. Optional, a caller that forgot it
  // silently got the previous release's rule — data winning over every error —
  // which is the defect this parameter was added to remove.
  error: unknown;
}): 'loading' | 'unavailable' | 'signed-in' | 'signed-out' {
  if (query.isPending) return 'loading';
  // A resolved `null` is the server's own "nobody is signed in", and it stays
  // the answer through any later failure. This is NOT the truthy case below and
  // does not get the same treatment: surrendering a session on a final answer
  // is right because a console that cannot be confirmed lies, and a sign-in
  // form never does. Without this a signed-OUT browser returning to its tab
  // during a deploy was put on the terminal "unavailable" screen — told it
  // might still be signed in, blocked from the form it was using, with no
  // interval and no way back — and on a retryable failure the same path
  // unmounted the form mid-typing and lost the username already in it.
  if (query.data === null) return 'signed-out';
  // Data wins over a RETRYABLE error, and only over a retryable one.
  //
  // The first half is why this exists: `refetchOnReconnect` is on by default,
  // so a laptop waking, a kiosk NIC flap or a Caddy reload fires `online` a
  // moment before the API is reachable, and replacing the signed-in tree with
  // an error paragraph unmounted every open form and lost whatever had been
  // typed into it — for a blip the next poll resolves. A session we DID resolve
  // is the best thing we know while the lookup is merely struggling.
  //
  // The second half is why the first is not enough. `pollSession` STOPS on a
  // final answer — a 403, or a `ZodError` from a tab holding a previous release
  // across a deploy — so on those the shell has learned the lookup is
  // permanently broken and will never ask again. Letting data win there kept a
  // complete, fully drawn console on screen for ever, with nothing to press and
  // nothing said: the exact defect the round before this one was written to
  // remove, reached through the door its own fix opened. The two rules have to
  // agree about which failures are worth waiting through.
  if (query.data && !finalAnswer(query.error)) return 'signed-in';
  if (query.isError) return 'unavailable';
  // Reaching here with `data` truthy needs `isError` false alongside a final
  // `error`, which query-core cannot produce: it sets and clears the two
  // together. `signed-out` rather than `query.data ? … : …` so the unreachable
  // case cannot answer `signed-in` for the state the line above just refused.
  return 'signed-out';
}

// ---------------------------------------------------------------------------
// The route table
// ---------------------------------------------------------------------------

export { NAV, GROUP_ORDER, navPermitted, isCurrent, type NavEntry } from './nav';

/**
 * The page for a path, plus the crumb trail that leads to it.
 *
 * One function so the two cannot disagree. A breadcrumb computed separately
 * from the render is a breadcrumb that eventually names a page you are not on.
 */
interface Resolved {
  readonly element: React.ReactNode;
  readonly crumbs: readonly { label: string; href?: string }[];
  readonly title: string;
}

/**
 * Every route `resolve` serves, as a pattern (`:id` is one path segment).
 *
 * The inventory the route test walks: each pattern must resolve to a real page
 * component, never to `NotFound`, and every navigation entry's path must be
 * one of them. The test also reads `resolve` below for its literal paths and
 * requires the two lists to agree, so a route added there and not here — or
 * listed here and served nowhere — fails the suite rather than going unwalked.
 */
export const ROUTE_PATTERNS: readonly string[] = [
  '/',
  '/users',
  '/users/:id',
  '/trials',
  '/products',
  '/products/:id',
  '/product-categories',
  '/extra-devices',
  '/service-locations',
  '/orders',
  '/orders/:id',
  '/services',
  '/services/:id',
  '/broadcasts',
  '/broadcasts/new',
  '/broadcasts/:id',
  '/bulk-operations',
  '/bulk-operations/new',
  '/bulk-operations/:id',
  '/tickets',
  '/tickets/:id',
  '/payments',
  '/payments/:id',
  '/compensations',
  '/payment-accounts',
  '/payment-gateways',
  '/bots',
  '/discounts',
  '/campaigns',
  '/campaigns/new',
  '/campaigns/:id',
  '/custom-service',
  '/referrals',
  '/resellers',
  '/reseller-tiers',
  '/reseller-plans',
  '/reports',
  '/panels',
  '/panels/new',
  '/panels/:id',
  '/providers',
  '/settings',
  '/support',
  '/client-apps',
  '/features',
  '/reminders',
  '/bot-buttons',
  '/content',
  '/alerts',
  '/notifications',
  '/appearance',
  '/ops-group',
  '/recovery',
  '/system',
];

/**
 * Round N, C1: each campaign action's editor is drawn on the key the server charges for it —
 * the discounts route's rule, per action.
 */
function campaignActionPermissions(may: (permission: string) => boolean) {
  return {
    discount: may('catalog.discounts.edit'),
    cashback: may('catalog.pricing.edit'),
    walletGift: may('users.wallet.mass'),
    serviceGift: may('services.mass.grant'),
    announcement: may('broadcasts.send'),
  };
}

/**
 * The route table, exported so a test can walk it.
 *
 * The planned-surface suite asserted nine component KEYS, never nine PATHS —
 * so a typo in `PLANNED_SURFACES[].path` would have left every one of its
 * eighteen assertions green while the navigation link fell through to
 * `NotFound`. Nothing exercised this function at all.
 */
export function resolve(
  route: Route,
  permissions: readonly string[],
  roleKeys: readonly string[] = [],
): Resolved {
  const may = (permission: string | null): boolean =>
    permission === null || permissions.includes(permission);
  const superAdmin = isSuperAdmin(roleKeys, permissions);

  const nav = (id: string): { label: string; href: string } => {
    const entry = NAV.find((candidate) => candidate.id === id);
    return { label: entry ? t(entry.label) : id, href: entry ? entry.path : '/' };
  };

  if (route.path === '/') {
    return {
      element: <DashboardPage permissions={permissions} route={route} superAdmin={superAdmin} />,
      crumbs: [{ label: t('web.nav_overview') }],
      title: t('web.nav_overview'),
    };
  }

  if (route.path === '/users') {
    return {
      element: (
        <UsersPage
          route={route}
          // THREE separate server permissions, passed separately because the
          // server charges them separately: `users.view` lists, `users.search`
          // narrows by Telegram id or username, `users.block` changes a status.
          // Collapsing them would hide a capability the server permits.
          maySearch={may('users.search')}
          mayManageTags={may('users.tags.manage')}
          denied={!may('users.view')}
        />
      ),
      crumbs: [{ label: t('web.users_title') }],
      title: t('web.users_title'),
    };
  }

  const user = match('/users/:id', route.path);
  if (user !== null) {
    return {
      element: (
        // KEYED BY THE CUSTOMER ID, for the reason the panel detail gives in
        // full: React reconciles by position and type, so navigating between two
        // customer URLs would keep one instance mounted and every `useState`
        // initialiser would hold the previous customer's value — here the block
        // reason, which would then be written onto the wrong person.
        <UserDetailPage
          key={user['id'] ?? ''}
          id={user['id'] ?? ''}
          mayBlock={may('users.block')}
          mayViewWallet={may('users.view')}
          mayCredit={may('users.wallet.credit')}
          mayDebit={may('users.wallet.debit')}
          mayViewOrders={may('orders.view')}
          mayViewServices={may('services.view')}
          mayEditTrial={may('users.trial.edit')}
          mayViewReferrals={may('referrals.view')}
          mayViewReseller={may('resellers.view')}
          mayEditReseller={may('resellers.edit')}
          mayExemptChannel={may('users.channel_membership.exempt')}
          mayVerifyPhone={may('users.phone.verify')}
          mayEditLocation={may('users.location.edit')}
          mayEditNotifications={may('users.notifications.edit')}
          mayTransfer={may('users.transfer')}
          mayManualOrder={may('orders.manual.create')}
          mayEditServices={may('services.edit')}
          mayViewAudit={may('audit.view')}
          mayViewNotes={may('users.notes.view')}
          mayWriteNotes={may('users.notes.write')}
          mayAssignTags={may('users.tags.assign')}
          mayManageTags={may('users.tags.manage')}
          denied={!may('users.view')}
        />
      ),
      crumbs: [nav('users'), { label: t('web.user_detail') }],
      title: t('web.user_detail'),
    };
  }

  if (route.path === '/trials') {
    return {
      element: (
        <TrialsPage
          mayViewOverrides={may('users.view')}
          // The preview names customers, so it is `users.view` as well (Codex, PR #65).
          mayReset={may('settings.destructive') && may('users.view')}
          mayViewHistory={may('settings.view')}
          mayViewPanels={may('panels.view')}
        />
      ),
      crumbs: [{ label: t('web.trials_title') }],
      title: t('web.trials_title'),
    };
  }

  if (route.path === '/products') {
    return {
      element: (
        <ProductsPage route={route} mayEdit={may('catalog.edit')} denied={!may('catalog.view')} />
      ),
      crumbs: [{ label: t('web.products_title') }],
      title: t('web.products_title'),
    };
  }

  if (route.path === '/service-locations') {
    return {
      element: (
        <ServiceLocationsPage
          mayEdit={may('catalog.edit')}
          denied={!may('catalog.view')}
          mayReadPanels={may('panels.view')}
        />
      ),
      crumbs: [{ label: t('web.service_locations_title') }],
      title: t('web.service_locations_title'),
    };
  }

  if (route.path === '/extra-devices') {
    return {
      element: (
        <ExtraDevicesPage
          mayEdit={may('catalog.edit')}
          mayViewPanels={may('panels.view')}
          denied={!may('catalog.view')}
        />
      ),
      crumbs: [{ label: t('web.extra_devices_title') }],
      title: t('web.extra_devices_title'),
    };
  }

  if (route.path === '/product-categories') {
    return {
      element: (
        <ProductCategoriesPage mayEdit={may('catalog.edit')} denied={!may('catalog.view')} />
      ),
      crumbs: [{ label: t('web.categories_title') }],
      title: t('web.categories_title'),
    };
  }

  const product = match('/products/:id', route.path);
  if (product !== null) {
    return {
      element: (
        // KEYED BY THE PRODUCT ID, for the reason the panel and user details give in
        // full: React reconciles by position and type, so navigating between two product
        // URLs would keep one instance mounted and every `useState` initialiser would
        // hold the previous product's values — here the fields about to be written.
        <ProductDetailPage
          key={product['id'] ?? ''}
          id={product['id'] ?? ''}
          mayEdit={may('catalog.edit')}
          denied={!may('catalog.view')}
        />
      ),
      crumbs: [nav('products'), { label: t('web.product_detail') }],
      title: t('web.product_detail'),
    };
  }

  if (route.path === '/orders') {
    return {
      element: <OrdersPage route={route} denied={!may('orders.view')} />,
      crumbs: [{ label: t('web.orders_title') }],
      title: t('web.orders_title'),
    };
  }

  if (route.path === '/services') {
    return {
      element: (
        <ServicesPage
          route={route}
          denied={!may('services.view')}
          mayViewRefundRequests={may('refunds.view')}
        />
      ),
      crumbs: [{ label: t('web.services_title') }],
      title: t('web.services_title'),
    };
  }

  const service = match('/services/:id', route.path);
  if (service !== null) {
    return {
      element: (
        // KEYED BY THE SERVICE ID, for the reason the panel, user and product details
        // give in full: React reconciles by position and type, so navigating between
        // two service URLs would keep one instance mounted and every `useState`
        // initialiser would hold the previous service's values.
        <ServiceDetailPage
          key={service['id'] ?? ''}
          id={service['id'] ?? ''}
          denied={!may('services.view')}
          mayEdit={may('services.edit')}
          /* Its own key, and the reason the page separates the terminate control. */
          mayTerminate={may('services.terminate')}
          /* WP19: a customer's refund request deletes the service AND moves money. */
          mayViewRefundRequests={may('refunds.view')}
          mayDecideRefundRequests={may('refunds.issue') && may('services.terminate')}
        />
      ),
      crumbs: [nav('services'), { label: t('web.service_detail') }],
      title: t('web.service_detail'),
    };
  }

  // Round N: broadcast and mass operations.
  if (route.path === '/broadcasts') {
    return {
      element: (
        <BroadcastsPage
          route={route}
          denied={!may('broadcasts.view')}
          maySend={may('broadcasts.send')}
        />
      ),
      crumbs: [{ label: t('web.bc_page_title') }],
      title: t('web.bc_page_title'),
    };
  }
  if (route.path === '/broadcasts/new') {
    return {
      element: <BroadcastNewPage maySend={may('broadcasts.send')} />,
      crumbs: [nav('broadcasts'), { label: t('web.bc_new') }],
      title: t('web.bc_new'),
    };
  }
  const broadcast = match('/broadcasts/:id', route.path);
  if (broadcast !== null) {
    return {
      element: (
        <BroadcastDetailPage
          key={broadcast['id'] ?? ''}
          id={broadcast['id'] ?? ''}
          denied={!may('broadcasts.view')}
          maySend={may('broadcasts.send')}
        />
      ),
      crumbs: [nav('broadcasts'), { label: t('web.bc_detail') }],
      title: t('web.bc_detail'),
    };
  }
  if (route.path === '/bulk-operations') {
    return {
      element: (
        <BulkOperationsPage
          route={route}
          denied={!may('bulk_operations.view')}
          mayRun={may('users.wallet.mass') || may('services.mass.grant')}
        />
      ),
      crumbs: [{ label: t('web.bulk_page_title') }],
      title: t('web.bulk_page_title'),
    };
  }
  if (route.path === '/bulk-operations/new') {
    return {
      element: (
        <BulkOperationNewPage
          mayWallet={may('users.wallet.mass')}
          mayGrant={may('services.mass.grant')}
        />
      ),
      crumbs: [nav('bulk-operations'), { label: t('web.bulk_new') }],
      title: t('web.bulk_new'),
    };
  }
  const bulk = match('/bulk-operations/:id', route.path);
  if (bulk !== null) {
    return {
      element: (
        <BulkOperationDetailPage
          key={bulk['id'] ?? ''}
          id={bulk['id'] ?? ''}
          denied={!may('bulk_operations.view')}
          mayWallet={may('users.wallet.mass')}
          mayGrant={may('services.mass.grant')}
        />
      ),
      crumbs: [nav('bulk-operations'), { label: t('web.bulk_detail') }],
      title: t('web.bulk_detail'),
    };
  }

  // WP-A7: the ticket inbox and one conversation.
  if (route.path === '/tickets') {
    return {
      element: (
        <TicketsPage
          route={route}
          denied={!may('tickets.view')}
          mayAssign={may('tickets.assign')}
          mayEditCategories={may('tickets.categories.edit')}
        />
      ),
      crumbs: [{ label: t('web.tickets_title') }],
      title: t('web.tickets_title'),
    };
  }

  const ticket = match('/tickets/:id', route.path);
  if (ticket !== null) {
    return {
      element: (
        // Keyed by the ticket id, for the reason the service detail gives.
        <TicketDetailPage
          key={ticket['id'] ?? ''}
          id={ticket['id'] ?? ''}
          denied={!may('tickets.view')}
          mayReply={may('tickets.reply')}
          mayAssign={may('tickets.assign')}
          mayClose={may('tickets.close')}
        />
      ),
      crumbs: [nav('tickets'), { label: t('web.ticket_detail') }],
      title: t('web.ticket_detail'),
    };
  }

  if (route.path === '/payment-accounts') {
    return {
      element: (
        <PaymentAccountsPage
          denied={!may('payments.accounts.view')}
          mayEdit={may('payments.accounts.edit')}
        />
      ),
      crumbs: [{ label: t('web.payment_accounts_title') }],
      title: t('web.payment_accounts_title'),
    };
  }

  /*
   * WP13. `settings.view` reads, `settings.edit` stops, starts and runs the live check,
   * and `settings.destructive` replaces the token — each passed separately, never
   * derived from `denied`, for the reason `PaymentAccountsPage` records.
   */
  if (route.path === '/bots') {
    return {
      element: (
        <BotsPage
          denied={!may('settings.view')}
          mayOperate={may('settings.edit')}
          mayReplaceToken={may('settings.destructive')}
        />
      ),
      crumbs: [{ label: t('web.nav_bots') }],
      title: t('web.nav_bots'),
    };
  }

  if (route.path === '/payment-gateways') {
    return {
      element: (
        <PaymentGatewaysPage
          denied={!may('payments.gateways.view')}
          mayEdit={may('payments.gateways.edit')}
        />
      ),
      crumbs: [{ label: t('web.payment_gateways_title') }],
      title: t('web.payment_gateways_title'),
    };
  }

  if (route.path === '/discounts') {
    return {
      element: (
        <DiscountsPage
          denied={!may('catalog.view')}
          /*
           * Two write keys, passed separately because the server charges them
           * separately: a discount on `catalog.discounts.edit`, a cashback rule on
           * `catalog.pricing.edit`. Folding them into one would draw a form the server
           * refuses for somebody holding the other.
           */
          mayEditDiscounts={may('catalog.discounts.edit')}
          mayEditCashback={may('catalog.pricing.edit')}
        />
      ),
      crumbs: [{ label: t('web.discounts_title') }],
      title: t('web.discounts_title'),
    };
  }

  // Round N, C1: campaigns — the list, a new draft, and one campaign.
  if (route.path === '/campaigns') {
    return {
      element: (
        <CampaignsPage
          route={route}
          denied={!may('campaigns.view')}
          mayManage={may('campaigns.manage')}
        />
      ),
      crumbs: [{ label: t('web.campaigns_title') }],
      title: t('web.campaigns_title'),
    };
  }
  if (route.path === '/campaigns/new') {
    return {
      element: (
        <CampaignNewPage
          denied={!may('campaigns.view')}
          mayManage={may('campaigns.manage')}
          may={campaignActionPermissions(may)}
        />
      ),
      crumbs: [nav('campaigns'), { label: t('web.campaign_new') }],
      title: t('web.campaign_new'),
    };
  }
  const campaign = match('/campaigns/:id', route.path);
  if (campaign !== null) {
    return {
      element: (
        <CampaignDetailPage
          key={campaign['id'] ?? ''}
          id={campaign['id'] ?? ''}
          denied={!may('campaigns.view')}
          mayManage={may('campaigns.manage')}
          may={campaignActionPermissions(may)}
        />
      ),
      crumbs: [nav('campaigns'), { label: t('web.campaigns_title') }],
      title: t('web.campaigns_title'),
    };
  }

  if (route.path === '/custom-service') {
    return {
      element: (
        <CustomServicePage
          denied={!may('catalog.view')}
          // The server charges `catalog.pricing.edit` for every rule and location write.
          mayEdit={may('catalog.pricing.edit')}
          /*
           * The pickers' own keys, passed separately because the server charges them
           * separately: the fleet on `panels.view`, the tiers on `resellers.view`.
           * Without one, that picker takes a typed id instead of asking for a list it
           * would be refused.
           */
          mayViewPanels={may('panels.view')}
          mayViewTiers={may('resellers.view')}
        />
      ),
      crumbs: [{ label: t('web.custom_service_title') }],
      title: t('web.custom_service_title'),
    };
  }

  if (route.path === '/referrals') {
    return {
      element: (
        <ReferralsPage
          route={route}
          denied={!may('referrals.view')}
          // The banner is tenant configuration: read under `settings.view`, written under
          // `settings.edit`, both charged by `TenantMediaService` on their own.
          mayViewBanner={may('settings.view')}
          mayEditBanner={may('settings.edit')}
          superAdmin={superAdmin}
          mayExportReports={mayExportReports(roleKeys, permissions)}
        />
      ),
      crumbs: [{ label: t('web.referrals_title') }],
      title: t('web.referrals_title'),
    };
  }

  if (route.path === '/resellers') {
    return {
      element: (
        <ResellersPage
          route={route}
          denied={!may('resellers.view')}
          mayEdit={may('resellers.edit')}
          mayViewWallet={may('users.view')}
          mayViewOrders={may('orders.view')}
          mayViewAudit={may('audit.view')}
          mayViewCatalog={may('catalog.view')}
          mayViewPanels={may('panels.view')}
        />
      ),
      crumbs: [{ label: t('web.resellers_title') }],
      title: t('web.resellers_title'),
    };
  }

  if (route.path === '/reseller-tiers') {
    return {
      element: (
        <ResellerTiersPage
          denied={!may('resellers.view')}
          mayEdit={may('resellers.edit')}
          /*
           * The pickers' own keys, passed separately because the server charges them
           * separately: the catalogue lists on `catalog.view`, the fleet on
           * `panels.view`. Without one, that picker takes a typed id instead of asking
           * for a list it would be refused.
           */
          mayViewCatalog={may('catalog.view')}
          mayViewPanels={may('panels.view')}
          mayViewAudit={may('audit.view')}
        />
      ),
      crumbs: [nav('resellers'), { label: t('web.reseller_tiers_title') }],
      title: t('web.reseller_tiers_title'),
    };
  }

  if (route.path === '/reseller-plans') {
    return {
      element: (
        <ResellerPlansPage
          denied={!may('resellers.view')}
          mayEdit={may('resellers.edit')}
          mayViewOrders={may('orders.view')}
          mayViewCatalog={may('catalog.view')}
          mayViewPanels={may('panels.view')}
        />
      ),
      crumbs: [nav('resellers'), { label: t('web.reseller_plans_title') }],
      title: t('web.reseller_plans_title'),
    };
  }

  if (route.path === '/payments') {
    return {
      element: <PaymentsPage route={route} denied={!may('payments.view')} />,
      crumbs: [{ label: t('web.payments_title') }],
      title: t('web.payments_title'),
    };
  }

  if (route.path === '/compensations') {
    return {
      element: <CompensationsPage route={route} denied={!may('payments.view')} />,
      crumbs: [nav('payments'), { label: t('web.compensations_title') }],
      title: t('web.compensations_title'),
    };
  }

  const payment = match('/payments/:id', route.path);
  if (payment !== null) {
    return {
      element: (
        <PaymentDetailPage
          key={payment['id'] ?? ''}
          id={payment['id'] ?? ''}
          /*
           * No review permission is passed: card-to-card review is Telegram's alone
           * (Payment File 02 §10), and this page draws no decision for anybody.
           */
          mayViewReceipts={may('receipts.view')}
          /*
           * Two refund permissions, not one.
           *
           * `refunds.view` reads the history — financial evidence about a customer —
           * and `refunds.issue` is the CRITICAL half that moves money. The service
           * charges both itself; this only decides whether the card is drawn and
           * whether its forms are, and the denied half names the permission rather
           * than drawing a disabled button.
           */
          mayViewRefunds={may('refunds.view')}
          // TonPays Telegram §9.6.4: resolving an UNKNOWN gateway payment from recorded evidence.
          mayReconcile={may('payments.reconcile')}
          mayIssueRefunds={may('refunds.issue')}
          mayViewWallet={may('users.view')}
          /*
           * `orders.view`, for the ORDER's state after a full refund (WP10 P3). The card
           * reads the order rather than inferring it from the refund rows, and without
           * this it says nothing about an order the operator may not open.
           */
          mayViewOrders={may('orders.view')}
          denied={!may('payments.view')}
        />
      ),
      crumbs: [nav('payments'), { label: t('web.payment_detail') }],
      title: t('web.payment_detail'),
    };
  }

  const order = match('/orders/:id', route.path);
  if (order !== null) {
    return {
      element: (
        <OrderDetailPage
          key={order['id'] ?? ''}
          id={order['id'] ?? ''}
          denied={!may('orders.view')}
          /*
           * Payments are their OWN permission, decided here rather than assumed.
           *
           * An operator may hold `orders.view` and not `payments.view`, and the
           * embedded payments card used to issue its request regardless — so opening
           * any order they could legitimately read logged a 403 they could do nothing
           * about. `PaymentService.list` was right to refuse it; the surface was wrong
           * to ask.
           */
          mayViewPayments={may('payments.view')}
          /* Same rule, same reason: `services.view` is its own grant. */
          mayViewServices={may('services.view')}
        />
      ),
      crumbs: [nav('orders'), { label: t('web.order_detail') }],
      title: t('web.order_detail'),
    };
  }

  if (route.path === '/panels') {
    return {
      element: (
        <PanelsPage route={route} mayEdit={may('panels.edit')} denied={!may('panels.view')} />
      ),
      crumbs: [{ label: t('web.nav_panels') }],
      title: t('web.nav_panels'),
    };
  }

  if (route.path === '/panels/new') {
    return {
      element: (
        <NewPanelPage
          denied={!may('panels.edit')}
          // Where they may go afterwards, which is not the same permission as
          // the one that let them fill the form in.
          mayView={may('panels.view')}
          // Initial credentials are a credential write, guarded by the same
          // CRITICAL permission as a rotation. Without this the create form
          // was the way round the boundary the detail page enforces.
          mayRotate={may('panels.credentials.rotate')}
        />
      ),
      crumbs: [nav('panels'), { label: t('web.panel_new') }],
      title: t('web.panel_new'),
    };
  }

  const panel = match('/panels/:id', route.path);
  if (panel !== null) {
    return {
      element: (
        // KEYED BY THE PANEL ID, and that is load-bearing rather than tidy.
        //
        // React reconciles by position and type, so navigating between two
        // panel-detail URLs kept ONE `PanelDetailPage` instance mounted. The
        // query key changes and the heading follows the new panel, but every
        // `useState` initialiser in the subtree ran once, against the old one:
        // `OverviewTab`'s `name`, `baseUrl` and `basis`, the credential draft
        // fields, and the selected tab. Pressing Save then wrote panel B's name
        // onto panel A — a cross-entity write, from a screen that looked
        // entirely normal.
        //
        // It needed both panels cached to be reachable: a pending query renders
        // a skeleton, which unmounts the subtree and hides it. Browser history
        // between two visited panels is exactly that state.
        //
        // The key is the structural fix. Resetting the two fields by hand would
        // leave the credential drafts and the tab, and would have to be
        // remembered by every future piece of per-panel state.
        <PanelDetailPage
          key={panel['id'] ?? ''}
          id={panel['id'] ?? ''}
          mayEdit={may('panels.edit')}
          mayRotate={may('panels.credentials.rotate')}
          // WP-A8: the Super Admin's read-only technical view.
          mayViewTechnical={may('panels.technical.view')}
          denied={!may('panels.view')}
        />
      ),
      crumbs: [nav('panels'), { label: t('web.panel_detail') }],
      title: t('web.panel_detail'),
    };
  }

  if (route.path === '/providers') {
    return {
      element: <ProvidersPage />,
      crumbs: [{ label: t('web.nav_providers') }],
      title: t('web.nav_providers'),
    };
  }

  if (route.path === '/settings') {
    return {
      element: <SettingsPage mayEdit={may('settings.edit')} denied={!may('settings.view')} />,
      crumbs: [{ label: t('web.nav_settings') }],
      title: t('web.nav_settings'),
    };
  }

  if (route.path === '/support') {
    return {
      element: <SupportPage mayEdit={may('settings.edit')} denied={!may('settings.view')} />,
      crumbs: [{ label: t('web.nav_support') }],
      title: t('web.nav_support'),
    };
  }

  if (route.path === '/client-apps') {
    return {
      element: (
        <ClientAppsPage mayEdit={may('client_apps.edit')} denied={!may('client_apps.view')} />
      ),
      crumbs: [{ label: t('web.nav_client_apps') }],
      title: t('web.nav_client_apps'),
    };
  }

  if (route.path === '/features') {
    return {
      element: <FeaturesPage mayEdit={may('settings.edit')} denied={!may('settings.view')} />,
      crumbs: [{ label: t('web.nav_features') }],
      title: t('web.nav_features'),
    };
  }

  if (route.path === '/reminders') {
    return {
      element: (
        <RemindersPage
          mayEdit={may('settings.edit')}
          denied={!may('settings.view')}
          mayViewTemplates={may('templates.view')}
          mayEditTemplates={may('templates.edit')}
        />
      ),
      crumbs: [{ label: t('web.nav_reminders') }],
      title: t('web.nav_reminders'),
    };
  }

  if (route.path === '/bot-buttons') {
    return {
      element: (
        <BotButtonsPage
          mayEdit={may('settings.edit')}
          denied={!may('settings.view')}
          mayViewTemplates={may('templates.view')}
          mayEditTemplates={may('templates.edit')}
        />
      ),
      crumbs: [{ label: t('web.nav_bot_buttons') }],
      title: t('web.nav_bot_buttons'),
    };
  }

  if (route.path === '/content') {
    return {
      element: <ContentPage mayEdit={may('templates.edit')} denied={!may('templates.view')} />,
      crumbs: [{ label: t('web.nav_templates') }],
      title: t('web.nav_templates'),
    };
  }

  if (route.path === '/alerts') {
    return {
      element: <AlertsPage denied={!may('opslog.view')} />,
      crumbs: [{ label: t('web.nav_alerts') }],
      title: t('web.nav_alerts'),
    };
  }

  if (route.path === '/notifications') {
    return {
      element: <NotificationsPage mayTest={may('settings.edit')} denied={!may('opslog.view')} />,
      crumbs: [{ label: t('web.nav_notifications') }],
      title: t('web.nav_notifications'),
    };
  }

  if (route.path === '/appearance') {
    return {
      element: <AppearancePage denied={!may('settings.view')} mayEdit={may('settings.edit')} />,
      crumbs: [{ label: t('web.nav_appearance') }],
      title: t('web.appearance_title'),
    };
  }

  if (route.path === '/ops-group') {
    return {
      element: <OpsGroupPage denied={!may('settings.view')} mayManage={may('settings.edit')} />,
      crumbs: [{ label: t('web.nav_ops_group') }],
      title: t('web.opsgroup_title'),
    };
  }

  if (route.path === '/recovery') {
    return {
      element: <RecoveryPage route={route} permissions={permissions} />,
      crumbs: [{ label: t('web.nav_recovery') }],
      title: t('web.nav_recovery'),
    };
  }

  if (route.path === '/system') {
    return {
      element: <SystemPage route={route} permissions={permissions} />,
      crumbs: [{ label: t('web.nav_system') }],
      title: t('web.nav_system'),
    };
  }

  if (route.path === '/reports') {
    return {
      element: (
        <ReportsPage
          route={route}
          denied={!superAdmin}
          mayExport={mayExportReports(roleKeys, permissions)}
        />
      ),
      crumbs: [{ label: t('web.nav_reports') }],
      title: t('web.nav_reports'),
    };
  }

  const planned = PLANNED_SURFACES.find((surface) => surface.path === route.path);
  if (planned !== undefined) {
    return {
      element: <PlannedPage surface={planned.key as PlannedKey} />,
      crumbs: [{ label: t(planned.label) }],
      title: t(planned.label),
    };
  }

  return {
    element: <NotFound />,
    crumbs: [{ label: t('web.not_found_title') }],
    title: t('web.not_found_title'),
  };
}

function NotFound() {
  const onLink = useLinkHandler();
  return (
    <div className="not-found">
      <Empty
        icon="alert"
        title={t('web.not_found_title')}
        hint={t('web.not_found_hint')}
        action={
          <a className="btn" href="/" onClick={onLink}>
            <Icon name="dashboard" />
            {t('web.nav_overview')}
          </a>
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/**
 * How often the shell re-resolves its session.
 *
 * The bound on two things: how long an expired or revoked session goes on
 * looking valid, and how long a permission this tab no longer holds goes on
 * being believed. A minute is short enough that neither outlives an operator's
 * attention and long enough to be one request per tab per minute.
 *
 * A FAILING session is asked about on `polling.ts`'s slow lane instead, which
 * is the shorter of the two; this constant governs the healthy cadence.
 */
const SESSION_REFRESH_MS = 60_000;

export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: fetchSession,
    retry: false,
    // The shell keeps up with its own session. See `pollSession`: without an
    // interval the "session unavailable" screen below was terminal for an
    // unattended tab — its Retry button being the very rationalisation this
    // branch established is false wherever nobody is present to press it — and
    // an expired session left a complete admin console on screen for ever.
    refetchInterval: pollSession(SESSION_REFRESH_MS),
    // ON, against the global default, and only here. `refetchInterval` does not
    // run while a tab is hidden (`refetchIntervalInBackground` is `false` by
    // default), so the interval alone covers the wall display and NOT the case
    // this was written for: an operator who leaves the tab open behind another
    // one. Without this they come back to the dead console, click something,
    // and are told to sign in again up to a minute later. Scoped to the session
    // because it is the one query whose answer can have changed while nobody
    // was looking; the pages have their own intervals and re-fetch on mount.
    refetchOnWindowFocus: true,
  });
  const view = sessionView(session);

  if (view === 'loading')
    return (
      <main className="shell screen" aria-busy="true">
        <p className="screen-loading">{t('web.loading')}</p>
      </main>
    );

  // A failed LOOKUP is not a signed-out state. `fetchSession` returns null only
  // for a 401, which is the server saying "no session"; anything else — a
  // database outage, a proxy 503, a dropped connection — rejects. Rendering the
  // sign-in form for those told an administrator holding a perfectly good
  // cookie that they were logged out, and invited them to open a second
  // session to fix a problem that was never theirs.
  if (view === 'unavailable') {
    /*
     * The THIRD error card, and the one that gates every other screen.
     *
     * `errorCopy` was introduced to stop two sites giving one screen two
     * diagnoses of one failure, and it was wired into the two that draw a
     * `StateSwitch`-shaped card. This one draws its own, and was left saying
     * the connection could not be established — with a live Retry — for
     * answers the server returned correctly. The headline case is a `ZodError`
     * on the SUCCESS path: a tab holding a previous release across a deploy
     * gets a 200 it cannot parse, and `pollSession` has STOPPED, so nothing
     * will ever ask again. Measured before this: copy blaming the connection
     * after a 200, and a Retry button whose press issued two more requests
     * (`main.tsx` retries once) that could not answer differently.
     *
     * `finalAnswer` rather than `errorCopy` because a 403 here is not "you may
     * not see this section" — it is the session lookup itself being refused,
     * and `refused()`'s copy would be a worse lie than the one being removed.
     * The rule is the same rule; only the vocabulary is the shell's.
     */
    const settled = finalAnswer(session.error);
    return (
      <main className="shell screen">
        <div className="screen-card">
          <Brand />
          <p className={settled ? 'danger' : 'warn'}>
            {settled ? t('web.rejected') : t('web.session_unavailable')}
          </p>
          {settled ? (
            <p className="muted small">{t('web.rejected_hint')}</p>
          ) : (
            <button type="button" className="btn" onClick={() => void session.refetch()}>
              <Icon name="refresh" />
              {t('web.retry')}
            </button>
          )}
        </div>
      </main>
    );
  }

  // From `view`, not from `session.data` again.
  //
  // Reading the data directly here left one ARM of `sessionView` unconsumed:
  // changing `signed-in` to `signed-out` — the arm that decides whether a
  // session survives a stale error — killed nothing, 239 of 239 web tests
  // green, because `App` acted on `loading` and `unavailable` and took the
  // console straight from `data`. With this line the same change kills seven.
  //
  // (Not "the function could return `signed-out` in every case and nothing
  // would notice": muting all four arms destroys `loading` and `unavailable`
  // too and always failed. The narrow claim is the true one, and it is the one
  // that matters — a rule expressed in an arm nobody reads is a rule that will
  // be edited in good faith and have no effect.)
  return (
    <ToastProvider>
      {view === 'signed-in' && session.data ? (
        <SignedIn permissions={session.data.permissions} admin={session.data.admin} />
      ) : (
        <SignIn />
      )}
    </ToastProvider>
  );
}

function SignIn() {
  const client = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const attempt = useMutation({
    // NEVER retried, whatever the global default is. Sign-in carries no
    // idempotency key and creates a session on every success, so an automatic
    // second attempt spends two of the throttle's allowance for one rejected
    // password, and a success whose response was lost leaves a live session
    // whose token the browser never received.
    retry: false,
    mutationFn: () => signIn(username, password),
    onSuccess: async () => {
      setPassword('');
      /*
       * Everything the PREVIOUS session cached is dropped before this one reads
       * anything.
       *
       * The console is a single-page app and a session can end without anyone
       * signing out: the cookie expires, the shell falls back to this screen, and
       * someone else signs in — on the shared operations machine that the sign-out
       * path below exists for. Every query key in this app is tenant-independent,
       * so without this the first frame of `/users` renders the previous tenant's
       * customer names, usernames and Telegram ids, and `staleTime` plus "keep the
       * previous data through a failed refetch" can hold them there.
       *
       * Dropped HERE rather than by adding a tenant to ~40 query keys: the keys are
       * correct as cache identities and the thing that changed is WHO is asking, so
       * the boundary is the session change. `removeQueries` and not `clear`, so the
       * session query this invalidate is about survives to be re-read.
       */
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      await client.invalidateQueries({ queryKey: ['session'] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    attempt.mutate();
  };

  return (
    <main className="shell signin screen">
      <div className="screen-card">
        <header>
          <Brand />
        </header>

        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="username">{t('web.username')}</label>
            <input
              id="username"
              name="username"
              className="input"
              dir="ltr"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>

          <div className="field">
            <label htmlFor="password">{t('web.password')}</label>
            <input
              id="password"
              name="password"
              type="password"
              className="input"
              dir="ltr"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>

          <button type="submit" className="btn primary" disabled={attempt.isPending}>
            {attempt.isPending ? t('web.signing_in') : t('web.sign_in')}
          </button>

          {attempt.isError && (
            <p className="error" role="alert">
              {messageFor(attempt.error)}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}

/** The product mark and name, as the sidebar draws them. */
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        N
      </span>
      <span className="brand-text">
        <h1 className="strong">{t('web.title')}</h1>
        <span className="subtitle">{t('web.subtitle')}</span>
      </span>
    </div>
  );
}

/**
 * One message for every credential failure.
 *
 * The server already refuses to distinguish an unknown username from a wrong
 * password; rendering the server's own text per case would be a way to undo
 * that here. Only rate limiting reads differently, because telling somebody to
 * come back later is not information about an account.
 */
function messageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === 'auth.rate_limited') return t('web.rate_limited');
  return t('web.sign_in_failed');
}

function SignedIn({
  admin,
  permissions,
}: {
  admin: { username: string; displayName: string; roleKeys: string[] };
  permissions: string[];
}) {
  const route = useRoute();
  const client = useQueryClient();
  const { choice, setChoice } = useTheme();

  // Collapsed below 980px, where a 248px sidebar is a third of the viewport.
  /**
   * The width decides, until the operator does — and then the operator does.
   *
   * The comment here used to say the state was "owned by the operator", while
   * the listener below overwrote their choice on every crossing of the
   * breakpoint: expand the sidebar at 900px, drag the window to 1000px and
   * back, and it re-collapsed. The comment was true only of resizes that never
   * crossed 980px, which is the least interesting case.
   *
   * `touched` is what makes it true. Before the operator has expressed a
   * preference the viewport is the best guess available; afterwards it is not
   * a guess any more, and nothing overrides it for the life of the session.
   */
  const [collapsed, setCollapsed] = useState(() =>
    window.innerWidth < 980 ? true : (readSidebarPreference() ?? false),
  );
  /*
   * A preference remembered from an earlier visit is an operator's decision
   * too, so it counts as touched: the viewport does not override it.
   */
  const touched = useRef(readSidebarPreference() !== null);
  const choose = (next: boolean) => {
    touched.current = true;
    setCollapsed(next);
    // Remembered per browser — but only as a desk-width choice. Below the
    // breakpoint the expanded sidebar is a drawer over the page, and opening
    // one is not a layout preference worth carrying into the next visit.
    if (window.innerWidth >= 980) writeSidebarPreference(next);
  };
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 980px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 980px)');
    const onChange = (event: MediaQueryListEvent) => {
      setNarrow(event.matches);
      if (!touched.current) setCollapsed(event.matches);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // On a narrow screen the open sidebar is a drawer: following a link closes it.
  useEffect(() => {
    if (window.matchMedia('(max-width: 980px)').matches) setCollapsed(true);
  }, [route.path]);

  const [searching, setSearching] = useState(false);
  useCommandShortcut(() => setSearching(true));
  const counters = useNavCounters();

  const resolved = resolve(route, permissions, admin.roleKeys);
  useDocumentTitle(`${resolved.title} — ${t('web.title')}`);

  const leave = useMutation({
    // Same reasoning as sign-in: no idempotency key, and a session action.
    retry: false,
    mutationFn: signOut,
    onSuccess: async () => {
      // Forced past the leave guard: the session is already gone, and a draft
      // cannot be saved by staying.
      navigate('/', { force: true });
      // SET it, do not merely invalidate. The server has destroyed the session;
      // that is known, and it is not a fact the client should have to re-derive
      // from a lookup that may fail. React Query retains the previous `data`
      // across a failed refetch, so an invalidate alone left the signed-in
      // console drawn when the follow-up request did not come back — and on a
      // final failure it stayed drawn for good. Writing the resolved answer
      // makes signing out immediate and independent of the network.
      // SET, and nothing else. An `invalidateQueries` beside it re-asks a
      // question already answered, and the answer it gets back can be worse
      // than the one we have: a failed lookup after a successful sign-out
      // rendered "session unavailable" — telling an operator who had just
      // signed out that something was wrong — and on a final failure it said so
      // for ever. `signOut` succeeding IS the resolved state.
      // CANCEL first. `setQueryData` dispatches a success and never touches the
      // retryer, so a `GET /auth/session` already in flight — sent with a
      // still-valid cookie, and made routine by `refetchOnWindowFocus` — lands
      // afterwards and overwrites the `null` with the session it fetched. The
      // console came back for a full minute after a successful sign-out, on the
      // shared machine this whole path exists for.
      // CANCEL EVERYTHING, not only the session. A `/customers` or `/panels`
      // request already in flight was sent with a still-valid cookie, so it
      // resolves after the removal below and writes the previous operator's rows
      // back into an empty cache — the same race as the session query, with
      // customer names in it.
      await client.cancelQueries();
      // And drop every cached answer. Signing out is the point at which this
      // browser must stop holding one tenant's data: the next person to sign in
      // re-renders this same app instance, and `['customers', …]` carries no
      // tenant, so the stale page would be theirs to read. The session key is
      // spared so the resolved `null` below is the one value left standing.
      client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
      client.setQueryData(['session'], null);
    },
  });

  const visible = NAV.filter((entry) => navPermitted(entry, permissions, admin.roleKeys));

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <a className="skip" href="#main">
        {t('web.skip_to_content')}
      </a>

      <Sidebar
        entries={visible}
        currentPath={route.path}
        collapsed={collapsed}
        onToggle={() => choose(!collapsed)}
        counters={counters}
        theme={choice}
        onTheme={setChoice}
        drawer={narrow && !collapsed}
        onDismiss={() => setCollapsed(true)}
      />
      {/* The scrim behind the sidebar drawer on a narrow screen; CSS shows it only there. */}
      <div className="sidebar-scrim" aria-hidden="true" onClick={() => setCollapsed(true)} />

      <div className="main">
        <Topbar
          crumbs={resolved.crumbs}
          collapsed={collapsed}
          onOpenMenu={() => setCollapsed(false)}
          onSearch={() => setSearching(true)}
          admin={admin}
          onSignOut={() => leave.mutate()}
        />

        <main className="content" id="main">
          <div className="content-inner">{resolved.element}</div>
        </main>
      </div>

      {searching && <CommandSearch entries={visible} onClose={() => setSearching(false)} />}
      <LeaveGuardHost />
    </div>
  );
}

const SIDEBAR_KEY = 'nexa.sidebar';

/** Storage can THROW, not only come back empty — see `theme.ts`. */
function readSidebarPreference(): boolean | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_KEY);
    return raw === 'collapsed' ? true : raw === 'expanded' ? false : null;
  } catch {
    return null;
  }
}

function writeSidebarPreference(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // A remembered layout is a convenience; a browser that refuses to store it
    // still gets a working sidebar for this visit.
  }
}
