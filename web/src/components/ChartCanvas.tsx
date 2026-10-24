/**
 * The chart surface: TradingView's own engine, bound to the PSX tape.
 *
 * The renderer is the genuine thing: `lightweight-charts` is TradingView's
 * open-source chart (Apache-2.0, the same renderer behind their quick
 * charts), so pan, zoom, the price scale, the crosshair, the packed candles
 * and the attached volume pane are drawn by their code, themed to TV's
 * exact dark tokens (#131722 chart, #1e222d grid, #089981 up, #f23645
 * down, #758696 crosshair, Trebuchet MS text).
 *
 * The drawing rule survives from the previous renderer: React re-renders
 * for metadata only, the engine owns the pixels, and a pointer move goes
 * through one subscription that writes a DOM node, never a rendered tree.
 * The tape owns time exactly as before: bars live in the Karachi clock and
 * reach the engine as UTC seconds, with the tick marks labelled explicitly
 * in Asia/Karachi, so a viewer in any zone reads the exchange's clock.
 *
 * The honesty features keep their place: an empty window says so on the
 * chart, and the order tape (the venue's own counters) is the floating
 * surface that draws when the tape has something to show.
 */

import {
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  LineStyle,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
  ColorType,
  createChart,
  createSeriesMarkers,
  createTextWatermark,
} from "lightweight-charts";
import {
  useEffect,
  useMemo,
  useRef,
} from "react";

import type { Gap, PrintEvent, PrintTotals, Resolution } from "../api/types";
import {
  measureBetween,
  newDrawingId,
  type AnchoredPoint,
  type Drawing,
  type DrawTool,
  type MeasureResult,
} from "../chart/drawings";
import {
  anchorAt,
  frameFor,
  paintOverlay,
} from "../chart/overlay";
import { formatClock, formatPrice, formatVolume } from "../chart/format";
import { type ColumnSeries, timeMs } from "../chart/series";
import type {
  IndicatorOutput,
  IndicatorSpec,
  SeriesData,
} from "../indicators/types";
import { computeIndicators, seriesData } from "../indicators/compute";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const TAPE_ROWS = 9;
const RIGHT_OFFSET_BARS = 5;

/** The chart's colour tokens, TV's exact values. */
export interface TvTheme {
  readonly background: string;
  readonly grid: string;
  readonly text: string;
  readonly border: string;
  readonly up: string;
  readonly down: string;
  readonly volumeUp: string;
  readonly volumeDown: string;
  readonly crosshair: string;
  readonly labelBack: string;
  readonly watermark: string;
}

/** TradingView's dark chart, token for token. */
export const TV_DARK_THEME: TvTheme = {
  background: "#131722",
  grid: "#1e222d",
  text: "#d1d4dc",
  border: "#2a2e39",
  up: "#089981",
  down: "#f23645",
  volumeUp: "rgba(8, 153, 129, 0.45)",
  volumeDown: "rgba(242, 54, 69, 0.45)",
  crosshair: "#758696",
  labelBack: "#363a45",
  watermark: "rgba(120, 123, 134, 0.18)",
};

/** The same drawing code read on a bright screen. */
export const TV_LIGHT_THEME: TvTheme = {
  background: "#ffffff",
  grid: "#e0e3eb",
  text: "#131722",
  border: "#d7dce3",
  up: "#089981",
  down: "#f23645",
  volumeUp: "rgba(8, 153, 129, 0.30)",
  volumeDown: "rgba(242, 54, 69, 0.30)",
  crosshair: "#9598a1",
  labelBack: "#f0f3fa",
  watermark: "rgba(120, 123, 134, 0.14)",
};

export function tvTheme(mode: "dark" | "light"): TvTheme {
  return mode === "light" ? TV_LIGHT_THEME : TV_DARK_THEME;
}

