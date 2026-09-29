import {
  MAIN_MENU_BUTTONS,
  mainMenuButton,
  packMainMenuRows,
  resolveMainMenuLayout,
  type BotMenuButton,
  type FeatureFlagKey,
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
  /** The tenant's own rendering — the resolver every customer message goes through. */
  readonly templates: {
    render(scope: ScopeContext, key: TemplateKey, values: TemplateValues): Promise<string>;
  };
}

/**
 * The customer main menu, as THIS tenant has it (R1, «دکمه‌های ربات»).
 *
 * One object with two readers, so the keyboard that is drawn and the table a tap is
 * matched against cannot disagree:
 *
 * - `rowsFor` is what `TelegramCustomerMessenger` draws: the operator's arrangement
 *   (`bot.main_menu`), without the buttons they switched off and without a button whose
 *   feature is off, labelled by the tenant's own templates, two to a row.
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

  /** The buttons drawn, in order: switched on, and their feature (if any) on. */
  async buttonsFor(scope: ScopeContext): Promise<readonly BotMenuButton[]> {
    const stored = await this.deps.settings.valueOf<readonly MainMenuLayoutEntry[]>(
      scope,
      'bot.main_menu',
    );
    const flags = new Map<FeatureFlagKey, boolean>();
    const drawn: BotMenuButton[] = [];
    for (const entry of resolveMainMenuLayout(stored)) {
      if (!entry.enabled) continue;
      const button = mainMenuButton(entry.button);
      if (button.feature !== null) {
        let on = flags.get(button.feature);
        if (on === undefined) {
          on = await this.deps.features.isEnabled(scope, button.feature);
          flags.set(button.feature, on);
        }
        if (!on) continue;
      }
      drawn.push(button);
    }
    return drawn;
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
