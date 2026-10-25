/**
 * The tape's per-minute buy/sell split, folded onto the chart's own bars.
 *
 * The service measures the split on the Karachi clock at one minute; a chart
 * may be drawing five-minute or hourly candles, so each minute's counts are
 * credited to the bar that contains it. The result is measured buy volume and
 * sell volume for every bar the tape covered - the numbers a volume-delta
 * pane draws - with NaN where the tape had no window to classify.
 *
 * Sub-minute charts are deliberately refused: a minute's split cannot be
 * attributed to a five-second candle without inventing detail, and the chart
 * falls back to its own signed volume there rather than pretending.
 */

export interface MinuteFlowLike {
  /** The minute's own start, ISO with the tape's offset. */
  readonly t: string;
  readonly buy: number;
  readonly sell: number;
}

export interface FlowColumns {
  readonly buy: Float64Array;
  readonly sell: Float64Array;
}

function filled(length: number): Float64Array {
  const values = new Float64Array(length);
  values.fill(Number.NaN);
  return values;
}

/** The index of the last bar starting at or before `moment`, or -1. */
function barAt(times: Float64Array, moment: number): number {
  let low = 0;
  let high = times.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = times[mid] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      return found;
    }
    if (value <= moment) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

export function flowColumns(
  minutes: readonly MinuteFlowLike[],
  times: Float64Array,
  stepMs: number,
): FlowColumns {
  const length = times.length;
  const buy = filled(length);
  const sell = filled(length);
  if (length === 0 || !(stepMs >= 60_000)) {
    return { buy, sell };
  }
  for (const minute of minutes) {
    const moment = Date.parse(minute.t);
    if (!Number.isFinite(moment)) {
      continue;
    }
    const index = barAt(times, moment);
    if (index < 0) {
      continue;
    }
    const start = times[index] ?? Number.NaN;
    // A minute that falls past the end of its bar (a hole in the tape) is
    // not attributed: it belongs to no candle this chart drew.
    if (!Number.isFinite(start) || moment - start >= stepMs) {
      continue;
    }
    if (Number.isNaN(buy[index] ?? Number.NaN)) {
      buy[index] = 0;
      sell[index] = 0;
    }
    buy[index] = (buy[index] ?? 0) + Math.max(0, minute.buy);
    sell[index] = (sell[index] ?? 0) + Math.max(0, minute.sell);
  }
  return { buy, sell };
}
