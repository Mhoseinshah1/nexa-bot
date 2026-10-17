import { isSettingKey, settingDefinition } from '@nexa/contracts';
import type { WebKey } from './i18n/web.fa';
import type { SettingControl } from './settings-presentation';

/**
 * What is wrong with a setting's draft, in Persian, BEFORE it is sent (W6).
 *
 * The registry's own schema decides — the same `settingDefinition(key).schema` the server
 * parses with — so this can never refuse a value the server would accept or pass one it
 * refuses. What it adds is the sentence: Zod's English issue becomes one Persian sentence
 * per kind of mistake, chosen by the control and the issue's path. The server still
 * validates every write; this only saves the operator a round trip and an English answer.
 *
 * An empty list means "send it".
 */
export function settingDraftProblems(
  key: string,
  control: SettingControl | null,
  draft: unknown,
): WebKey[] {
  if (!isSettingKey(key)) return [];
  let parsed: ReturnType<ReturnType<typeof settingDefinition>['schema']['safeParse']>;
  try {
    parsed = settingDefinition(key).schema.safeParse(draft);
  } catch {
    /*
     * Some money schemas refine with `BigInt(amountMinor)`, and Zod still runs a refine after
     * the digits regex failed — so letters in an amount THROW out of `safeParse` rather than
     * failing it. That is a refused draft, never a crash of the submit handler.
     */
    return [
      control?.kind === 'money' || control?.kind === 'money_list'
        ? 'web.err_setting_money'
        : 'web.settings_invalid_value',
    ];
  }
  if (parsed.success) return [];
  const problems = parsed.error.issues.map((issue) =>
    problemFor(control, issue.path.map(String), draft),
  );
  return [...new Set(problems)];
}

function problemFor(
  control: SettingControl | null,
  path: readonly string[],
  draft: unknown,
): WebKey {
  switch (control?.kind) {
    case 'integer':
      return typeof draft === 'number' ? 'web.err_setting_range' : 'web.err_setting_integer';
    case 'decimal':
      return 'web.err_setting_decimal';
    case 'money':
      return path[0] === 'currency' ? 'web.err_setting_currency' : 'web.err_setting_money';
    case 'money_list':
      if (path.length === 0) return 'web.err_setting_duplicate';
      return path[path.length - 1] === 'currency'
        ? 'web.err_setting_currency'
        : 'web.err_setting_money';
    case 'handle_list':
      return path.length === 0 ? 'web.err_setting_duplicate' : 'web.err_setting_handle';
    case 'channel_list':
      return channelProblem(path, draft);
    default:
      return 'web.settings_invalid_value';
  }
}

function channelProblem(path: readonly string[], draft: unknown): WebKey {
  if (path.length === 0) return 'web.err_setting_duplicate';
  const field = path[1];
  if (field === 'handle') return 'web.err_setting_handle';
  if (field === 'chatId') return 'web.err_setting_chat_id';
  if (field === 'joinUrl') return 'web.err_setting_join_url';
  // A refinement over the whole channel: which of its two rules it broke.
  const channel = Array.isArray(draft) ? (draft[Number(path[0])] as unknown) : undefined;
  const shaped = (typeof channel === 'object' && channel !== null ? channel : {}) as {
    handle?: unknown;
    chatId?: unknown;
  };
  return shaped.handle === undefined && shaped.chatId === undefined
    ? 'web.err_setting_channel_identity'
    : 'web.err_setting_channel_open';
}
