import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Input, SecretInput } from '../../apps/web/src/ui/kit';
import { t } from '../../apps/web/src/i18n/web.fa';

describe('SecretInput', () => {
  const draw = () => {
    const view = render(
      <form>
        <label htmlFor="k">key</label>
        <SecretInput id="k" value="abc" onChange={() => undefined} />
      </form>,
    );
    return view.container.querySelector('input') as HTMLInputElement;
  };

  it('is a text input that asks browsers and password managers to leave it alone', () => {
    const input = draw();
    expect(input.type).toBe('text');
    expect(input.getAttribute('type')).not.toBe('password');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('data-lpignore')).toBe('true');
    expect(input.hasAttribute('data-1p-ignore')).toBe(true);
    expect(input.getAttribute('data-form-type')).toBe('other');
    // A name that is not a login word.
    expect(input.name).toMatch(/^nx-secret-/u);
    expect(input.name).not.toMatch(/pass|user|login|email/iu);
  });

  it('never renders a password-type input, whatever props it is given', () => {
    const { container } = render(
      <SecretInput {...({ type: 'password', autoComplete: 'new-password' } as object)} />,
    );
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input')!.getAttribute('autocomplete')).toBe('off');
  });

  it('is masked until the eye is pressed, then masked again', () => {
    const input = draw();
    expect(input.classList.contains('secret-masked')).toBe(true);
    const eye = screen.getByRole('button', { name: t('web.secret_show') });
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(eye);
    expect(input.classList.contains('secret-masked')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: t('web.secret_hide') }));
    expect(input.classList.contains('secret-masked')).toBe(true);
  });

  it('keeps an explicit name', () => {
    const { container } = render(<SecretInput name="gateway-key" />);
    expect(container.querySelector('input')!.name).toBe('gateway-key');
  });
});

describe('the kit input', () => {
  it('turns autocomplete off by default, so every search and filter is not a login', () => {
    const { container } = render(<Input aria-label="search" />);
    expect(container.querySelector('input')!.getAttribute('autocomplete')).toBe('off');
  });

  it('lets a page that wants a value say so', () => {
    const { container } = render(<Input aria-label="email" autoComplete="email" />);
    expect(container.querySelector('input')!.getAttribute('autocomplete')).toBe('email');
  });
});
