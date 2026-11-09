/**
 * Session boundaries inside one chart, decided once for every timeframe.
 *
 * A chart that merges several days packs the sessions edge to edge: Friday's
 * 11:59 is followed by Friday's 14:32 with nothing between them, and a
 * Thursday's 15:29 is followed by the next Monday's 09:32. Read without a
 * break that looks like a clock running backwards, so the renderer draws a
 * dashed rule wherever the exchange's session changes.
 *
 * PSX does not have one shape per date. Monday to Thursday trade one band;
 * Friday trades two, with the exchange's own midday break between them. The
 * canonical statement of those hours is `src/data/sessions.py`, and the server
 * already sends resolved session facts in every payload. This module therefore
 * accepts a `SessionSchedule` built from the service's own session list, so a
 * changed exchange hour reaches the drawing code as data rather than as a
 * second copy of the table. The weekday constants below are the fallback for a
 * payload from a service that does not send one, and they mirror the same
 * schedule:
 * https://www.psx.com.pk/psx/exchange/general/trading-hours
 *
 * Two properties matter for visual consistency across the ladder:
 *
 *  - **One policy table.** Every rung declares whether it carries intraday
 *    session rules and whether it may carry daily EOD rows. A `Record` over
 *    the `Resolution` union means a new rung cannot compile without an
 *    answer, so no rung silently renders with a different rule set.
 *  - **One rule.** A rule is drawn wherever `(Karachi day, session band)`
 *    changes, for every intraday rung. Band membership is computed from
 *    integer day and minute arithmetic, so the pass allocates nothing per bar
 *    while a long history is being replayed.
 */

import type { Resolution } from "../api/types";

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;

const dayLabelFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
});

/** A band is [open, close) in minutes after midnight, Karachi time. */
export type SessionBand = readonly [open: number, close: number];

const WEEKDAY_OPEN = 9 * 60 + 32;
const WEEKDAY_CLOSE = 15 * 60 + 30;
const FRIDAY_OPEN = 9 * 60 + 17;
const FRIDAY_FIRST_CLOSE = 12 * 60;
const FRIDAY_SECOND_OPEN = 14 * 60 + 32;
const FRIDAY_CLOSE = 16 * 60 + 30;

const WEEKDAY_BANDS: readonly SessionBand[] = [[WEEKDAY_OPEN, WEEKDAY_CLOSE]];
const FRIDAY_BANDS: readonly SessionBand[] = [
  [FRIDAY_OPEN, FRIDAY_FIRST_CLOSE],
  [FRIDAY_SECOND_OPEN, FRIDAY_CLOSE],
];

/** What the renderer must know about one rung before drawing it. */
export interface RungPolicy {
  /** Does a change of trading session draw a rule on this rung? */
  readonly breaks: boolean;
  /**
   * May this rung carry daily EOD rows (stamped Karachi noon) behind its
   * recorded sessions? Those rows are calendar history, not intraday bars, so
   * on these rungs they are excluded from the session-rule pass. On the
   * minute and second rungs the flag is false, which matters: noon is a real
   * intraday bar there and must not be discarded.
   */
  readonly calendarGrain: boolean;
}

/**
 * Every rung's policy, in one exhaustive table.
 *
 * Calendar rungs get no intraday rules: a daily, weekly or monthly candle
 * already is a whole session, so an open/close rule through it would be a lie
 * about its grain.
 */
export const RUNG_POLICY: Readonly<Record<Resolution, RungPolicy>> = {
  // Every intraday rung carries the daily history behind its recorded
  // sessions. The purpose of this chart is ten years at any timeframe, and a
  // one-minute or five-minute view that stopped at the first recorded session
  // while the hourly view carried the decade was the hole in that promise.
  "1s": { breaks: true, calendarGrain: true },
  "10s": { breaks: true, calendarGrain: true },
  "1m": { breaks: true, calendarGrain: true },
  "5m": { breaks: true, calendarGrain: true },
  "10m": { breaks: true, calendarGrain: true },
  "15m": { breaks: true, calendarGrain: true },
  "30m": { breaks: true, calendarGrain: true },
  "1h": { breaks: true, calendarGrain: true },
  "4h": { breaks: true, calendarGrain: true },
  "1D": { breaks: false, calendarGrain: false },
  "1d": { breaks: false, calendarGrain: false },
  session: { breaks: false, calendarGrain: false },
  "1W": { breaks: false, calendarGrain: false },
  "1M": { breaks: false, calendarGrain: false },
};