export interface ChartCanvasProps {
  readonly series: ColumnSeries;
  readonly gaps: readonly Gap[];
  readonly resolution: Resolution;
  /** Symbol, session and timeframe: a new value means a new chart. */
  readonly viewKey: string;
  readonly version: number;
  readonly volumeAvailable: boolean;
  readonly theme: "dark" | "light";
  /** A sentence for the accessible description: which session is on screen. */
  readonly sessionLabel: string;
  /** What to say when there is nothing to draw, and why. */
  readonly emptyNote: string;
  /** Configured indicators; unlimited overlays, up to eight panes. */
  readonly indicators: readonly IndicatorSpec[];
  /** Order prints the tape carried, drawn as markers on their candles. */
  readonly prints?: readonly PrintEvent[];
  /** The venue's own session counters, for the on-chart order tape. */
  readonly printTotals?: PrintTotals | null;
  /** The chart headline, TV-style: `PRL · 1h · PSX` watermark. */
  readonly heading?: string;
  /** True while a live stream is open; the chart itself does not need it. */
  readonly live?: boolean;
  /** The active drawing tool, or "cursor" when the chart is being read. */
  readonly tool?: DrawTool;
  /** Committed drawings on this chart, oldest first. */
  readonly drawings?: readonly Drawing[];
  /** Every drawing hidden, the eye toggle. */
  readonly drawingsHidden?: boolean;
  /** A drawing the reader just committed: the note belongs to the app. */
  readonly onDrawingComplete?: (drawing: Drawing) => void;
}

interface PaneRef {
  readonly lines: readonly ISeriesApi<"Line", Time>[];
  readonly histogram?: ISeriesApi<"Histogram", Time>;
}

type MarkerApi = {
  setMarkers(markers: SeriesMarker<Time>[]): void;
};

interface EngineState {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<"Candlestick", Time>;
  readonly volume: ISeriesApi<"Histogram", Time> | null;
  readonly markers: MarkerApi | null;
  readonly panes: Map<string, PaneRef>;
  /** epoch-second → bar index, for the legend's previous close. */
  readonly index: Map<number, number>;
  readonly volumeShown: boolean;
  data: SeriesData | null;
}

/** decimals the tape's own closes use, so the axis is exact. */
function decimalsFrom(values: readonly number[]): number {
  let best = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }
    const text = value.toString();
    const dot = text.indexOf(".");
    const digits = dot === -1 ? 0 : text.length - dot - 1;
    if (digits > best) {
      best = Math.min(digits, 4);
    }
  }
  return best;
}

const karachiClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const karachiStamp = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const karachiDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
});

