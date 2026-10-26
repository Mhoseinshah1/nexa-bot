import {
  customMenuButtonVisible,
  customMenuRefOf,
  type CustomMenuRef,
  type FeatureFlagKey,
  type ScopeContext,
} from '@nexa/contracts';
import type { MainMenuSource } from '../../../commerce/messaging/application/main-menu.js';
import type { CustomMenuButtonRepository } from './custom-menu-button.ports.js';

/**
 * R10 D2 — what the customer-facing side reads of the owner's main-menu buttons: which are
 * drawn on a keyboard, which labels route a tap, and what a tap answers.
 *
 * No actor and no permission: this is the bot reading state to answer a customer, like
 * `MainMenuLayout`. It writes nothing.
 */

/** What a tap on a custom button resolves to, decided now from state. */
export type CustomMenuTap =
  | { readonly outcome: 'UNAVAILABLE' }
  | { readonly outcome: 'LINK'; readonly url: string; readonly note: string | null }
  | { readonly outcome: 'TEXT'; readonly text: string }
  | {
      readonly outcome: 'MEDIA';
      readonly kind: 'PHOTO' | 'DOCUMENT';
      readonly mimeType: string;
      readonly fileName: string;
      readonly bytes: Uint8Array;
      readonly caption: string | null;
    };

export interface CustomMenuButtonRuntimeDeps {
  readonly repository: Pick<CustomMenuButtonRepository, 'list' | 'find' | 'readMedia'>;
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  /** The runtime's own selection of what the keyboard is drawn from (published, never a draft). */
  readonly source: MainMenuSource;
}

export class CustomMenuButtonRuntime {
  constructor(private readonly deps: CustomMenuButtonRuntimeDeps) {}

  private enabled(scope: ScopeContext): Promise<boolean> {
    return this.deps.features.isEnabled(scope, 'custom_menu_buttons');
  }

  /**
   * The buttons drawn for a bot, by reference, with their labels. Empty while the feature is
   * off (no row is read then). `botInstanceId` null is a view naming no bot: the bot filter is
   * ignored, the flag and the archive are not.
   */
  async visibleFor(
    scope: ScopeContext,
    botInstanceId: string | null,
  ): Promise<ReadonlyMap<CustomMenuRef, string>> {
    const visible = new Map<CustomMenuRef, string>();
    const featureEnabled = await this.enabled(scope);
    if (!featureEnabled) return visible;
    for (const button of await this.deps.repository.list(scope)) {
      if (customMenuButtonVisible(button, featureEnabled, botInstanceId)) {
        visible.set(customMenuRefOf(button.id), button.label);
      }
    }
    return visible;
  }

  /**
   * Every label that may still be tapped, ACTIVE buttons first, so a label an archived button
   * once held and a live one holds now routes to the live one. Archived buttons stay routable
   * on purpose: a keyboard already in a chat is answered "unavailable", not "unknown".
   */
  async routeLabels(
    scope: ScopeContext,
  ): Promise<readonly { readonly id: string; readonly label: string }[]> {
    const all = await this.deps.repository.list(scope);
    return [...all]
      .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null))
      .map((one) => ({ id: one.id, label: one.label }));
  }

  /**
   * THE answer to a tap. Routing granted nothing: every condition is decided again, from
   * state, for the SENDING bot — the feature is on, the button exists and is not archived,
   * it is shown on this bot, and the PUBLISHED layout (the one the keyboard is drawn from)
   * places it with its switch on.
   */
  async forTap(scope: ScopeContext, id: string, botInstanceId: string): Promise<CustomMenuTap> {
    const unavailable: CustomMenuTap = { outcome: 'UNAVAILABLE' };
    const featureEnabled = await this.enabled(scope);
    if (!featureEnabled) return unavailable;
    const button = await this.deps.repository.find(scope, id);
    if (button === null || !customMenuButtonVisible(button, featureEnabled, botInstanceId)) {
      return unavailable;
    }
    const snapshot = await this.deps.source.snapshotFor(scope);
    if (snapshot.source.kind !== 'EXPLICIT') return unavailable;
    const layout = snapshot.source.layout;
    if (layout.v !== 2) return unavailable;
    const ref = customMenuRefOf(button.id);
    const placed = layout.rows.some((row) => row.includes(ref));
    const config = layout.customButtons.find((one) => one.ref === ref);
    if (!placed || config === undefined || !config.enabled) return unavailable;

    switch (button.kind) {
      case 'LINK':
        return button.url === null
          ? unavailable
          : { outcome: 'LINK', url: button.url, note: button.body };
      case 'TEXT':
        return button.body === null ? unavailable : { outcome: 'TEXT', text: button.body };
      case 'PHOTO':
      case 'DOCUMENT': {
        if (button.media === null) return unavailable;
        const media = await this.deps.repository.readMedia(scope, button.media.id);
        if (media === null) return unavailable;
        return {
          outcome: 'MEDIA',
          kind: media.kind,
          mimeType: media.mimeType,
          fileName: media.fileName,
          bytes: media.bytes,
          caption: button.body,
        };
      }
    }
  }
}
