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
): AnchoredPoint | null {
  const time = chart.timeScale().coordinateToTime(x);
  const price = candles.coordinateToPrice(y);
  if (time === null || price === null) {
    return null;
  }
  return { t: Number(time) * 1000, price };
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
): OverlayPositions {
  const timeScale = chart.timeScale();
  // The drawing path speaks milliseconds (`anchorAt` multiplies the
  // engine's seconds by 1000), so the positions take milliseconds and
  // drop back to seconds only for the engine's own calls.
  const barTimes = barTimesMs.map((t) => Math.floor(t / 1000));
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
      // edge it is the edge extended at the series' own bar pace.
      const tSec = Math.floor(tMs / 1000);
      // Copied so the subscripts are their own number, not number | null◌.
      const first = barTimes[0]!;
      const second = barTimes[1] ?? first;
      const last = barTimes[count - 1]!;
      const beforeLast = barTimes[count - 2] ?? first;
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
          if (barTimes[mid]! <= tSec) {
            lo = mid;
          } else {
            hi = mid;
          }
        }
        const span = barTimes[hi]! - barTimes[lo]!;
        indexFloat = lo + (span === 0 ? 0 : (tSec - barTimes[lo]!) / span);
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
      // After the last bar: extend at the last two bars' pixel pace. This is
      // the margin a trend line is drawn into when the window will not
      // scroll further - the anchor must land where the click landed, not
      // snap back onto the newest candle.
      if (indexFloat > count - 1) {
        const edge = pxAt(count - 1);
        if (edge === null) {
          return null;
        }
        const prior = pxAt(count - 2);
        const over = indexFloat - (count - 1);
        return prior === null ? edge : edge + (edge - prior) * over;
      }
      // Two real bars to lean on: the nearest visible pixel at or under
      // this index and the nearest at or above it. Bars the viewport left
      // have no pixels; the lean goes to the visible bracket, so a segment
      // that clips the screen edge still draws like the engine's own line.
      const start = Math.max(0, Math.min(count - 1, Math.floor(indexFloat)));
      let leftIdx: number | null = null;
      let rightIdx: number | null = null;
      for (let k = start; k >= 0 && leftIdx === null; k -= 1) {
        if (pxAt(k) !== null) {
          leftIdx = k;
        }
      }
      for (let k = start + 1; k < count && rightIdx === null; k += 1) {
        if (pxAt(k) !== null) {
          rightIdx = k;
        }
      }
      if (leftIdx === null && rightIdx === null) {
        return null;
      }
      const a = leftIdx ?? rightIdx!;
      const bIdx = rightIdx ?? a;
      if (a === bIdx) {
        const only = pxAt(a);
        return only === null ? null : only;
      }
      const l = pxAt(a);
      const r = pxAt(bIdx);
      if (l === null || r === null) {
        return null;
      }
      const frac = (indexFloat - a) / (bIdx - a);
      return l + (r - l) * frac;
    },
    yAt(price: number): number {
      return candles.priceToCoordinate(price) ?? 0;
    },
  };
}

/**
 * The session breaks: one dashed line where the Karachi day changes, with
 * that day's label at the top of the plot. A merged chart packs its sessions
 * edge to edge, so without this the clock appears to jump backwards at every
 * boundary; with it the reader can see where one day ends and the next
 * begins, exactly as the terminal's own session dividers read.
 */
export function paintSessionBreaks(
  context: CanvasRenderingContext2D,
  chart: IChartApi,
  frame: OverlayFrame,
  breaks: readonly SessionBreak[],
  colors: { line: string; label: string },
): void {
  if (breaks.length < 2) {
    return;
  }
  context.save();
  context.font = "10px 'Trebuchet MS', 'Segoe UI', sans-serif";
  context.textBaseline = "top";
  for (const item of breaks) {
    const x = chart.timeScale().timeToCoordinate((item.t / 1000) as never);
    if (x === null || item.first) {
      continue;
    }
    context.setLineDash([2, 4]);
    context.strokeStyle = colors.line;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, 0);
    context.lineTo(Math.round(x) + 0.5, frame.plotHeight);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = colors.label;
    context.fillText(item.label, Math.round(x) + 5, 3);
  }
  context.restore();
}

export interface OverlayShapeInput {
  readonly drawings: readonly Drawing[];
  readonly hidden: boolean;
  readonly toolColor: string;
  readonly midDrag: MeasureResult | null;
  readonly positions: OverlayPositions;
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
      input.toolColor, lineWidth, input.positions);
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
): void {
  const a = drawing.points[0];
  const b = drawing.points[1];
  if (a === undefined) {
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
