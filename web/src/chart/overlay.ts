/**
 * The drawing overlay: shapes a reader places over the price pane.
 *
 * The overlay is an ordinary canvas filling the chart surface; the shapes
 * inside it are placed with the engine's own mappings, so a drawing glued
 * to a bar stays glued when the reader pans, zooms or the next bars arrive.
 *
 * One concrete fault has a name here: `timeToCoordinate` answers only for
 * instants that are exactly a bar of the series, and returns null for any
 * point between bars or in the margin after the last one. A trend line
 * whose end was a sliver off a bar would silently refuse to be drawn. The
 * overlay therefore maps time → x in *bar-index space* (the tape's own
 * clip, interpolated linearly between real bars), which never drops a line
 * and reads exactly like the terminal's own crosshair placement.
 */

import type {
  IChartApi,
  ISeriesApi,
} from "lightweight-charts";

import {
  type AnchoredPoint,
  type Drawing,
  type MeasureResult,
} from "./drawings";
import type { SessionBreak } from "./sessions";

export interface DrawingChip {
  /** Drawing colour, TV's active blue. */
  color: string;
}

/** The pixels a shape may use: the price pane inside the axes. */
export interface OverlayFrame {
  /** Width of the price plot (the price axis is excluded). */
  readonly plotWidth: number;
  /** Height of pane 0, the price pane itself. */
  readonly plotHeight: number;
}

/** The measurements of the surface the overlay draws on. */
export function frameFor(chart: IChartApi, width: number, height: number):
  OverlayFrame {
  let axisWidth = 60;
  try {
    axisWidth = Math.max(0, Math.round(chart.priceScale("right").width()));
  } catch {
    axisWidth = 60;
  }
  let paneHeight = height;
  try {
    const paneArray = chart.panes();
    const first = paneArray[0];
    if (first !== undefined && typeof first.getHeight === "function") {
      const shown = first.getHeight();
      if (Number.isFinite(shown) && shown > 0) {
        paneHeight = Math.min(height, shown);
      }
    }
  } catch {
    // Older panes API: fall back to the whole height.
  }
  return {
    plotWidth: Math.max(0, width - axisWidth),
    plotHeight: Math.max(0, paneHeight),
  };
}

/** An anchor back into the tape's coordinates: the instant and the price. */
export function anchorAt(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  x: number,
  y: number,
  /** Map the engine's presentation instant back to the tape's own instant. */
  toRealMs: (chartMs: number) => number = (value) => value,
): AnchoredPoint | null {
  const time = chart.timeScale().coordinateToTime(x);
  const price = candles.coordinateToPrice(y);
  if (time === null || price === null) {
    return null;
  }
  return { t: toRealMs(Number(time) * 1000), price };
}


/** The bar columns a fixed-range volume profile reads. */
export interface ProfileBarSource {
  readonly time: ArrayLike<number>;
  readonly high: ArrayLike<number>;
  readonly low: ArrayLike<number>;
  readonly volume: ArrayLike<number>;
}

export interface ProfileBin {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
}

export interface VolumeProfile {
  readonly bins: readonly ProfileBin[];
  readonly max: number;
  readonly total: number;
  /** The price with the most volume traded through it. */
  readonly poc: number;
  /** Value area edges: the busiest 70% of the range's volume. */
  readonly vah: number;
  readonly val: number;
}

/** The ratios every retracement tool draws, low to high. */
const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

export interface FibLevel {
  readonly ratio: number;
  readonly price: number;
}

/**
 * The levels between two anchors, measured from the first across the swing.
 *
 * The list is the classic one the terminal draws, and the price of each level
 * is the swing's own arithmetic: no rounding, because a retracement that
 * snapped its levels would sit off the swing it was drawn on.
 */
export function fibLevels(a: AnchoredPoint, b: AnchoredPoint): FibLevel[] {
  return FIB_RATIOS.map((ratio) => ({
    ratio,
    price: a.price + (b.price - a.price) * ratio,
  }));
}

