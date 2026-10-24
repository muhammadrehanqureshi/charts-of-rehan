/**
 * The canvas renderer.
 *
 * One function draws one frame. It reads a window of the series, decides the
 * candle width from the space actually available, and paints. It never
 * touches React state, never allocates per bar, and never draws a candle
 * outside the plot: that is what keeps a live chart at frame rate while bars
 * keep arriving.
 *
 * The layout follows the convention every professional chart uses, and which
 * a reader assumes without noticing they assume it: **bars are packed per
 * session**. The hours between one session's close and the next open exist on
 * the exchange, not on the chart, so a month of trading days is drawn edge to
 * edge with a thin session break between them rather than hours of blank
 * canvas every night. That is why this renderer plots by bar slot, not by
 * wall-clock position: a clock axis would give the weekend the same width as
 * a trading day.
 *
 * The honesty features are drawn literally: a measured intra-session gap is
 * shaded with its minute count (a session break, by contrast, is expected
 * missing time and is drawn as a line, not an accusation), and an empty
 * window says "no bars for this symbol yet" on the canvas rather than
 * showing an empty price axis that could be mistaken for a flat market.
 */

import { type Gap, type PrintEvent } from "../api/types";
import type { IndicatorOutput } from "../indicators/types";
import { formatClock, formatDay, formatPrice, formatVolume } from "./format";
import { decimalsFor, linearScale, niceTicks } from "./scale";
import { type ColumnSeries, gapsInWindow, timeMs } from "./series";

export interface RendererTheme {
  readonly background: string;
  readonly grid: string;
  readonly axisText: string;
  readonly up: string;
  readonly down: string;
  readonly volumeUp: string;
  readonly volumeDown: string;
  readonly gapFill: string;
  readonly gapText: string;
  readonly crosshair: string;
  readonly lastLine: string;
  readonly sessionLine: string;
  readonly muted: string;
  /** The big muted symbol text behind the candles, the TV watermark. */
  readonly watermark: string;
}

/** The TradingView-style dark chart: #131722 with the teal-and-red candles. */
export const DARK_THEME: RendererTheme = {
  background: "#131722",
  grid: "#1e2530",
  axisText: "#787b86",
  up: "#089981",
  down: "#f23645",
  volumeUp: "rgba(8, 153, 129, 0.45)",
  volumeDown: "rgba(242, 54, 69, 0.45)",
  gapFill: "rgba(120, 123, 134, 0.14)",
  gapText: "rgba(120, 123, 134, 0.85)",
  crosshair: "#758696",
  lastLine: "#758696",
  sessionLine: "#2d3340",
  muted: "#787b86",
  watermark: "rgba(120, 123, 134, 0.18)",
};

/** The light theme: the same drawing code, read on a bright screen. */
export const LIGHT_THEME: RendererTheme = {
  background: "#ffffff",
  grid: "#e9edf2",
  axisText: "#6a6d78",
  up: "#089981",
  down: "#f23645",
  volumeUp: "rgba(8, 153, 129, 0.30)",
  volumeDown: "rgba(242, 54, 69, 0.30)",
  gapFill: "rgba(106, 109, 120, 0.10)",
  gapText: "rgba(106, 109, 120, 0.85)",
  crosshair: "#9598a1",
  lastLine: "#758696",
  sessionLine: "#d7dce3",
  muted: "#6a6d78",
  watermark: "rgba(106, 109, 120, 0.14)",
};

export function themeFor(mode: "dark" | "light"): RendererTheme {
  return mode === "light" ? LIGHT_THEME : DARK_THEME;
}

export interface PaneFrame {
  readonly index: number;
  readonly top: number;
  readonly bottom: number;
}

export interface ChartGeometry {
  readonly plotLeft: number;
  readonly plotRight: number;
  readonly plotTop: number;
  /** The bottom of the price plot: where the volume pane begins. */
  readonly plotBottom: number;
  readonly volumeTop: number;
  readonly volumeBottom: number;
  readonly priceAxisWidth: number;
  readonly timeAxisHeight: number;
  readonly timeAxisTop: number;
  /** One frame per visible indicator pane, top to bottom. */
  readonly panes: readonly PaneFrame[];
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/** The UTC calendar day of a bar timestamp, the identity of a session. */
const dayOfMs = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 10);

/**
 * The stack, laid out once: price, volume, indicator panes, time axis.
 *
 * A candle can never be drawn through a volume column or an RSI line: they
 * are different measurements on different scales. Pane height is bounded so
 * one oscillator cannot take over a tall window, and a short phone screen
 * keeps a usable price plot by shrinking the panes before the candles.
 */
