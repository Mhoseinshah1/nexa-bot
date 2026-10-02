import {
  MAIN_MENU_BUTTONS,
  customerRowsOf,
  legacyProjectionOf,
  mainMenuButton,
  packMainMenuRows,
  resolveMainMenuLayout,
  type AppearanceSlot,
  type BotMenuButton,
  type ExplicitMainMenu,
  type FeatureFlagKey,
  type MainMenuButtonId,
  type MainMenuButtonStyle,
  type MainMenuGate,
  type MainMenuGateOpenById,
  type MainMenuItem,
  type MainMenuLayoutEntry,
  type ScopeContext,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';

/**
 * Round T: where the customer keyboard is drawn from NOW — the builder's PUBLISHED layout,
 * or the legacy path over `bot.main_menu` (`docs/round-t-button-builder-audit.md` §11.5).
 *
 * - `EXPLICIT`: a layout is published, it parses, and `bot.main_menu` is still at the
 *   version that publish wrote.
 * - `LEGACY`: nothing published (`superseded` and `publishedUnreadable` false — today's path,
 *   byte for byte); or the setting was written behind the published layout by an older
 *   release (`superseded`: the operator's latest act wins); or the published snapshot cannot
 *   be read by this release (`publishedUnreadable`).
 *
 * A draft is never an answer: the runtime reads only what was published.
 */
export type MainMenuSourceAnswer =
  | { readonly kind: 'EXPLICIT'; readonly layout: ExplicitMainMenu; readonly revision: number }
  | {
      readonly kind: 'LEGACY';
      readonly superseded: boolean;
      readonly publishedUnreadable: boolean;
    };

/**
 * Everything the keyboard is decided from, read in ONE snapshot: the source answer AND the
 * legacy arrangement (`bot.main_menu`, resolved) from the same statement. `describeFor` and
 * `keyboardFor` compute from it and read the menu state nowhere else; only the gate answers
 * (a feature flag, a panel's trial offer) are read live.
 */
export interface MainMenuSnapshot {
  readonly source: MainMenuSourceAnswer;
  /** `bot.main_menu` as resolved in that snapshot; drawn when `source` is LEGACY. */
  readonly legacy: readonly MainMenuLayoutEntry[];
}

export interface MainMenuSource {
  snapshotFor(scope: ScopeContext): Promise<MainMenuSnapshot>;
}

/**
 * One button of the customer keyboard as the bot draws it: the rendered label — which is
 * also exactly the text a tap sends back, so routing is unchanged — its style, and its
 * icon SLOT. The slot is resolved to a custom emoji id per SENDING bot by the transport,
 * never here: eligibility is a property of a bot, not of a tenant.
 */
export interface MainMenuKeyboardButton {
  readonly text: string;
  readonly style: MainMenuButtonStyle;
  readonly iconSlot: AppearanceSlot | null;
}

/**
 * A snapshot the CALLER already read: the builder's read passes the one it built its heads
 * from, so the items and live rows it returns describe that state and not a later commit.
 */
export interface MainMenuReadOptions {
  readonly pinned?: MainMenuSnapshot;
}

export interface MainMenuDeps {
  /**
   * Round T: the published-layout source. Absent means the legacy path only — what a
   * stand-in without the builder draws; the container always wires it.
   */
  readonly source?: MainMenuSource;
  readonly settings: {
    valueOf<T>(scope: ScopeContext, key: SettingKey, tx?: unknown): Promise<T>;
  };
  readonly features: {
    isEnabled(scope: ScopeContext, key: FeatureFlagKey, tx?: unknown): Promise<boolean>;
  };
  /**
   * F5: whether at least one panel offers a trial NOW — `trialOffersFor`, the answer the
   * claim and the operator's overview share. The trial button's only gate: the `trials`
   * flag is retired and each panel's own trial is the switch.
   */
  readonly trials: {
    anyOffered(scope: ScopeContext): Promise<boolean>;
  };
  /** The tenant's own rendering — the resolver every customer message goes through. */
  readonly templates: {
    render(scope: ScopeContext, key: TemplateKey, values: TemplateValues): Promise<string>;
  };
}

/** One resolved item and the keyboard's decision about it. */
export interface DescribedMainMenuItem {
  readonly item: MainMenuItem;
  readonly button: BotMenuButton;
  /** What, besides the operator's switch, can hide it. */
  readonly gate: MainMenuGate | null;
  /** Whether that gate is open; null when there is no gate or the item is off (not asked). */
  readonly gateOpen: boolean | null;
  /** Whether the keyboard draws it now. */
  readonly shown: boolean;
}

/**
 * The customer main menu, as THIS tenant has it (R1, «دکمه‌های ربات»).
 *
 * One object with two readers, so the keyboard that is drawn and the table a tap is
 * matched against cannot disagree:
 *
 * - `rowsFor` is what `TelegramCustomerMessenger` draws: the operator's arrangement
 *   (`bot.main_menu`), without the buttons they switched off, without a button whose
 *   feature is off and — since F5 — without the trial button while no panel offers a
 *   trial, labelled by the tenant's own templates, two to a row — or, once the tenant has
 *   published a layout in the button builder (round T), in the operator's own rows, with
 *   styles and icon slots (`keyboardFor`). The runtime reads only what was PUBLISHED.
 * - `routesFor` is what the runtime matches a tap against: EVERY declared button's label
 *   as the tenant renders it now, whatever is switched on — so a keyboard already sitting
 *   in a chat still routes after a button is hidden, and a renamed button routes under
 *   its new name. The shared default labels stay in the runtime's static table beside it,
 *   so a keyboard drawn before a rename keeps working too.
 *
 * Routing a hidden button is not authority: a tap is text, and the turn it resolves to
 * answers from the feature's own state.
 */
export class MainMenuLayout {
  constructor(private readonly deps: MainMenuDeps) {}

  /**
   * Every item of the arrangement, in order, with the ONE decision about each: whether it
   * is drawn — switched on, its feature (if any) on, and, for the trial button, a panel
   * offering a trial. Each gate is read once, and only when an item that needs it is
   * switched on. `buttonsFor` is the drawn subset; the Web Admin's table (round P) reads
   * the whole list, so it shows the same answer the keyboard gives and never a second one.
   */
  async describeFor(
    scope: ScopeContext,
    options: {
      /**
       * Read a gate for an item the operator switched OFF too. The keyboard never needs
       * that (an off item is not drawn, so its gate is not asked — the trial offer dials the
       * panel repositories on every reply); the Web Admin does, so its preview of an item
       * about to be switched on says what the keyboard will do, not "unknown" (Codex #6).
       */
      readonly gatesForHidden?: boolean;
    } & MainMenuReadOptions = {},
  ): Promise<readonly DescribedMainMenuItem[]> {
    return (await this.decide(scope, options)).described;
  }

  /**
   * The one decision behind `describeFor` and `keyboardFor`: the source read ONCE, every
   * item described against it. On an explicit layout the items are its compatibility
   * projection resolved — placed buttons row-major with their own switch, then the unplaced
   * ones off — so the Web Admin's table and the gate reads mean what they always meant.
   */
  private async decide(
    scope: ScopeContext,
    options: { readonly gatesForHidden?: boolean } & MainMenuReadOptions,
  ): Promise<{
    readonly source: MainMenuSourceAnswer;
    readonly described: readonly DescribedMainMenuItem[];
  }> {
    const ask = (enabled: boolean) => enabled || options.gatesForHidden === true;
    const snapshot = options.pinned ?? (await this.snapshotFor(scope));
    const source = snapshot.source;
    const stored = source.kind === 'EXPLICIT' ? legacyProjectionOf(source.layout) : snapshot.legacy;
    const flags = new Map<FeatureFlagKey, boolean>();
    let trialOffered: boolean | undefined;
    const described: DescribedMainMenuItem[] = [];
    for (const item of resolveMainMenuLayout(stored)) {
      const button = mainMenuButton(item.button);
      const gate: MainMenuGate | null = button.needsTrialOffer
        ? 'TRIAL_OFFER'
        : button.feature !== null
          ? 'FEATURE'
          : null;
      let gateOpen: boolean | null = null;
      if (ask(item.enabled) && button.needsTrialOffer) {
        trialOffered ??= await this.deps.trials.anyOffered(scope);
        gateOpen = trialOffered;
      }
      if (ask(item.enabled) && button.feature !== null) {
        let on = flags.get(button.feature);
        if (on === undefined) {
          on = await this.deps.features.isEnabled(scope, button.feature);
          flags.set(button.feature, on);
        }
        gateOpen = on;
      }
      described.push({
        item,
        button,
        gate,
        gateOpen,
        shown: item.enabled && (gate === null || gateOpen === true),
      });
    }
    return { source, described };
  }

  /** One read of the menu state: the source's snapshot, or the legacy setting for a stand-in. */
  private async snapshotFor(scope: ScopeContext): Promise<MainMenuSnapshot> {
    if (this.deps.source !== undefined) return this.deps.source.snapshotFor(scope);
    return {
      source: { kind: 'LEGACY', superseded: false, publishedUnreadable: false },
      legacy: await this.deps.settings.valueOf<readonly MainMenuLayoutEntry[]>(
        scope,
        'bot.main_menu',
      ),
    };
  }

  /** The buttons drawn, in order. */
  async buttonsFor(scope: ScopeContext): Promise<readonly BotMenuButton[]> {
    return (await this.describeFor(scope))
      .filter((described) => described.shown)
      .map((described) => described.button);
  }

  /**
   * The keyboard's rows as structured buttons (round T): what is drawn, row by row, with
   * each button's style and icon slot.
   *
   * - LEGACY: the shown buttons packed two to a row (a wide one alone) — exactly the rows
   *   `rowsFor` drew before round T — every style `default`, no icon.
   * - EXPLICIT: `customerRowsOf` over the published layout with THIS evaluator's gate
   *   answers — the operator's rows, nothing reflowed, an emptied row dropped.
   *
   * Never empty: both schemas keep one ungated button on.
   */
  async keyboardFor(
    scope: ScopeContext,
    options: MainMenuReadOptions = {},
  ): Promise<MainMenuKeyboardButton[][]> {
    const { source, described } = await this.decide(scope, options);
    const label = (button: BotMenuButton) => this.deps.templates.render(scope, button.label, {});
    if (source.kind === 'EXPLICIT') {
      const gateOpenById: Partial<Record<MainMenuButtonId, boolean | null>> = {};
      for (const one of described) gateOpenById[one.item.button] = one.gateOpen;
      const rows = customerRowsOf(source.layout, gateOpenById as MainMenuGateOpenById);
      return Promise.all(
        rows.map((row) =>
          Promise.all(
            row.map(async (one) => ({
              text: await label(mainMenuButton(one.button)),
              style: one.style,
              iconSlot: one.iconSlot,
            })),
          ),
        ),
      );
    }
    const buttons = described.filter((one) => one.shown).map((one) => one.button);
    const labelled = await Promise.all(
      buttons.map(async (button) => ({ wide: button.wide, text: await label(button) })),
    );
    return packMainMenuRows(labelled).map((row) =>
      row.map((button) => ({ text: button.text, style: 'default' as const, iconSlot: null })),
    );
  }

  /**
   * The keyboard's rows as rendered labels — the TEXT-ONLY view of `keyboardFor`. The
   * messenger draws `keyboardFor` itself (styles and icons, round T, T2); this serves the
   * views that show text only: the operator's `/bot-menu` read (`BotMenuService`) and the
   * builder's `live` rows. Byte for byte the rows the transport drew before round T on the
   * legacy path.
   */
  async rowsFor(scope: ScopeContext, options: MainMenuReadOptions = {}): Promise<string[][]> {
    return (await this.keyboardFor(scope, options)).map((row) => row.map((button) => button.text));
  }

  /** Every declared button's CURRENT label, and the slash command it stands for. */
  async routesFor(scope: ScopeContext): Promise<ReadonlyMap<string, string>> {
    // Rendered together: one round of lookups for the whole table, not eight in a row.
    const labels = await Promise.all(
      MAIN_MENU_BUTTONS.map(async (button) =>
        (await this.deps.templates.render(scope, button.label, {})).trim(),
      ),
    );
    const routes = new Map<string, string>();
    MAIN_MENU_BUTTONS.forEach((button, index) => {
      const label = labels[index] ?? '';
      // The first button to claim a label keeps it: two buttons an operator gave one name
      // cannot both be reached by it, and the earlier-declared one is the stable answer.
      // A label that reads as a slash command routes nothing: `intentOf` parses it as
      // the command it spells, and a button must not take `/start` away from `/start`.
      if (label === '' || label.startsWith('/')) return;
      if (!routes.has(label)) routes.set(label, `/${button.command}`);
    });
    return routes;
  }
}