/**
 * Volume at price across the selected range: the FRVP tool's numbers.
 *
 * Each bar's own volume is spread evenly across the prices that bar traded
 * (its high-low span), so a tall candle feeds every bin it crossed rather
 * than dumping its whole volume on the close. Bins outside the range, and
 * bars whose time sits outside it, contribute nothing. The value area is the
 * busiest bins that together hold 70% of the range's volume.
 */
export function volumeProfile(
  bars: ProfileBarSource | null | undefined,
  a: AnchoredPoint,
  b: AnchoredPoint,
  bins = 24,
): VolumeProfile | null {
  if (bars === null || bars === undefined || bins < 1) {
    return null;
  }
  const count = Math.min(bars.time.length, bars.high.length,
    bars.low.length, bars.volume.length);
  const priceLow = Math.min(a.price, b.price);
  const priceHigh = Math.max(a.price, b.price);
  const timeLow = Math.min(a.t, b.t);
  const timeHigh = Math.max(a.t, b.t);
  if (count === 0 || !(priceHigh > priceLow)) {
    return null;
  }
  const step = (priceHigh - priceLow) / bins;
  const filled = new Float64Array(bins);
  for (let index = 0; index < count; index += 1) {
    const time = bars.time[index];
    const high = bars.high[index];
    const low = bars.low[index];
    const volume = bars.volume[index];
    if (time === undefined || high === undefined || low === undefined
      || volume === undefined) {
      continue;
    }
    if (!Number.isFinite(time) || time < timeLow || time > timeHigh) {
      continue;
    }
    if (!Number.isFinite(high) || !Number.isFinite(low)
      || !Number.isFinite(volume) || volume <= 0) {
      continue;
    }
    const top = Math.min(high, priceHigh);
    const bottom = Math.max(low, priceLow);
    if (!(top > bottom)) {
      continue;
    }
    const span = high - low;
    const first = Math.max(0,
      Math.min(bins - 1, Math.floor((bottom - priceLow) / step)));
    const last = Math.max(0,
      Math.min(bins - 1, Math.floor((top - priceLow) / step)));
    for (let bin = first; bin <= last; bin += 1) {
      const binLow = priceLow + bin * step;
      const overlap = Math.min(top, binLow + step)
        - Math.max(bottom, binLow);
      if (overlap <= 0) {
        continue;
      }
      filled[bin] = (filled[bin] ?? 0)
        + (span > 0 ? volume * (overlap / span) : volume);
    }
  }
  let total = 0;
  let max = 0;
  let pocIndex = -1;
  for (let bin = 0; bin < bins; bin += 1) {
    const value = filled[bin] ?? 0;
    total += value;
    if (value > max) {
      max = value;
      pocIndex = bin;
    }
  }
  if (pocIndex < 0 || total <= 0) {
    return null;
  }
  const order: number[] = [];
  for (let bin = 0; bin < bins; bin += 1) {
    order.push(bin);
  }
  order.sort((left, right) => (filled[right] ?? 0) - (filled[left] ?? 0));
  let taken = 0;
  let lowest = bins;
  let highest = -1;
  for (const bin of order) {
    if (taken >= total * 0.7) {
      break;
    }
    taken += filled[bin] ?? 0;
    lowest = Math.min(lowest, bin);
    highest = Math.max(highest, bin);
  }
  const binLow = (bin: number): number => priceLow + bin * step;
  const rows: ProfileBin[] = [];
  for (let bin = 0; bin < bins; bin += 1) {
    rows.push({ lo: binLow(bin), hi: binLow(bin) + step,
                volume: filled[bin] ?? 0 });
  }
  const pocBase = binLow(pocIndex);
  return {
    bins: rows,
    max,
    total,
    poc: pocBase + step / 2,
    vah: binLow(highest) + step,
    val: binLow(lowest),
  };
}

/** One of the three prices a fixed-range profile is read by. */
export interface ProfileLevel {
  readonly key: "VAH" | "POC" | "VAL";
  readonly price: number;
  readonly color: string;
  readonly dashed: boolean;
  readonly bright: boolean;
}

/**
 * The value area's edges and the point of control between them, in the order
 * a reader scans them: the top of value, the busiest price, the bottom.
 */