export function geometryFor(
  width: number,
  height: number,
  paneCount = 0,
): ChartGeometry {
  const priceAxisWidth = 68;
  const timeAxisHeight = 22;
  const padding = 4;
  const usable = Math.max(60, height - timeAxisHeight - padding * 2);
  const count = clamp(Math.floor(paneCount), 0, 8);
  // The price plot is the point of the whole screen, so it wins: volume is
  // a thin strip and each oscillator pane is capped, and anything neither
  // of them needs is left to the candles.
  const volumeHeight = clamp(usable * 0.16, 26, 80);
  let paneTotal = count > 0
    ? Math.min(usable * 0.36, count * 64)
    : 0;
  let priceHeight = usable - volumeHeight - paneTotal;
  if (priceHeight < 80) {
    paneTotal = Math.max(0, usable - volumeHeight - 80);
    priceHeight = usable - volumeHeight - paneTotal;
  }
  const paneHeight = count > 0 ? paneTotal / count : 0;
  const plotTop = padding;
  const plotBottom = plotTop + Math.max(40, priceHeight);
  const volumeTop = plotBottom;
  const volumeBottom = volumeTop + volumeHeight;
  const timeAxisTop = height - timeAxisHeight;
  const panes: PaneFrame[] = [];
  for (let index = 0; index < count; index += 1) {
    const top = volumeBottom + index * paneHeight;
    panes.push({ index, top, bottom: top + paneHeight });
  }
  return {
    plotLeft: padding,
    plotRight: Math.max(padding + 10, width - priceAxisWidth),
    plotTop,
    plotBottom,
    volumeTop,
    volumeBottom,
    priceAxisWidth,
    timeAxisHeight,
    timeAxisTop: Math.max(volumeBottom, timeAxisTop),
    panes,
  };
}

export interface Crosshair {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface RenderInput {
  readonly series: ColumnSeries;
  readonly gaps: readonly Gap[];
  readonly fromMs: number;
  readonly toMs: number;
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly crosshair?: Crosshair | null;
  readonly theme?: RendererTheme;
  /** Indicator lines drawn on the price scale. */
  readonly overlays?: readonly IndicatorOutput[];
  /** Indicator outputs drawn in their own panes, in order. */
  readonly panes?: readonly IndicatorOutput[];
  /**
   * Whether the source reported a volume counter for this session at all.
   *
   * When it did not, the pane says so instead of drawing a row of flat zero
   * columns: an absent measurement and a measured zero are different facts,
   * and a chart must not turn one into the other.
   */
  readonly volumeAvailable?: boolean;
  /**
   * The order prints the tape carried, newest last.
   *
   * Each is a trade the venue itself reported, drawn as a dot on the
   * candle whose slot holds it. A source without a ledger simply passes
   * an empty list and nothing is drawn - absence stays absence.
   */
  readonly prints?: readonly PrintEvent[];
  /**
   * The headline the chart carries, TradingView-style: symbol, timeframe
   * and venue (`PRL · 1h · PSX`), drawn large and muted behind the candles.
   */
  readonly heading?: string;
  /**
   * When the newest bar closes, in epoch ms, while a live stream is open.
   * Drawn as the countdown on the price axis; a stored session passes null
   * and no countdown is drawn.
   */
  readonly barEndsAtMs?: number | null;
}

export function drawChart(
  context: CanvasRenderingContext2D,
  input: RenderInput,
): void {
  const theme = input.theme ?? DARK_THEME;
  const { width, height, dpr } = input;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = theme.background;
  context.fillRect(0, 0, width, height);

  const paneOutputs = input.panes ?? [];
  const frame = geometryFor(width, height,
    Math.min(paneOutputs.length, 8));
  const plotWidth = frame.plotRight - frame.plotLeft;
  if (plotWidth <= 10) {
    return;
  }

  const { series } = input;
  const window = series.window(input.fromMs, input.toMs);
  const visible = window.to - window.from + 1;
  // The packed-session slot: every visible bar gets an equal share of the
  // plot, whatever wall-clock time it carries, so a quiet stock and the
  // overnight between sessions cost exactly one slot each instead of hours.
  const slot = plotWidth / Math.max(1, visible);
  const xOf = (index: number): number =>
    frame.plotLeft + (index - window.from + 0.5) * slot;

  drawSessionBreaks(context, input, frame, theme, window, slot);
  drawGaps(context, input, frame, theme, window, slot);

  if (series.length === 0 || visible <= 0) {
    context.fillStyle = theme.muted;
    context.font = "13px 'Segoe UI', system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText("no bars for this symbol yet",
      frame.plotLeft + plotWidth / 2, frame.plotTop + (frame.plotBottom - frame.plotTop) / 2);
    drawTimeAxis(context, input, frame, theme, window, xOf, slot);
    context.textAlign = "left";
    return;
  }

