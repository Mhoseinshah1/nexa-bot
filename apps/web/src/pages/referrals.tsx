import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  REFERRAL_COMMISSION_STATES,
  TENANT_MEDIA_MAX_BYTES,
  TENANT_MEDIA_MIME_TYPES,
  uuidV7Schema,
  type CurrencyCode,
  type ReferralCommissionScope,
  type ReferralCommissionState,
  type ReferralCommissionSummaryResponse,
  type ReferralPartyResponse,
  type ReferralSummaryResponse,
  type ReferralTrigger,
  type TenantMediaMimeType,
  type TenantMediaResponse,
} from '@nexa/contracts';
import {
  clearTenantMedia,
  fetchReferralCommissions,
  fetchReferrals,
  fetchTenantMedia,
  uploadTenantMedia,
} from '../api/client';
import { formatTimestamp, splitBytes } from '../format';
import { useSubmissionKey } from '../submission-key';
import { mayRequest } from '../view-state';
import { t, type WebKey } from '../i18n/web.fa';
import { setQueries, useLinkHandler, type Route } from '../router';
import { messageFor } from './settings';
import {
  Badge,
  Banner,
  Card,
  CursorPager,
  DataTable,
  Empty,
  Field,
  Ltr,
  Money,
  PageHead,
  Pills,
  StateSwitch,
  useToast,
  type Column,
  type Tone,
} from '../ui/kit';

/**
 * Referrals — who brought whom, and what the tenant owes for it (WP9-A).
 *
 * READ-ONLY, and the absence is the design rather than an unfinished page. The server
 * has no route that writes an attribution or a commission (`docs/wp9-referral-audit.md`
 * F10): reassigning a referee or editing a commission changes who is owed money, and an
 * override is its own future decision (OQ-WP9-01). So there is no button on this page
 * that sends anything but a GET, and the scope card says so in words.
 *
 * Both lists are charged `referrals.view` by `ReferralReadService`; `denied` only decides
 * whether this page asks. The program itself — the flag and the three settings — is
 * configured on the features and settings pages, which is where the scope card points.
 *
 * Every figure is the server's. `earnedAmount` is null until delivery and is shown as a
 * dash, never as zero: "nothing earned yet" and "earned nothing" are different facts.
 */

// ---------------------------------------------------------------------------
// Vocabularies — each a `Record` over the frozen enum, so a value added to the
// contract without a label is a compile error rather than a blank cell.
// ---------------------------------------------------------------------------

export const TRIGGER_LABELS: Readonly<Record<ReferralTrigger, WebKey>> = {
  // Declared and never produced (F5); labelled so a row that somehow carries it is
  // still readable rather than blank.
  ON_SIGNUP: 'web.referral_trigger_signup',
  ON_FIRST_PAID_ORDER: 'web.referral_trigger_first_paid_order',
  ON_EVERY_PAID_ORDER: 'web.referral_trigger_every_paid_order',
};

export const TRIGGER_TONES: Readonly<Record<ReferralTrigger, Tone>> = {
  ON_SIGNUP: 'neutral',
  ON_FIRST_PAID_ORDER: 'info',
  ON_EVERY_PAID_ORDER: 'violet',
};

/** A commission's scope names the same two rules as the trigger it was snapshotted from. */
export const COMMISSION_SCOPE_LABELS: Readonly<Record<ReferralCommissionScope, WebKey>> = {
  FIRST_PAID_ORDER: 'web.referral_trigger_first_paid_order',
  EVERY_PAID_ORDER: 'web.referral_trigger_every_paid_order',
};

export const COMMISSION_STATE_LABELS: Readonly<Record<ReferralCommissionState, WebKey>> = {
  PENDING: 'web.referral_commission_state_pending',
  EARNED: 'web.referral_commission_state_earned',
  VOID: 'web.referral_commission_state_void',
};

const COMMISSION_STATE_TONES: Readonly<Record<ReferralCommissionState, Tone>> = {
  PENDING: 'warn',
  EARNED: 'ok',
  VOID: 'neutral',
};

function Dash() {
  return <span className="faint">—</span>;
}

/**
 * One party to a referral: a link to the customer, named as the operator would
 * recognise them, with the Telegram id beside it.
 *
 * The display name is the customer's own Telegram name and may be absent; the Telegram
 * id never is, so it is always shown and it is what the link falls back to.
 */