export function profileLevels(profile: VolumeProfile): ProfileLevel[] {
  return [
    { key: "VAH", price: profile.vah, color: "rgba(41, 98, 255, 0.55)",
      dashed: true, bright: false },
    { key: "POC", price: profile.poc, color: "rgba(41, 98, 255, 0.95)",
      dashed: false, bright: true },
    { key: "VAL", price: profile.val, color: "rgba(41, 98, 255, 0.55)",
      dashed: true, bright: false },
  ];
}

/**
 * A tape instant → x mapping that never drops a line.
 *
 * The engine's own `timeToCoordinate` answers only for instants that are
 * exactly a bar time. A sliver off a bar returned null, and a trend line
 * whose end sat between bars refused to be drawn at all. Chart draws in
 * bar-index space instead - each real bar occupies one linear unit - and
 * interpolates inside it, so a pixel exists for every instant, including
 * the empty margin after the newest bar and the sliver between two bars.
 */
export interface OverlayPositions {
  /** Pixel x for a tape instant (ms), or null with no bars at all. */
  xAt(tMs: number): number | null;
  /** Pixel y of a price on the candle pane. */
  yAt(price: number): number;
}

export function makePositions(
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  barTimesMs: readonly number[],
  /** The tape's real instants, parallel to the presentation times. */
  realTimesMs: readonly number[] = barTimesMs,
): OverlayPositions {
  const timeScale = chart.timeScale();
  // The drawing path speaks milliseconds (`anchorAt` multiplies the
  // engine's seconds by 1000), so the positions take milliseconds and
  // drop back to seconds only for the engine's own calls. Presentations
  // are the engine's packed instants; anchors stay the tape's real ones.
  const barTimes = barTimesMs.map((t) => Math.floor(t / 1000));
  const realTimes = realTimesMs.length === barTimesMs.length
    ? realTimesMs.map((t) => Math.floor(t / 1000))
    : barTimes;
  const cache = new Map<number, number | null>();
  const pxAt = (i: number): number | null => {
    const known = cache.get(i);
    if (known !== undefined) {
      return known;
    }
    const t = barTimes[i];
    const x = t === undefined ? null
      : timeScale.timeToCoordinate(t as never);
    cache.set(i, x);
    return x;
  };
  const count = barTimes.length;
  return {
    xAt(tMs: number): number | null {
      if (count === 0) {
        return null;
      }
      if (count === 1) {
        return pxAt(0);
      }
      // The bar-index coordinate of this instant, in seconds: inside the
      // series it is the bracketing pair interpolated; outside either
      // edge it is the edge extended at the series' own bar pace. The
      // interpolation uses real tape times, while the pixels come from
      // the engine's packed ones.
      const tSec = Math.floor(tMs / 1000);
      const first = realTimes[0]!;
      const second = realTimes[1] ?? first;
      const last = realTimes[count - 1]!;
      const beforeLast = realTimes[count - 2] ?? first;
      let indexFloat: number;
      if (tSec <= first) {
        indexFloat = second === first
          ? 0
          : (tSec - first) / (second - first);
      } else if (tSec >= last) {
        const pace = last - beforeLast;
        indexFloat = (count - 1) + (pace === 0 ? 0 : (tSec - last) / pace);
      } else {
        let lo = 0;
        let hi = count - 1;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (realTimes[mid]! <= tSec) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const span = realTimes[hi]! - realTimes[lo]!;
        indexFloat = lo + (span === 0 ? 0 : (tSec - realTimes[lo]!) / span);
      }
      // Before the first bar: extend at the first two bars' pixel pace.
      if (indexFloat < 0) {
        const edge = pxAt(0);
        const next = pxAt(1);
        if (edge === null) {
          return null;
        }
        return next === null ? edge : edge + (edge - next) * -indexFloat;
      }
      if (indexFloat > count - 1) {
        const edge = pxAt(count - 1);
        const before = pxAt(count - 2);
        if (edge === null) {
          return null;
        }
        return before === null
          ? edge
          : edge + (edge - before) * (indexFloat - (count - 1));
      }
      const from = Math.floor(indexFloat);
      const to = Math.min(count - 1, from + 1);
      const left = pxAt(from);
      const right = pxAt(to);
      if (left === null || right === null) {
        return left ?? right;
      }
      return left + (right - left) * (indexFloat - from);
    },
    yAt(price: number): number {
      return candles.priceToCoordinate(price) ?? 0;
    },
  };
}

