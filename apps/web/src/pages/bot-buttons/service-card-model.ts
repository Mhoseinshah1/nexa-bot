import {
  DEFAULT_SERVICE_CARD_ROWS,
  SERVICE_CARD_ROW_MAX,
  type ServiceCardButton,
  type ServiceCardEntry,
} from '@nexa/contracts';

/**
 * R8-C3: the service screen's layout as the editor holds it. Pure functions over rows of
 * entries, so every rule the editor enforces (one to three to a row, each button once, no
 * empty row) is testable without a page. The server's schema is the authority; this only
 * stops the editor from producing a value it would refuse.
 */
export type ServiceCardRows = readonly (readonly ServiceCardEntry[])[];

/** The arrangement the bot draws when nothing is saved, every button on. */
export function defaultServiceCardRows(): ServiceCardRows {
  return DEFAULT_SERVICE_CARD_ROWS.map((row) => row.map((button) => ({ button, enabled: true })));
}

/**
 * The rows to edit: the saved ones, then every button they do not name in its usual
 * grouping. That is exactly where the bot draws an unnamed button, so the editor shows what
 * a customer gets, and a save names every button.
 */
export function effectiveServiceCardRows(saved: ServiceCardRows): ServiceCardRows {
  if (saved.length === 0) return defaultServiceCardRows();
  const named = new Set(saved.flat().map((entry) => entry.button));
  const rest = DEFAULT_SERVICE_CARD_ROWS.map((row) =>
    row.filter((button) => !named.has(button)).map((button) => ({ button, enabled: true })),
  ).filter((row) => row.length > 0);
  return [...saved, ...rest];
}

/** Whether the rows are the default arrangement: then nothing needs saving but «as always». */
export function isDefaultServiceCardRows(rows: ServiceCardRows): boolean {
  return JSON.stringify(rows) === JSON.stringify(defaultServiceCardRows());
}

/** The value to store: the default arrangement is stored as the empty layout. */
export function storedServiceCardRows(rows: ServiceCardRows): ServiceCardRows {
  return isDefaultServiceCardRows(rows) ? [] : rows;
}

/** Show or hide one button. */
export function setServiceCardEnabled(
  rows: ServiceCardRows,
  button: ServiceCardButton,
  enabled: boolean,
): ServiceCardRows {
  return rows.map((row) =>
    row.map((entry) => (entry.button === button ? { ...entry, enabled } : entry)),
  );
}

/**
 * The rows as the drag-and-drop layout holds them: the buttons that show, row by row, and the
 * hidden ones as its free box («دکمه‌های حذف‌شده از منو»). A hidden button keeps no place.
 */
export function toDndLayout(rows: ServiceCardRows): {
  readonly rows: string[][];
  readonly free: string[];
} {
  return {
    rows: rows
      .map((row) => row.filter((entry) => entry.enabled).map((entry) => entry.button as string))
      .filter((row) => row.length > 0),
    free: rows.flatMap((row) =>
      row.filter((entry) => !entry.enabled).map((entry) => entry.button as string),
    ),
  };
}

/**
 * The rows to store after a drop: shown buttons in their rows, hidden ones (the free box) in
 * trailing rows of up to three, so every button is named once and each row stays one to
 * three long. `back to list` is not here: the bot always draws it last.
 */
export function fromDndLayout(next: {
  readonly rows: readonly (readonly string[])[];
  readonly free: readonly string[];
}): ServiceCardRows {
  const shown = next.rows
    .filter((row) => row.length > 0)
    .map((row) => row.map((button) => ({ button: button as ServiceCardButton, enabled: true })));
  const hidden: ServiceCardEntry[][] = [];
  next.free.forEach((button, index) => {
    if (index % SERVICE_CARD_ROW_MAX === 0) hidden.push([]);
    hidden[hidden.length - 1]?.push({ button: button as ServiceCardButton, enabled: false });
  });
  return [...shown, ...hidden];
}