export function hasSessionBreaks(resolution: Resolution): boolean {
  return RUNG_POLICY[resolution]?.breaks ?? false;
}

export function hasDailyBackfill(resolution: Resolution): boolean {
  return RUNG_POLICY[resolution]?.calendarGrain ?? false;
}

/** One session day as the service states it: a date and its trading bands. */
export interface ScheduledDay {
  readonly day: string;
  readonly bands: readonly { readonly open: string; readonly close: string }[];
}

/**
 * The bands each day actually traded, converted once for cheap lookups.
 *
 * Keyed by Karachi day *number* rather than by date string, because the
 * renderer asks this question once per bar and a string key would allocate a
 * date per bar. A day absent from the table falls back to the weekday mirror,
 * so a partial schedule degrades rather than deleting rules.
 */
export interface SessionSchedule {
  readonly byDay: ReadonlyMap<number, readonly SessionBand[]>;
}

/** Parse "HH:MM" to minutes after midnight; NaN when it is not a clock. */
function parseClock(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) {
    return Number.NaN;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)
      || hour < 0 || hour > 24 || minute < 0 || minute > 59) {
    return Number.NaN;
  }
  return hour * 60 + minute;
}

/**
 * Build a schedule from the service's own session rows.
 *
 * A malformed day or band is skipped rather than guessed at: the fallback
 * table then describes that day, which is the same answer a service with no
 * schedule would give.
 */
export function scheduleFrom(
  rows: readonly ScheduledDay[],
): SessionSchedule {
  const byDay = new Map<number, readonly SessionBand[]>();
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || row.bands.length === 0) {
      continue;
    }
    // `dayNumber` counts Karachi days, and a date's UTC midnight is the same
    // integer: the schedule is keyed exactly the way a bar asks for it, with
    // no offset arithmetic of its own to get wrong.
    const dayStart = Date.parse(`${row.day}T00:00:00Z`);
    if (!Number.isFinite(dayStart)) {
      continue;
    }
    const bands: SessionBand[] = [];
    for (const band of row.bands) {
      const open = parseClock(band.open);
      const close = parseClock(band.close);
      if (Number.isFinite(open) && Number.isFinite(close) && close > open) {
        bands.push([open, close]);
      }
    }
    if (bands.length > 0) {
      byDay.set(Math.floor(dayStart / DAY_MS), bands);
    }
  }
  return { byDay };
}

export interface SessionBreak {
  /** Epoch milliseconds of the session's first bar. */
  readonly t: number;
  /** The day as the tape labels it, e.g. "23 Oct". */
  readonly label: string;
  /** The ISO day in Karachi, e.g. "2026-10-23". */
  readonly day: string;
  /** True for the first bar of the series (no line is drawn there). */
  readonly first: boolean;
  /** The last bar before this session, when the series holds one. */
  readonly previous?: number | undefined;
}

/** Whole Karachi days since the epoch; the identity of a session date. */
function dayNumber(ms: number): number {
  return Math.floor((ms + KARACHI_OFFSET_MS) / DAY_MS);
}