  const prices = series.priceRange(window.from, window.to);
  const overlayMinMax = overlayRange(input.overlays ?? [], series, window);
  const low = Math.min(prices.min, overlayMinMax?.min ?? prices.min);
  const high = Math.max(prices.max, overlayMinMax?.max ?? prices.max);
  const pad = (high - low || Math.max(0.01, high * 0.01)) * 0.08;
  const priceScale = linearScale([low - pad, high + pad],
    [frame.plotBottom, frame.plotTop]);
  const volumeMax = series.maxVolume(window.from, window.to);

  drawPriceGrid(context, frame, priceScale, { min: low, max: high }, pad,
    theme);
  drawWatermark(context, input, frame, theme);
  drawTimeAxis(context, input, frame, theme, window, xOf, slot);
  drawVolumePane(context, input, frame, window, slot, volumeMax, theme);
  drawCandles(context, input, window, xOf, slot, priceScale, theme);
  drawPrints(context, input, frame, window, xOf, priceScale, theme);
  drawOverlays(context, input, frame, window, xOf, slot, priceScale,
    theme);
  drawIndicatorPanes(context, input, frame, window, xOf, slot, theme);
  drawLastPrice(context, input, frame, priceScale, window, theme);

  if (input.crosshair) {
    drawCrosshair(context, input, frame, priceScale, theme, input.crosshair);
  }
}

/**
 * The symbol headline, drawn large and muted behind everything.
 *
 * The watermark is the signature a reader recognises before they read any
 * number on the chart: symbol, timeframe and venue in big grey type. It
 * paints before the candles, so it sits behind them and never competes
 * with the price for attention.
 */
function drawWatermark(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  theme: RendererTheme,
): void {
  const heading = input.heading;
  if (heading === undefined || heading.length === 0) {
    return;
  }
  context.save();
  context.font = "300 30px 'Segoe UI', system-ui, sans-serif";
  context.fillStyle = theme.watermark;
  context.textAlign = "left";
  context.textBaseline = "middle";
  const middle = (frame.plotTop + frame.volumeTop) / 2;
  context.fillText(heading, frame.plotLeft + 16, middle);
  context.restore();
}

// ------------------------------------------------------------------ pieces

/**
 * The order prints, drawn on the candles they belong to.
 *
 * One dot per print, at its own price, on the bar slot its time falls
 * into. The mapping is honest by construction: prints are timed facts and
 * the chart is a packed-slot series, so a print draws on the bar active
 * when it printed, the same rule the drawn candle itself follows. A print
 * at a price off this window's scale is skipped, not clamped - pulling a
 * dot onto the canvas would misplace a real trade.
 *
 * The newest print wears a ring, so "an order just came" is visible at a
 * glance without any animation the frame loop would have to sustain.
 */
function drawPrints(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  window: { from: number; to: number },
  xOf: (index: number) => number,
  priceScale: (value: number) => number,
  theme: RendererTheme,
): void {
  const prints = input.prints;
  if (prints === undefined || prints.length === 0) {
    return;
  }
  context.save();
  for (let i = 0; i < prints.length; i += 1) {
    const event = prints[i];
    if (event === undefined || !Number.isFinite(event.price) ||
        !Number.isFinite(timeMs(event.t))) {
      continue;
    }
    const index = input.series.indexAtOrBefore(timeMs(event.t));
    if (index < Math.max(0, window.from) || index > window.to) {
      continue;
    }
    const y = priceScale(event.price);
    if (y < frame.plotTop - 2 || y > frame.volumeBottom + 2) {
      continue;
    }
    const x = xOf(index);
    const colour = event.change === "down" ? theme.down
      : event.change === "up" ? theme.up : theme.muted;
    const newest = i === prints.length - 1;
    const radius = newest ? 4.5 : 3;
    context.beginPath();
    context.fillStyle = colour;
    context.globalAlpha = 0.85;
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    if (newest) {
      context.globalAlpha = 1;
      context.strokeStyle = colour;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(x, y, radius + 3, 0, Math.PI * 2);
      context.stroke();
    }
  }
  context.restore();
}

/** Inclusive index window of one visible stretch of bars. */
interface SlotWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * The vertical line where one session ends and the next begins.
 *
 * Packed bars hide the passage of days, so the chart says it out loud: a
 * quiet vertical line through every pane, and a date label on the axis. The
 * first bar of the series is not a break (nothing ended to its left inside
 * this window), and a break is drawn even while its slot is empty, because
 * the boundary is between bars, not at one.
 */