/**
 * Where a session break may paint, decided before any canvas is touched.
 *
 * A merged chart full of daily-grain backfill packs a day into every few
 * pixels, and a line and a date for *each* day is the dashed forest and the
 * unreadable strip that reads as noise. The plan is decided on pixel
 * geometry instead: day joins get their rule while there is room for one,
 * and once they crowd below a thirty-pixel rhythm only the month's first
 * bar keeps one - the months stay findable, the days are left to the
 * zoom that actually has space for them. A normal one-hour PSX day is six
 * candles, about 36 px at the default window, so it keeps its five day
 * joins; a packed decade still falls back to months. Rules carry no dates;
 * the time axis owns every date label.
 */
export interface BreakPlan {
  readonly x: number;
  /** The date a rule opens, when the caller asked for labels. */
  readonly label?: string;
}

const LINE_MIN_PX = 18;
// A six-candle hour day needs a rule at roughly 36 px at the default 1h
// window. Collapse only below that; otherwise every day becomes a month.
const DENSE_PX = 30;

export function breakPlan(
  breaks: readonly SessionBreak[],
  xOf: (t: number) => number | null,
  plotWidth: number,
  /** Kept for callers: both plans obey the same rhythm. Dates are the axis's. */
  _denseAllowed = true,
  /** Carry one date label per day when the caller paints it. */
  withLabels = false,
): BreakPlan[] {
  const visible: { x: number; day: string; label: string; daily: boolean }[] = [];
  for (const item of breaks) {
    if (item.first) {
      continue;
    }
    let x = xOf(item.t);
    // The engine now spaces bars uniformly, so the previous and new
    // sessions' bars are adjacent even when the calendar between them
    // contains a weekend. Put the rule at their midpoint: between the
    // two candles, not through the first candle of the new session.
    if (x !== null && item.previous !== undefined) {
      const before = xOf(item.previous);
      if (before !== null) {
        x = (before + x) / 2;
      }
    }
    if (x === null || x < -1 || x > plotWidth + 1) {
      continue;
    }
    visible.push({
      x: Math.round(x), day: item.day, label: item.label,
      daily: item.daily === true,
    });
  }
  if (visible.length === 0) {
    return [];
  }
  // Crowding is the viewport's property, not the rung's: a real session span
  // packs as tight as a decade of daily rows the moment the reader zooms out.
  // Both passes - calendar history and real sessions - obey the same law:
  // roomy keeps every join's rule, crowded keeps the month's rule.
  //
  // But the two populations are measured separately. A decade of daily rows
  // packed at half a pixel each used to declare the whole viewport dense and
  // thin the recorded sessions' rules away with it; those sessions can be
  // roomy while the history behind them is not. Each grain keeps its own
  // rhythm, and the two plans merge in x order.
  const plan: BreakPlan[] = [];
  let lastLabelDay = "";
  for (const grain of [false, true] as const) {
    const items = visible.filter((item) => item.daily === grain);
    if (items.length === 0) {
      continue;
    }
    let span = 0;
    for (let i = 1; i < items.length; i += 1) {
      span += items[i]!.x - items[i - 1]!.x;
    }
    const dense = items.length > 1
      && span / (items.length - 1) < DENSE_PX;
    let lastLine = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const monthStart = i === 0
        || item.day.slice(0, 7) !== items[i - 1]!.day.slice(0, 7);
      // Rules keep a rhythm of their own: in the dense mode only the month's
      // first bar asks for one, and none crowds the previous within 18px.
      const asks = !dense || monthStart;
      if (asks && (!dense || item.x - lastLine >= LINE_MIN_PX)) {
        // A packed axis has no calendar distance of its own, so the first
        // rule of each session carries the date. A Friday lunch rule stays
        // label-free because it names the same day as the morning rule.
        plan.push({
          x: item.x,
          ...(withLabels && item.day !== lastLabelDay
            ? { label: item.label } : {}),
        });
        lastLine = item.x;
        lastLabelDay = item.day;
      }
    }
  }
  plan.sort((a, b) => a.x - b.x);
  // A daily rule and a session rule can land on the same pixel at a month
  // boundary; one stroke is enough. The session's plan is built first, so its
  // label wins.
  const deduped: BreakPlan[] = [];
  for (const item of plan) {
    if (deduped[deduped.length - 1]?.x !== item.x) {
      deduped.push(item);
    }
  }
  return deduped;
}

