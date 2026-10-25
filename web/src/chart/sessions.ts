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
}

function keyOf(ms: number): string {
  return dayKeyFormat.format(new Date(ms));
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
    out.push({
      t,
      day: key,
      label: dayLabelFormat.format(moment),
      first: out.length === 0,
    });
  }
  return out;
}
