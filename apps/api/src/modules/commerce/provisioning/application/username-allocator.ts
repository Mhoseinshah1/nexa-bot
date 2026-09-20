import {
  COMMERCE_ERROR_CODES,
  DEFAULT_USERNAME_PREFIX,
  PROVIDER_USERNAME_MAX_LENGTH,
  RANDOM_STRATEGY_LENGTH,
  RANDOM_USERNAME_MAX_ATTEMPTS,
  TELEGRAM_ID_RANDOM_SUFFIX_LENGTH,
  USERNAME_REDRAWN_TOKENS,
  assertNewProviderUsername,
  canonicalizeCustomUsername,
  drawUsernameCharacters,
  errors,
  isNewProviderUsername,
  isValidCustomUsername,
  prefixRandomLength,
  renderUsernameTemplate,
  telegramIdSuffix4,
  usernameDigest4,
  validateUsernameTemplate,
  type ServiceUsernameMode,
  type TenantContext,
} from '@nexa/contracts';
import type { Hasher, IdGenerator } from '@nexa/contracts';
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
  if (policy.allowAutomatic) modes.push('AUTOMATIC');
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
  /**
   * SHA-256, for `{customer4}` and `{order4}`.
   *
   * The SAME hasher the operation ids use, bound once in the container. A second one
   * would make the two digests of one order disagree between processes, and `{order4}`
   * is supposed to be stable across a replay.
   */
  readonly hash: Hasher;
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
   * callback carrying `CUSTOM` for a panel that allows only AUTOMATIC is refused here —
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
      : this.allocateAutomatic(scope, input, namespaceKey, tx);
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
   * A name this installation generates, from the panel's saved preset.
   *
   * Four presets, all of them bounded by the universal contract, and the bound is
   * checked on the RENDER rather than trusted from the save. `TELEGRAM_ID_RANDOM` is
   * why: its length depends on the customer, so a policy that is perfectly legal for
   * one buyer produces twenty-three characters for another, and the only place that
   * can be known is here.
   *
   * ## What a collision redraws, and what it does not
   *
   * Only the random component. `RANDOM`, `PREFIX_RANDOM` and `TELEGRAM_ID_RANDOM`
   * always have one, so they get up to `RANDOM_USERNAME_MAX_ATTEMPTS` candidates. A
   * template whose only uniqueness token is `{order4}` has NONE: the second attempt
   * renders exactly what the first did, so it gets one attempt and then a refusal.
   * Looping would be pretending that a deterministic function might come out
   * differently, and mutating the order's identity to make it do so would be worse.
   *
   * Every exit is BEFORE any debit, and there are two of them because they are two
   * different answers. `SERVICE_USERNAME_EXHAUSTED` says the drawn names were all
   * held — nothing the customer chose, so nothing they can choose differently.
   * `SERVICE_USERNAME_UNGENERATABLE` says no redraw could have helped at all and the
   * operator is the one who fixes it. Neither is `SERVICE_USERNAME_TAKEN`, which
   * answers a name the customer typed.
   */
  private async allocateAutomatic(
    scope: TenantContext,
    input: AllocateUsernameInput,
    namespaceKey: string,
    tx: TransactionScope,
  ): Promise<UsernameReservation> {
    const attempts = this.redrawsOnCollision(input.policy) ? RANDOM_USERNAME_MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const username = this.generate(input);
      const reserved = await this.attempt(scope, input, namespaceKey, username, tx);
      if (reserved !== null) return reserved;
    }
    throw errors.conflict(
      COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED,
      'A username could not be generated for this plan right now.',
    );
  }

  /**
   * Whether a second attempt would differ from the first.
   *
   * True for the three presets that always draw, and for a template that uses at least
   * one `USERNAME_REDRAWN_TOKENS` token. False for a template built only from
   * `{order4}` and identity tokens — see `allocateAutomatic`.
   */
  private redrawsOnCollision(policy: PanelUsernamePolicy): boolean {
    if (policy.strategy !== 'CUSTOM_TEMPLATE') return true;
    const verdict = validateUsernameTemplate(policy.template ?? '');
    return verdict.tokens.some((token) => USERNAME_REDRAWN_TOKENS.includes(token));
  }

  /**
   * One candidate from the panel's preset, already proved legal.
   *
   * `TELEGRAM_ID_RANDOM` is the one preset whose output length this installation
   * cannot bound at save time, so it is checked here and refused with the code that
   * says an operator must act. The other three end in `assertNewProviderUsername`,
   * which is a defect check rather than a refusal: their lengths are decided by
   * constants and by a prefix the save already bounded, so a failure means this file
   * and the contract have come apart.
   */
  private generate(input: AllocateUsernameInput): string {
    const policy = input.policy;
    switch (policy.strategy) {
      case 'RANDOM': {
        const username = this.draw(RANDOM_STRATEGY_LENGTH);
        assertNewProviderUsername(username);
        return username;
      }
      case 'PREFIX_RANDOM': {
        const prefix = policy.prefix ?? DEFAULT_USERNAME_PREFIX;
        const username = `${prefix}${this.draw(prefixRandomLength(prefix))}`;
        assertNewProviderUsername(username);
        return username;
      }
      case 'TELEGRAM_ID_RANDOM': {
        const username = `${input.telegramId}_${this.draw(TELEGRAM_ID_RANDOM_SUFFIX_LENGTH)}`;
        if (!isNewProviderUsername(username)) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE,
            `A username for this account would exceed ${PROVIDER_USERNAME_MAX_LENGTH} characters.`,
          );
        }
        return username;
      }
      case 'CUSTOM_TEMPLATE':
        // `renderUsernameTemplate` asserts the result itself, and the template was
        // bounded at save time, so a throw here is the contract and this file
        // disagreeing rather than a customer or an operator being wrong.
        return renderUsernameTemplate(policy.template ?? '', {
          telegram_id: input.telegramId,
          tg4: telegramIdSuffix4(input.telegramId),
          customer4: usernameDigest4(input.customerId, this.deps.hash),
          order4: usernameDigest4(input.orderId, this.deps.hash),
          random4: this.draw(4),
          random6: this.draw(6),
          random10: this.draw(10),
        });
    }
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
   * `length` characters of the username alphabet, from the secrets port.
   *
   * The draw itself is `drawUsernameCharacters` in the contracts package, because the
   * settlement fallback and the preview need the same one and three copies of a draw
   * is three chances for one of them to reach for `Math.random`. What stays here is
   * WHERE the entropy comes from: `secrets.hex`, the same CSPRNG the subscription ref
   * uses.
   */
  private draw(length: number): string {
    return drawUsernameCharacters(this.deps.secrets.hex(length), length);
  }
}
