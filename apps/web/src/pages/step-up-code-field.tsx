import { t } from '../i18n/web.fa';

/**
 * The code half of the account-password step-up (D2 review): required by the server when the
 * administrator's own two-step sign-in is on, and ignored when it is off. Moved here from the
 * Recovery Kit page when the kit was removed (SFR A1); the backup password uses it.
 */
export function StepUpCodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{t('web.admin_step_up_code')}</span>
      <input
        className="input"
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={8}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <span className="muted small">{t('web.admin_step_up_code_hint')}</span>
    </label>
  );
}
