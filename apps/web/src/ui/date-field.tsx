import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n/web.fa';
import { Icon } from './icons';
import { LayerContext, useLayer } from './layer';
import { useFocusTrap } from './overlays';
import {
  JALALI_MONTH_KEYS,
  JALALI_WEEKDAY_KEYS,
  dayNumberOfDate,
  dayNumberToGregorian,
  dayNumberToJalali,
  plainDigits,
  formatIsoDay,
  formatTime,
  gregorianToDayNumber,
  jalaliMonthLength,
  jalaliToDayNumber,
  latinDigits,
  parseIsoDay,
  parseTime,
  weekdayOf,
} from './jalali';

/**
 * The Jalali date / date-time / time field (W1.1) — replaces every native `type="date"`,
 * `type="datetime-local"` and `type="time"` input in the admin.
 *
 * VALUE CONTRACT (unchanged from the native inputs it replaces — the server receives exactly
 * what it received before): `YYYY-MM-DD` for `date`, `YYYY-MM-DDTHH:MM` for `datetime`,
 * `HH:MM` for `time`, and `''` for "no value". Only display and picking are Jalali.
 *
 * The trigger is a button («۲۴ مهر ۱۴۰۵», «۲۴ مهر ۱۴۰۵ — ۲۳:۳۴», or the placeholder) that a
 * `<label htmlFor={id}>` names. It opens a calendar popover in a portal (so no Drawer, Modal or
 * scrolling card clips it), placed under the trigger by CSS anchor positioning — under
 * `style-src 'self'` nothing may be positioned by a computed coordinate — and centred on the
 * screen where a browser has no anchor positioning; a bottom sheet on a phone. The popover is a focus trap (`useFocusTrap`): Escape closes it and focus returns to
 * the trigger. Days move with the arrow keys as they read in RTL (← is the next day), Enter
 * picks.
 *
 * Tests drive it ONLY through `setDateField` in `tests/web/ui-helpers.ts`.
 */
export type DateFieldMode = 'date' | 'datetime' | 'time';

export interface DateFieldProps {
  /** The trigger's DOM id, so a `<Field htmlFor>` label names it. */
  id?: string;
  mode?: DateFieldMode;
  value: string;
  onChange: (value: string) => void;
  /** Same format as `value`. */
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  /** Accessible name when no `<label htmlFor>` points at `id`. */
  label?: string;
  describedBy?: string;
  invalid?: boolean;
  /** Draws the compact (toolbar) size. */
  size?: 'md' | 'sm';
}

interface Parts {
  /** The day as a Julian Day Number, or null. */
  readonly day: number | null;
  readonly time: { h: number; m: number } | null;
}

function partsOf(mode: DateFieldMode, value: string): Parts {
  if (mode === 'time') return { day: null, time: parseTime(value) };
  if (mode === 'datetime') {
    const [day = '', time = ''] = value.split('T');
    const g = parseIsoDay(day);
    const parsed = parseTime(time.slice(0, 5));
    return g === null || parsed === null
      ? { day: null, time: null }
      : { day: gregorianToDayNumber(g), time: parsed };
  }
  const g = parseIsoDay(value);
  return { day: g === null ? null : gregorianToDayNumber(g), time: null };
}

/** A day number as the field shows it: day, Persian month name, year, in Persian digits. */
export function jalaliDayLabel(day: number): string {
  const j = dayNumberToJalali(day);
  return `${plainDigits(j.jd)} ${t(JALALI_MONTH_KEYS[j.jm - 1] ?? 'web.jalali_m1')} ${plainDigits(j.jy)}`;
}

/**
 * A wire value as the field shows it, or null when it is empty or not a value of `mode`.
 * Pages use it to describe an applied date filter (a chip reads «از: ۲۴ مهر ۱۴۰۵»).
 */
