import {
  MARZBAN_PROXY_PROTOCOLS,
  PANEL_ACTIVATION_SCHEMAS,
  type ProviderType,
} from '@nexa/contracts';
import { t } from '../i18n/web.fa';
import { Field, Ltr } from '../ui/kit';

/**
 * The per-provider activation configuration, as a form.
 *
 * ## Why this file exists at all
 *
 * It did not, and that is the proximate cause of order `01a0c54b`. The panels
 * page rendered `requiredActivationFields` as a read-only banner — the NAMES of
 * the fields, in a warning box — and offered no way to set any of them. An
 * operator configuring a Marzban panel from the admin they were given could not
 * complete it, so the panel stayed enabled and unconfigured, and the catalogue
 * sold onto it.
 *
 * ## What it must not do
 *
 * It must not invent a default. `marzbanActivationSchema` records what an absent
 * `inboundTags` entry actually does on the binary — Marzban computes
 * `excluded_inbounds` as every inbound for a requested protocol that is not
 * listed, so the customer gets a 200, a subscription URL and zero bytes. There
 * is no safe guess about which server a customer connects to, so an unset field
 * stays unset and the panel stays unsellable until somebody chooses.
 *
 * It must not silently rewrite what an operator typed. The draft is TEXT, the
 * conversion happens once on submit, and a value that does not parse is refused
 * with the schema's own field paths rather than being coerced into something
 * that does.
 */

/**
 * The draft, as strings, for the same reason the cap and the username template
 * are strings on the page that owns this: an operator halfway through typing a
 * tag list is a normal state, not an error, and a typed model would have to
 * represent it as something.
 */
export interface ActivationDraft {
  /** Marzban: which protocols are ticked. */
  readonly protocols: readonly string[];
  /** Marzban: comma-separated tags, keyed by protocol. */
  readonly tags: Readonly<Record<string, string>>;
  /** 3X-UI: the host that serves `/sub/`. */
  readonly subscriptionDomain: string;
  /** 3X-UI: the inbound a created client joins, as text. */
  readonly inboundId: string;
}

export const EMPTY_ACTIVATION_DRAFT: ActivationDraft = {
  protocols: [],
  tags: {},
  subscriptionDomain: '',
  inboundId: '',
};

/**
 * The stored activation, as a draft.
 *
 * Reads defensively because `panels.activation` is `unknown` by contract — the
 * column holds whatever an older release or a direct API call put there, and a
 * row that does not parse is exactly the row an operator has come here to fix.
 * A reader that threw on it would hide the form from the only person who can
 * repair it.
 */
export function draftFromActivation(activation: unknown): ActivationDraft {
  const held = (activation ?? {}) as Record<string, unknown>;
  const protocols = Array.isArray(held.proxyProtocols)
    ? held.proxyProtocols.filter((value): value is string => typeof value === 'string')
    : [];
  const tags: Record<string, string> = {};
  if (held.inboundTags !== null && typeof held.inboundTags === 'object') {
    for (const [protocol, value] of Object.entries(held.inboundTags as Record<string, unknown>)) {
      tags[protocol] = Array.isArray(value) ? value.join(', ') : '';
    }
  }
  return {
    protocols,
    tags,
    subscriptionDomain: typeof held.subscriptionDomain === 'string' ? held.subscriptionDomain : '',
    inboundId: typeof held.inboundId === 'number' ? String(held.inboundId) : '',
  };
}

/**
 * The draft as the object the API stores, or the field paths that stop it being
 * one.
 *
 * Validated through `PANEL_ACTIVATION_SCHEMAS` — the SAME schema
 * `decideEligibility` and `decideOperability` parse against — so a form that
 * accepts a configuration and a server that refuses to sell onto it cannot
 * disagree. A second opinion here is how an operator ends up with a green form
 * and an unsellable panel.
 *
 * `EMPTY` is its own answer rather than an error: an operator who has cleared
 * every field is asking to unset the configuration, which is a legitimate thing
 * to want and a different request from a malformed one.
 */
export type ActivationParse =
  | { readonly kind: 'VALUE'; readonly value: Record<string, unknown> }
  | { readonly kind: 'EMPTY' }
  | { readonly kind: 'INVALID'; readonly fields: readonly string[] };

export function activationFromDraft(
  providerType: ProviderType,
  draft: ActivationDraft,
): ActivationParse {
  const candidate = buildCandidate(providerType, draft);
  if (candidate === null) return { kind: 'EMPTY' };
  const parsed = PANEL_ACTIVATION_SCHEMAS[providerType].safeParse(candidate);
  if (parsed.success) return { kind: 'VALUE', value: candidate };
  return {
    kind: 'INVALID',
    fields: [
      ...new Set(
        parsed.error.issues.map((issue) =>
          issue.path.length === 0 ? 'activation' : issue.path.join('.'),
        ),
      ),
    ],
  };
}

