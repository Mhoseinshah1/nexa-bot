# Hosted tenant defaults and independent manual creation

The creator panel creates a `HOSTED` tenant with its own administrator. Its
manual create request needs a username, display name, password, slug and initial
expiry (or no expiry). It needs no primary-bot customer, reseller or wallet.
`resellerBotRequestId` is optional and belongs only to the existing reseller
request flow. Manual creation neither files that request nor bills a wallet.
The legacy reseller approval and renewal billing remains unchanged.

The owner signs in within the hosted tenant's scope. Domain activation and the
one-time owner link remain the existing activation flow; the primary account's
password does not authenticate to a hosted domain. Hosting's owner-only guard,
section session, fresh second-factor proof and production creation gate remain
required. This change does not switch on production hosting.

## Missing initialization

`DrizzleHostedTenantSystemPath.provisionIn` previously created the tenant,
roles and administrator only. The primary installation CLI seeded its first
product category, but hosted provisioning did not. API bootstrap reconciles
gateway routes for the primary tenant only, so it could not repair a hosted
tenant's empty gateways page.

Hosted provisioning now uses `PaymentGatewayRepository.ensureDefaults` and
`ProductCategoryRepository.ensureDefault` in the **original** creation
transaction, alongside identity and the hosted register. A failure rolls all
of those writes back. New category IDs use the application UUIDv7 generator.

Gateway bounds use the child's resolved `sales.currency`, the same authority
used by product and payment services and primary bootstrap. This is a
tenant-local setting (registry default IRT), not the parent's stored sales
setting or a copied payment configuration. Existing locale/timezone/calendar
and tenant metadata provisioning are unchanged.

The existing gateway default policy remains authoritative: manual transfer
starts ACTIVE; routes requiring credentials, a fixed unit rate or central FX
start DISABLED. No credential, merchant identity, callback secret, endpoint or
other payment configuration is inherited. A configured manual destination is
still needed before the manual route can accept a payment.

## Repair for existing hosted tenants

Data migration `0347_hosted_tenant_defaults.sql`:

- Inserts only missing `(tenant_id, provider)` routes for `HOSTED` tenants.
  Existing rows, including their timestamps and disabled/custom configuration,
  are never updated. Missing routes use that tenant's valid IRT/IRR sales
  setting, or IRT for a missing/invalid setting, matching the resolver.
- Inserts «عمومی» only when the hosted tenant has **zero** categories. An
  inactive, hidden, renamed or custom category also means no insertion.
  Backfill UUIDv7s use migration 0100's timestamp/version-bit construction;
  bare PostgreSQL UUIDv4s would be rejected by category service/API readers.
- Never reads/writes credentials, billing, customer, product, order or wallet
  rows. It sends no notification. Non-hosted tenants are untouched.
- Can be executed repeatedly without changing already initialized rows.

The category repair briefly locks category writes while its transaction
finishes, preventing a concurrent first custom-category insert from racing
the zero-category check. It waits at most 10 seconds for that lock, failing
the migration transaction if busy rather than waiting indefinitely; the
session's previous lock timeout is restored after acquisition. Reads remain available. The migration changes no
schema or permissions and requires no generated snapshot. It is applied by
the normal migrator during an authorized update; it has not been run against
production by this development work.

## Regression coverage

`tests/integration/hosting-panel.test.ts` exercises the real application as
`nexa_app` under RLS: independent manual ownership, supplied expiry, all
provider defaults, no inherited credentials/settings, own catalogue and
credential management, cross-tenant refusals, no reseller-wallet writes,
repeated actual migration SQL and full provisioning rollback.

`hosted-activation.test.ts` also verifies actual HTTP sign-in on a hosted
domain, including colliding primary/hosted usernames and rejected cross-domain
passwords. The existing reseller-hosting suite protects legacy billing.

Online hosted-subscription checkout, payment callbacks and automatic extension
are outside this phase. No deployment, release or production-secret change is
part of this fix.