function drawSessionBreaks(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  theme: RendererTheme,
  window: SlotWindow,
  slot: number,
): void {
  const { series } = input;
  if (series.length === 0) {
    return;
  }
  context.save();
  context.textAlign = "left";
  context.textBaseline = "top";
  for (let index = window.from + 1; index <= window.to; index += 1) {
    const bar = series.at(index);
    const before = series.at(index - 1);
    if (bar === undefined || before === undefined) {
      continue;
    }
    if (dayOfMs(bar.timeMs) === dayOfMs(before.timeMs)) {
      continue;
    }
    const left = frame.plotLeft + (index - window.from) * slot;
    if (left < frame.plotLeft - slot || left > frame.plotRight + slot) {
      continue;
    }
    context.strokeStyle = theme.sessionLine;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(Math.round(left) + 0.5, frame.plotTop);
    context.lineTo(Math.round(left) + 0.5, frame.timeAxisTop);
    context.stroke();
  }
  context.restore();
}

function drawPriceGrid(
  context: CanvasRenderingContext2D,
  frame: ChartGeometry,
  priceScale: (value: number) => number,
  prices: { min: number; max: number },
  pad: number,
  theme: RendererTheme,
): void {
  const ticks = niceTicks(prices.min - pad, prices.max + pad, 6);
  const decimals = decimalsFor(ticks.step);
  context.font = "11px 'Segoe UI', system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  for (const value of ticks.values) {
    const y = Math.round(priceScale(value)) + 0.5;
    context.strokeStyle = theme.grid;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(frame.plotLeft, y);
    context.lineTo(frame.plotRight, y);
    context.stroke();
    context.fillStyle = theme.axisText;
    context.fillText(formatPrice(value, decimals), frame.plotRight + 6, y);
  }
  // The separator between plot and price axis, the line every terminal has.
  context.strokeStyle = theme.grid;
  context.beginPath();
  context.moveTo(Math.round(frame.plotRight) + 0.5, frame.plotTop);
  context.lineTo(Math.round(frame.plotRight) + 0.5, frame.timeAxisTop);
  context.stroke();
}

/**
 * The time axis, labelled along the packed bars.
 *
 * Labels sit on bars at a fixed pixel stride, so they move with the candles
 * when the reader pans and never drift into empty clock time that holds no
 * bar. The label position is anchored to the series (index mod stride), so
 * the same bar stays under the same time while the window slides.
 */
function drawTimeAxis(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  theme: RendererTheme,
  window: SlotWindow,
  xOf: (index: number) => number,
  slot: number,
): void {
  const { series } = input;
  const visible = window.to - window.from + 1;
  // Every fillText is wrapped: axis text lives at the very bottom of the
  // canvas, and one leaked fill style from an earlier drawing piece would
  // silently paint it invisible.
  const label = (text: string, x: number, y: number, size = 11): void => {
    context.save();
    context.font = `${size}px 'Segoe UI', system-ui, sans-serif`;
    context.fillStyle = theme.axisText;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    const width = context.measureText(text).width;
    const clamped = Math.min(frame.plotRight - width / 2,
                             Math.max(frame.plotLeft + width / 2, x));
    context.fillText(text, clamped, y);
    context.restore();
  };
  if (series.length === 0 || visible <= 0) {
    // No bars: keep the classic even clock labels along the window, so an
    // empty frame still shows which stretch of time was asked for.
    const labels = 6;
    const spanMs = input.toMs - input.fromMs;
    for (let step = 0; step <= labels; step += 1) {
      const moment = input.fromMs + (spanMs * step) / labels;
      const x = frame.plotLeft + ((frame.plotRight - frame.plotLeft) * step) / labels;
      const iso = new Date(moment).toISOString();
      const text = spanMs > 36 * 3_600_000 ? formatDay(iso) : formatClock(iso);
      label(text, x, frame.timeAxisTop);
    }
  } else {
    // Where one packed session ends and the next begins, the axis says the
    // date like every professional terminal does: dates on the joins, clock
    // times elsewhere, never one crowding the other.
    const dayStarts = new Map<number, string>();
    for (let index = Math.max(1, window.from); index <= window.to; index += 1) {
      const bar = series.at(index);
      const before = series.at(index - 1);
      if (bar === undefined || before === undefined) {
        continue;
      }
      if (dayOfMs(bar.timeMs) !== dayOfMs(before.timeMs)) {
        dayStarts.set(index, formatDay(new Date(bar.timeMs).toISOString()));
      }
    }
    const clockLabelBlocked = (x: number): boolean => {
      for (const startIndex of dayStarts.keys()) {
        if (Math.abs(x - xOf(startIndex)) < 36) {
          return true;
        }
      }
      return false;
    };
    const maxLabels = Math.max(2, Math.floor((frame.plotRight - frame.plotLeft) / 84));
    const stride = Math.max(1, Math.ceil(visible / maxLabels));
    // Anchor on the series, not on the window's left edge, so labels do not
    // slide under the candles while panning.
    const start = window.from + (stride - (window.from % stride)) % stride;
    for (let index = start; index <= window.to; index += stride) {
      const bar = series.at(index);
      if (bar === undefined || dayStarts.has(index) ||
          clockLabelBlocked(xOf(index))) {
        continue;
      }
      label(formatClock(new Date(bar.timeMs).toISOString()), xOf(index),
        frame.timeAxisTop - 2);
    }
    for (const [startIndex, text] of dayStarts) {
      label(text, xOf(startIndex), frame.timeAxisTop - 2, 10.5);
    }
  }
  void slot;
}

