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

function locate(rows: ServiceCardRows, button: ServiceCardButton) {
  for (let r = 0; r < rows.length; r += 1) {
    const c = (rows[r] ?? []).findIndex((entry) => entry.button === button);
    if (c >= 0) return { r, c };
  }
  return null;
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

/** Swap a button with its neighbour in the same row (`delta` -1 earlier, +1 later). */
export function moveServiceCardWithinRow(
  rows: ServiceCardRows,
  button: ServiceCardButton,
  delta: -1 | 1,
): ServiceCardRows {
  const at = locate(rows, button);
  if (at === null) return rows;
  const target = at.c + delta;
  const row = [...(rows[at.r] ?? [])];
  if (target < 0 || target >= row.length) return rows;
  [row[at.c], row[target]] = [row[target] as ServiceCardEntry, row[at.c] as ServiceCardEntry];
  return rows.map((one, index) => (index === at.r ? row : one));
}

/**
 * Move a button to the row above (-1) or below (+1). Into a neighbouring row that has room;
 * past the first or last row it becomes a row of its own, but only if that leaves the row it
 * came from non-empty. A full target row refuses (the same rows come back).
 */
export function moveServiceCardAcrossRows(
  rows: ServiceCardRows,
  button: ServiceCardButton,
  direction: -1 | 1,
): ServiceCardRows {
  const at = locate(rows, button);
  if (at === null) return rows;
  const entry = (rows[at.r] as readonly ServiceCardEntry[])[at.c] as ServiceCardEntry;
  const sourceAlone = (rows[at.r] as readonly ServiceCardEntry[]).length === 1;
  const targetIndex = at.r + direction;
  const without = rows.map((row) => row.filter((one) => one.button !== button));
  if (targetIndex < 0 || targetIndex >= rows.length) {
    if (sourceAlone) return rows;
    const next = [...without];
    if (direction < 0) next.unshift([entry]);
    else next.push([entry]);
    return next;
  }
  const target = without[targetIndex] as readonly ServiceCardEntry[];
  if (target.length >= SERVICE_CARD_ROW_MAX) return rows;
  const merged = [...target];
  if (direction < 0) merged.push(entry);
  else merged.unshift(entry);
  return without
    .map((row, index) => (index === targetIndex ? merged : row))
    .filter((row) => row.length > 0);
}

/** Take a button out of a shared row into a row of its own, just below. */
export function splitServiceCardButton(
  rows: ServiceCardRows,
  button: ServiceCardButton,
): ServiceCardRows {
  const at = locate(rows, button);
  if (at === null) return rows;
  const row = rows[at.r] as readonly ServiceCardEntry[];
  if (row.length === 1) return rows;
  const entry = row[at.c] as ServiceCardEntry;
  const next: (readonly ServiceCardEntry[])[] = [];
  rows.forEach((one, index) => {
    if (index !== at.r) next.push(one);
    else {
      next.push(one.filter((candidate) => candidate.button !== button));
      next.push([entry]);
    }
  });
  return next;
}

/** Swap a whole row with its neighbour. */
export function moveServiceCardRow(
  rows: ServiceCardRows,
  index: number,
  delta: -1 | 1,
): ServiceCardRows {
  const target = index + delta;
  if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return rows;
  const next = [...rows];
  [next[index], next[target]] = [
    next[target] as readonly ServiceCardEntry[],
    next[index] as readonly ServiceCardEntry[],
  ];
  return next;
}
