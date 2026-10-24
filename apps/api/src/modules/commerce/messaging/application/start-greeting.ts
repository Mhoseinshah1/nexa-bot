import type { Money, TemplateKey, TemplateValues } from '@nexa/contracts';

/**
 * R6 item 3: the values of `/start`'s two greetings (`bot.start.welcome`,
 * `bot.start.welcome_back`).
 *
 * The MirzaBot incident (see `packages/contracts/src/templates.ts` above `bot.start.welcome`)
 * is why every rule here exists. A greeting with a name in it was damaging once a RENDERED
 * echo was saved back into the template, and the name belonged to somebody who was not
 * receiving the message. So:
 *
 * - this is a pure function of ONE customer's own facts, called at send time for the
 *   customer the update came from; it reads no administrator and nothing shared;
 * - it returns VALUES, never a rendered string — nothing here (or anywhere it flows to)
 *   persists a rendered greeting; the one renderer composes the text when the message is sent;
 * - a name is passed raw and the renderer sanitises it (`untrusted` placeholder), so there is
 *   no second sanitiser to forget; the fields that are not free text are validated here;
 * - an empty fact is OMITTED rather than sent as an empty string, which is what lets the
 *   renderer remove its line or close its gap.
 */
export interface StartGreetingFacts {
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly firstName: string | null;
  /** The wallet balance in the selling currency, derived from the ledger. */
  readonly balance: Money | null;
  /** How many of the customer's services serve now. */
  readonly activeServices: number | null;
  /** The soonest deadline among those; null when none serves or none has one. */
  readonly nearestExpiresAt: Date | null;
  readonly now: Date;
}

const TEHRAN = 'Asia/Tehran';
const DAY_MS = 86_400_000;
/** Telegram usernames: 5-32 of letters, digits and underscore; accept 1-32 to stay tolerant. */
const USERNAME_PATTERN = /^[A-Za-z0-9_]{1,32}$/u;
const TELEGRAM_ID_PATTERN = /^[0-9]{1,20}$/u;

const DATE_FORMAT = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TEHRAN,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const WEEKDAY_FORMAT = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TEHRAN,
  weekday: 'long',
});
const TIME_FORMAT = new Intl.DateTimeFormat('fa-IR', {
  timeZone: TEHRAN,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** «۲ آبان ۱۴۰۵», «جمعه», «۱۸:۳۰» in Tehran, from the injected moment. */
export function tehranDateParts(now: Date): {
  readonly date: string;
  readonly weekday: string;
  readonly time: string;
} {
  return {
    date: DATE_FORMAT.format(now),
    weekday: WEEKDAY_FORMAT.format(now),
    time: TIME_FORMAT.format(now),
  };
}

/** Whole days until `expiresAt`, rounded UP so the last day still reads «۱ روز»; null if past. */
export function daysUntil(expiresAt: Date, now: Date): number | null {
  const remaining = expiresAt.getTime() - now.getTime();
  return remaining <= 0 ? null : Math.max(1, Math.ceil(remaining / DAY_MS));
}

export function startGreetingValues(facts: StartGreetingFacts): TemplateValues {
  const values: Record<string, TemplateValues[string]> = {
    ...tehranDateParts(facts.now),
  };
  const firstName = facts.firstName?.trim() ?? '';
  if (firstName !== '') values['firstName'] = firstName;
  if (facts.username !== null && USERNAME_PATTERN.test(facts.username)) {
    values['username'] = `@${facts.username}`;
  }
  if (TELEGRAM_ID_PATTERN.test(facts.telegramUserId)) values['telegramId'] = facts.telegramUserId;
  if (facts.balance !== null) values['walletBalance'] = facts.balance;
  if (facts.activeServices !== null) values['activeServices'] = facts.activeServices;
  if (facts.nearestExpiresAt !== null) {
    const days = daysUntil(facts.nearestExpiresAt, facts.now);
    if (days !== null) values['nearestExpiry'] = days;
  }
  return values;
}

/** Which greeting a customer's arrival gets: only these two keys take the variables. */
export type StartGreetingKey = Extract<TemplateKey, 'bot.start.welcome' | 'bot.start.welcome_back'>;