/** The `YYYY-MM-DD` Karachi date of a day number. */
function dayText(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Minutes after Karachi midnight, 0 to 1439. */
function minuteOfDay(ms: number): number {
  return Math.floor(((ms + KARACHI_OFFSET_MS) % DAY_MS) / MINUTE_MS);
}

/** 0 = Sunday, matching `Date#getUTCDay`, without allocating a Date. */
function weekdayOf(day: number): number {
  return (((day % 7) + 4) % 7);
}

/**
 * A daily EOD bar is stamped at Karachi noon, which is 07:00 UTC. It is a
 * calendar row, not an intraday session bar. The exchange's clock has no DST,
 * so the conversion is integer arithmetic and never touches a Date.
 */
export function isDailyGrainStamp(ms: number): boolean {
  if (!Number.isFinite(ms)) {
    return false;
  }
  const local = ms + KARACHI_OFFSET_MS;
  return local % MINUTE_MS === 0
    && Math.floor(local / MINUTE_MS) % MINUTES_PER_DAY === 12 * 60;
}

/**
 * True when a stamp belongs to this rung's own intraday tape.
 *
 * On the coarse rungs the service prepends one daily EOD row per trading day,
 * stamped at noon. Those rows are a calendar series wearing an intraday
 * resolution, so they are excluded there. On a 1m chart noon is a real bar
 * and is kept.
 */
export function isIntradayStamp(ms: number, resolution: Resolution): boolean {
  if (!Number.isFinite(ms)) {
    return false;
  }
  return !hasDailyBackfill(resolution) || !isDailyGrainStamp(ms);
}

/** The stamps that belong to this rung's real intraday sessions. */
export function intradayStamps(
  times: ArrayLike<number>,
  resolution: Resolution,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t !== undefined && isIntradayStamp(t, resolution)) {
      out.push(t);
    }
  }
  return out;
}

/** The bands in force on one Karachi day, or undefined outside the week. */
function bandsFor(
  day: number,
  schedule?: SessionSchedule,
): readonly SessionBand[] | undefined {
  const scheduled = schedule?.byDay.get(day);
  if (scheduled !== undefined && scheduled.length > 0) {
    return scheduled;
  }
  const weekday = weekdayOf(day);
  if (weekday >= 1 && weekday <= 5) {
    return weekday === 5 ? FRIDAY_BANDS : WEEKDAY_BANDS;
  }
  return undefined;
}

/**
 * The session slot a Karachi instant belongs to: day number plus band, packed
 * into one integer so the hot loop compares numbers instead of strings.
 *
 * A real band owns its instant. Bars just outside a band (a pre-open print or
 * a post-close one) are attached to the nearest band of that day so they do
 * not invent a boundary of their own. Friday's lunch belongs to the first
 * band: the break is then the move into the 14:32 band, not a second edge
 * inside the lunch.
 */
function slotId(ms: number, schedule?: SessionSchedule): number {
  const day = dayNumber(ms);
  const bands = bandsFor(day, schedule);
  const minute = minuteOfDay(ms);
  let band = -1;
  if (bands !== undefined) {
    band = bands.findIndex(([open, close]) => minute >= open && minute < close);
    if (band < 0) {
      if (minute < (bands[0]?.[0] ?? 0)) {
        band = 0;
      } else {
        // The nearest preceding band: the Friday lunch attaches to the
        // morning, and an after-close print attaches to the last band.
        band = bands.length - 1;
        for (let index = 0; index < bands.length; index += 1) {
          if (minute >= (bands[index]?.[0] ?? 0)) {
            band = index;
          }
        }
      }
    }
  }
  // 1024 leaves room for every band a session could plausibly have without
  // the packed key colliding across days, and stays inside exact integers.
  return day * 1024 + band + 1;
}

/**
 * One rule per Karachi trading date, in bar order.
 *
 * This is the chart's session division: every candle from 06 Nov belongs to
 * 06 Nov, even on a Friday whose two official bands are separated by lunch.
 * A band change is a time gap inside the day, not a new day, and must never
 * leave one date in two pieces of two or three candles.
 *
 * Daily-grain backfill rows are skipped as boundaries but still advance
 * `previous`, so the rule before a real session sits after the last backfill
 * row rather than halfway across it. `first: true` means there is no bar at
 * all before this date; when calendar rows precede the tape, the first real
 * date still earns its rule, because the daily block before it is a different
 * grain and the join must be visible.
 */
