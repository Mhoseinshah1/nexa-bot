import type { AudienceDefinition, AudienceSampleCustomer, TenantContext } from '@nexa/contracts';

/** What one evaluation of a definition found. */
export interface AudienceSummary {
  /** Every selected customer. */
  readonly customers: number;
  /** Of those, the ones with a bot to be messaged through. */
  readonly reachable: number;
  /** md5 of the sorted customer ids — the set, not only its size. */
  readonly fingerprint: string;
}

/** The names an audience builder offers. */
export interface AudienceOptions {
  readonly resellerTiers: readonly { readonly id: string; readonly name: string }[];
  readonly products: readonly { readonly id: string; readonly title: string }[];
  readonly panels: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Reads an audience. Tenant-scoped by the `scope` every method takes; the SQL is the one
 * builder in `audience-sql.ts`.
 */
export interface AudienceReader {
  summarise(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    tx?: unknown,
  ): Promise<AudienceSummary>;
  sample(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly AudienceSampleCustomer[]>;
  options(scope: TenantContext): Promise<AudienceOptions>;
}