export function formatDateFieldValue(mode: DateFieldMode, value: string): string | null {
  const parts = partsOf(mode, value);
  if (mode === 'time') return parts.time === null ? null : plainDigits(formatTime(parts.time));
  if (parts.day === null) return null;
  const day = jalaliDayLabel(parts.day);
  return mode === 'datetime' && parts.time !== null
    ? `${day} — ${plainDigits(formatTime(parts.time))}`
    : day;
}

function dayOfBound(mode: DateFieldMode, bound: string | undefined): number | null {
  if (bound === undefined || bound === '' || mode === 'time') return null;
  const g = parseIsoDay(bound.slice(0, 10));
  return g === null ? null : gregorianToDayNumber(g);
}

function placeholderOf(mode: DateFieldMode): string {
  if (mode === 'time') return t('web.date_pick_time');
  if (mode === 'datetime') return t('web.date_pick_datetime');
  return t('web.date_pick');
}

export function DateField({
  id,
  mode = 'date',
  value,
  onChange,
  min,
  max,
  disabled = false,
  required = false,
  label,
  describedBy,
  invalid = false,
  size = 'md',
}: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const valueId = useId();
  const popoverId = useId();
  const shown = formatDateFieldValue(mode, value);

  const layer = useLayer(open, () => setOpen(false));

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };

  const described = [valueId, describedBy].filter((part) => part !== undefined).join(' ');

  return (
    <span
      ref={layer.inside}
      className={`date-field${size === 'sm' ? ' sm' : ''}${open ? ' open' : ''}`}
      data-date-field-wrap={mode}
    >
      <button
        ref={trigger}
        type="button"
        className={`input date-field-btn${size === 'sm' ? ' sm' : ''}`}
        data-date-field={mode}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-describedby={described}
        disabled={disabled}
        onClick={() => {
          if (!open) trigger.current?.focus();
          setOpen(!open);
        }}
        {...(open ? { 'aria-controls': popoverId } : {})}
        {...(id === undefined ? {} : { id })}
        {...(label === undefined ? {} : { 'aria-label': label })}
        {...(invalid ? { 'aria-invalid': true } : {})}
        {...(required ? { 'aria-required': true } : {})}
      >
        <Icon name={mode === 'time' ? 'clock' : 'calendar'} size={15} />
        <span id={valueId} className={shown === null ? 'date-field-ph' : 'date-field-val'}>
          {shown ?? placeholderOf(mode)}
        </span>
      </button>
      {value !== '' && !disabled && (
        <button
          type="button"
          className="date-field-clear"
          aria-label={t('web.date_clear_field')}
          title={t('web.date_clear_field')}
          onClick={() => {
            onChange('');
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <Icon name="x" size={13} />
        </button>
      )}
      {open &&
        createPortal(
          <LayerContext.Provider value={layer.registry}>
            <div ref={layer.inside} className="date-pop-layer">
              {/* A phone's bottom sheet dims the page behind it; a tap there closes the
                  picker (PR #285 review, A3). On `click`, not `mousedown`: the backdrop is
                  inside this layer and every layer around it, so a filter panel the field
                  sits in stays open — the press lands on a node still in the DOM. */}
              <div
                className="date-pop-backdrop"
                aria-hidden="true"
                onClick={() => setOpen(false)}
              />
              <DatePopover
                id={popoverId}
                mode={mode}
                value={value}
                min={min}
                max={max}
                onCommit={commit}
                onClose={() => setOpen(false)}
              />
            </div>
          </LayerContext.Provider>,
          document.body,
        )}
    </span>
  );
}

const TIME_MINUTE_STEP = 5;

function DatePopover({
  id,
  mode,
  value,
  min,
  max,
  onCommit,
  onClose,
}: {
  id: string;
  mode: DateFieldMode;
  value: string;
  min: string | undefined;
  max: string | undefined;
  onCommit: (value: string) => void;
  onClose: () => void;
}) {
  const now = useMemo(() => new Date(), []);
  const today = dayNumberOfDate(now);
  const parts = partsOf(mode, value);
  const minDay = dayOfBound(mode, min);
  const maxDay = dayOfBound(mode, max);
  const timed = mode !== 'date';

  const startDay = parts.day ?? today;
  const startJ = dayNumberToJalali(startDay);
  const [view, setView] = useState({ jy: startJ.jy, jm: startJ.jm });
  const [months, setMonths] = useState(false);
  const [focusDay, setFocusDay] = useState(startDay);
  const [selected, setSelected] = useState<number | null>(parts.day);
  const [time, setTime] = useState(parts.time ?? { h: now.getHours(), m: now.getMinutes() });
  const [hourText, setHourText] = useState<string | null>(null);
  const [minuteText, setMinuteText] = useState<string | null>(null);

  const ref = useRef<HTMLDivElement>(null);
  const initial = useRef<HTMLElement | null>(null);
  const focusAfterMove = useRef(false);
  useFocusTrap(ref, true, onClose, initial);

  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    ref.current?.querySelector<HTMLElement>('[data-focus-day="true"]')?.focus();
  });

  const outOfRange = (day: number) =>
    (minDay !== null && day < minDay) || (maxDay !== null && day > maxDay);

  const candidate = (): string | null => {
    if (mode === 'time') return formatTime(time);
    if (selected === null) return null;
    return `${formatIsoDay(dayNumberToGregorian(selected))}T${formatTime(time)}`;
  };
  const candidateAllowed = (next: string | null): boolean => {
    if (next === null) return false;
    if (min !== undefined && min !== '' && next < min) return false;
    if (max !== undefined && max !== '' && next > max) return false;
    return true;
  };

  const pick = (day: number) => {
    if (outOfRange(day)) return;
    if (timed) {
      setSelected(day);
      setFocusDay(day);
      return;
    }
    onCommit(formatIsoDay(dayNumberToGregorian(day)));
  };

  const moveFocus = (day: number) => {
    const j = dayNumberToJalali(day);
    setView({ jy: j.jy, jm: j.jm });
    setFocusDay(day);
    focusAfterMove.current = true;
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // RTL: the next day sits to the LEFT.
    const steps: Record<string, number> = {
      ArrowLeft: 1,
      ArrowRight: -1,
      ArrowDown: 7,
      ArrowUp: -7,
    };
    const step = steps[event.key];
    if (step !== undefined) {
      event.preventDefault();
      moveFocus(focusDay + step);
      return;
    }
    if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      const j = dayNumberToJalali(focusDay);
      let { jy, jm } = j;
      jm += event.key === 'PageDown' ? 1 : -1;
      if (jm > 12) [jy, jm] = [jy + 1, 1];
      if (jm < 1) [jy, jm] = [jy - 1, 12];
      moveFocus(jalaliToDayNumber({ jy, jm, jd: Math.min(j.jd, jalaliMonthLength(jy, jm)) }));
    }
  };

  const shiftMonth = (delta: number) => {
    let { jy, jm } = view;
    jm += delta;
    if (jm > 12) [jy, jm] = [jy + 1, 1];
    if (jm < 1) [jy, jm] = [jy - 1, 12];
    setView({ jy, jm });
    const length = jalaliMonthLength(jy, jm);
    const jd = Math.min(dayNumberToJalali(focusDay).jd, length);
    setFocusDay(jalaliToDayNumber({ jy, jm, jd }));
  };

  const readTyped = (text: string, limit: number): number | null => {
    const digits = latinDigits(text).replace(/\D/gu, '');
    if (digits === '') return null;
    const n = Number(digits);
    return n >= 0 && n <= limit ? n : null;
  };

  const confirm = () => {
    const next = candidate();
    if (candidateAllowed(next) && next !== null) onCommit(next);
  };

  const timeQuick: readonly { key: string; label: string; apply: () => void }[] =
    mode === 'time'
      ? [
          {
            key: 'now',
            label: t('web.date_now'),
            apply: () => setTime({ h: now.getHours(), m: now.getMinutes() }),
          },
          { key: '9', label: t('web.date_9am'), apply: () => setTime({ h: 9, m: 0 }) },
          { key: '12', label: t('web.date_noon'), apply: () => setTime({ h: 12, m: 0 }) },
          { key: '18', label: t('web.date_6pm'), apply: () => setTime({ h: 18, m: 0 }) },
        ]
      : [
          {
            key: 'now',
            label: t('web.date_now'),
            apply: () => {
              setTime({ h: now.getHours(), m: now.getMinutes() });
              setSelected(today);
              moveView(today);
            },
          },
          {
            key: 'h1',
            label: t('web.date_in_one_hour'),
            apply: () => {
              const later = new Date(now.getTime() + 3_600_000);
              const day = dayNumberOfDate(later);
              setTime({ h: later.getHours(), m: later.getMinutes() });
              setSelected(day);
              moveView(day);
            },
          },
          {
            key: 'tm10',
            label: t('web.date_tomorrow_10'),
            apply: () => {
              setTime({ h: 10, m: 0 });
              setSelected(today + 1);
              moveView(today + 1);
            },
          },
        ];

  function moveView(day: number) {
    const j = dayNumberToJalali(day);
    setView({ jy: j.jy, jm: j.jm });
    setFocusDay(day);
  }

  const timeBlock = timed && (
    <div className="date-pop-time">
      <span className="date-pop-time-label" aria-hidden="true">
        {t('web.date_time')}
      </span>
      <div className="date-pop-time-fields">
        <TimeUnit
          label={t('web.date_hour')}
          up={t('web.date_hour_up')}
          down={t('web.date_hour_down')}
          text={hourText ?? plainDigits(String(time.h).padStart(2, '0'))}
          onText={(text) => {
            setHourText(text);
            const n = readTyped(text, 23);
            if (n !== null) setTime((current) => ({ ...current, h: n }));
          }}
          onBlur={() => setHourText(null)}
          onStep={(delta) => {
            setHourText(null);
            setTime((current) => ({ ...current, h: (current.h + delta + 24) % 24 }));
          }}
          onEnter={confirm}
          refFor={mode === 'time' ? initial : undefined}
        />
        <b className="date-pop-colon" aria-hidden="true">
          :
        </b>
        <TimeUnit
          label={t('web.date_minute')}
          up={t('web.date_minute_up')}
          down={t('web.date_minute_down')}
          text={minuteText ?? plainDigits(String(time.m).padStart(2, '0'))}
          onText={(text) => {
            setMinuteText(text);
            const n = readTyped(text, 59);
            if (n !== null) setTime((current) => ({ ...current, m: n }));
          }}
          onBlur={() => setMinuteText(null)}
          onStep={(delta) => {
            setMinuteText(null);
            setTime((current) => ({
              ...current,
              m: (current.m + delta * TIME_MINUTE_STEP + 60) % 60,
            }));
          }}
          onEnter={confirm}
          refFor={undefined}
        />
      </div>
    </div>
  );

  const quickRow = timed ? (
    <div className="date-pop-quick">
      {timeQuick.map((quick) => (
        <button key={quick.key} type="button" className="date-pop-q" onClick={quick.apply}>
          {quick.label}
        </button>
      ))}
    </div>
  ) : (
    <div className="date-pop-quick">
      {(
        [
          ['today', t('web.date_today'), 0],
          ['yesterday', t('web.date_yesterday'), -1],
          ['7', t('web.date_7_days_ago'), -7],
          ['30', t('web.date_30_days_ago'), -30],
        ] as const
      ).map(([key, text, offset]) => (
        <button
          key={key}
          type="button"
          className="date-pop-q"
          disabled={outOfRange(today + offset)}
          onClick={() => pick(today + offset)}
        >
          {text}
        </button>
      ))}
    </div>
  );

  const committed = candidate();
  const confirmButton = timed && (
    <button
      type="button"
      className="btn sm primary date-pop-ok"
      disabled={!candidateAllowed(committed)}
      onClick={confirm}
    >
      {t('web.date_confirm')}
    </button>
  );
  const clearButton = value !== '' && (
    <button type="button" className="date-pop-clear" onClick={() => onCommit('')}>
      {t('web.date_clear')}
    </button>
  );

  // The bottom sheet's × (phones only, `ui.css`); Escape and a tap outside close it too.
  const sheetClose = (
    <div className="date-pop-sheet">
      <button
        type="button"
        className="btn ghost icon sm"
        aria-label={t('web.close')}
        title={t('web.close')}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );

  if (mode === 'time') {
    return (
      <div
        ref={ref}
        id={id}
        className="date-pop time-only"
        role="dialog"
        aria-label={t('web.date_pick_time')}
      >
        {sheetClose}
        <div className="date-pop-head">
          <b className="date-pop-only">{t('web.date_pick_time')}</b>
        </div>
        {timeBlock}
        {quickRow}
        <div className="date-pop-foot">
          <span className="muted">{t('web.date_24h')}</span>
          <span className="date-pop-foot-actions">
            {clearButton}
            {confirmButton}
          </span>
        </div>
      </div>
    );
  }

  const shownSelection = timed ? selected : parts.day;
  const gregorian =
    shownSelection === null ? null : formatIsoDay(dayNumberToGregorian(shownSelection));

  return (
    <div
      ref={ref}
      id={id}
      className="date-pop"
      role="dialog"
      aria-label={timed ? t('web.date_pick_datetime') : t('web.date_pick')}
      data-view-year={view.jy}
      data-view-month={view.jm}
    >
      {sheetClose}
      <div className="date-pop-head">
        <button
          type="button"
          className="date-pop-nav"
          data-nav="prev"
          aria-label={months ? t('web.date_prev_year') : t('web.date_prev_month')}
          onClick={() => (months ? setView({ ...view, jy: view.jy - 1 }) : shiftMonth(-1))}
        >
          <Icon name="chevronRight" size={16} />
        </button>
        <button
          type="button"
          className="date-pop-title"
          aria-label={t('web.date_choose_month')}
          aria-expanded={months}
          onClick={() => setMonths(!months)}
        >
          {months ? (
            plainDigits(view.jy)
          ) : (
            <>
              {t(JALALI_MONTH_KEYS[view.jm - 1] ?? 'web.jalali_m1')} <b>{plainDigits(view.jy)}</b>
            </>
          )}
          <Icon name="chevron" size={12} />
        </button>
        <button
          type="button"
          className="date-pop-nav"
          data-nav="next"
          aria-label={months ? t('web.date_next_year') : t('web.date_next_month')}
          onClick={() => (months ? setView({ ...view, jy: view.jy + 1 }) : shiftMonth(1))}
        >
          <Icon name="chevronLeft" size={16} />
        </button>
      </div>

      {months ? (
        <div className="date-pop-months">
          {JALALI_MONTH_KEYS.map((key, index) => (
            <button
              key={key}
              type="button"
              className={`date-pop-m${index + 1 === view.jm ? ' sel' : ''}`}
              data-month={index + 1}
              aria-pressed={index + 1 === view.jm}
              onClick={() => {
                const jm = index + 1;
                setView({ jy: view.jy, jm });
                const jd = Math.min(dayNumberToJalali(focusDay).jd, jalaliMonthLength(view.jy, jm));
                setFocusDay(jalaliToDayNumber({ jy: view.jy, jm, jd }));
                setMonths(false);
              }}
            >
              {t(key)}
            </button>
          ))}
        </div>
      ) : (
        <DayGrid
          view={view}
          today={today}
          selected={shownSelection}
          focusDay={focusDay}
          outOfRange={outOfRange}
          onPick={pick}
          onKeyDown={onGridKey}
          initial={initial}
        />
      )}

      {timeBlock}
      {quickRow}

      <div className="date-pop-foot">
        <span className="muted">
          {gregorian === null ? (
            timed ? (
              t('web.date_pick_day')
            ) : (
              t('web.date_none')
            )
          ) : (
            <>
              {t('web.date_gregorian')}{' '}
              <span dir="ltr" className="date-pop-greg">
                {timed ? `${gregorian} ${formatTime(time)}` : gregorian}
              </span>
            </>
          )}
        </span>
        <span className="date-pop-foot-actions">
          {clearButton}
          {confirmButton}
        </span>
      </div>
    </div>
  );
}