export function dayBreaks(
  times: ArrayLike<number>,
  resolution: Resolution,
): SessionBreak[] {
  if (!hasSessionBreaks(resolution)) {
    return [];
  }
  const out: SessionBreak[] = [];
  let lastDay = Number.NaN;
  let previous: number | undefined;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t === undefined || !Number.isFinite(t)) {
      continue;
    }
    // A backfill row belongs to the previous date's edge, but it is not a
    // candle in the new date's session and must not create a rule itself.
    if (!isIntradayStamp(t, resolution)) {
      previous = t;
      continue;
    }
    const day = dayNumber(t);
    if (day === lastDay) {
      previous = t;
      continue;
    }
    out.push({
      t,
      day: dayText(day),
      label: dayLabelFormat.format(new Date(t)),
      first: out.length === 0 && previous === undefined,
      ...(previous !== undefined ? { previous } : {}),
    });
    lastDay = day;
    previous = t;
  }
  return out;
}

/**
 * Every band change in a series, in bar order.
 *
 * Kept for callers that need Friday's lunch as a separate intraday session;
 * the chart uses `dayBreaks` because the owner's division is the date. A
 * band change is not a new date, and must not split a Friday into 3+2 bars.
 * The first intraday session is still returned (with `first: true`) so
 * callers can anchor it, but the renderer does not draw a rule before the
 * series begins.
 *
 * The rung's own policy is applied here, not by the caller: a calendar rung
 * yields no intraday rules even if a caller forgets to ask, which is the
 * whole point of keeping the policy in one table.
 */
export function sessionBreaks(
  times: ArrayLike<number>,
  resolution: Resolution,
  schedule?: SessionSchedule,
): SessionBreak[] {
  if (!hasSessionBreaks(resolution)) {
    return [];
  }
  const out: SessionBreak[] = [];
  let lastSlot = Number.NaN;
  let previous: number | undefined;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t === undefined || !isIntradayStamp(t, resolution)) {
      continue;
    }
    const slot = slotId(t, schedule);
    if (slot === lastSlot) {
      previous = t;
      continue;
    }
    out.push({
      t,
      day: dayText(dayNumber(t)),
      label: dayLabelFormat.format(new Date(t)),
      first: out.length === 0,
      ...(previous !== undefined ? { previous } : {}),
    });
    lastSlot = slot;
    previous = t;
  }
  return out;
}

/**
 * Day boundaries across the daily-grain history behind a coarse rung.
 *
 * A 10m/15m/30m/1h/4h chart carries daily rows where the recorder has no
 * intraday session. Those rows are whole-day bars, so their only honest
 * break is at the day they open. Keep every day as a candidate: the paint
 * plan collapses crowded candidates to the first day of each month, and
 * keeps every day when the reader has zoomed in far enough to read them.
 * This is what puts a rule between 4, 5 and 6 Nov when those days are daily
 * backfill rather than real sessions. Real intraday sessions still get every
 * session rule from `sessionBreaks`.
 */
export function calendarBreaks(times: ArrayLike<number>): SessionBreak[] {
  const out: SessionBreak[] = [];
  let lastDay = "";
  let previous: number | undefined;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t === undefined) {
      continue;
    }
    if (!isDailyGrainStamp(t)) {
      // A real intraday bar is the candle immediately before the next
      // backfill day. The rule belongs between those two candles, not
      // between the new day and the last daily row before the session.
      previous = t;
      continue;
    }
    const day = dayText(dayNumber(t));
    if (day === lastDay) {
      previous = t;
      continue;
    }
    out.push({
      t,
      day,
      label: dayLabelFormat.format(new Date(t)),
      first: out.length === 0,
      ...(previous !== undefined ? { previous } : {}),
    });
    lastDay = day;
    previous = t;
  }
  return out;
}