export function ChartCanvas(props: ChartCanvasProps) {
  const {
    series,
    resolution,
    viewKey,
    version,
    volumeAvailable,
    theme,
    sessionLabel,
    emptyNote,
    indicators,
    prints,
    printTotals,
    heading,
    live,
    tool,
    drawings,
    drawingsHidden,
    onDrawingComplete,
  } = props;
  void live; // the status bar owns liveness; the chart owns candles
  void props.gaps; // the status bar owns the gap ledger; see it there


  const wrapper = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const legend = useRef<HTMLDivElement | null>(null);
  const engine = useRef<EngineState | null>(null);
  const didFit = useRef(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  // The drawing overlay: its canvas, the capture in progress and one
  // batched repaint, so a pointer move costs one frame, not a render.
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    kind: "trend" | "flatTop" | "flatBottom" | "measure";
    a: AnchoredPoint;
    b: AnchoredPoint | null;
  } | null>(null);
  const paintQueued = useRef(false);

  const showSeconds = resolution === "1s" || resolution === "10s";

  /** TV's tick marks and axis: the Karachi clock, whatever the viewer's PC. */
  const tickLabel = useMemo(() => {
    const secondsFormat = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return (time: Time): string => {
      const ms = Number(time) * 1000;
      const moment = new Date(ms);
      if (Number.isNaN(moment.getTime())) {
        return "";
      }
      return showSeconds ? secondsFormat.format(moment)
        : karachiClock.format(moment);
    };
  }, [showSeconds]);

  /** The indicator plan: the chart engine rebuilds when the plan changes. */
  const indicatorsKey = useMemo(
    () => indicators
      .map((spec) =>
        `${spec.id}:${spec.type}:${spec.placement ?? ""}:${spec.color}:` +
        `${JSON.stringify(spec.params)}`)
      .join("|"),
    [indicators],
  );

  useEffect(() => {
    const surfaceEl = surface.current;
    if (surfaceEl === null) {
      return;
    }
    const tokens = tvTheme(themeRef.current);

    // The decimals come from the tape's own closes, before any axis print.
    const columns = series.columns();
    const decimals = decimalsFrom(Array.from(columns.close));

    const chart = createChart(surfaceEl, {
      width: surfaceEl.clientWidth || MIN_WIDTH,
      height: surfaceEl.clientHeight || MIN_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: tokens.background },
        textColor: tokens.text,
        fontFamily: "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif",
        panes: { separatorColor: tokens.border },
      },
      grid: {
        vertLines: { color: tokens.grid },
        horzLines: { color: tokens.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: tokens.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: tokens.labelBack,
        },
        horzLine: {
          color: tokens.crosshair,
          width: 1,
          style: LineStyle.Dashed,
          labelBackgroundColor: tokens.labelBack,
        },
      },
      rightPriceScale: {
        borderColor: tokens.border,
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: tokens.border,
        rightOffset: RIGHT_OFFSET_BARS,
        barSpacing: 8,
        timeVisible: true,
        secondsVisible: showSeconds,
        tickMarkFormatter:
          (time: Time) => tickLabel(time),
      },
      localization: {
        priceFormatter: (price: number) => formatPrice(price, decimals),
      },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: tokens.up,
      downColor: tokens.down,
      wickUpColor: tokens.up,
      wickDownColor: tokens.down,
      borderVisible: false,
      priceLineVisible: true,
      priceLineColor: tokens.crosshair,
      priceLineStyle: LineStyle.Dashed,
      lastValueVisible: true,
    });

    let volume: ISeriesApi<"Histogram", Time> | null = null;
    if (volumeAvailable) {
      chart.addPane();
      const volumeSeries = chart.addSeries(
        HistogramSeries,
        {
          priceScaleId: "right",
          priceLineVisible: false,
          lastValueVisible: false,
          base: 0,
        },
        1,
      );
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.6, bottom: 0 },
      });
      volume = volumeSeries;
    }

    // The TV watermark: the symbol, then the timeframe, behind the candles.
    if (heading !== undefined && heading.length > 0) {
      const parts = heading.split("·");
      const symbolLine = (parts[0] ?? "").trim();
      const restLine = parts.slice(1).join("·").trim();
      const pricePane = chart.panes()[0];
      if (pricePane !== undefined) {
        createTextWatermark(pricePane, {
          horzAlign: "center",
          vertAlign: "center",
          lines: [
            { text: symbolLine, color: tokens.watermark, fontSize: 44 },
            ...(restLine.length > 0
              ? [{ text: restLine, color: tokens.watermark, fontSize: 26 }]
              : []),
          ],
        });
      }
    }

    const markersApi = createSeriesMarkers(candles, []);

    // The pointer readout: one browser callback, one DOM write, no renders.
    const onCrosshair = (param: MouseEventParams) => {
      const state = engine.current;
      const legendEl = legend.current;
      if (state === null || legendEl === null) {
        return;
      }
      if (param.time === undefined || param.point === undefined) {
        // Left the chart: the legend falls back to the newest bar.
        const last = state.data === null ? undefined
          : state.data.length - 1;
        writeLegend(state, last, legendEl, volumeAvailable);
        return;
      }
      writeLegend(state, state.index.get(Number(param.time)),
        legendEl, volumeAvailable);
    };
    chart.subscribeCrosshairMove(onCrosshair);

    const resize = () => {
      chart.applyOptions({
        width: Math.max(MIN_WIDTH, surfaceEl.clientWidth),
        height: Math.max(MIN_HEIGHT, surfaceEl.clientHeight),
      });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surfaceEl);
    resize();

    // Pan or zoom moves the drawings too: repaint once per viewport change.
    const rangeSub = () => scheduleOverlayPaint();
    chart.timeScale().subscribeVisibleTimeRangeChange(rangeSub);

    engine.current = {
      chart,
      candles,
      volume,
      markers: markersApi as unknown as MarkerApi,
      panes: new Map(),
      index: new Map(),
      volumeShown: volumeAvailable,
      data: null,
    };
    didFit.current = false;

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleTimeRangeChange(rangeSub);
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      engine.current = null;
    };
    // The full build is keyed to the chart's identity only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, indicatorsKey, theme, volumeAvailable]);

  /**
   * The data effect: every bar version flows through setData on the
   * engine's series, prints become markers, indicator series are built on
   * a fresh engine or fed their own series, and the legend reads the
   * newest bar. Exactly the pattern the engine docs prescribe.
   */
  useEffect(() => {
    const state = engine.current;
    if (state === null || series.length === 0) {
      return;
    }
    const tokens = tvTheme(themeRef.current);
    const data = seriesData(series);
    const length = data.time.length;
    if (length === 0) {
      return;
    }

    state.data = data;
    state.index.clear();
    for (let i = 0; i < length; i += 1) {
      const t = data.time[i];
      if (t !== undefined) {
        state.index.set(Math.floor(t / 1000), i);
      }
    }

    const candlesData: CandlestickData[] = new Array(length);
    for (let i = 0; i < length; i += 1) {
      const t = data.time[i];
      const open = data.open[i];
      const high = data.high[i];
      const low = data.low[i];
      const close = data.close[i];
      if (t === undefined || open === undefined || high === undefined
        || low === undefined || close === undefined) {
        continue;
      }
      candlesData[i] = {
        time: (t / 1000) as UTCTimestamp,
        open,
        high,
        low,
        close,
      };
    }
    state.candles.setData(candlesData);

    if (state.volumeShown && state.volume !== null) {
      const volumeData: HistogramData[] = new Array(length);
      for (let i = 0; i < length; i += 1) {
        const t = data.time[i];
        const open = data.open[i];
        const close = data.close[i];
        const value = data.volume[i];
        if (t === undefined || open === undefined || close === undefined
          || value === undefined) {
          continue;
        }
        volumeData[i] = {
          time: (t / 1000) as UTCTimestamp,
          value,
          color: close >= open ? tokens.volumeUp : tokens.volumeDown,
        };
      }
      state.volume.setData(volumeData);
    }

    if (state.markers !== null) {
      state.markers.setMarkers(
        printMarkers(data, prints, tokens),
      );
    }

    buildIndicators(state, indicators, data, tokens);

    const legendEl = legend.current;
    if (legendEl !== null) {
      writeLegend(state, length - 1, legendEl, state.volumeShown);
    }

    if (!didFit.current) {
      didFit.current = true;
      state.chart.timeScale().fitContent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const hasBars = series.length > 0;
  const activeTool = tool ?? "cursor";
  const drawingActive = activeTool !== "cursor";

  useEffect(() => {
    if (!drawingActive) {
      const pressed = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          dragRef.current = null;
          scheduleOverlayPaint();
        }
      };
      window.addEventListener("keydown", pressed, { capture: true });
      return () =>
        window.removeEventListener("keydown", pressed, { capture: true });
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawingActive]);

  useEffect(() => {
    scheduleOverlayPaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, drawings, drawingsHidden, version, viewKey]);

  const scheduleOverlayPaint = () => {
    if (paintQueued.current) {
      return;
    }
    paintQueued.current = true;
    requestAnimationFrame(() => {
      paintQueued.current = false;
      paintOverlayNow();
    });
  };

  const paintOverlayNow = () => {
    const canvas = overlay.current;
    const wrapperEl = wrapper.current;
    const state = engine.current;
    if (canvas === null || wrapperEl === null || state === null) {
      return;
    }
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cssWidth = wrapperEl.clientWidth;
    const cssHeight = wrapperEl.clientHeight;
    if (canvas.width !== Math.round(cssWidth * dpr)
      || canvas.height !== Math.round(cssHeight * dpr)) {
      canvas.width = Math.round(cssWidth * dpr);
      canvas.height = Math.round(cssHeight * dpr);
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame = frameFor(state.chart, cssWidth, cssHeight);
    const drag = dragRef.current;
    const midDrag: MeasureResult | null = drag !== null
      && drag.kind === "measure" && drag.b !== null
      ? measureBetween(drag.a, drag.b)
      : null;
    paintOverlay(context, state.chart, state.candles, frame, {
      drawings: drawings ?? [],
      hidden: drawingsHidden ?? false,
      toolColor: "#2962ff",
      midDrag,
    });
    if (drag !== null) {
      paintLive(context, state.chart, state.candles, frame, drag);
    }
  };

  const paintLive = (
    context: CanvasRenderingContext2D,
    chart: ReturnType<typeof createChart>,
    candles: ISeriesApi<"Candlestick", Time>,
    frame: ReturnType<typeof frameFor>,
    drag: NonNullable<typeof dragRef.current>,
  ) => {
    if (drag.b === null) {
      return;
    }
    if (drag.kind === "measure") {
      return; // painted by paintOverlay's measure block
    }
    const points: [AnchoredPoint, AnchoredPoint | null] =
      drag.kind === "flatTop" || drag.kind === "flatBottom"
        // A flat never slants: hold the first anchor's level.
        ? [{ t: drag.a.t, price: drag.a.price },
           { t: drag.b.t, price: drag.a.price }]
        : [drag.a, drag.b];
    paintOne(context, chart, candles, frame, {
      id: "live",
      kind: drag.kind,
      points,
    });
  };

  const onOverlayDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const state = engine.current;
    if (state === null || !drawingActive) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const anchor = anchorAt(state.chart, state.candles, x, y);
    if (anchor === null) {
      return;
    }
    if (activeTool === "hline" || activeTool === "hray") {
      const drawing: Drawing = {
        id: newDrawingId(),
        kind: activeTool,
        points: [anchor, null],
      };
      onDrawingComplete?.(drawing);
      return;
    }
    dragRef.current = {
      kind: activeTool === "trend" ? "trend"
        : activeTool === "flatTop" ? "flatTop"
        : activeTool === "flatBottom" ? "flatBottom"
        : "measure",
      a: anchor,
      b: null,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A synthetic pointer (assistive or test) cannot be captured; keep it.
    }
    scheduleOverlayPaint();
  };

  const onOverlayMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const state = engine.current;
    if (drag === null || state === null) {
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const anchor = anchorAt(
      state.chart,
      state.candles,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    if (anchor !== null) {
      drag.b = anchor;
      scheduleOverlayPaint();
    }
  };

  const onOverlayUp = () => {
    const drag = dragRef.current;
    const state = engine.current;
    if (drag === null || state === null) {
      return;
    }
    dragRef.current = null;
    if (drag.kind === "measure") {
      scheduleOverlayPaint();
      return; // a measure is read, never kept
    }
    const points: [AnchoredPoint, AnchoredPoint | null] =
      drag.kind === "flatTop" || drag.kind === "flatBottom"
        ? [{ t: drag.a.t, price: drag.a.price },
           drag.b === null
             ? null
             : { t: drag.b.t, price: drag.a.price }]
        : [drag.a, drag.b];
    onDrawingComplete?.({
      id: newDrawingId(),
      kind: drag.kind,
      points,
    });
    scheduleOverlayPaint();
  };

  return (
    <div className="chart tv-chart" ref={wrapper}>
      <div
        ref={surface}
        className="chart__canvas chart__tv"
        tabIndex={0}
        aria-label={`candlestick chart. ${sessionLabel} ${series.length} bars. ` +
          "Drag to pan, wheel to zoom."}
        data-bars={series.length}
      />
      {!hasBars ? (
        <p className="chart__empty" role="status">
          {emptyNote}
        </p>
      ) : null}
      {/* The TV legend: OHLC + change, live under the pointer. */}
      <div className="tv-legend" ref={legend} aria-live="off" />
      {/* The drawing overlay: interactive only while a tool is picked, so
          reading (pan, zoom, crosshair) is never blocked by it. */}
      <canvas
        ref={overlay}
        className="tv-overlay"
        style={drawingActive
          ? { pointerEvents: "auto", cursor: "crosshair" }
          : { pointerEvents: "none" } as React.CSSProperties}
        onPointerDown={onOverlayDown}
        onPointerMove={onOverlayMove}
        onPointerUp={onOverlayUp}
        onPointerCancel={onOverlayUp}
        aria-hidden={drawingActive ? "false" : "true"}
        aria-label={drawingActive
          ? "drawing surface: click or drag to place the selected tool"
          : "drawings"}
      />
      {printTape(prints, printTotals)}
    </div>
  );
}

/**
 * The TV legend, written straight into one DOM node. Every field wears the
 * bar's own colour: teal above the prior close, red below, grey when flat.
 * When the series carries a volume counter the readout ends with it.
 */
function writeLegend(
  state: EngineState,
  at: number | undefined,
  legendEl: HTMLElement,
  withVolume: boolean,
): void {
  if (at === undefined || state.data === null
    || at < 0 || at >= state.data.length) {
    return;
  }
  const i = at;
  const close = state.data.close[i];
  if (close === undefined) {
    return;
  }
  const priorRaw = i > 0 ? state.data.close[i - 1] : close;
  const prior = priorRaw ?? close;
  const change = close - prior;
  const changePct = prior !== 0 ? (change / prior) * 100 : 0;
  const tone = change > 0 ? "var(--tv-up)" : change < 0
    ? "var(--tv-down)" : "var(--tv-muted)";
  const stampMs = state.data.time[i];
  if (stampMs === undefined) {
    return;
  }
  const colour = (value: number): string => {
    const previous = i > 0 ? (state.data!.close[i - 1] ?? value) : value;
    const own = value - previous;
    return own > 0 ? "var(--tv-up)" : own < 0 ? "var(--tv-down)"
      : "var(--tv-muted)";
  };
  const open = state.data.open[i] ?? close;
  const high = state.data.high[i] ?? close;
  const low = state.data.low[i] ?? close;
  const stampedVolume = state.data.volume[i] ?? Number.NaN;

  const volumeHtml = withVolume && state.volumeShown
    ? `<span class="tv-legend__field">V <b>` +
      `${formatVolume(stampedVolume)}</b></span>`
    : "";
  legendEl.innerHTML =
    `<span class="tv-legend__stamp">` +
    karachiStamp.format(new Date(stampMs)) +
    ` <span class="tv-legend__day">` +
    karachiDay.format(new Date(stampMs)) + `</span></span>` +
    `<span class="tv-legend__field">O <b style="color:${colour(open)}">` +
    `${formatPrice(open, 2)}</b></span>` +
    `<span class="tv-legend__field">H <b style="color:${colour(high)}">` +
    `${formatPrice(high, 2)}</b></span>` +
    `<span class="tv-legend__field">L <b style="color:${colour(low)}">` +
    `${formatPrice(low, 2)}</b></span>` +
    `<span class="tv-legend__field">C <b style="color:${colour(close)}">` +
    `${formatPrice(close, 2)}</b></span>` +
    `<span class="tv-legend__field" style="color:${tone}">` +
    `${change >= 0 ? "+" : ""}${formatPrice(change, 2)} ` +
    `(${change >= 0 ? "+" : ""}${changePct.toFixed(2)}%)</span>` +
    volumeHtml;
}

// ---------------------------------------------------------------------------
// Live-shape paint: the mid-drag line, through the kept painter.
// ---------------------------------------------------------------------------

function paintOne(
  context: CanvasRenderingContext2D,
  chart: ReturnType<typeof createChart>,
  candles: ISeriesApi<"Candlestick", Time>,
  frame: ReturnType<typeof frameFor>,
  shape: Drawing,
): void {
  // The live shape draws through the same painter as the kept ones.
  paintOverlay(context, chart, candles, frame, {
    drawings: [shape],
    hidden: false,
    toolColor: "#2962ff",
    midDrag: null,
  });
}

// ---------------------------------------------------------------------------
// Order prints as TV-style markers
// ---------------------------------------------------------------------------

/**
 * A print rides the candle that was active when it printed — the same rule
 * the one-minute fold keeps — as a teal dot (buyer lifted) or a red dot
 * (seller hit) set on the bar it belongs to. Snap by matching time, in
 * order, to the bar whose own minute window covers the print.
 */
function printMarkers(
  data: SeriesData,
  prints: readonly PrintEvent[] | undefined,
  tokens: TvTheme,
): SeriesMarker<Time>[] {
  if (prints === undefined || prints.length === 0 || data.time.length === 0) {
    return [];
  }
  const markers: SeriesMarker<Time>[] = [];
  for (let i = 0; i < prints.length; i += 1) {
    const event = prints[i];
    if (event === undefined) {
      continue;
    }
    const ms = timeMs(event.t);
    if (!Number.isFinite(ms)) {
      continue;
    }
    // The bar whose time is the greatest one at or before this print.
    let lo = 0;
    let hi = data.time.length - 1;
    const first = data.time[0];
    if (first === undefined || ms < first) {
      continue; // before the tape watched: no bar owns it
    }
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const midT = data.time[mid];
      if (midT !== undefined && midT <= ms) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    const barT = data.time[lo];
    if (barT === undefined) {
      continue;
    }
    const newest = i === prints.length - 1;
    const buy = event.side === "B";
    const sell = event.side === "S";
    markers.push({
      time: (barT / 1000) as UTCTimestamp,
      position: sell ? "belowBar" : "inBar",
      shape: "circle",
      color: buy ? tokens.up : sell ? tokens.down : tokens.crosshair,
      size: newest ? 2 : 1,
      text: "",
    });
  }
  return markers;
}

// ---------------------------------------------------------------------------
// Indicator panes
// ---------------------------------------------------------------------------

/**
 * The indicators, on the chart the TV way: an overlay indicator paints on
 * the price pane, a pane indicator owns its own pane beneath the volume,
 * the first one starting at pane 2 (0 price, 1 volume). This runs on a
 * freshly built engine or on new bars; series then exist once and feed.
 */
function buildIndicators(
  state: EngineState,
  specs: readonly IndicatorSpec[],
  data: SeriesData,
  tokens: TvTheme,
): void {
  void tokens;
  const outputs = computeIndicators(specs, data);
  let nextPane = state.volumeShown ? 2 : 1;
  for (const output of outputs) {
    if (output.error !== undefined) {
      continue;
    }
    const isPane = output.placement === "pane";
    const existing = state.panes.get(output.id);
    if (existing !== undefined) {
      for (let li = 0; li < output.lines.length && li < existing.lines.length; li += 1) {
        const priorLine = existing.lines[li];
        const nextLine = output.lines[li];
        if (priorLine !== undefined && nextLine !== undefined) {
          priorLine.setData(lineData(data, nextLine.values));
        }
      }
      if (existing.histogram !== undefined && output.histogram !== undefined) {
        existing.histogram.setData(histData(data, output));
      }
      continue;
    }

    const paneIndex = isPane ? nextPane : 0;
    if (isPane) {
      state.chart.addPane();
      nextPane += 1;
    }
    const    lines: ISeriesApi<"Line", Time>[] = [];
    for (const line of output.lines) {
      const points = lineData(data, line.values);
      if (points.length === 0) {
        continue;
      }
      const lineSeries = state.chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: isPane && output.lines.length === 1,
      }, paneIndex);
      lineSeries.setData(points);
      fixRange(lineSeries, output.range);
      lines.push(lineSeries);
    }
    let histogram: ISeriesApi<"Histogram", Time> | undefined;
    if (output.histogram !== undefined) {
      const bars = histData(data, output);
      if (bars.length > 0) {
        histogram = state.chart.addSeries(HistogramSeries, {
          priceLineVisible: false,
          lastValueVisible: false,
        }, paneIndex);
        histogram.setData(bars);
        fixRange(histogram, output.range);
      }
    }
    const ref: PaneRef = histogram === undefined
      ? { lines }
      : { lines, histogram };
    state.panes.set(output.id, ref);
  }
}

