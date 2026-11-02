/**
 * Session boundaries inside one chart.
 *
 * A chart that merges several days packs the sessions edge to edge: Friday's
 * 11:59 is followed by Friday's 14:32 with nothing between them, and a
 * Thursday's 15:29 is followed by the next Monday's 09:32. Read without a
 * break that looks like a clock running backwards, so the renderer draws a
 * dashed rule wherever the exchange's session changes.
 *
 * PSX does not have one shape per date. Monday to Thursday trade one band;
 * Friday trades two, with the exchange's own midday break between them. This
 * module mirrors the schedule in `src/data/sessions.py`, the repository's
 * authority on market phase, and cites the exchange's published hours:
 * https://www.psx.com.pk/psx/exchange/general/trading-hours
 *
 * The functions are pure and timezone-explicit: every key is built from the
 * Karachi date and clock, never the viewer's own zone, so a laptop in another
 * timezone still finds the exchange's sessions.
 */

import type { Resolution } from "../api/types";

const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;

const dayLabelFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
});

/** A band is [open, close) in minutes after midnight, Karachi time. */
type SessionBand = readonly [open: number, close: number];

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

/**
 * Intraday rungs that carry session rules. Calendar rungs are deliberately
 * absent: a daily, weekly or monthly candle already is a whole session, so an
 * intraday open/close rule through it would be a lie about its grain.
 */
const SESSION_BREAK_RUNGS: ReadonlySet<Resolution> = new Set<Resolution>([
  "1s", "10s", "1m", "5m", "10m", "15m", "30m", "1h", "4h",
]);

/**
 * Rungs that append daily EOD rows behind their recorded sessions. Those rows
 * are stamped at Karachi noon; they are calendar history, not intraday bars,
 * and must stay out of the session-rule pass or a decade of them turns the
 * chart into a dashed forest.
 *
 * The minute and second rungs never request this backfill, which matters:
 * noon is a real intraday bar on a 1m chart and must not be discarded.
 */
const DAILY_BACKFILL_RUNGS: ReadonlySet<Resolution> = new Set<Resolution>([
  "10m", "15m", "30m", "1h", "4h",
]);

export function hasSessionBreaks(resolution: Resolution): boolean {
  return SESSION_BREAK_RUNGS.has(resolution);
}

export function hasDailyBackfill(resolution: Resolution): boolean {
  return DAILY_BACKFILL_RUNGS.has(resolution);
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

/**
 * A daily EOD bar is stamped at Karachi noon, which is 07:00 UTC. It is a
 * calendar row, not an intraday session bar. The conversion is explicit
 * because the exchange's clock has no DST.
 */
export function isDailyGrainStamp(ms: number): boolean {
  if (!Number.isFinite(ms)) {
    return false;
  }
  const at = new Date(ms);
  return at.getUTCHours() === 7 && at.getUTCMinutes() === 0
    && at.getUTCSeconds() === 0;
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

interface SessionSlot {
  /** Karachi day plus the band index in that day's session shape. */
  readonly key: string;
  readonly day: string;
}

/**
 * The session shape a Karachi instant belongs to.
 *
 * A real band owns its instant. Bars just outside a band (a pre-open print or
 * a post-close one) are attached to the nearest band of that day so they do
 * not invent a boundary of their own. Friday's lunch belongs to the first
 * band: the break is then the move into the 14:32 band, not a second edge
 * inside the lunch.
 */
function sessionSlot(ms: number): SessionSlot {
  const at = new Date(ms + KARACHI_OFFSET_MS);
  const day = at.toISOString().slice(0, 10);
  const weekday = at.getUTCDay();
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();

  let band = -1;
  if (weekday >= 1 && weekday <= 5) {
    const bands = weekday === 5 ? FRIDAY_BANDS : WEEKDAY_BANDS;
    band = bands.findIndex(([open, close]) =>
      minute >= open && minute < close,
    );
    if (band < 0) {
      if (minute < bands[0]![0]) {
        band = 0;
      } else if (weekday === 5 && minute < FRIDAY_SECOND_OPEN) {
        // The Friday lunch: 12:00 up to the second open.
        band = 0;
      } else {
        band = bands.length - 1;
      }
    }
  }
  return { day, key: `${day}:${band}` };
}

/**
 * Every session change in a series, in bar order.
 *
 * A break is a change of session band, not merely a change of date. That is
 * what makes Friday's lunch visible and what keeps a data hole inside one
 * band from being mistaken for a market close. The first intraday session is
 * still returned (with `first: true`) so callers can anchor it, but the
 * renderer does not draw a rule before the series begins.
 *
 * The bar list is filtered by resolution first: coarse charts carry daily
 * backfill rows, and those rows must not earn rules of their own.
 */
export function sessionBreaks(
  times: ArrayLike<number>,
  resolution: Resolution,
): SessionBreak[] {
  const out: SessionBreak[] = [];
  let lastKey = "";
  let previous: number | undefined;
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t === undefined || !isIntradayStamp(t, resolution)) {
      continue;
    }
    const slot = sessionSlot(t);
    if (slot.key === lastKey) {
      previous = t;
      continue;
    }
    out.push({
      t,
      day: slot.day,
      label: dayLabelFormat.format(new Date(t)),
      first: out.length === 0,
      ...(previous !== undefined ? { previous } : {}),
    });
    lastKey = slot.key;
    previous = t;
  }
  return out;
}
