/**
 * Session boundaries inside one chart.
 *
 * A chart that merges several days packs the sessions edge to edge: 23 Oct's
 * 11:59 is followed by 21 Oct's 09:32 with nothing between them. Read without
 * a break that looks like a clock running backwards, so the renderer draws a
 * dashed line and the day's own label wherever the Karachi date changes.
 *
 * The function is pure and timezone-explicit: the key is the Karachi calendar
 * day of each bar, never the viewer's own zone, so a laptop in another
 * timezone still finds the exchange's sessions.
 */

const KARACHI = "Asia/Karachi";

const dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: KARACHI,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dayLabelFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: KARACHI,
  day: "2-digit",
  month: "short",
});

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

function keyOf(ms: number): string {
  return dayKeyFormat.format(new Date(ms));
}

/**
 * A daily EOD bar is stamped at Karachi noon, which is 07:00 UTC. It is a
 * calendar row, not an intraday session bar: drawing a session rule around
 * every one of them would turn a decade backfill into a forest of lines.
 * The conversion is explicit because the exchange's clock has no DST.
 */
export function isDailyGrainStamp(ms: number): boolean {
  if (!Number.isFinite(ms)) {
    return false;
  }
  const at = new Date(ms);
  return at.getUTCHours() === 7 && at.getUTCMinutes() === 0
    && at.getUTCSeconds() === 0;
}

/** The stamps that belong to real intraday sessions, in their own order. */
export function intradayStamps(times: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t !== undefined && !isDailyGrainStamp(t)) {
      out.push(t);
    }
  }
  return out;
}

export function sessionBreaks(times: ArrayLike<number>): SessionBreak[] {
  const out: SessionBreak[] = [];
  let last = "";
  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    if (t === undefined || !Number.isFinite(t)) {
      continue;
    }
    const key = keyOf(t);
    if (key === last) {
      continue;
    }
    last = key;
    const moment = new Date(t);
    const previous = i > 0 ? times[i - 1] : undefined;
    out.push({
      t,
      day: key,
      label: dayLabelFormat.format(moment),
      first: out.length === 0,
      ...(previous !== undefined && Number.isFinite(previous)
        ? { previous } : {}),
    });
  }
  return out;
}
