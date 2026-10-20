/**
 * The canvas renderer.
 *
 * One function draws one frame. It reads a window of the series, decides the
 * candle width from the space actually available, and paints. It never
 * touches React state, never allocates per bar, and never draws a candle
 * outside the plot: that is what keeps a live chart at frame rate while bars
 * keep arriving.
 *
 * The two honesty features the server asked for are drawn literally:
 * measured gaps are shaded across the plot with their minute count, and an
 * empty window says "no bars for this symbol yet" on the canvas rather than
 * showing an empty price axis that could be mistaken for a flat market.
 */

import type { Gap } from "../api/types";
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
  readonly muted: string;
}

export const DARK_THEME: RendererTheme = {
  background: "#0e1116",
  grid: "#1c2330",
  axisText: "#8b98ab",
  up: "#2fbf71",
  down: "#e05252",
  volumeUp: "rgba(47, 191, 113, 0.35)",
  volumeDown: "rgba(224, 82, 82, 0.35)",
  gapFill: "rgba(139, 152, 171, 0.10)",
  gapText: "rgba(139, 152, 171, 0.75)",
  crosshair: "#5b6474",
  lastLine: "#8b98ab",
  muted: "#8b98ab",
};

/** The light theme. The same drawing code, read on a bright screen. */
export const LIGHT_THEME: RendererTheme = {
  background: "#ffffff",
  grid: "#e6eaef",
  axisText: "#5b6474",
  up: "#14884f",
  down: "#c02b2b",
  volumeUp: "rgba(20, 136, 79, 0.28)",
  volumeDown: "rgba(192, 43, 43, 0.28)",
  gapFill: "rgba(91, 100, 116, 0.10)",
  gapText: "rgba(91, 100, 116, 0.85)",
  crosshair: "#8b98ab",
  lastLine: "#5b6474",
  muted: "#5b6474",
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
  const priceAxisWidth = 62;
  const timeAxisHeight = 20;
  const padding = 6;
  const usable = Math.max(60, height - timeAxisHeight - padding * 2);
  const count = clamp(Math.floor(paneCount), 0, 8);
  const volumeHeight = clamp(usable * 0.18, 24, 88);
  let paneTotal = count > 0
    ? Math.min(usable * 0.42, count * 58)
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
  const timeScale = linearScale([input.fromMs, input.toMs],
    [frame.plotLeft, frame.plotRight]);

  drawGaps(context, input, frame, timeScale, theme);

  if (series.length === 0 || visible <= 0) {
    context.fillStyle = theme.muted;
    context.font = "13px ui-sans-serif, system-ui, sans-serif";
    context.textAlign = "center";
    context.fillText("no bars for this symbol yet",
      frame.plotLeft + plotWidth / 2, frame.plotTop + (frame.plotBottom - frame.plotTop) / 2);
    drawTimeAxis(context, input, frame, theme);
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
  const slot = plotWidth / Math.max(1, visible);

  drawPriceGrid(context, frame, priceScale, { min: low, max: high }, pad,
    theme);
  drawTimeAxis(context, input, frame, theme);
  drawVolumePane(context, input, frame, window, timeScale, volumeMax, theme);
  drawCandles(context, input, frame, window, timeScale, priceScale, theme);
  drawOverlays(context, input, frame, window, timeScale, priceScale,
    theme);
  drawIndicatorPanes(context, input, frame, window, timeScale, slot, theme);
  drawLastPrice(context, input, frame, priceScale, window, theme);

  if (input.crosshair) {
    drawCrosshair(context, input, frame, priceScale, theme, input.crosshair);
  }
}

// ------------------------------------------------------------------ pieces

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
  context.font = "11px ui-sans-serif, system-ui, sans-serif";
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
}

function drawTimeAxis(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  theme: RendererTheme,
): void {
  const labels = 6;
  const spanMs = input.toMs - input.fromMs;
  const crossesDay = formatDay(new Date(input.fromMs).toISOString()) !==
    formatDay(new Date(input.toMs).toISOString());
  const wide = spanMs > 36 * 3_600_000;
  context.font = "11px ui-sans-serif, system-ui, sans-serif";
  context.fillStyle = theme.axisText;
  context.textAlign = "center";
  context.textBaseline = "top";
  for (let step = 0; step <= labels; step += 1) {
    const moment = input.fromMs + (spanMs * step) / labels;
    const x = frame.plotLeft + ((frame.plotRight - frame.plotLeft) * step) / labels;
    const iso = new Date(moment).toISOString();
    const text = wide
      ? formatDay(iso)
      : crossesDay && step === 0
        ? `${formatDay(iso)} ${formatClock(iso)}`
        : formatClock(iso);
    const width = context.measureText(text).width;
    const clamped = Math.min(
      frame.plotRight - width / 2,
      Math.max(frame.plotLeft + width / 2, x),
    );
    context.fillText(text, clamped, frame.timeAxisTop + 2);
  }
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
}

