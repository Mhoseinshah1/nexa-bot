import { useEffect, useSyncExternalStore } from 'react';

/**
 * Making `/r/` installable: the manifest, the service worker and the install prompt.
 *
 * Only the panel's own shell does this — the Web Admin is never offered for install and never
 * gets a worker. The worker (`public/r/sw.js`) caches static files only and never an `/api`
 * response; it has no offline mode (see the file for the rule and its test).
 */
export const PANEL_MANIFEST_URL = '/r/manifest.webmanifest';
export const PANEL_SW_URL = '/r/sw.js';
export const PANEL_SCOPE = '/r/';

/** The browser's install prompt, which `lib.dom` does not type. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallState {
  readonly event: BeforeInstallPromptEvent | null;
  readonly installed: boolean;
}

let state: InstallState = { event: null, installed: false };
const listeners = new Set<() => void>();
let wired = false;

function setState(next: InstallState): void {
  state = next;
  for (const listener of listeners) listener();
}

function wireInstallEvents(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    setState({ ...state, event: event as BeforeInstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => setState({ event: null, installed: true }));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the browser offered an install prompt, whether the app is installed, and iOS. */
export function useInstallState(): {
  canPrompt: boolean;
  installed: boolean;
  standalone: boolean;
  install: () => Promise<void>;
} {
  const current = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  const standalone =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  return {
    canPrompt: current.event !== null,
    installed: current.installed,
    standalone,
    install: async () => {
      const event = current.event;
      if (event === null) return;
      await event.prompt();
      const choice = await event.userChoice;
      // The prompt can be used once either way.
      setState({ event: null, installed: choice.outcome === 'accepted' });
    },
  };
}

function ensureHeadTag(selector: string, create: () => HTMLElement): void {
  if (document.head.querySelector(selector) === null) document.head.appendChild(create());
}

/**
 * Mounted once by the signed-in shell: adds the manifest link and the theme colour, starts
 * listening for the install prompt and registers the worker. Every step is guarded, because a
 * browser without service workers (or a private window) must still show the panel.
 */
export function usePanelPwa(): void {
  useEffect(() => {
    wireInstallEvents();
    ensureHeadTag('link[rel="manifest"]', () => {
      const link = document.createElement('link');
      link.rel = 'manifest';
      link.href = PANEL_MANIFEST_URL;
      return link;
    });
    ensureHeadTag('meta[name="theme-color"]', () => {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      // The dark token `--bg-0`: the same colour the manifest names.
      meta.content = '#0a0a0b';
      return meta;
    });
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register(PANEL_SW_URL, { scope: PANEL_SCOPE }).catch(() => undefined);
    }
  }, []);
}

/** The iPhone has no install prompt: Safari's share sheet is the only way. */
export function isIosSafari(userAgent: string): boolean {
  return /iPhone|iPad|iPod/u.test(userAgent);
}