/** A fixed indicator range (RSI 0-100) pins its pane's scale. */
function fixRange(    series: ISeriesApi<"Line", Time> | ISeriesApi<"Histogram", Time>,
  range: readonly [number, number] | null | undefined,
): void {
  if (range === undefined || range === null) {
    return;
  }
  (series as unknown as ISeriesApi<"Line", Time>).applyOptions({
    autoscaleInfoProvider: () => ({
      priceRange: {
        minValue: range[0],
        maxValue: range[1],
      },
    }),
  });
}

function lineData(data: SeriesData, values: Float64Array): LineData[] {
  const length = Math.min(data.time.length, values.length);
  const points: LineData[] = [];
  for (let i = 0; i < length; i += 1) {
    const value = values[i];
    const t = data.time[i];
    if (value === undefined || t === undefined || !Number.isFinite(value)) {
      continue; // the warm-up bars an indicator does not have yet
    }
    points.push({ time: (t / 1000) as UTCTimestamp, value });
  }
  return points;
}

function histData(
  data: SeriesData,
  output: IndicatorOutput,
): HistogramData[] {
  const histogram = output.histogram;
  if (histogram === undefined) {
    return [];
  }
  const length = Math.min(data.time.length, histogram.values.length);
  const points: HistogramData[] = [];
  for (let i = 0; i < length; i += 1) {
    const value = histogram.values[i];
    const t = data.time[i];
    if (value === undefined || t === undefined || !Number.isFinite(value)) {
      continue;
    }
    points.push({
      time: (t / 1000) as UTCTimestamp,
      value,
      color: value >= 0 ? histogram.positive : histogram.negative,
    });
  }
  return points;
}