function drawGaps(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  timeScale: (value: number) => number,
  theme: RendererTheme,
): void {
  const gaps = gapsInWindow(input.gaps, input.fromMs, input.toMs);
  if (gaps.length === 0) {
    return;
  }
  context.font = "10px ui-sans-serif, system-ui, sans-serif";
  for (const gap of gaps) {
    const left = timeScale(timeMs(gap.start));
    const right = timeScale(timeMs(gap.end) + 60_000);
    const width = Math.max(2, right - left);
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
  timeScale: (value: number) => number,
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
    // Anchor every series at its timestamp. Adding half a slot here was
    // harmless on a dense chart but pushed a single bar off the right edge:
    // the slot can be the whole plot when only one bar is in view.
    const x = timeScale(bar.timeMs);
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
  timeScale: (value: number) => number,
  priceScale: (value: number) => number,
  theme: RendererTheme,
): void {
  for (const output of input.overlays ?? []) {
    for (const line of output.lines) {
      drawLineSeries(context, input.series, line.values, window, timeScale,
        priceScale, line.color, 1.4);
    }
  }
  // A small legend, so a line is never an anonymous squiggle.
  const outputs = (input.overlays ?? []).filter((item) => item.lines.length > 0);
  if (outputs.length === 0) {
    return;
  }
  context.save();
  context.font = "10px ui-sans-serif, system-ui, sans-serif";
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
}

function drawIndicatorPanes(
  context: CanvasRenderingContext2D,
  input: RenderInput,
  frame: ChartGeometry,
  window: { from: number; to: number },
  timeScale: (value: number) => number,
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
      timeScale, slot, theme);
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
  timeScale: (value: number) => number,
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

  context.font = "10px ui-sans-serif, system-ui, sans-serif";
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
      const bar = input.series.at(index);
      if (!Number.isFinite(value) || bar === undefined) {
        continue;
      }
      const y = yScale(value);
      context.fillStyle = value >= 0 ? histogram.positive : histogram.negative;
      context.fillRect(timeScale(bar.timeMs) - bodyWidth / 2,
        Math.min(y, base), bodyWidth, Math.max(1, Math.abs(base - y)));
    }
  }

  for (const line of output.lines) {
    drawLineSeries(context, input.series, line.values, window, timeScale,
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
  frame: ChartGeometry,
  window: { from: number; to: number },
  timeScale: (value: number) => number,
  priceScale: (value: number) => number,
  theme: RendererTheme,
): void {
  const visible = window.to - window.from + 1;
  const slot = (frame.plotRight - frame.plotLeft) / Math.max(1, visible);
  const bodyWidth = Math.max(1, Math.min(14, slot * 0.7));
  const half = bodyWidth / 2;
  for (let index = window.from; index <= window.to; index += 1) {
    const bar = input.series.at(index);
    if (bar === undefined) {
      continue;
    }
    const rising = bar.c >= bar.o;
    const colour = rising ? theme.up : theme.down;
    const x = timeScale(bar.timeMs);
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(Math.round(x) + 0.5, priceScale(bar.h));
    context.lineTo(Math.round(x) + 0.5, priceScale(bar.l));
    context.stroke();
    const top = priceScale(Math.max(bar.o, bar.c));
    const bottom = priceScale(Math.min(bar.o, bar.c));
    const height = Math.max(1, bottom - top);
    context.fillRect(x - half, top, bodyWidth, height);
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
  timeScale: (value: number) => number,
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

  context.font = "10px ui-sans-serif, system-ui, sans-serif";
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

  const visible = window.to - window.from + 1;
  const slot = (frame.plotRight - frame.plotLeft) / Math.max(1, visible);
  const bodyWidth = Math.max(1, Math.min(14, slot * 0.7));
  // The label sits in the top of the pane, so the columns start below it.
  const top = frame.volumeTop + 14;
  const height = Math.max(4, frame.volumeBottom - top);
  for (let index = window.from; index <= window.to; index += 1) {
    const bar = input.series.at(index);
    if (bar === undefined) {
      continue;
    }
    const barHeight = Math.max(0.5, height * (bar.v / volumeMax));
    const x = timeScale(bar.timeMs);
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
  context.font = "11px ui-sans-serif, system-ui, sans-serif";
  const width = context.measureText(label).width + 10;
  context.fillStyle = last.c >= last.o ? theme.up : theme.down;
  context.fillRect(frame.plotRight + 2, y - 8, width, 16);
  context.fillStyle = theme.background;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(label, frame.plotRight + 7, y);
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
    `${formatClock(new Date(bar.timeMs).toISOString())}  ` +
    `O ${formatPrice(bar.o)}  H ${formatPrice(bar.h)}  ` +
    `L ${formatPrice(bar.l)}  C ${formatPrice(bar.c)}  V ${formatVolume(bar.v)}`;
  context.font = "11px ui-sans-serif, system-ui, sans-serif";
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
    context.fillStyle = "#0e1116";
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