function DayGrid({
  view,
  today,
  selected,
  focusDay,
  outOfRange,
  onPick,
  onKeyDown,
  initial,
}: {
  view: { jy: number; jm: number };
  today: number;
  selected: number | null;
  focusDay: number;
  outOfRange: (day: number) => boolean;
  onPick: (day: number) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  initial: MutableRefObject<HTMLElement | null> | undefined;
}) {
  const first = jalaliToDayNumber({ jy: view.jy, jm: view.jm, jd: 1 });
  const offset = weekdayOf(first);
  const length = jalaliMonthLength(view.jy, view.jm);
  // The roving tab stop: the focused day when it is in this month, else the selected day,
  // else today, else the first.
  const inMonth = (day: number | null) => day !== null && day >= first && day < first + length;
  const stop = inMonth(focusDay)
    ? focusDay
    : inMonth(selected)
      ? (selected as number)
      : inMonth(today)
        ? today
        : first;
  const monthName = t(JALALI_MONTH_KEYS[view.jm - 1] ?? 'web.jalali_m1');
  return (
    <>
      <div className="date-pop-wd" aria-hidden="true">
        {JALALI_WEEKDAY_KEYS.map((key, index) => (
          <span key={key} className={index === 6 ? 'fri' : undefined}>
            {t(key)}
          </span>
        ))}
      </div>
      <div className="date-pop-grid" onKeyDown={onKeyDown}>
        {Array.from({ length: offset }, (_, index) => (
          <span key={`e${index}`} aria-hidden="true" />
        ))}
        {Array.from({ length }, (_, index) => {
          const day = first + index;
          const jd = index + 1;
          const blocked = outOfRange(day);
          const classes = [
            'date-pop-d',
            day === selected && 'sel',
            day === today && 'today',
            (offset + index) % 7 === 6 && 'fri',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <button
              key={day}
              ref={
                day === stop && initial !== undefined
                  ? (node) => void (initial.current = node)
                  : undefined
              }
              type="button"
              className={classes}
              data-day={jd}
              data-focus-day={day === stop}
              tabIndex={day === stop ? 0 : -1}
              aria-label={`${plainDigits(jd)} ${monthName} ${plainDigits(view.jy)}`}
              aria-pressed={day === selected}
              aria-disabled={blocked || undefined}
              {...(day === today ? { 'aria-current': 'date' as const } : {})}
              onClick={() => onPick(day)}
            >
              {plainDigits(jd)}
            </button>
          );
        })}
      </div>
    </>
  );
}

function TimeUnit({
  label,
  up,
  down,
  text,
  onText,
  onBlur,
  onStep,
  onEnter,
  refFor,
}: {
  label: string;
  up: string;
  down: string;
  text: string;
  onText: (text: string) => void;
  onBlur: () => void;
  onStep: (delta: number) => void;
  onEnter: () => void;
  refFor: MutableRefObject<HTMLElement | null> | undefined;
}) {
  return (
    <div className="date-pop-tc">
      <button type="button" className="date-pop-ts" aria-label={up} onClick={() => onStep(1)}>
        <Icon name="arrowUp" size={12} />
      </button>
      <input
        ref={refFor === undefined ? undefined : (node) => void (refFor.current = node)}
        className="date-pop-tin"
        inputMode="numeric"
        maxLength={2}
        aria-label={label}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onBlur={onBlur}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            onStep(1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            onStep(-1);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            onEnter();
          }
        }}
      />
      <button type="button" className="date-pop-ts" aria-label={down} onClick={() => onStep(-1)}>
        <Icon name="arrowDown" size={12} />
      </button>
    </div>
  );
}