/**
 * A measured missing stretch, shaded and labelled.
 *
 * On a packed chart a hole in a session occupies exactly one empty slot (the
 * hours it names exist between its neighbouring bars, and the axes say how
 * long they were), so the shade is one slot wide and the label carries the *
 * measured minutes-of-absence the server computed.
 */
function drawGaps(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  theme: RendererTheme,
  window: SlotWindow,
  slot: number,
): void {
  const gaps = gapsInWindow(input.gaps, input.fromMs, input.toMs);
  if (gaps.length === 0) {
    return;
  }
  context.font = "10px 'Segoe UI', system-ui, sans-serif";
  const slotLeft = (index: number): number =>
    frame.plotLeft + (index - window.from) * slot;
  for (const gap of gaps) {
    // The bars around the gap bound the empty slot in the packed chart. The
    // first bar at or after the gap's end is the slot the shade may reach;
    // before it, the gap is outside this window.
    const firstAfter = input.series.indexAtOrBefore(
      new Date(gap.end).getTime()) + 1;
    if (firstAfter <= 0 || firstAfter > window.to) {
      continue;
    }
    const left = slotLeft(firstAfter);
    const width = Math.max(2, slot);
    const height = frame.volumeBottom - frame.plotTop;
    context.fillStyle = theme.gapFill;
    context.fillRect(left, frame.plotTop, width, height);
    if (width > 34) {
      context.fillStyle = theme.gapText;
      context.textAlign = "left";
      context.fillText(`${Math.round(gap.minutes)}m gap`, left + 3, frame.plotTop + 10);
    }
  }
  context.textAlign = "left";
}