/**
 * The session breaks, painted from a pre-decided plan.
 *
 * The line is one dashed stroke where the exchange's session changes, and
 * the label is the date of the day that just began at the top of the plot.
 * Which breaks earn a line and a label is the plan's own decision - the
 * geometry lives in `breakPlan`, so what a reader sees can be tested
 * without a canvas in sight.
 */
export function paintSessionBreaks(
  context: CanvasRenderingContext2D,
  chart: IChartApi,
  frame: OverlayFrame,
  breaks: readonly SessionBreak[],
  colors: { line: string; label: string },
  denseAllowed = true,
  /** How far down the stack the rule runs: every pane, not only price. */
  bottom = frame.plotHeight,
  /** The display's device-pixel ratio, so every rule has equal weight. */
  dpr = 1,
  /** Name the day each session opens on the packed axis. */
  showDates = false,
): void {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  // A one-CSS-pixel rule at a fractional DPR lands on a different pixel
  // phase from one rule to the next, so some lines read bold and some read
  // faint. Snap every rule to a device-pixel centre: same width and weight.
  const deviceX = (x: number): number =>
    (Math.round(x * ratio - 0.5) + 0.5) / ratio;
  if (breaks.length < 2) {
    return;
  }
  const scale = chart.timeScale();
  const plan = breakPlan(
    breaks,
    (t) => scale.timeToCoordinate((t / 1000) as never),
    frame.plotWidth,
    denseAllowed,
    showDates,
  );
  if (plan.length === 0) {
    return;
  }
  context.save();
  for (const item of plan) {
    context.setLineDash([2, 4]);
    context.strokeStyle = colors.line;
    context.lineWidth = 1;
    const x = deviceX(item.x);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, bottom);
    context.stroke();
    context.setLineDash([]);
    if (item.label !== undefined) {
      context.font = "10px 'Trebuchet MS', 'Segoe UI', sans-serif";
      context.fillStyle = colors.label;
      context.textAlign = "left";
      context.textBaseline = "top";
      context.fillText(item.label, x + 4, 4);
    }
  }
  context.restore();
}

export interface OverlayShapeInput {
  readonly drawings: readonly Drawing[];
  readonly hidden: boolean;
  readonly toolColor: string;
  readonly midDrag: MeasureResult | null;
  readonly positions: OverlayPositions;
  /** Bars behind the profile tool, or null when the chart holds none. */
  readonly bars?: ProfileBarSource | null;
}

/**
 * Paint one frame: every kept drawing, then the live one mid-drag.
 * context/globalAlpha are the caller's; this must not touch state.
 */
export function paintOverlay(
  context: CanvasRenderingContext2D,
  chart: IChartApi,
  candles: ISeriesApi<"Candlestick">,
  frame: OverlayFrame,
  input: OverlayShapeInput,
): void {
  void chart; // positions carry their own mapping
  void candles;
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (input.hidden && input.midDrag === null) {
    return;
  }
  const lineWidth = 1.6;
  for (const drawing of input.drawings) {
    if (input.hidden) {
      continue;
    }
    paintDrawing(context, frame, drawing,
      input.toolColor, lineWidth, input.positions, input.bars ?? null);
  }
  if (input.midDrag !== null) {
    paintMeasure(context, input.midDrag, input.toolColor,
      input.positions);
  }
}