/** The shape before validation, or null when the operator has filled in nothing. */
function buildCandidate(
  providerType: ProviderType,
  draft: ActivationDraft,
): Record<string, unknown> | null {
  if (providerType === 'marzban') {
    const tags: Record<string, string[]> = {};
    for (const protocol of draft.protocols) {
      const written = draft.tags[protocol] ?? '';
      /*
       * Split, trimmed, and EMPTIES DROPPED — so "VLESS_TCP, " is one tag and
       * not one tag plus a blank. A blank tag would be refused by the schema
       * with a message about a minimum length, which is a true statement about
       * a value the operator did not think they had typed.
       */
      tags[protocol] = written
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
    }
    if (draft.protocols.length === 0 && Object.keys(tags).length === 0) return null;
    return { proxyProtocols: [...draft.protocols], inboundTags: tags };
  }
  const domain = draft.subscriptionDomain.trim();
  const inbound = draft.inboundId.trim();
  if (domain === '' && inbound === '') return null;
  return {
    subscriptionDomain: domain,
    // `Number.NaN` rather than a guess, so a non-numeric inbound is refused by
    // the schema and reported as `inboundId` instead of silently becoming 0 —
    // which is a real inbound id on somebody's panel.
    inboundId: inbound === '' ? Number.NaN : Number(inbound),
  };
}

/** Whether two drafts would store the same thing. Compared as TEXT, before parsing. */
export function sameActivationDraft(a: ActivationDraft, b: ActivationDraft): boolean {
  if (a.subscriptionDomain.trim() !== b.subscriptionDomain.trim()) return false;
  if (a.inboundId.trim() !== b.inboundId.trim()) return false;
  if (a.protocols.length !== b.protocols.length) return false;
  if (a.protocols.some((protocol) => !b.protocols.includes(protocol))) return false;
  return a.protocols.every(
    (protocol) => normaliseTags(a.tags[protocol]) === normaliseTags(b.tags[protocol]),
  );
}

function normaliseTags(written: string | undefined): string {
  return (written ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .join(',');
}

/**
 * The fields themselves.
 *
 * Per provider, because the two providers do not share a field — a subscription
 * domain and an inbound number are 3X-UI's, protocols and per-protocol tags are
 * Marzban's, and a generic "activation JSON" box would be the write-only
 * settings screen `docs/conventions.md` names, in a new costume.
 */
export function ActivationFields({
  providerType,
  draft,
  onChange,
  disabled,
}: {
  providerType: ProviderType;
  draft: ActivationDraft;
  onChange: (next: ActivationDraft) => void;
  disabled: boolean;
}) {
  if (providerType === 'marzban') {
    return (
      <>
        <Field label={t('web.panel_proxy_protocols')} hint={t('web.panel_proxy_protocols_hint')}>
          <div className="stack-sm">
            {MARZBAN_PROXY_PROTOCOLS.map((protocol) => (
              <label key={protocol} className="check">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={draft.protocols.includes(protocol)}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      protocols: event.target.checked
                        ? [...draft.protocols, protocol]
                        : draft.protocols.filter((held) => held !== protocol),
                    })
                  }
                />
                <Ltr>{protocol}</Ltr>
              </label>
            ))}
          </div>
        </Field>
        {/*
          One tag box per TICKED protocol, and none for the others. A box for a
          protocol nobody selected invites an operator to fill it in and wonder
          why nothing happened, and the schema refuses exactly the pairing this
          layout makes impossible: a protocol with no tags.
        */}
        {draft.protocols.map((protocol) => (
          <Field
            key={protocol}
            label={`${t('web.panel_inbound_tags')} — ${protocol}`}
            hint={t('web.panel_inbound_tags_hint')}
            htmlFor={`activation-tags-${protocol}`}
          >
            <input
              id={`activation-tags-${protocol}`}
              className="input ltr mono"
              disabled={disabled}
              value={draft.tags[protocol] ?? ''}
              onChange={(event) =>
                onChange({ ...draft, tags: { ...draft.tags, [protocol]: event.target.value } })
              }
            />
          </Field>
        ))}
      </>
    );
  }
  return (
    <>
      <Field
        label={t('web.panel_subscription_domain')}
        hint={t('web.panel_subscription_domain_hint')}
        htmlFor="activation-subscription-domain"
      >
        <input
          id="activation-subscription-domain"
          className="input ltr mono"
          disabled={disabled}
          value={draft.subscriptionDomain}
          onChange={(event) => onChange({ ...draft, subscriptionDomain: event.target.value })}
        />
      </Field>
      <Field
        label={t('web.panel_inbound_id')}
        hint={t('web.panel_inbound_id_hint')}
        htmlFor="activation-inbound-id"
      >
        <input
          id="activation-inbound-id"
          className="input ltr mono"
          inputMode="numeric"
          disabled={disabled}
          value={draft.inboundId}
          onChange={(event) => onChange({ ...draft, inboundId: event.target.value })}
        />
      </Field>
    </>
  );
}
