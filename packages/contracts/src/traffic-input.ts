/**
 * Traffic as a person types it: gigabytes, with at most two decimal places (WP21).
 *
 * The owner's rule is that every human-editable traffic amount is entered in GB. What is
 * STORED does not change: a traffic allowance is integer bytes (`bigint`) in the database,
 * in every domain type and on the way to a provider, exactly as `catalog.ts` says. This
 * module is the one conversion between the two, used by the HTTP boundary and by the Web
 * Admin form alike, so the figure an operator types and the bytes a panel receives cannot
 * be converted two different ways.
 *
 * One GB here is the binary gigabyte this codebase has always shown — 1 GiB,
 * 1,073,741,824 bytes — because `BYTE_FACTOR` in `catalog.ts` already renders 53687091200
 * as «50 گیگابایت», and a form that meant 10^9 would store a different number than the
 * list beside it displays.
 *
 * No floating point anywhere. `0.01 * 1073741824` is not a JavaScript number anyone
 * should trust at eight-digit scales, so the text is split into its whole part and its
 * hundredths and multiplied as `bigint`.
 */

/** Bytes in one GB as this codebase displays it: a gibibyte. */
export const BYTES_PER_GB = 1_073_741_824n;

/** At most two decimal places: 1, 1.5, 1.50, 10.25, 0.01. */
export const TRAFFIC_GB_MAX_DECIMALS = 2;

/**
 * Digits, an optional point and one or two more digits — and nothing else.
 *
 * Deliberately narrow. It refuses a sign (`-1`, `+1`), an exponent (`1e3`), a leading
 * or trailing point (`.5`, `1.`), a comma in either role (`1,5`, `1,000`), whitespace
 * inside the figure, and digits outside ASCII. Each of those is a figure two readers
 * could take two ways, and an allowance someone pays for is not the place to guess. A
 * redundant leading zero (`01`) is refused for the same reason.
 */
export const TRAFFIC_GB_PATTERN = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,2})?$/u;

/**
 * The typed figure as bytes, rounded to the nearest byte, or null when it is not a
 * figure `TRAFFIC_GB_PATTERN` admits.
 *
 * A hundredth of a GiB is 10,737,418.24 bytes, so a figure with decimals is rarely a
 * whole number of bytes; it is rounded to the NEAREST byte, half up. (With 1 GiB ending
 * in …24, no hundredth lands exactly on a half, so half-up is a statement of the rule
 * rather than a case that occurs — but it is the rule.) Surrounding whitespace is
 * trimmed; nothing else is forgiven. Zero parses to zero bytes — what zero MEANS is the
 * caller's decision, and no caller here reads it as "unlimited".
 */
export function parseTrafficGb(text: string): bigint | null {
  const match = TRAFFIC_GB_PATTERN.exec(text.trim());
  if (match === null) return null;
  const whole = BigInt(match[1] ?? '0');
  const decimals = (match[2] ?? '.').slice(1).padEnd(TRAFFIC_GB_MAX_DECIMALS, '0');
  const hundredths = whole * 100n + BigInt(decimals);
  return (hundredths * BYTES_PER_GB + 50n) / 100n;
}

/**
 * A byte count as the GB figure an edit form shows: at most two decimal places, rounded
 * to the nearest hundredth, trailing zeros dropped — 11005853696 is `10.25`, 1610612736
 * is `1.5`, 1073741824 is `1`.
 *
 * The inverse of `parseTrafficGb` for every figure it produces: a saved `10.25` reopens
 * as `10.25`. A historical byte count that is not a whole number of hundredths is shown
 * at its nearest hundredth; `trafficBytesAfterEdit` is what stops that rounding from
 * rewriting the stored value when the operator did not touch it.
 */
export function formatTrafficGb(bytes: bigint): string {
  const magnitude = bytes < 0n ? -bytes : bytes;
  const hundredths = (magnitude * 100n + BYTES_PER_GB / 2n) / BYTES_PER_GB;
  const whole = hundredths / 100n;
  const fraction = hundredths % 100n;
  const text =
    fraction === 0n
      ? whole.toString()
      : `${whole.toString()}.${fraction.toString().padStart(2, '0').replace(/0$/u, '')}`;
  return bytes < 0n ? `-${text}` : text;
}

/**
 * The bytes an edit should store, given what is stored and what was submitted.
 *
 * An edit form shows a stored allowance at its nearest hundredth of a GB. A value stored
 * before WP21 in raw bytes — 1,000,000,000, say — shows as `0.93`, and saving the form
 * unchanged would otherwise quietly rewrite it to 0.93 GiB, 998,579,896 bytes: a change
 * nobody asked for, made by an edit to the title. So when the submitted figure is the
 * one the form displayed for the stored bytes, the stored bytes are kept; any other
 * figure is what the operator typed, and it is stored.
 */
export function trafficBytesAfterEdit(stored: bigint, submitted: bigint): bigint {
  // Zero is its own answer on either side: a tiny stored figure that DISPLAYS as `0` must
  // not survive an edit to zero (unlimited on a product), and zero is never kept over a
  // figure the operator typed.
  if ((stored === 0n) !== (submitted === 0n)) return submitted;
  return formatTrafficGb(stored) === formatTrafficGb(submitted) ? stored : submitted;
}