function paintDrawing(
  context: CanvasRenderingContext2D,
  frame: OverlayFrame,
  drawing: Drawing,
  color: string,
  lineWidth: number,
  positions: OverlayPositions,
  bars: ProfileBarSource | null,
): void {
  const a = drawing.points[0];
  const b = drawing.points[1];
  if (a === undefined) {
    return;
  }
  if (drawing.kind === "fib") {
    if (b === null) {
      return;
    }
    paintFib(context, frame, a, b, positions);
    return;
  }
  if (drawing.kind === "profile") {
    if (b === null) {
      return;
    }
    paintProfile(context, frame, a, b, positions, bars);
    return;
  }
  context.beginPath();
  if (drawing.kind === "hline") {
    const y = positions.yAt(a.price);
    context.moveTo(0, y);
    context.lineTo(frame.plotWidth, y);
  } else if (drawing.kind === "hray") {
    const start = positions.xAt(a.t);
    const y = positions.yAt(a.price);
    if (start === null) {
      return;
    }
    context.moveTo(start, y);
    context.lineTo(frame.plotWidth, y);
  } else if (drawing.kind === "ob") {
    if (b === null) {
      return;
    }
    paintOrderBlock(context, positions, a, b);
    return;
  } else {
    if (b === null) {
      return;
    }
    if (drawing.kind === "trend") {
      const x1 = positions.xAt(a.t);
      const x2 = positions.xAt(b.t);
      if (x1 === null || x2 === null) {
        return;
      }
      context.moveTo(x1, positions.yAt(a.price));
      context.lineTo(x2, positions.yAt(b.price));
    } else {
      // flatTop / flatBottom: a level held between two instants.
      const y = positions.yAt(a.price);
      const x1 = positions.xAt(a.t);
      const x2 = positions.xAt(b.t);
      if (x1 === null || x2 === null) {
        return;
      }
      context.moveTo(x1, y);
      context.lineTo(x2, y);
      paintEndCert(context, x1, y);
      paintEndCert(context, x2, y);
    }
  }
  context.strokeStyle = color;
  context.lineWidth = lineWidth;
  context.stroke();
}