// ---------------------------------------------------------------------------
// The order tape, TV-styled
// ---------------------------------------------------------------------------

/**
 * The order tape: the venue's own counters and the newest prints, floating
 * over the chart. It draws when the tape has either prints or counters to
 * show, and nothing when it has neither — no empty box.
 */
function printTape(
  prints: readonly PrintEvent[] | undefined,
  printTotals: PrintTotals | null | undefined,
): React.ReactNode {
  const hasPrints = prints !== undefined && prints.length > 0;
  const hasCounters = printTotals != null
    && [printTotals.buy_volume, printTotals.sell_volume,
        printTotals.volume, printTotals.orders]
      .some((value) =>
        value !== null && Number.isFinite(value) && value > 0);
  if (!hasPrints && !hasCounters) {
    return null;
  }
  return (
    <div className="chart__tape" aria-label="order tape, newest first">
      <div className="chart__tape__head">order tape</div>
      {printTotals != null ? (
        <div className="chart__tape__totals">
          {printTotals.buy_volume !== null
            && Number.isFinite(printTotals.buy_volume)
            && printTotals.buy_volume > 0
            ? (
              <span className="chart__tape__buy">
                buy {formatVolume(printTotals.buy_volume)}
              </span>
            )
            : null}
          {printTotals.sell_volume !== null
            && Number.isFinite(printTotals.sell_volume)
            && printTotals.sell_volume > 0
            ? (
              <span className="chart__tape__sell">
                sell {formatVolume(printTotals.sell_volume)}
              </span>
            )
            : null}
          {printTotals.volume !== null && Number.isFinite(printTotals.volume)
            ? (
              <span className="chart__tape__vol">
                vol {formatVolume(printTotals.volume)}
              </span>
            )
            : null}
          {printTotals.orders !== null && Number.isFinite(printTotals.orders)
            ? (
              <span className="chart__tape__orders">
                {formatVolume(printTotals.orders)} orders
              </span>
            )
            : null}
        </div>
      ) : null}
      {(prints ?? []).slice(-TAPE_ROWS).reverse().map((row, index) => {
        const sideClass = row.side === "B"
          ? " chart__tape__row--buy"
          : row.side === "S"
            ? " chart__tape__row--sell"
            : "";
        return (
          <div
            key={`${row.t}:${index}`}
            className={`chart__tape__row${sideClass}`}
          >
            <span className="chart__tape__time">{formatClock(row.t)}</span>
            <span className="chart__tape__price">{formatPrice(row.price)}</span>
            <span className="chart__tape__size">
              {row.size !== null && Number.isFinite(row.size)
                ? formatVolume(row.size)
                : ""}
            </span>
            <span className="chart__tape__side">
              {row.side === "B" ? "buy" : row.side === "S" ? "sell" : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}
