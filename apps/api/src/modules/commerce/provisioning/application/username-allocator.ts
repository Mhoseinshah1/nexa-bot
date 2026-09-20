import {
  COMMERCE_ERROR_CODES,
  PANEL_LEGACY_TEMPLATE,
  RANDOM_USERNAME_ALPHABET,
  RANDOM_USERNAME_MAX_ATTEMPTS,
  canonicalizeCustomUsername,
  errors,
  isValidCustomUsername,
  renderUsernameTemplate,
  type ServiceUsernameMode,
  type TenantContext,
} from '@nexa/contracts';
import type { IdGenerator } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PanelUsernamePolicy } from '../../../platform/panels/application/ports.js';
import type { ServiceUsernameRepository, UsernameReservation } from './username-ports.js';

/**
 * The provider account namespace a panel's names live in.
 *
 * `<provider_type>:<host>[:<port>]`, lowercased, derived from the panel's base URL. The
 * port is included only when the URL states one, so `https://p.example` and
 * `https://p.example:443` are deliberately DIFFERENT keys: normalising them would mean
 * this function deciding what a default port is per scheme, which is a second opinion
 * about the same question `SafeHttpClient` already answers, and a wrong one is two
 * tenants silently sharing a namespace they do not share.
 *
 * The provider type leads because the same host can run two different panels on two
 * ports, and a Marzban account namespace is not a 3X-UI one.
 */
export function namespaceKeyFor(providerType: string, baseUrl: string): string {
  const url = new URL(baseUrl);
  const port = url.port === '' ? '' : `:${url.port}`;
  return `${providerType}:${url.hostname}${port}`.toLowerCase();
}

/**
 * Which username modes this panel actually offers.
 *
 * Both flags can be on; at least one always is, because the CHECK constraint and
 * `PanelService.validateUsernamePolicy` both refuse a policy with neither. A surface
 * that finds one mode skips the question and runs that mode directly — asking a
 * customer to choose between one option is a tap that teaches them nothing.
 */
export function modesOffered(policy: PanelUsernamePolicy): readonly ServiceUsernameMode[] {
  const modes: ServiceUsernameMode[] = [];
  if (policy.allowCustom) modes.push('CUSTOM');
  if (policy.allowRandom) modes.push('RANDOM');
  return modes;
}

export interface AllocateUsernameInput {
  readonly orderId: string;
  readonly customerId: string;
  readonly telegramId: string;
  readonly panelId: string;
  readonly providerType: string;
  readonly baseUrl: string;
  readonly policy: PanelUsernamePolicy;
  readonly mode: ServiceUsernameMode;
  /** What the customer typed, RAW and unaltered. Required for CUSTOM, ignored otherwise. */
  readonly raw?: string | undefined;
  /** When an unfunded hold lapses. The ORDER's deadline, so the two cannot disagree. */
  readonly expiresAt: Date;
}

export interface UsernameAllocatorDeps {
  readonly repository: ServiceUsernameRepository;
  readonly ids: IdGenerator;
  /** Random bytes as hex. The same port the subscription ref uses. */
  readonly secrets: { readonly hex: (bytes: number) => string };
}

/**
 * Who gets to be called what, on which panel.
 *
 * One object with one decision in it, called from the order confirmation and read by
 * provisioning. It is not a surface concern: two surfaces deciding this separately is
 * exactly the "two surfaces recompute the same concept differently" failure this
 * repository has a measured example of, and here the two answers would be two different
 * accounts on somebody's panel.
 */
export class UsernameAllocator {
  constructor(private readonly deps: UsernameAllocatorDeps) {}

  /**
   * Take a name for this order, before any money moves.
   *
   * Idempotent by the `(tenant_id, order_id)` index and by NOTHING ELSE, which is a
   * correction this file earned. It began with a `findByOrder` here as well, and the
   * mutation pass then could not kill either mechanism: each covered for the other, so
   * the suite could not tell which one was doing the work and a later edit could have
   * removed the load-bearing half in silence.
   *
   * The index is the half that survives concurrency. A read issued before the insert
   * sees the state the loser started from, so two simultaneous taps would both find
   * nothing and both try to take a name; the conditional insert is what makes exactly
   * one of them win, and `reserve` reads the winner's row back BY ORDER and returns it.
   * A double tap therefore produces one name, and the redundant read is gone.
   *
   * The mode is checked against the PANEL, not against what the surface offered. A
   * callback carrying `CUSTOM` for a panel that allows only RANDOM is refused here —
   * the button that produced it may have been drawn before an operator changed the
   * policy, and a surface's memory of what it offered is not authorisation.
   */
  async allocate(
    scope: TenantContext,
    input: AllocateUsernameInput,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    if (!modesOffered(input.policy).includes(input.mode)) {
      throw errors.preconditionFailed(
        COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE,
        'That way of choosing a username is not available for this plan.',
      );
    }

    const namespaceKey = namespaceKeyFor(input.providerType, input.baseUrl);
    return input.mode === 'CUSTOM'
      ? this.allocateCustom(scope, input, namespaceKey, tx)
      : this.allocateRandom(scope, input, namespaceKey, tx);
  }

