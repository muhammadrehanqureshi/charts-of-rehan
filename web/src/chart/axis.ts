/**
 * Where the axis writes a date, and where it writes a clock.
 *
 * A packed intraday axis has no calendar distance of its own: the engine picks
 * tick instants by presentation time, and several of them can land on the same
 * bar, or in the middle of one day. Printing the date at every one of those
 * put two "20 Oct" stamps on top of each other, which reads as a broken axis
 * rather than as a session boundary. The rule here is the one the chart needs:
 * a date is printed once, on the bar that opens it.
 */

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

/** The Karachi calendar day of an instant, `YYYY-MM-DD`, or "" if unusable. */
export function karachiDayText(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "";
  }
  return new Date(Math.floor((ms + KARACHI_OFFSET_MS) / DAY_MS) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Does the bar at `index` start a new Karachi date?
 *
 * True for the first bar of the series and for every bar whose predecessor
 * belongs to another date. A bar in the middle of a day is false, so its tick
 * prints a clock instead of repeating the date.
 */
export function opensDay(realMs: ArrayLike<number>, index: number): boolean {
  const day = karachiDayText(realMs[index] ?? Number.NaN);
  if (day.length === 0) {
    return false;
  }
  if (index <= 0) {
    return true;
  }
  // An unknown predecessor cannot contradict the day, so the day is named.
  return karachiDayText(realMs[index - 1] ?? Number.NaN) !== day;
}