/** The ratio's own label: 0 and 1 stay whole, the rest keep their digits. */
function ratioText(ratio: number): string {
  if (ratio === 0 || ratio === 1) {
    return String(ratio);
  }
  return ratio.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/** A volume figure a chart label can hold: 2.4M, 780.1K, 512. */
function compactVolume(value: number): string {
  const size = Math.abs(value);
  if (size >= 1e9) {
    return `${(value / 1e9).toFixed(2)}B`;
  }
  if (size >= 1e6) {
    return `${(value / 1e6).toFixed(2)}M`;
  }
  if (size >= 1e3) {
    return `${(value / 1e3).toFixed(1)}K`;
  }
  return value.toFixed(0);
}

/**
 * The retracement: the dashed swing, then each level across the panel.
 *
 * The levels run to the right edge of the plot rather than stopping at the
 * second anchor, which is the terminal's own default: the reader uses them
 * as a shelf for what happens after the swing, not as a box around it.
 */
function paintFib(
  context: CanvasRenderingContext2D,
  frame: OverlayFrame,
  a: AnchoredPoint,
  b: AnchoredPoint,
  positions: OverlayPositions,
): void {
  const x1 = positions.xAt(a.t);
  const x2 = positions.xAt(b.t);
  if (x1 === null || x2 === null) {
    return;
  }
  const left = Math.min(x1, x2);
  const right = Math.max(frame.plotWidth, Math.max(x1, x2));
  context.save();
  context.font = "10px 'Trebuchet MS', 'Segoe UI', sans-serif";
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.setLineDash([3, 4]);
  context.strokeStyle = "rgba(41, 98, 255, 0.45)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x1, positions.yAt(a.price));
  context.lineTo(x2, positions.yAt(b.price));
  context.stroke();
  context.setLineDash([]);
  for (const level of fibLevels(a, b)) {
    const y = Math.round(positions.yAt(level.price)) + 0.5;
    const edge = level.ratio === 0 || level.ratio === 1;
    context.strokeStyle = edge ? "rgba(41, 98, 255, 0.8)"
      : "rgba(41, 98, 255, 0.42)";
    context.lineWidth = edge ? 1.3 : 1;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
    context.fillStyle = edge ? "#b9c6e8" : "#8f9bb3";
    context.fillText(`${ratioText(level.ratio)}  ${level.price.toFixed(2)}`,
      right - 6, Math.max(8, y - 8));
  }
  context.restore();
}

/**
 * The fixed range volume profile: the selection box, then one bar per price
 * bin, grown leftward from the right edge of the selection exactly like the
 * terminal's own tool. The point of control is brightest and the value area
 * is tinted, so the shape reads at a glance without a legend.
 */
function paintProfile(
  context: CanvasRenderingContext2D,
  frame: OverlayFrame,
  a: AnchoredPoint,
  b: AnchoredPoint,
  positions: OverlayPositions,
  bars: ProfileBarSource | null,
): void {
  void frame;
  const x1 = positions.xAt(a.t);
  const x2 = positions.xAt(b.t);
  if (x1 === null || x2 === null) {
    return;
  }
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(positions.yAt(a.price), positions.yAt(b.price));
  const bottom = Math.max(positions.yAt(a.price), positions.yAt(b.price));
  const width = Math.max(1, right - left);
  context.save();
  context.setLineDash([4, 3]);
  context.strokeStyle = "rgba(41, 98, 255, 0.55)";
  context.lineWidth = 1;
  context.strokeRect(left + 0.5, top + 0.5, width, Math.max(1, bottom - top));
  context.setLineDash([]);
  const profile = volumeProfile(bars, a, b, 24);
  context.font = "10px 'Trebuchet MS', 'Segoe UI', sans-serif";
  context.textAlign = "left";
  context.textBaseline = "bottom";
  context.fillStyle = "#8f9bb3";
  context.fillText(
    profile === null
      ? "no volume in this range"
      : `Vol ${compactVolume(profile.total)}`,
    left + 6, Math.max(12, bottom - 6));
  if (profile === null || profile.max <= 0) {
    context.restore();
    return;
  }
  const height = Math.max(1, bottom - top) / profile.bins.length;
  for (let index = 0; index < profile.bins.length; index += 1) {
    const bin = profile.bins[index];
    if (bin === undefined || !(bin.volume > 0)) {
      continue;
    }
    const y = bottom - (index + 1) * height;
    const barWidth = (bin.volume / profile.max) * width * 0.92;
    if (barWidth <= 0) {
      continue;
    }
    const nearPoc = profile.poc >= bin.lo && profile.poc < bin.hi;
    const inValue = bin.hi > profile.val && bin.lo < profile.vah;
    context.fillStyle = nearPoc ? "rgba(41, 98, 255, 0.62)"
      : inValue ? "rgba(41, 98, 255, 0.30)"
      : "rgba(120, 123, 134, 0.20)";
    context.fillRect(right - barWidth, y + 0.5, barWidth,
      Math.max(1, height - 1));
  }
  const pocY = Math.round(positions.yAt(profile.poc)) + 0.5;
  context.strokeStyle = "rgba(41, 98, 255, 0.9)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(left, pocY);
  context.lineTo(right, pocY);
  context.stroke();
  // The three levels, all named: VAH and VAL as dashed edges, POC as the
  // solid centre, each rule reaching the pane's right edge so the labels can
  // sit there without covering the distribution itself.
  const levels = profileLevels(profile);
  const labelRight = Math.max(left + 64, frame.plotWidth - 8);
  let lastLabelY = Number.NEGATIVE_INFINITY;
  context.font = "10px 'Trebuchet MS', 'Segoe UI', sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  for (const level of levels) {
    const levelY = Math.round(positions.yAt(level.price)) + 0.5;
    if (level.key !== "POC") {
      context.save();
      context.setLineDash([4, 3]);
      context.strokeStyle = level.color;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(left, levelY);
      context.lineTo(frame.plotWidth - 2, levelY);
      context.stroke();
      context.restore();
    }
    const text = `${level.key} ${level.price.toFixed(2)}`;
    const textWidth = context.measureText(text).width;
    // Keep the three labels apart when the value area is only pixels tall.
    const boxY = Math.min(bottom - 8,
      Math.max(top + 8, Math.max(levelY, lastLabelY + 13)));
    lastLabelY = boxY;
    context.fillStyle = "rgba(19, 23, 34, 0.92)";
    context.fillRect(labelRight - textWidth - 10, boxY - 7,
      textWidth + 10, 14);
    context.fillStyle = level.bright ? "#d1d4dc" : "#8f9bb3";
    context.fillText(text, labelRight - textWidth - 5, boxY);
  }
  context.restore();
}

