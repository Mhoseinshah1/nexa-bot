import {
  MAIN_MENU_BUTTONS,
  mainMenuButton,
  packMainMenuRows,
  resolveMainMenuLayout,
  type BotMenuButton,
  type FeatureFlagKey,
  type MainMenuGate,
  type MainMenuItem,
  type MainMenuLayoutEntry,
  type ScopeContext,
  type SettingKey,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';

export interface MainMenuDeps {
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
 *   trial, labelled by the tenant's own templates, two to a row.
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
    } = {},
  ): Promise<readonly DescribedMainMenuItem[]> {
    const ask = (enabled: boolean) => enabled || options.gatesForHidden === true;
    const stored = await this.deps.settings.valueOf<readonly MainMenuLayoutEntry[]>(
      scope,
      'bot.main_menu',
    );
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
    return described;
  }

  /** The buttons drawn, in order. */
  async buttonsFor(scope: ScopeContext): Promise<readonly BotMenuButton[]> {
    return (await this.describeFor(scope))
      .filter((described) => described.shown)
      .map((described) => described.button);
  }

  /** The keyboard's rows, as rendered labels. Never empty: the schema keeps one ungated button on. */
  async rowsFor(scope: ScopeContext): Promise<string[][]> {
    const buttons = await this.buttonsFor(scope);
    const labelled = await Promise.all(
      buttons.map(async (button) => ({
        wide: button.wide,
        text: await this.deps.templates.render(scope, button.label, {}),
      })),
    );
    return packMainMenuRows(labelled).map((row) => row.map((button) => button.text));
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
