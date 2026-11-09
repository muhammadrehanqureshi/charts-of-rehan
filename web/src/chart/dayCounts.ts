/**
 * How many candles each Karachi date holds on this chart.
 *
 * The chart's own division is the date (see `dayBreaks`), so the number worth
 * reading beside the series is the candle count per date: five on a Friday
 * whose lunch sits inside the block, six on a Monday, one on a date that only
 * carries the daily backfill row. Showing the newest few and naming how many
 * older dates were left out keeps a decade of daily backfill to one backward
 * pass and a handful of objects instead of four hundred labels.
 */

import type { Bar } from "../api/types";

export interface DayCount {
  /** The Karachi date, `YYYY-MM-DD`. */
  readonly day: string;
  /** The same date as the strip writes it, e.g. `23 Oct`. */
  readonly label: string;
  /** Candles in this date's block, fill=flat buckets included. */
  readonly count: number;
  /** How many of those candles are fill=flat placeholders, not trades. */
  readonly synthetic: number;
}

export interface DayCounts {
  /** The newest dates, oldest first, so the list reads like the chart. */
  readonly days: readonly DayCount[];
  /** Distinct dates older than the newest shown, left out of the list. */
  readonly earlierDays: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

const DAY_TEXT = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * The Karachi date a bar is stamped with, or "" when the stamp is unusable.
 *
 * The service stamps each bar in Karachi time with its own offset, so the date
 * is the leading text of the stamp and needs no Date to read.
 */
function dayOf(stamp: string): string {
  const match = DAY_TEXT.exec(stamp);
  return match === null ? "" : `${match[1]}-${match[2]}-${match[3]}`;
}

/** `2026-10-30` as the strip writes it: `30 Oct`. */
export function dayLabel(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1];
  return month === undefined ? day : `${day.slice(8, 10)} ${month}`;
}

/**
 * Count the candles per Karachi date, keeping the newest `keep` dates.
 *
 * Bars arrive oldest first, so one pass from the end groups them without a
 * map: the first date met is the newest, and every change of date after the
 * kept window only increments the count of earlier days.
 */
export function perDayCounts(
  bars: readonly Bar[],
  keep = 6,
): DayCounts {
  const limit = Math.max(0, Math.floor(keep));
  const seen: { day: string; count: number; synthetic: number }[] = [];
  let earlierDays = 0;
  let current = "";
  // The slot the bar being read belongs to; -1 once the kept window is full,
  // where the pass only counts dates, not candles.
  let index = -1;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    const bar = bars[i];
    if (bar === undefined) {
      continue;
    }
    const day = dayOf(bar.t);
    if (day.length === 0) {
      continue;
    }
    if (day !== current) {
      current = day;
      if (seen.length < limit) {
        seen.push({ day, count: 0, synthetic: 0 });
        index = seen.length - 1;
      } else {
        earlierDays += 1;
        index = -1;
      }
    }
    if (index < 0) {
      continue;
    }
    const entry = seen[index];
    if (entry === undefined) {
      continue;
    }
    entry.count += 1;
    if (bar.synthetic === true) {
      entry.synthetic += 1;
    }
  }
  const days: DayCount[] = [];
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const entry = seen[i];
    if (entry === undefined) {
      continue;
    }
    days.push({
      day: entry.day,
      label: dayLabel(entry.day),
      count: entry.count,
      synthetic: entry.synthetic,
    });
  }
  return { days, earlierDays };
}
