import { useCallback, useEffect, useState } from 'react';

/**
 * Dark, light, or whatever the operating system says.
 *
 * The attribute is ALWAYS written, even for `system`, so the stylesheet needs
 * no `prefers-color-scheme` block and every token has exactly one definition
 * per theme. A media query in the stylesheet plus an attribute set here is two
 * sources for the same decision, and the pair disagrees the moment somebody
 * adds a token to one and not the other.
 */

export const THEME_CHOICES = ['system', 'dark', 'light'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

const STORAGE_KEY = 'nexa.theme';

function isChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

/**
 * Storage can throw, not just come back empty.
 *
 * A browser configured to block site data raises on the ACCESS, so an
 * unguarded read takes the whole admin down at boot rather than falling back
 * to the system theme.
 */
function readStored(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isChoice(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

function writeStored(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // A remembered preference is a convenience. Losing it is not a failure
    // worth interrupting an operator over, and there is nothing else to do
    // about a browser that refuses to store it.
  }
}

function systemPrefersLight(): boolean {
  return window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): 'dark' | 'light' {
  if (choice === 'system') return prefersLight ? 'light' : 'dark';
  return choice;
}

function apply(choice: ThemeChoice): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(choice, systemPrefersLight()));
}

/** Set before React mounts, so the first paint is not the wrong theme. */
export function initTheme(): void {
  apply(readStored());
}

export function useTheme(): { choice: ThemeChoice; setChoice: (next: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStored);

  // While the choice is `system`, the OS may change under us. Without this the
  // admin keeps the theme it booted with until a reload.
  useEffect(() => {
    if (choice !== 'system') return undefined;
    const query = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => apply('system');
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    writeStored(next);
    apply(next);
  }, []);

  return { choice, setChoice };
}