export function PartyCell({ party }: { party: ReferralPartyResponse }) {
  const onLink = useLinkHandler();
  return (
    <div>
      <a href={`/users/${encodeURIComponent(party.customerId)}`} onClick={onLink}>
        {party.displayName ?? <Ltr>{party.telegramUserId}</Ltr>}
      </a>
      {party.displayName !== null && (
        <div className="muted small">
          <Ltr>{party.telegramUserId}</Ltr>
        </div>
      )}
    </div>
  );
}

export function TriggerBadge({ value }: { value: ReferralTrigger }) {
  return <Badge tone={TRIGGER_TONES[value]}>{t(TRIGGER_LABELS[value])}</Badge>;
}

/**
 * The cursor trail, reset when the filter changes.
 *
 * The shape `discounts.tsx` uses and for its reason: a cursor minted under one filter
 * strands every row before it under another. Derived rather than reset in an effect, so
 * there is no render in which the old cursor meets the new filter. Local rather than in
 * the URL because this page carries two independent lists, and one `cursor` query
 * parameter cannot page both.
 */
function useTrail(signature: string) {
  const [trail, setTrail] = useState<{ signature: string; cursors: readonly string[] }>({
    signature,
    cursors: [],
  });
  const cursors = trail.signature === signature ? trail.cursors : [];
  return {
    cursor: cursors.length > 0 ? cursors[cursors.length - 1] : undefined,
    depth: cursors.length,
    push: (next: string) => setTrail({ signature, cursors: [...cursors, next] }),
    pop: () => setTrail({ signature, cursors: cursors.slice(0, -1) }),
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

/**
 * `mayViewBanner` and `mayEditBanner` are passed, never derived from `denied`: the lists
 * take `referrals.view`, the banner is tenant configuration under `settings.view` and
 * `settings.edit`, and `TenantMediaService` charges each on its own. Deriving one from
 * another would draw an upload control for a role that may only read the ledger, and
 * teach it about the refusal by pressing it.
 */
export function ReferralsPage({
  route,
  denied,
  mayViewBanner,
  mayEditBanner,
}: {
  route: Route;
  denied: boolean;
  mayViewBanner: boolean;
  mayEditBanner: boolean;
}) {
  const onLink = useLinkHandler();
  const applied = route.query.get('referrerId') ?? '';

  /*
   * The draft is keyed to the APPLIED value, so navigation that drops the query clears
   * the box — the defect `users.tsx` and `payments.tsx` record: the sidebar link
   * re-renders this component with an empty query instead of remounting it.
   */
  const [draft, setDraft] = useState({ applied, value: applied });
  if (draft.applied !== applied) setDraft({ applied, value: applied });

  const problem =
    draft.value === '' || uuidV7Schema.safeParse(draft.value).success
      ? undefined
      : t('web.referrals_filter_invalid_id');

  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (problem !== undefined) return;
    setQueries(route, [['referrerId', draft.value === '' ? null : draft.value]]);
  };

  return (
    <>
      <PageHead
        title={t('web.referrals_title')}
        subtitle={t('web.referrals_intro')}
        maturity="now"
      />

      {!denied && (
        <Card>
          <form className="toolbar" onSubmit={apply}>
            <Field
              label={t('web.referrals_filter_referrer')}
              hint={t('web.referrals_filter_referrer_hint')}
              htmlFor="referrals-referrer"
              {...(problem === undefined ? {} : { error: problem })}
            >
              <input
                id="referrals-referrer"
                dir="ltr"
                value={draft.value}
                onChange={(event) => setDraft({ applied, value: event.target.value.trim() })}
              />
            </Field>
            <button type="submit" className="btn sm">
              {t('web.referrals_filter_apply')}
            </button>
            {applied !== '' && (
              <a href="/referrals" onClick={onLink}>
                {t('web.referrals_filter_clear')}
              </a>
            )}
          </form>
        </Card>
      )}

      <Attributions denied={denied} referrerId={applied} />
      <Commissions denied={denied} referrerId={applied} />

      {mayViewBanner && <BannerCard mayEdit={mayEditBanner} />}

      <Card title={t('web.referrals_scope_title')}>
        <p className="muted">{t('web.referrals_rule_read_only')}</p>
        <p className="muted">{t('web.referrals_rule_configure')}</p>
        <p className="muted">{t('web.referrals_rule_unrecovered')}</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Attributions
// ---------------------------------------------------------------------------

function Attributions({ denied, referrerId }: { denied: boolean; referrerId: string }) {
  const trail = useTrail(referrerId);
  const referrals = useQuery({
    queryKey: ['referrals', referrerId, trail.cursor ?? null],
    queryFn: () =>
      fetchReferrals({
        ...(trail.cursor === undefined ? {} : { cursor: trail.cursor }),
        ...(referrerId === '' ? {} : { referrerId }),
      }),
    enabled: !denied,
  });
  const rows = referrals.data?.referrals ?? [];
  const nextCursor = referrals.data?.nextCursor ?? null;

  const columns: readonly Column<ReferralSummaryResponse>[] = [
    {
      key: 'referrer',
      header: t('web.referral_referrer'),
      render: (row) => <PartyCell party={row.referrer} />,
    },
    {
      key: 'referee',
      header: t('web.referral_referee'),
      render: (row) => <PartyCell party={row.referee} />,
    },
    {
      key: 'trigger',
      header: t('web.referral_trigger'),
      render: (row) => <TriggerBadge value={row.trigger} />,
    },
    {
      key: 'created',
      header: t('web.referral_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
  ];

  return (
    <Card title={t('web.referrals_attributions_title')} hint={t('web.referrals_attributions_hint')}>
      <StateSwitch
        query={referrals}
        denied={denied}
        isEmpty={rows.length === 0 && trail.depth === 0}
        empty={
          <Empty
            title={
              referrerId === ''
                ? t('web.referrals_attributions_empty')
                : t('web.referrals_filter_empty')
            }
            icon="link"
          />
        }
      >
        <DataTable
          caption={t('web.referrals_attributions_title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
        {/* Default labels: `GET /referrals` pages newest to oldest. */}
        <CursorPager
          shown={rows.length}
          hasPrevious={trail.depth > 0}
          hasNext={nextCursor !== null}
          onPrevious={trail.pop}
          onNext={() => nextCursor !== null && trail.push(nextCursor)}
        />
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The commission ledger
// ---------------------------------------------------------------------------

type StateFilter = 'ALL' | ReferralCommissionState;

function Commissions({ denied, referrerId }: { denied: boolean; referrerId: string }) {
  const onLink = useLinkHandler();
  const [state, setState] = useState<StateFilter>('ALL');
  const trail = useTrail(`${referrerId}|${state}`);

  const commissions = useQuery({
    queryKey: ['referral-commissions', referrerId, state, trail.cursor ?? null],
    queryFn: () =>
      fetchReferralCommissions({
        ...(trail.cursor === undefined ? {} : { cursor: trail.cursor }),
        ...(state === 'ALL' ? {} : { state }),
        ...(referrerId === '' ? {} : { referrerId }),
      }),
    enabled: !denied,
  });
  const rows = commissions.data?.commissions ?? [];
  const nextCursor = commissions.data?.nextCursor ?? null;
  const anyUnrecovered = rows.some((row) => row.unrecoveredAmount !== '0');

  const money = (amountMinor: string, currency: CurrencyCode) => (
    <Money value={{ amountMinor, currency }} />
  );

  const columns: readonly Column<ReferralCommissionSummaryResponse>[] = [
    {
      key: 'order',
      header: t('web.referral_order'),
      render: (row) => (
        <a href={`/orders/${encodeURIComponent(row.orderId)}`} onClick={onLink}>
          <Ltr>{row.orderId.slice(0, 8)}</Ltr>
        </a>
      ),
    },
    {
      key: 'referrer',
      header: t('web.referral_referrer'),
      render: (row) => <PartyCell party={row.referrer} />,
    },
    {
      key: 'referee',
      header: t('web.referral_referee'),
      render: (row) => <PartyCell party={row.referee} />,
    },
    {
      key: 'scope',
      header: t('web.referral_trigger'),
      render: (row) => <span className="nowrap">{t(COMMISSION_SCOPE_LABELS[row.scope])}</span>,
    },
    {
      key: 'percent',
      header: t('web.referral_percent'),
      render: (row) => (
        <span className="nowrap">
          <Ltr>{String(row.percent)}</Ltr> {t('web.discount_percent_unit')}
        </span>
      ),
    },
    {
      key: 'basis',
      header: t('web.referral_basis'),
      render: (row) => money(row.basisAmount, row.currency),
    },
    {
      key: 'promised',
      header: t('web.referral_promised'),
      render: (row) => money(row.promisedAmount, row.currency),
    },
    {
      key: 'state',
      header: t('web.status'),
      render: (row) => (
        <Badge tone={COMMISSION_STATE_TONES[row.state]}>
          {t(COMMISSION_STATE_LABELS[row.state])}
        </Badge>
      ),
    },
    {
      key: 'earned',
      header: t('web.referral_earned'),
      render: (row) =>
        row.earnedAmount === null ? <Dash /> : money(row.earnedAmount, row.currency),
    },
    {
      key: 'reversed',
      header: t('web.referral_reversed'),
      render: (row) => money(row.reversedAmount, row.currency),
    },
    {
      key: 'unrecovered',
      header: t('web.referral_unrecovered'),
      render: (row) => money(row.unrecoveredAmount, row.currency),
    },
    {
      key: 'created',
      header: t('web.referral_created_at'),
      render: (row) => <span className="nowrap">{formatTimestamp(row.createdAt)}</span>,
    },
    {
      /*
       * When it was DECIDED — earned or voided, never both. A PENDING row has neither,
       * and a dash says that without inventing a date.
       */
      key: 'settled',
      header: t('web.referral_settled_at'),
      render: (row) => {
        const at = row.earnedAt ?? row.voidedAt;
        return at === null ? <Dash /> : <span className="nowrap">{formatTimestamp(at)}</span>;
      },
    },
  ];

  return (
    <Card title={t('web.referrals_commissions_title')} hint={t('web.referrals_commissions_hint')}>
      {/* Hidden while the list cannot answer: a filter mints a request the server has
          just refused. */}
      <div className="toolbar" hidden={!mayRequest(commissions, denied)}>
        <Pills
          value={state}
          onChange={setState}
          items={[
            { id: 'ALL' as const, label: t('web.referrals_state_all') },
            ...REFERRAL_COMMISSION_STATES.map((one) => ({
              id: one,
              label: t(COMMISSION_STATE_LABELS[one]),
            })),
          ]}
        />
      </div>

      <StateSwitch
        query={commissions}
        denied={denied}
        isEmpty={rows.length === 0 && trail.depth === 0}
        empty={
          <Empty
            title={
              state === 'ALL' && referrerId === ''
                ? t('web.referrals_commissions_empty')
                : t('web.referrals_filter_empty')
            }
            icon="inbox"
          />
        }
      >
        <DataTable
          caption={t('web.referrals_commissions_title')}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
        {/* Default labels: `GET /referral-commissions` pages newest to oldest. */}
        <CursorPager
          shown={rows.length}
          hasPrevious={trail.depth > 0}
          hasNext={nextCursor !== null}
          onPrevious={trail.pop}
          onNext={() => nextCursor !== null && trail.push(nextCursor)}
        />
        {anyUnrecovered && <Banner tone="warn">{t('web.referral_unrecovered_note')}</Banner>}
      </StateSwitch>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The referral banner (customer UX §I)
// ---------------------------------------------------------------------------

const MIME_LABELS: Readonly<Record<TenantMediaMimeType, string>> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

/** A file read into the shape the upload route takes, or the reason it was not. */
type PickedFile =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'INVALID'; readonly reason: WebKey }
  | {
      readonly kind: 'READY';
      readonly name: string;
      readonly mimeType: TenantMediaMimeType;
      readonly byteLength: number;
      readonly contentBase64: string;
    };

function isMediaMimeType(value: string): value is TenantMediaMimeType {
  return (TENANT_MEDIA_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Reads the chosen file as base64 in the browser. The type and the size are checked
 * HERE before a megabyte is read, and again by the server against the bytes' own magic
 * number — this check only spares the operator a round trip for a file that cannot be
 * accepted.
 */
function readPicked(file: File): Promise<PickedFile> {
  if (!isMediaMimeType(file.type)) {
    return Promise.resolve({ kind: 'INVALID', reason: 'web.referral_banner_file_invalid_type' });
  }
  if (file.size > TENANT_MEDIA_MAX_BYTES) {
    return Promise.resolve({ kind: 'INVALID', reason: 'web.referral_banner_file_too_large' });
  }
  const mimeType = file.type;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () =>
      resolve({ kind: 'INVALID', reason: 'web.referral_banner_file_unreadable' });
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      // A data URL is `data:<type>;base64,<payload>`; the payload is what the route takes.
      const comma = url.indexOf(',');
      if (comma < 0) {
        resolve({ kind: 'INVALID', reason: 'web.referral_banner_file_unreadable' });
        return;
      }
      resolve({
        kind: 'READY',
        name: file.name,
        mimeType,
        byteLength: file.size,
        contentBase64: url.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

function BannerMetadata({ media }: { media: TenantMediaResponse }) {
  const size = splitBytes(BigInt(media.byteLength));
  return (
    <dl className="kv">
      <dt>{t('web.referral_banner_type')}</dt>
      <dd>{MIME_LABELS[media.mimeType]}</dd>
      <dt>{t('web.referral_banner_size')}</dt>
      <dd>
        {size.value} {t(size.unit)}
      </dd>
      <dt>{t('web.referral_banner_version')}</dt>
      <dd>{media.version}</dd>
      <dt>{t('web.referral_banner_updated_at')}</dt>
      <dd className="nowrap">{formatTimestamp(media.updatedAt)}</dd>
      <dt>{t('web.referral_banner_digest')}</dt>
      <dd>
        <Ltr>
          <code>{media.sha256}</code>
        </Ltr>
      </dd>
    </dl>
  );
}

/**
 * The banner slot: what is stored (never the bytes — the digest, the size and the
 * version are what an operator can compare), a file input, and the two writes.
 */
function BannerCard({ mayEdit }: { mayEdit: boolean }) {
  const queries = useQueryClient();
  const notify = useToast();
  const submission = useSubmissionKey();
  const [picked, setPicked] = useState<PickedFile>({ kind: 'NONE' });

  const media = useQuery({
    queryKey: ['tenant-media', 'REFERRAL_BANNER'],
    queryFn: () => fetchTenantMedia('REFERRAL_BANNER'),
  });

  const refresh = () => {
    void queries.invalidateQueries({ queryKey: ['tenant-media', 'REFERRAL_BANNER'] });
  };

  const upload = useMutation({
    mutationFn: () => {
      if (picked.kind !== 'READY') throw new Error(t('web.referral_banner_file_unreadable'));
      const body = {
        purpose: 'REFERRAL_BANNER' as const,
        mimeType: picked.mimeType,
        contentBase64: picked.contentBase64,
      };
      // Keyed to the digest-sized fingerprint of the payload: picking a different file is
      // a new command, retrying the same one after an ambiguous failure is not.
      return uploadTenantMedia({
        ...body,
        idempotencyKey: submission.current({ name: picked.name, size: picked.byteLength }),
      });
    },
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.referral_banner_uploaded') });
      setPicked({ kind: 'NONE' });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const clear = useMutation({
    mutationFn: () =>
      clearTenantMedia({
        purpose: 'REFERRAL_BANNER',
        idempotencyKey: submission.current({ clear: media.data?.media?.version ?? null }),
      }),
    onSuccess: () => {
      submission.settle();
      notify({ tone: 'ok', message: t('web.referral_banner_cleared') });
      refresh();
    },
    onError: (error) => submission.settleOn(error),
  });

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined) {
      setPicked({ kind: 'NONE' });
      return;
    }
    void readPicked(file).then(setPicked);
  };

  const busy = upload.isPending || clear.isPending;
  const failure = upload.error ?? clear.error;
  const current = media.data?.media ?? null;

  return (
    <Card title={t('web.referral_banner_title')} hint={t('web.referral_banner_hint')}>
      <StateSwitch
        query={media}
        denied={false}
        isEmpty={media.data !== undefined && current === null}
        empty={<Empty title={t('web.referral_banner_empty')} icon="link" />}
      >
        {current !== null && <BannerMetadata media={current} />}
      </StateSwitch>

      {mayEdit ? (
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            if (picked.kind === 'READY' && !busy) upload.mutate();
          }}
        >
          <Field
            label={t('web.referral_banner_file')}
            hint={t('web.referral_banner_file_hint')}
            htmlFor="referral-banner-file"
            {...(picked.kind === 'INVALID' ? { error: t(picked.reason) } : {})}
          >
            <input
              id="referral-banner-file"
              type="file"
              accept={TENANT_MEDIA_MIME_TYPES.join(',')}
              onChange={onPick}
              disabled={busy}
            />
          </Field>
          <div className="toolbar">
            <button
              type="submit"
              className="btn primary sm"
              disabled={busy || picked.kind !== 'READY'}
            >
              {upload.isPending
                ? t('web.referral_banner_uploading')
                : t('web.referral_banner_upload')}
            </button>
            {current !== null && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => clear.mutate()}
              >
                {t('web.referral_banner_clear')}
              </button>
            )}
          </div>
          {failure != null && <Banner tone="danger">{messageFor(failure)}</Banner>}
        </form>
      ) : (
        <p className="muted">{t('web.referral_banner_read_only')}</p>
      )}
    </Card>
  );
}