function overlayRange(
  outputs: readonly IndicatorOutput[],
  series: ColumnSeries,
  window: { from: number; to: number },
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const output of outputs) {
    for (const line of output.lines) {
      for (let index = Math.max(0, window.from);
           index <= window.to && index < series.length; index += 1) {
        const value = line.values[index] ?? Number.NaN;
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function drawLineSeries(
  context: CanvasRenderingContext2D,
  series: ColumnSeries,
  values: Float64Array,
  window: { from: number; to: number },
  xOf: (index: number) => number,
  yScale: (value: number) => number,
  color: string,
  width = 1.5,
): void {
  context.save();
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineJoin = "round";
  let drawing = false;
  for (let index = Math.max(0, window.from);
       index <= window.to && index < series.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    if (!Number.isFinite(value)) {
      drawing = false;
      continue;
    }
    const bar = series.at(index);
    if (bar === undefined) {
      continue;
    }
    const x = xOf(index);
    const y = yScale(value);
    if (drawing) {
      context.lineTo(x, y);
    } else {
      context.moveTo(x, y);
      drawing = true;
    }
  }
  context.stroke();
  context.restore();
}

function drawOverlays(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  window: { from: number; to: number },
  xOf: (index: number) => number,
  slot: number,
  priceScale: (value: number) => number,
  theme: RendererTheme,
): void {
  for (const output of input.overlays ?? []) {
    for (const line of output.lines) {
      drawLineSeries(context, input.series, line.values, window, xOf,
        priceScale, line.color, 1.4);
    }
  }
  // A small legend, so a line is never an anonymous squiggle.
  const outputs = (input.overlays ?? []).filter((item) => item.lines.length > 0);
  if (outputs.length === 0) {
    return;
  }
  context.save();
  context.font = "10px 'Segoe UI', system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "top";
  let x = frame.plotLeft + 4;
  let y = frame.plotTop + 22;
  for (const output of outputs) {
    const line = output.lines[0];
    if (line === undefined) {
      continue;
    }
    const label = output.label;
    const width = context.measureText(label).width;
    if (x + width + 18 > frame.plotRight) {
      x = frame.plotLeft + 4;
      y += 13;
    }
    context.fillStyle = line.color;
    context.fillRect(x, y + 3, 7, 2);
    context.fillStyle = theme.muted;
    context.fillText(label, x + 11, y);
    x += width + 22;
  }
  context.restore();
  void slot;
}

function drawIndicatorPanes(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  window: { from: number; to: number },
  xOf: (index: number) => number,
  slot: number,
  theme: RendererTheme,
): void {
  const outputs = input.panes ?? [];
  const count = Math.min(outputs.length, frame.panes.length);
  for (let index = 0; index < count; index += 1) {
    const output = outputs[index];
    const pane = frame.panes[index];
    if (output === undefined || pane === undefined) {
      continue;
    }
    drawIndicatorPane(context, input, frame, pane, output, window,
      xOf, slot, theme);
  }
}

function paneRange(
  output: IndicatorOutput,
  series: ColumnSeries,
  window: { from: number; to: number },
): { min: number; max: number } {
  if (output.range !== undefined && output.range !== null) {
    return { min: output.range[0], max: output.range[1] };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const line of output.lines) {
    for (let index = Math.max(0, window.from);
         index <= window.to && index < series.length; index += 1) {
      const value = line.values[index] ?? Number.NaN;
      if (Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  const histogram = output.histogram;
  if (histogram !== undefined) {
    for (let index = Math.max(0, window.from);
         index <= window.to && index < series.length; index += 1) {
      const value = histogram.values[index] ?? Number.NaN;
      if (Number.isFinite(value)) {
        min = Math.min(min, value, 0);
        max = Math.max(max, value, 0);
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (min === max) {
    const pad = Math.abs(max) * 0.05 || 1;
    return { min: min - pad, max: max + pad };
  }
  return { min, max };
}

function drawIndicatorPane(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  pane: PaneFrame,
  output: IndicatorOutput,
  window: { from: number; to: number },
  xOf: (index: number) => number,
  slot: number,
  theme: RendererTheme,
): void {
  context.save();
  context.fillStyle = theme.background;
  context.fillRect(frame.plotLeft, pane.top, frame.plotRight - frame.plotLeft,
    pane.bottom - pane.top);
  context.strokeStyle = theme.grid;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(frame.plotLeft, Math.round(pane.top) + 0.5);
  context.lineTo(frame.plotRight, Math.round(pane.top) + 0.5);
  context.stroke();

  const range = paneRange(output, input.series, window);
  const fixed = output.range !== undefined && output.range !== null;
  const pad = fixed ? 0 : (range.max - range.min) * 0.06;
  const low = range.min - pad;
  const high = range.max + pad;
  const yScale = linearScale([low, high], [pane.bottom - 3, pane.top + 14]);
  const zeroY = yScale(0);

  context.font = "10px 'Segoe UI', system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "top";
  context.fillStyle = theme.muted;
  context.fillText(output.label, frame.plotLeft + 4, pane.top + 3);

  // Reference lines make RSI and stochastic readable at a glance.
  if (output.range !== undefined && output.range !== null) {
    const [lowGuide, highGuide] = output.range[0] === 0 && output.range[1] === 100
      ? [30, 70] : [null, null];
    context.save();
    context.setLineDash([3, 4]);
    context.strokeStyle = theme.grid;
    for (const guide of [lowGuide, highGuide]) {
      if (guide === null) {
        continue;
      }
      const y = Math.round(yScale(guide)) + 0.5;
      context.beginPath();
      context.moveTo(frame.plotLeft, y);
      context.lineTo(frame.plotRight, y);
      context.stroke();
    }
    context.restore();
  } else if (low < 0 && high > 0) {
    context.save();
    context.setLineDash([2, 4]);
    context.strokeStyle = theme.grid;
    context.beginPath();
    context.moveTo(frame.plotLeft, Math.round(zeroY) + 0.5);
    context.lineTo(frame.plotRight, Math.round(zeroY) + 0.5);
    context.stroke();
    context.restore();
  }

  context.save();
  context.beginPath();
  context.rect(frame.plotLeft, pane.top + 12,
    frame.plotRight - frame.plotLeft, pane.bottom - pane.top - 14);
  context.clip();

  const histogram = output.histogram;
  if (histogram !== undefined) {
    const bodyWidth = Math.max(1, Math.min(10, slot * 0.6));
    const base = Math.min(pane.bottom - 3, Math.max(pane.top + 14, zeroY));
    for (let index = Math.max(0, window.from);
         index <= window.to && index < input.series.length; index += 1) {
      const value = histogram.values[index] ?? Number.NaN;
      if (!Number.isFinite(value)) {
        continue;
      }
      const y = yScale(value);
      context.fillStyle = value >= 0 ? histogram.positive : histogram.negative;
      context.fillRect(xOf(index) - bodyWidth / 2,
        Math.min(y, base), bodyWidth, Math.max(1, Math.abs(base - y)));
    }
  }

  for (const line of output.lines) {
    drawLineSeries(context, input.series, line.values, window, xOf,
      yScale, line.color, 1.3);
  }
  context.restore();

  // Two labels on the shared price axis, enough to read the pane's scale.
  const decimals = decimalsFor((high - low) / 2);
  context.fillStyle = theme.axisText;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(formatPrice(fixed ? range.max : high, decimals),
    frame.plotRight + 4, pane.top + 14);
  context.fillText(formatPrice(fixed ? range.min : low, decimals),
    frame.plotRight + 4, pane.bottom - 4);
  context.restore();
}

function drawCandles(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  window: { from: number; to: number },
  xOf: (index: number) => number,
  slot: number,
  priceScale: (value: number) => number,
  theme: RendererTheme,
): void {
  // TradingView's candle proportion: the body takes most of the slot with
  // a thin air gap between neighbours, so a dense chart reads as candles
  // rather than a row of touch hairlines. Two pixels is still a body, not
  // a dot: under that the drawn shape is the wick alone.
  const bodyWidth = Math.max(2, Math.min(22, Math.round(slot * 0.85)));
  for (let index = window.from; index <= window.to; index += 1) {
    const bar = input.series.at(index);
    if (bar === undefined) {
      continue;
    }
    const rising = bar.c >= bar.o;
    const colour = rising ? theme.up : theme.down;
    const x = Math.round(xOf(index));
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineWidth = 1;
    // The wick first, the full high-low span, pixel centred. The body
    // paints over its middle afterwards, exactly like the references
    // a reader knows.
    context.beginPath();
    context.moveTo(x + 0.5, Math.round(priceScale(bar.h)));
    context.lineTo(x + 0.5, Math.round(priceScale(bar.l)));
    context.stroke();
    if (bodyWidth < 2) {
      // Smaller than two pixels a body adds nothing a coloured tick has
      // not already said; the wick alone keeps the shape readable.
      continue;
    }
    const top = Math.round(priceScale(Math.max(bar.o, bar.c)));
    const bottom = Math.round(priceScale(Math.min(bar.o, bar.c)));
    const height = Math.max(1, bottom - top);
    context.fillRect(x - Math.floor((bodyWidth - 1) / 2), top, bodyWidth,
      height);
  }
}

/**
 * The volume pane: its divider, its own scale label, and the columns.
 *
 * The pane is drawn even when there is no volume to draw, because the label
 * is the point: "volume not reported by this source" is a fact the reader
 * needs, and an empty strip with no explanation is not.
 */
function drawVolumePane(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  window: { from: number; to: number },
  slot: number,
  volumeMax: number,
  theme: RendererTheme,
): void {
  context.save();
  context.strokeStyle = theme.grid;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(frame.plotLeft, Math.round(frame.volumeTop) + 0.5);
  context.lineTo(frame.plotRight, Math.round(frame.volumeTop) + 0.5);
  context.stroke();
  context.restore();

  context.font = "10px 'Segoe UI', system-ui, sans-serif";
  context.fillStyle = theme.axisText;
  context.textAlign = "left";
  context.textBaseline = "top";
  const reported = input.volumeAvailable !== false && volumeMax > 0;
  context.fillText(reported ? `volume ${formatVolume(volumeMax)}` :
    "volume not reported by this source", frame.plotLeft + 4,
    frame.volumeTop + 3);
  context.textBaseline = "alphabetic";
  if (!reported) {
    return;
  }

  const bodyWidth = Math.max(1, Math.min(16, slot * 0.75));
  // The label sits in the top of the pane, so the columns start below it.
  const top = frame.volumeTop + 14;
  const height = Math.max(4, frame.volumeBottom - top);
  for (let index = window.from; index <= window.to; index += 1) {
    const bar = input.series.at(index);
    if (bar === undefined) {
      continue;
    }
    const barHeight = Math.max(0.5, height * (bar.v / volumeMax));
    const x = frame.plotLeft + (index - window.from + 0.5) * slot;
    context.fillStyle = bar.c >= bar.o ? theme.volumeUp : theme.volumeDown;
    context.fillRect(x - bodyWidth / 2, frame.volumeBottom - barHeight,
      bodyWidth, barHeight);
  }
}

function drawLastPrice(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  priceScale: (value: number) => number,
  window: { from: number; to: number },
  theme: RendererTheme,
): void {
  const last = input.series.at(window.to);
  if (last === undefined) {
    return;
  }
  const y = Math.round(priceScale(last.c)) + 0.5;
  context.save();
  context.setLineDash([4, 4]);
  context.strokeStyle = theme.lastLine;
  context.beginPath();
  context.moveTo(frame.plotLeft, y);
  context.lineTo(frame.plotRight, y);
  context.stroke();
  context.restore();

  const label = formatPrice(last.c, 2);
  context.font = "11px 'Segoe UI', system-ui, sans-serif";
  const width = context.measureText(label).width + 10;
  context.fillStyle = last.c >= last.o ? theme.up : theme.down;
  context.fillRect(frame.plotRight + 2, y - 8, width, 16);
  context.fillStyle = theme.background;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(label, frame.plotRight + 7, y);
  context.textBaseline = "alphabetic";
  drawCountdown(context, input, frame, y, width, theme);
}

/**
 * The bar-close countdown, under the last price on the axis.
 *
 * The TradingView detail a live reader homes in on: how long the newest
 * candle still has to form. Only drawn while a live stream says the bar
 * is closing; a stored session has no living bar and stays silent.
 */
function drawCountdown(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  lastY: number,
  priceLabelWidth: number,
  theme: RendererTheme,
): void {
  const ends = input.barEndsAtMs;
  if (ends === undefined || ends === null || !Number.isFinite(ends)) {
    return;
  }
  const remain = Math.round((ends - Date.now()) / 1000);
  if (remain < 0) {
    return;
  }
  const hours = Math.floor(remain / 3600);
  const minutes = Math.floor((remain % 3600) / 60);
  const seconds = remain % 60;
  const label = hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
  const width = Math.max(priceLabelWidth, context.measureText(label).width + 12);
  const top = lastY + 8;
  context.fillStyle = theme.background;
  context.fillRect(frame.plotRight + 2, top, width, 15);
  context.strokeStyle = theme.crosshair;
  context.strokeRect(frame.plotRight + 2.5, top + 0.5, width, 14);
  context.fillStyle = theme.axisText;
  context.font = "10.5px 'Segoe UI', system-ui, sans-serif";
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(label, frame.plotRight + 7, top + 8);
  context.textBaseline = "alphabetic";
}

function drawCrosshair(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  priceScale: (value: number) => number,
  theme: RendererTheme,
  crosshair: Crosshair,
): void {
  const bar = input.series.at(crosshair.index);
  if (bar === undefined) {
    return;
  }
  context.save();
  context.strokeStyle = theme.crosshair;
  context.lineWidth = 1;
  context.setLineDash([3, 3]);
  context.beginPath();
  context.moveTo(Math.round(crosshair.x) + 0.5, frame.plotTop);
  context.lineTo(Math.round(crosshair.x) + 0.5, frame.timeAxisTop);
  context.moveTo(frame.plotLeft, Math.round(crosshair.y) + 0.5);
  context.lineTo(frame.plotRight, Math.round(crosshair.y) + 0.5);
  context.stroke();
  context.restore();

  const readout =
    `${formatDay(new Date(bar.timeMs).toISOString())} ` +
    `${formatClock(new Date(bar.timeMs).toISOString())}  ` +
    `O ${formatPrice(bar.o)}  H ${formatPrice(bar.h)}  ` +
    `L ${formatPrice(bar.l)}  C ${formatPrice(bar.c)}  V ${formatVolume(bar.v)}`;
  context.font = "11px 'Segoe UI', system-ui, sans-serif";
  const width = context.measureText(readout).width + 12;
  context.fillStyle = theme.background;
  context.globalAlpha = 0.92;
  context.fillRect(frame.plotLeft, frame.plotTop, width, 18);
  context.globalAlpha = 1;
  context.fillStyle = theme.muted;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(readout, frame.plotLeft + 6, frame.plotTop + 9);
  context.textBaseline = "alphabetic";

  // The price under the pointer, on the same axis the candles use.
  const pointerPrice = priceFromY(priceScale, crosshair.y, frame);
  if (pointerPrice !== null) {
    context.fillStyle = theme.crosshair;
    context.fillRect(frame.plotRight + 2, crosshair.y - 8,
      frame.priceAxisWidth - 2, 16);
    context.fillStyle = theme.background;
    context.fillText(formatPrice(pointerPrice, 2), frame.plotRight + 6,
      crosshair.y);
  }
}

/** Invert a price scale for the pointer's y, clamped to the plot. */
function priceFromY(
  priceScale: (value: number) => number,
  y: number,
  frame: ChartGeometry,
): number | null {
  if (y < frame.plotTop || y > frame.plotBottom) {
    return null;
  }
  const domain = (priceScale as unknown as { domain?: readonly [number, number] })
    .domain;
  const range = (priceScale as unknown as { range?: readonly [number, number] })
    .range;
  if (domain === undefined || range === undefined) {
    return null;
  }
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (r1 === r0) {
    return null;
  }
  const ratio = (y - r0) / (r1 - r0);
  return d0 + ratio * (d1 - d0);
}
