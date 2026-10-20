import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_PREFIX, BACKUP_ROUTES, type BackupStatusResponse } from '@nexa/contracts';
import { BackupPasswordCard } from '../../apps/web/src/pages/backup-password';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Round 4 PR-E (E4): the owner-set backup password. Never shown, typed twice, behind the
 * account password, and every secret field cleared once the server has answered.
 */

const STATUS = {
  archivePassword: { configured: false, setAt: null },
} as unknown as BackupStatusResponse;

afterEach(() => vi.unstubAllGlobals());

describe('the backup password card (E4)', () => {
  it('says only whether a password is set, and offers no form to a non-owner', () => {
    stubApi([]);
    const { container } = renderPage(<BackupPasswordCard status={STATUS} mayEdit={false} />);
    expect(container.textContent).toContain(t('web.backup_password_unset'));
    expect(container.textContent).toContain(t('web.backup_password_owner_only'));
    expect(container.querySelector('input')).toBeNull();
  });

  it('sends the password twice and the account password in the body, then clears every field', async () => {
    const api = stubApi([
      {
        url: `${API_PREFIX}${BACKUP_ROUTES.archivePassword}`,
        body: { archivePassword: { configured: true, setAt: '2026-10-19T04:00:00.000Z' } },
      },
    ]);
    renderPage(<BackupPasswordCard status={STATUS} mayEdit />);
    const save = screen.getByRole('button', { name: t('web.backup_password_save') });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.backup_password_new')), {
      target: { value: 'short' },
    });
    expect(screen.getByText(t('web.backup_password_short'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.backup_password_new')), {
      target: { value: 'a long backup password' },
    });
    fireEvent.change(screen.getByLabelText(t('web.backup_password_again')), {
      target: { value: 'a long backup passworD' },
    });
    expect(screen.getByText(t('web.backup_password_mismatch'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.backup_password_again')), {
      target: { value: 'a long backup password' },
    });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.kit_account_password')), {
      target: { value: 'my-account-password' },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText(t('web.backup_password_saved'));
    const write = api.calls.find((call) => call.method === 'POST');
    expect(write?.body).toMatchObject({
      password: 'a long backup password',
      confirmation: 'a long backup password',
      stepUp: { password: 'my-account-password' },
    });
    await waitFor(() =>
      expect(screen.getByLabelText(t('web.backup_password_new'))).toHaveValue(''),
    );
    expect(screen.getByLabelText(t('web.kit_account_password'))).toHaveValue('');
  });
});