  /**
   * A name the customer typed.
   *
   * Validated on the RAW input and then folded, in that order and not the other — see
   * `canonicalizeCustomUsername`. One attempt: a name somebody else holds is a fact
   * about the world, not a collision to retry through, and the customer is told and
   * types another.
   */
  private async allocateCustom(
    scope: TenantContext,
    input: AllocateUsernameInput,
    namespaceKey: string,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    const raw = input.raw ?? '';
    if (!isValidCustomUsername(raw)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.SERVICE_USERNAME_INVALID,
        'That username does not meet the requirements.',
      );
    }
    const username = canonicalizeCustomUsername(raw);
    const taken = await this.attempt(scope, input, namespaceKey, username, tx);
    if (taken !== null) return taken;
    throw errors.conflict(
      COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN,
      'That username is already in use.',
    );
  }

  /**
   * A name this installation generates.
   *
   * `template === PANEL_LEGACY_TEMPLATE` mints the shape every panel used before this
   * phase — `nx` plus 32 hex — but from RANDOM hex rather than from the service id. The
   * shape, the length and the `LEGACY_USERNAME_PATTERN` it matches are unchanged, so
   * nothing an operator reads is different; what changes is that the name now exists
   * before the money does, which is the whole point of reserving. Deriving it from the
   * service id is impossible here because that id is minted at settlement, and the
   * derivation is no longer load-bearing anywhere: `providerRefFor` reads the stored
   * column, and reconciliation asks the panel about the name the service row already
   * carries.
   *
   * Otherwise the template is rendered and, on a collision, drawn again up to
   * `RANDOM_USERNAME_MAX_ATTEMPTS` times.
   *
   * BOUNDED, and the bound is the point. A template whose only uniqueness token is
   * `{random6}` has 2.1 billion names and will collide eventually; a template an
   * operator has mistakenly made constant collides every time, and an unbounded loop
   * against it holds a transaction open against the database for ever rather than
   * answering. Running out is a refusal the operator can act on, with the panel named.
   */
  private async allocateRandom(
    scope: TenantContext,
    input: AllocateUsernameInput,
    namespaceKey: string,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    const template = input.policy.template;

    for (let attempt = 0; attempt < RANDOM_USERNAME_MAX_ATTEMPTS; attempt += 1) {
      const username =
        template === PANEL_LEGACY_TEMPLATE
          ? `nx${this.deps.secrets.hex(16)}`
          : renderUsernameTemplate(template, {
              telegram_id: input.telegramId,
              customer_id: input.customerId,
              order_id: input.orderId,
              random6: this.draw(6),
              random10: this.draw(10),
            });
      const reserved = await this.attempt(scope, input, namespaceKey, username, tx);
      if (reserved !== null) return reserved;
    }
    throw errors.conflict(
      COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN,
      'A username could not be generated for this plan right now.',
    );
  }

  /**
   * One attempt at one name: null means the name is taken, by anything.
   *
   * The services check runs FIRST and inside the same transaction, because a legacy
   * service's name has no reservation row and the reservation index cannot see it. The
   * check is not a substitute for the index — it is a read, and a read cannot be
   * exclusive — which is why the insert below is still conditional and still the
   * decision.
   */
  private async attempt(
    scope: TenantContext,
    input: AllocateUsernameInput,
    namespaceKey: string,
    username: string,
    tx: TransactionScope,
  ): Promise<UsernameReservation | null> {
    if (await this.deps.repository.usernameInUseOnPanel(scope, input.panelId, username, tx)) {
      return null;
    }
    const result = await this.deps.repository.reserve(
      scope,
      {
        id: this.deps.ids.uuid(),
        namespaceKey,
        username,
        panelId: input.panelId,
        orderId: input.orderId,
        customerId: input.customerId,
        mode: input.mode,
        expiresAt: input.expiresAt,
      },
      tx,
    );
    if (result.outcome === 'NAME_TAKEN') return null;
    return result.reservation;
  }

  /**
   * `length` characters of `RANDOM_USERNAME_ALPHABET`, from the secrets port.
   *
   * `% 36` over a byte is very slightly biased — four of the thirty-six characters are
   * drawn 8/256 of the time rather than 7/256 — and that is accepted deliberately. A
   * username is an identifier, not a secret: nothing here is guarding against somebody
   * predicting the next draw, only against two draws colliding, and a 1.14x bias on
   * one character changes the collision probability by nothing an operator could
   * measure. Rejection sampling would be the correct fix if this were ever used for a
   * token; `secrets.hex` is what the subscription ref uses, and that one IS a secret.
   */
  private draw(length: number): string {
    const bytes = this.deps.secrets.hex(length);
    let drawn = '';
    for (let index = 0; index < length; index += 1) {
      const pair = bytes.slice(index * 2, index * 2 + 2);
      drawn += RANDOM_USERNAME_ALPHABET[parseInt(pair, 16) % RANDOM_USERNAME_ALPHABET.length];
    }
    return drawn;
  }
}