/**
 * The order block: a box from one anchor to another, filled with the side
 * it faces (a box lifted up is bullish, driven down bearish) at TV's own
 * translucency, with the OB tag inside the corner. An order block survives
 * being read later: the fill is quiet, the edge is enough.
 */
function paintOrderBlock(
  context: CanvasRenderingContext2D,
  positions: OverlayPositions,
  a: AnchoredPoint,
  b: AnchoredPoint,
): void {
  const x1 = positions.xAt(a.t);
  const x2 = positions.xAt(b.t);
  if (x1 === null || x2 === null) {
    return;
  }
  const y1 = positions.yAt(a.price);
  const y2 = positions.yAt(b.price);
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  const bullish = b.price >= a.price;
  const fill = bullish ? "rgba(8, 153, 129, 0.13)"
    : "rgba(242, 54, 69, 0.13)";
  const edge = bullish ? "rgba(8, 153, 129, 0.65)"
    : "rgba(242, 54, 69, 0.65)";
  context.fillStyle = fill;
  context.fillRect(left, top, Math.max(2, right - left),
    Math.max(2, bottom - top));
  context.strokeStyle = edge;
  context.lineWidth = 1;
  context.strokeRect(left, top, Math.max(2, right - left),
    Math.max(2, bottom - top));
  context.fillStyle = edge;
  context.font = "10px 'Trebuchet MS', sans-serif";
  context.textBaseline = "top";
  context.fillText("OB", left + 4, top + 3);
}

function paintEndCert(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
): void {
  context.fillStyle = "rgba(41, 98, 255, 0.9)";
  context.beginPath();
  context.arc(x, y, 1.6, 0, Math.PI * 2);
  context.fill();
}

/** The measure readout, TV's dashed rectangle with the counting label. */
function paintMeasure(
  context: CanvasRenderingContext2D,
  midDrag: MeasureResult,
  color: string,
  positions: OverlayPositions,
): void {
  const p1 = {
    x: positions.xAt(midDrag.from.t) ?? NaN,
    y: positions.yAt(midDrag.from.price),
  };
  const p2 = {
    x: positions.xAt(midDrag.to.t) ?? NaN,
    y: positions.yAt(midDrag.to.price),
  };
  if (Number.isNaN(p1.x) || Number.isNaN(p2.x)) {
    return;
  }
  const left = Math.min(p1.x, p2.x);
  const right = Math.max(p1.x, p2.x);
  const top = Math.min(p1.y, p2.y);
  const bottom = Math.max(p1.y, p2.y);

  context.save();
  context.setLineDash([4, 3]);
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.fillStyle = "rgba(41, 98, 255, 0.12)";
  context.fillRect(left, top, Math.max(1, right - left),
    Math.max(1, bottom - top));
  context.strokeRect(left, top, Math.max(1, right - left),
    Math.max(1, bottom - top));

  const tone = midDrag.up === true ? "#089981" : midDrag.up === false
    ? "#f23645" : "#787b86";
  const label =
    `${midDrag.delta >= 0 ? "+" : ""}${midDrag.delta.toFixed(2)} ` +
    `(${midDrag.pct >= 0 ? "+" : ""}${midDrag.pct.toFixed(2)}%)`;
  const bars = `${Math.round(midDrag.minutes / 1)} m`;
  context.setLineDash([]);
  context.font = "11px 'Trebuchet MS', sans-serif";
  const textWidth = context.measureText(label).width;
  const boxWidth = textWidth + 12;
  const boxHeight = 18;
  const boxX = Math.min(right, boxWidth) - boxWidth;
  const boxY = bottom + 2;
  context.fillStyle = "rgba(19, 23, 34, 0.92)";
  context.fillRect(boxX, boxY, boxWidth, boxHeight + 14);
  context.fillStyle = tone;
  context.textAlign = "left";
  context.fillText(label, boxX + 6, boxY + 12);
  context.fillStyle = "#787b86";
  context.font = "10px 'Trebuchet MS', sans-serif";
  context.fillText(bars, boxX + 6, boxY + 26);
  context.restore();
}
