import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { HOSTING_ERROR_CODES, type HostingProof } from '@nexa/contracts';
import { ApiError, newIdempotencyKey } from '../api/client';
import { errorText } from '../error-text';
import { t } from '../i18n/web.fa';
import { Banner, CopyButton, Modal } from '../ui/kit';
import { Icon } from '../ui/icons';
import { ErrorRef } from '../ui/technical-details';

/**
 * The pieces every part of «میزبانی‌ها» shares: the fresh-code field, the dialog that asks
 * for it before a sensitive action, and the one-time reveal of recovery codes.
 */

export const HOSTING_STATUS_KEY = ['hosting', 'status'] as const;
export const HOSTING_BOTS_KEY = ['hosting', 'bots'] as const;
export const HOSTING_SERVER_KEY = ['hosting', 'server'] as const;

/** What the owner has typed into the code field: an app code, or a recovery code. */
export interface ProofDraft {
  readonly backup: boolean;
  readonly value: string;
}

export const EMPTY_PROOF: ProofDraft = { backup: false, value: '' };

/**
 * The request's `proof`, or null while the field does not hold a code the server could accept
 * (six digits, or a recovery code of at least eight characters). Only the SHAPE is checked
 * here; whether the code is right is the server's answer alone.
 */
export function proofOf(draft: ProofDraft): HostingProof | null {
  if (draft.backup) {
    const backupCode = draft.value.trim();
    return backupCode.length >= 8 ? { backupCode } : null;
  }
  const code = draft.value.replace(/\s+/g, '');
  return /^[0-9]{6}$/.test(code) ? { code } : null;
}

/**
 * An answer that means the section's state changed under the page — its session ran out, or the
 * codes are now locked — sends the page back to the status, which draws the right gate.
 */
export function noteSectionError(error: unknown, queryClient: QueryClient): void {
  if (
    error instanceof ApiError &&
    (error.code === HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED ||
      error.code === HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED)
  ) {
    void queryClient.invalidateQueries({ queryKey: HOSTING_STATUS_KEY });
  }
}

/** The code field with its «use a recovery code» switch. */
export function ProofField({
  draft,
  onChange,
  idPrefix,
}: {
  draft: ProofDraft;
  onChange: (next: ProofDraft) => void;
  idPrefix: string;
}) {
  const id = `${idPrefix}-proof`;
  return (
    <div className="field">
      <label htmlFor={id}>
        {draft.backup ? t('web.hosting_backup_label') : t('web.hosting_code_label')}
      </label>
      <input
        id={id}
        className="input"
        dir="ltr"
        inputMode={draft.backup ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={draft.backup ? 64 : 8}
        value={draft.value}
        onChange={(event) => onChange({ backup: draft.backup, value: event.currentTarget.value })}
      />
      <span className="muted small">
        {draft.backup ? t('web.hosting_backup_hint') : t('web.hosting_code_hint')}
      </span>
      <button
        type="button"
        className="link"
        onClick={() => onChange({ backup: !draft.backup, value: '' })}
      >
        {draft.backup ? t('web.hosting_use_code') : t('web.hosting_use_backup')}
      </button>
    </div>
  );
}

/**
 * The dialog behind EVERY sensitive action: a fresh code (or a recovery code) first, then the
 * action. `children` are the action's own fields; `run` makes the request with the proof and
 * this dialog's idempotency key.
 *
 * The key is minted when the dialog opens — it is mounted only while open — and kept across
 * retries, so pressing the button again after a lost answer is the same command, never a second.
 * The code is cleared after every answer: a code in a field outlives the reason it was typed for.
 */
export function CodePromptDialog<R>({
  title,
  hint,
  children,
  confirmLabel,
  pendingLabel,
  danger = false,
  valid = true,
  run,
  onClose,
  onDone,
}: {
  title: string;
  hint?: string;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  danger?: boolean;
  /** Whether the action's own fields are complete. */
  valid?: boolean;
  run: (context: { proof: HostingProof; idempotencyKey: string }) => Promise<R>;
  onClose: () => void;
  onDone: (result: R) => void;
}) {
  const queryClient = useQueryClient();
  const idPrefix = useId();
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [draft, setDraft] = useState<ProofDraft>(EMPTY_PROOF);
  const proof = proofOf(draft);
  const mutation = useMutation({
    retry: false,
    mutationFn: (accepted: HostingProof) => run({ proof: accepted, idempotencyKey }),
    onSuccess: onDone,
    onError: (error) => noteSectionError(error, queryClient),
    onSettled: () => setDraft((current) => ({ ...current, value: '' })),
  });
  const ready = valid && proof !== null && !mutation.isPending;
  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (ready && proof !== null) mutation.mutate(proof);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      danger={danger}
      foot={
        <>
          <button
            type="button"
            className={danger ? 'btn danger solid' : 'btn primary'}
            disabled={!ready}
            onClick={() => submit()}
          >
            {mutation.isPending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('web.hosting_cancel')}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={submit} autoComplete="off">
        {hint !== undefined && <p className="muted small">{hint}</p>}
        {children}
        <Banner tone="info" slim>
          {t('web.hosting_prompt_intro')}
        </Banner>
        <ProofField draft={draft} onChange={setDraft} idPrefix={idPrefix} />
        {mutation.error !== null && (
          <Banner tone="danger">
            {errorText(mutation.error)}
            <ErrorRef error={mutation.error} />
          </Banner>
        )}
        {/* Enter submits from any field, like every other form on the page. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
}

/** Shown once, after activation or after new codes were made. The page never has them again. */
export function RecoveryCodesReveal({
  codes,
  onDone,
}: {
  codes: readonly string[];
  onDone: () => void;
}) {
  const download = (): void => {
    const text = `${t('web.hosting_recovery_file_heading')}\n\n${codes.join('\n')}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nexa-hosting-recovery-codes.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return (
    <div className="stack">
      <Banner tone="warn" title={t('web.hosting_recovery_once_title')}>
        {t('web.hosting_recovery_once_body')}
      </Banner>
      <ul className="hosting-codes" dir="ltr" aria-label={t('web.hosting_recovery_list')}>
        {codes.map((value) => (
          <li key={value}>
            <code>{value}</code>
          </li>
        ))}
      </ul>
      <div className="btn-group">
        <CopyButton value={codes.join('\n')} label={t('web.hosting_recovery_copy')} />
        <button type="button" className="btn" onClick={download}>
          <Icon name="download" />
          {t('web.hosting_recovery_download')}
        </button>
        <button type="button" className="btn primary" onClick={onDone}>
          <Icon name="check" />
          {t('web.hosting_recovery_saved')}
        </button>
      </div>
    </div>
  );
}
