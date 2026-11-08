/**
 * The chart surface: TradingView's own engine, bound to the PSX tape.
 *
 * The renderer is `lightweight-charts`, TradingView's open-source engine
 * (Apache-2.0), so pan, zoom, the price scale, the crosshair and the candles
 * are drawn by their code. The plate is true black (#000) with one step of
 * separation for the grid (#141414) and the borders (#1f1f1f), the candles
 * are TV's own teal (#089981) and red (#f23645), the crosshair is #758696
 * and the type is Trebuchet MS. Their attribution badge is switched off: the
 * chart is the owner's, and nothing here links off the page.
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
  type Time,
  type UTCTimestamp,
  TickMarkType,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  CrosshairMode,
  ColorType,
  createChart,
  createTextWatermark,
} from "lightweight-charts";
import {
  useEffect,
  useMemo,
  useRef,
} from "react";

import type {
  DeltaMinute,
  Gap,
  Resolution,
} from "../api/types";
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
  makePositions,
  paintOverlay,
  paintSessionBreaks,
  type OverlayPositions,
  type ProfileBarSource,
} from "../chart/overlay";
import { flowColumns } from "../chart/flow";
import {
  calendarBreaks,
  hasDailyBackfill,
  hasSessionBreaks,
  isIntradayStamp,
  sessionBreaks,
  type SessionBreak,
} from "../chart/sessions";
import { formatPrice, formatVolume } from "../chart/format";
import { type ColumnSeries } from "../chart/series";
import type { ChartAppearance } from "../hooks/useAppearance";
import type {
  IndicatorOutput,
  IndicatorSpec,
  SeriesData,
} from "../indicators/types";
import { computeIndicators, seriesData } from "../indicators/compute";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const RIGHT_OFFSET_BARS = 5;
/** How many bars the chart shows when it opens, TradingView's own window. */
const WINDOW_BARS = 160;

/** The chart's colour tokens: one theme, black, with TV's own candle hues. */
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

/**
 * Black, and only black.
 *
 * The chart used to sit on TV's slate (#131722), which reads grey once it
 * fills a screen. The plate is now true black so the candles, the grid and
 * the axes are the only things with weight on it; the grid and the borders
 * are one step off black so they separate without becoming lines of their
 * own. The candle hues stay TV's own teal and red.
 */
export const TV_DARK_THEME: TvTheme = {
  background: "#000000",
  grid: "#141414",
  text: "#d1d4dc",
  border: "#1f1f1f",
  up: "#089981",
  down: "#f23645",
  volumeUp: "rgba(8, 153, 129, 0.45)",
  volumeDown: "rgba(242, 54, 69, 0.45)",
  crosshair: "#758696",
  labelBack: "#2a2a2a",
  watermark: "rgba(120, 123, 134, 0.16)",
};

export interface ChartCanvasProps {
  readonly series: ColumnSeries;
  readonly gaps: readonly Gap[];
  readonly resolution: Resolution;
  /** Symbol, session and timeframe: a new value means a new chart. */
  readonly viewKey: string;
  readonly version: number;
  readonly volumeAvailable: boolean;
  /**
   * Kept so an older shell still type-checks. The chart has one plate now:
   * true black, in both themes, because the owner asked for black only.
   */
  readonly theme?: "dark" | "light";
  /** A sentence for the accessible description: which session is on screen. */
  readonly sessionLabel: string;
  /** What to say when there is nothing to draw, and why. */
  readonly emptyNote: string;
  /** Configured indicators; unlimited overlays, up to eight panes. */
  readonly indicators: readonly IndicatorSpec[];
  /** The tape's per-minute buy/sell split, for the volume-delta plate. */
  readonly delta?: readonly DeltaMinute[];
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
  /** The settings dialog's appearance: colours and what shows behind price. */
  readonly appearance?: ChartAppearance;
}

interface PaneRef {
  readonly lines: readonly ISeriesApi<"Line", Time>[];
  readonly histogram?: ISeriesApi<"Histogram", Time>;
  /** The study pane this output owns, for the off-switch's removal. */
  readonly pane?: number;
}

interface ChartTimeMap {
  /** Presentation seconds, one per accepted bar, ascending by one. */
  readonly chartSec: readonly number[];
  /** The tape's real instants, parallel to `chartSec`. */
  readonly realMs: readonly number[];
}

interface EngineState {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<"Candlestick", Time>;
  readonly volume: ISeriesApi<"Histogram", Time> | null;
  readonly panes: Map<string, PaneRef>;
  /** epoch-second → bar index, for the legend's previous close. */
  readonly index: Map<number, number>;
  readonly volumeShown: boolean;
  /** The plate under the candles is delta (buy - sell), not raw volume. */
  deltaShown: boolean;
  data: SeriesData | null;
  /** The packed presentation instants, in ms: the drawing clip's bars. */
  barTimes: number[];
  /** The tape's real instants in ms, parallel to `barTimes`. */
  realTimes: number[];
  /** Real ms by data index, NaN where the engine skipped a duplicate. */
  chartTimes: number[];
  /** The real intraday session starts the overlay rules run between. */
  breaks: readonly SessionBreak[];
  /** Month starts across the daily-grain history behind those sessions. */
  calendarBreaks: readonly SessionBreak[];
}

/** The nearest value at or below `value`, or -1 for an empty list. */
function nearestIndex(values: readonly number[], value: number): number {
  if (values.length === 0) {
    return -1;
  }
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((values[mid] ?? Number.POSITIVE_INFINITY) <= value) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** A presentation instant back to the tape's own millisecond instant. */
function realFromChartMs(state: EngineState, chartMs: number): number {
  const firstSec = (state.barTimes[0] ?? 0) / 1000;
  const index = Math.round(chartMs / 1000 - firstSec);
  const bounded = Math.max(0, Math.min(state.realTimes.length - 1, index));
  return state.realTimes[bounded] ?? chartMs;
}

/** A hex colour at an alpha, for the muted volume under the candles. */
function withAlpha(hex: string, alpha: number): string {
  const raw = /^#([0-9a-fA-F]{6})$/.exec(hex);
  const digits = raw?.[1];
  if (digits === undefined) {
    return hex;
  }
  const value = Number.parseInt(digits, 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

const karachiDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "2-digit",
  month: "short",
});

const karachiMonth = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  month: "short",
  year: "numeric",
});

const karachiYear = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  year: "numeric",
});

export function ChartCanvas(props: ChartCanvasProps) {
  const {
    series,
    resolution,
    viewKey,
    version,
    volumeAvailable,
    sessionLabel,
    emptyNote,
    indicators,
    delta,
    heading,
    live,
    tool,
    drawings,
    drawingsHidden,
    onDrawingComplete,
    appearance,
  } = props;
  void live; // the status bar owns liveness; the chart owns candles
  void props.gaps; // the status bar owns the gap ledger; see it there
  void props.theme; // one plate, black; see TV_DARK_THEME

  // A RAF paint must never read a stale closure: the pointer's own commit
  // schedules its repaint before React has handed it the new drawing, and
  // the commit-triggered repaint is then a no-op on the queue flag. Keep
  // the drawing inputs in a ref that every render refreshes; the next
  // frame paints whatever the app holds at frame time.
  const overlayProps = useRef({ drawings, drawingsHidden });
  overlayProps.current = { drawings, drawingsHidden };

  const wrapper = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const legend = useRef<HTMLDivElement | null>(null);
  /** Shown when the reader pans past the oldest bar the tape holds. */
  const historyEdge = useRef<HTMLParagraphElement | null>(null);
  /** Re-run the boundary caption after a data paint, not only on range events. */
  const refreshHistoryEdge = useRef<(() => void) | null>(null);
  const engine = useRef<EngineState | null>(null);
  const engineView = useRef(viewKey);
  /** A view switch owes the next dataset one fit, whatever the old zoom. */
  const fitPending = useRef(false);
  const fitKey = useRef("");
  const fitCount = useRef(0);
  /** Rides the last opening fit, so a late layout cannot undo it. */
  const fitToken = useRef(0);
  /** True once the reader pans, zooms or drags: no fit after that. */
  const zoomed = useRef(false);

  /** The drawing overlay: its canvas, the capture in progress and one
   * batched repaint, so a pointer move costs one frame, not a render. */
  const overlay = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    kind: "trend" | "ob" | "flatTop" | "flatBottom" | "fib" | "profile"
      | "measure";
    a: AnchoredPoint;
    b: AnchoredPoint | null;
  } | null>(null);
  const paintQueued = useRef(false);
  const timeMap = useRef<ChartTimeMap>({ chartSec: [], realMs: [] });

  const showSeconds = resolution === "1s" || resolution === "10s";

  /**
   * TV's tick marks and axis: the Karachi clock, whatever the viewer's PC.
   *
   * A tick that lands on a day's first bar is labelled with the day itself -
   * "23 Oct" - exactly as TV does. Two sessions on one chart otherwise read
   * as a clock that jumps backwards, which is precisely how a merged chart
   * was being misread.
   */
  const tickLabel = useMemo(() => {
    const secondsFormat = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Karachi",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    return (time: Time, markType: TickMarkType): string => {
      const sec = Number(time);
      const map = timeMap.current;
      const index = nearestIndex(map.chartSec, sec);
      const realMs = index >= 0 ? (map.realMs[index] ?? sec * 1000)
        : sec * 1000;
      const moment = new Date(realMs);
      if (Number.isNaN(moment.getTime())) {
        return "";
      }
      // Every calendar rank gets its own rank-appropriate label: a day reads
      // as "23 Oct", a month as "Oct 2025" and a year as "2026", so a
      // decade never shows three ambiguous "23 Oct" stamps at one rank.
      if (markType === TickMarkType.Year) {
        return karachiYear.format(moment);
      }
      if (markType === TickMarkType.Month) {
        return karachiMonth.format(moment);
      }
      // A packed axis has no calendar distance, so the day itself has to be
      // named where a new session begins; otherwise 49 hourly bars have only
      // a month label and every session rule reads the same.
      const dayText = karachiDay.format(moment);
      const before = index > 0 ? map.realMs[index - 1] : undefined;
      if (before !== undefined
          && karachiDay.format(new Date(before)) !== dayText) {
        return dayText;
      }
      if (markType === TickMarkType.DayOfMonth) {
        return dayText;
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
        `${JSON.stringify(spec.params)}:${spec.visible ? "1" : "0"}`)
      .join("|"),
    [indicators],
  );

  /** A one-token identity of the dialog's appearance, for the engine deps. */
  const appearanceKey = useMemo(
    () => appearance === undefined ? "" : JSON.stringify(appearance),
    [appearance],
  );

  useEffect(() => {
    const surfaceEl = surface.current;
    if (surfaceEl === null) {
      return;
    }
    const sameView = engineView.current === viewKey;
    engineView.current = viewKey;
    if (!sameView) {
      fitPending.current = true;
    }
    const tokens = { ...TV_DARK_THEME };
    if (appearance !== undefined) {
      // The volume bars wear the candles' own colours at TV's muted alpha.
      tokens.up = appearance.up;
      tokens.down = appearance.down;
      tokens.volumeUp = withAlpha(appearance.up, 0.45);
      tokens.volumeDown = withAlpha(appearance.down, 0.45);
    }

    // The decimals come from the tape's own closes, before any axis print.
    const columns = series.columns();
    const decimals = decimalsFrom(Array.from(columns.close));

    const chart = createChart(surfaceEl, {
      width: surfaceEl.clientWidth || MIN_WIDTH,
      height: surfaceEl.clientHeight || MIN_HEIGHT,
      layout: {
        background: { type: ColorType.Solid, color: tokens.background },
        textColor: tokens.text,
        // No TV badge, and no link off this page: the chart is the owner's.
        attributionLogo: false,
        fontFamily: "'Trebuchet MS', 'Segoe UI', Verdana, sans-serif",
        panes: { separatorColor: tokens.border },
      },
      // The owner's plate: candles, and nothing ruling the space behind
      // them except the blue dotted session breaks the overlay paints.
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
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
        // Room for the volume bars at the foot of the price pane, so a candle
        // never hides behind them.
        scaleMargins: volumeAvailable
          ? { top: 0.08, bottom: 0.24 }
          : { top: 0.12, bottom: 0.12 },
      },
      timeScale: {
        borderColor: tokens.border,
        rightOffset: RIGHT_OFFSET_BARS,
        barSpacing: 8,
        // The recorder omits non-trading days. A date-proportional axis
        // turns those omissions into large empty slots and makes the same
        // sessions look unrelated at different resolutions. TradingView's
        // continuous tape uses uniform spacing; every real bar gets a slot.
        uniformDistribution: true,
        timeVisible: true,
        secondsVisible: showSeconds,
        tickMarkFormatter:
          (time: Time, markType: TickMarkType) => tickLabel(time, markType),
      },
      localization: {
        priceFormatter: (price: number) => formatPrice(price, decimals),
      },
    });
    // A dev-only handle: a broken pane only shows itself live, so the
    // console needs the engine to name what it built. Production strips it.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__chartsEngine = chart;
    }

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
      // Volume rides an overlay scale of the price pane - no axis of its own,
      // no pane of its own - held to the bottom fifth as TV draws it, so the
      // bars sit under the candles and never stretch the price axis.
      const volumeSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: "",
        priceLineVisible: false,
        lastValueVisible: false,
        base: 0,
        priceFormat: { type: "volume", precision: 0, minMove: 1 },
      });
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      });
      volume = volumeSeries;
    }

    // The TV watermark: the symbol, then the timeframe, behind the candles.
    if (heading !== undefined && heading.length > 0
        && appearance?.watermarkOn !== false) {
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
      // A resize after the fit used to slide the window sideways while the
      // engine held the old bar spacing, so the bars ended as a squeezed
      // band far from the frame's edges (a 17-bar hour chart drew inside
      // 200px of a 1400px pane). While the window is still the chart's own
      // - the reader has not panned or zoomed - re-assert the same logical
      // range at the new width, which is a pure rescale. A reader's own
      // zoom is never touched.
      if (!zoomed.current && fitCount.current > 0) {
        const newest = Math.min(WINDOW_BARS, fitCount.current);
        if (fitCount.current <= WINDOW_BARS) {
          // Every loaded bar fits: fit the whole tape, then open one bar of
          // whitespace on each side. fitContent puts the first candle centre
          // exactly on the left edge, where half of it is clipped.
          chart.timeScale().fitContent();
          chart.timeScale().setVisibleLogicalRange({
            from: -1,
            to: fitCount.current,
          });
        } else {
          // One extra bar on the left keeps the oldest visible candle whole
          // when a reader pans to the start of a longer series.
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, fitCount.current - newest - 1),
            to: fitCount.current - 1 + RIGHT_OFFSET_BARS,
          });
        }
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surfaceEl);
    resize();

    // Any real gesture is the reader taking the window: from then on the
    // chart keeps their zoom, whatever data lands.
    const tookTheWindow = () => {
      zoomed.current = true;
    };
    // Capture, because the engine's own handlers stop short of this div:
    // a wheel zoom must count as the reader taking the window even when the
    // event never bubbles to us.
    surfaceEl.addEventListener("wheel", tookTheWindow,
      { passive: true, capture: true });
    surfaceEl.addEventListener("pointerdown", tookTheWindow, true);

    // Pan or zoom moves the drawings too: repaint once per viewport change.
    // The same callback names the tape's first bar when the viewport is
    // panned into the blank before it, so nothing here has a reason.
    const writeHistoryEdge = () => {
      const el = historyEdge.current;
      const state = engine.current;
      if (el === null || state === null) {
        return;
      }
      const first = state.realTimes[0];
      const firstIntraday = state.realTimes.find(
        (stamp) => isIntradayStamp(stamp, resolution));
      const range = state.chart.timeScale().getVisibleLogicalRange();
      // An intraday tape is shorter than the calendar series behind it.
      // Keep its first recorded day visible as a calm caption, whatever
      // window the reader has chosen; a calendar chart needs no caption.
      const intraday = hasSessionBreaks(resolution);
      const showBoundary = range !== null && intraday;
      if (first === undefined || range === null || !showBoundary) {
        el.hidden = true;
        el.textContent = "";
        return;
      }
      if (firstIntraday !== undefined && firstIntraday !== first) {
        el.textContent = `${resolution} candles from ` +
          karachiDay.format(new Date(firstIntraday)) +
          " · older bars are daily from " +
          karachiDay.format(new Date(first));
      } else if (firstIntraday === undefined) {
        el.textContent = "daily-grain history begins " +
          karachiDay.format(new Date(first)) + " · whole-day bars";
      } else {
        el.textContent = `${resolution} recorded history begins ` +
          karachiDay.format(new Date(first)) + " · older days are in 1D";
      }
      el.hidden = false;
    };
    const rangeSub = () => {
      scheduleOverlayPaint();
      writeHistoryEdge();
    };
    refreshHistoryEdge.current = writeHistoryEdge;
    chart.timeScale().subscribeVisibleTimeRangeChange(rangeSub);

    engine.current = {
      chart,
      candles,
      volume,
      panes: new Map(),
      index: new Map(),
      volumeShown: volumeAvailable,
      deltaShown: false,
      data: null,
      barTimes: [],
      realTimes: [],
      chartTimes: [],
      breaks: [],
      calendarBreaks: [],
    };

    // The price pane is the chart; a study pane beneath it is a detail, so
    // the candles keep the height and the studies share what is left.
    chart.panes()[0]?.setStretchFactor(4);

    // A rebuilt engine draws the bars it already has: a new study must never
    // leave an empty plate waiting for the market to move.
    fitKey.current = "";
    fitCount.current = 0;
    zoomed.current = false;
    // A view switch still has the previous series in the feed for this
    // task. Do not paint it into the new engine and fit its bar count:
    // the incoming series would inherit that stale window. The version
    // bump when the new bars arrive paints and fits them.
    if (sameView) {
      paintData();
    }
    window.setTimeout(writeHistoryEdge, 0);

    return () => {
      refreshHistoryEdge.current = null;
      observer.disconnect();
      surfaceEl.removeEventListener("wheel", tookTheWindow, true);
      surfaceEl.removeEventListener("pointerdown", tookTheWindow, true);
      chart.timeScale().unsubscribeVisibleTimeRangeChange(rangeSub);
      chart.unsubscribeCrosshairMove(onCrosshair);
      chart.remove();
      engine.current = null;
    };
    // The full build is keyed to the chart's identity only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey, indicatorsKey, volumeAvailable, appearanceKey]);

  /**
   * One pass of the tape into the engine: candles, the volume plate, the
   * study series, the legend, and the single fit a new view gets. It runs
   * when bars arrive and again right after an engine is rebuilt, so a rebuild
   * is never a blank chart waiting for the next tick.
   *
   * Times go in strictly increasing order because the engine asserts it: a
   * repeated instant (two sources, one minute) is drawn once, at the newest
   * reading, rather than throwing the whole series away.
   */
  function paintData(): void {
    const state = engine.current;
    if (state === null) {
      return;
    }
    const timeScale = state.chart.timeScale();
    // A reader's zoom is theirs, and the opening fit is the chart's. The
    // tape repaints on every poll and setData re-anchors the engine's scale
    // to its default bar spacing, so hold the logical window now and hand it
    // straight back once the bars are in. Without this, every poll undid a
    // wheel zoom a second after it happened.
    const held = timeScale.getVisibleLogicalRange();
    const base = seriesData(series);
    const length = base.time.length;
    if (length === 0) {
      return;
    }
    // The tape's own split, folded onto the bars this chart is drawing. Only
    // minute-or-coarser charts take it: a five-second candle cannot borrow a
    // minute's split without inventing detail.
    const flow = delta !== undefined && delta.length > 0
      ? flowColumns(delta, base.time, series.stepMs())
      : null;
    const hasFlow = flow !== null && flow.buy.some(Number.isFinite);
    const wantsDelta = indicators.some((item) =>
      item.type === "volumedelta" && item.visible);
    const data: SeriesData = hasFlow
      ? { ...base, buy: flow.buy, sell: flow.sell }
      : base;
    // The delta study owns its own pane (the registry's placement), so the
    // price pane never draws the split twice: with the study on, the plate
    // shows nothing and the candles keep the full height; with it off, the
    // plain volume overlay is the plate again.
    state.deltaShown = wantsDelta;
    const tokens = TV_DARK_THEME;
    state.data = data;
    state.index.clear();

    // The engine places bars by wall-clock time, so a merged session chart
    // would spend most of its width on nights and weekends. Pack the bars
    // into consecutive presentation seconds, keeping the tape's real times
    // beside them for the axis, the rules, the drawings and the legend.
    const accepted: {
      sourceIndex: number;
      realMs: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }[] = [];
    let previous = Number.NEGATIVE_INFINITY;
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
      if (!Number.isFinite(open) || !Number.isFinite(high)
        || !Number.isFinite(low) || !Number.isFinite(close)) {
        continue; // a bar the tape never priced is not a price of zero
      }
      if (t <= previous) {
        continue;
      }
      previous = t;
      accepted.push({
        sourceIndex: i, realMs: t, open, high, low, close,
        volume: data.volume[i] ?? Number.NaN,
      });
    }
    if (accepted.length === 0) {
      state.barTimes = [];
      state.realTimes = [];
      state.chartTimes = [];
      return;
    }
    const baseSec = Math.floor(accepted[0]!.realMs / 1000);
    const chartSec = accepted.map((_bar, index) => baseSec + index);
    const realTimes = accepted.map((bar) => bar.realMs);
    timeMap.current = { chartSec, realMs: realTimes };
    const chartTimes = new Array<number>(length).fill(Number.NaN);
    for (let index = 0; index < accepted.length; index += 1) {
      chartTimes[accepted[index]!.sourceIndex] = (chartSec[index] ?? baseSec) * 1000;
    }
    state.realTimes = realTimes;
    state.chartTimes = chartTimes;
    state.barTimes = accepted.map((_bar, index) =>
      (chartSec[index] ?? baseSec) * 1000);
    state.index.clear();
    const candlesData: CandlestickData[] = [];
    const volumeData: HistogramData[] = [];
    for (let index = 0; index < accepted.length; index += 1) {
      const bar = accepted[index]!;
      const time = (chartSec[index] ?? baseSec) as UTCTimestamp;
      state.index.set(Number(time), bar.sourceIndex);
      candlesData.push({
        time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      });
      if (!wantsDelta && Number.isFinite(bar.volume)) {
        volumeData.push({
          time,
          value: bar.volume,
          color: bar.close >= bar.open ? tokens.volumeUp : tokens.volumeDown,
        });
      }
    }
    const chartMsOf = (realMs: number): number => {
      const index = nearestIndex(realTimes, realMs);
      return (chartSec[Math.max(0, index)] ?? baseSec) * 1000;
    };
    // Session rules follow the exchange's bands, not a mere date change:
    // Friday's two sessions need a rule at the lunch break too. Daily
    // backfill rows are calendar bars stamped at Karachi noon, so the
    // session pass drops them on the rungs that receive that backfill.
    state.breaks = hasSessionBreaks(resolution)
      ? sessionBreaks(realTimes, resolution).map((item): SessionBreak => {
          const moved: SessionBreak = { ...item, t: chartMsOf(item.t) };
          return item.previous === undefined ? moved
            : { ...moved, previous: chartMsOf(item.previous) };
        })
      : [];
    // A coarse rung carries a decade of daily rows behind its real sessions.
    // They have no intraday session boundary to draw, so use one month rule
    // per month instead of one per daily bar; the plan's dense mode spaces
    // those rules and labels them when the viewport is crowded.
    state.calendarBreaks = hasDailyBackfill(resolution)
      ? calendarBreaks(realTimes).map((item): SessionBreak => {
          const moved: SessionBreak = { ...item, t: chartMsOf(item.t) };
          return item.previous === undefined ? moved
            : { ...moved, previous: chartMsOf(item.previous) };
        })
      : [];
    state.candles.setData(candlesData);
    if (state.volumeShown && state.volume !== null) {
      // An empty plate is cleared, not left with stale bars behind the
      // candles when the reader turns the delta study on.
      state.volume.setData(volumeData);
      state.volume.priceScale().applyOptions({
        scaleMargins: state.deltaShown
          ? { top: 0.12, bottom: 0.12 }
          : { top: 0.82, bottom: 0 },
      });
      // The candles' own scale: with the delta pane carrying the split the
      // price pane need not reserve the plate strip; without it the strip
      // keeps the volume bars from hiding behind price.
      state.chart.priceScale("right").applyOptions({
        scaleMargins: state.deltaShown
          ? { top: 0.08, bottom: 0.12 }
          : { top: 0.08, bottom: 0.24 },
      });
    }

    buildIndicators(state, indicators, data, tokens);

    const legendEl = legend.current;
    if (legendEl !== null) {
      writeLegend(state, length - 1, legendEl, state.volumeShown);
    }

    if (held !== null) {
      timeScale.setVisibleLogicalRange(held);
    }

    // Fit in logical bars rather than pixels, so the window is the same
    // whatever width the pane happened to have when the data landed. A view
    // change refits; so does a wider dataset arriving while the reader has
    // not touched the chart (a merged span lands after the live snapshot of
    // one session, and the chart must show the span, not the snapshot). Once
    // the reader pans or zooms, nothing here moves their window again.
    const fit = candlesData.length > fitCount.current
      || candlesData.length < fitCount.current;
    const shouldFit = fitPending.current || fitKey.current !== viewKey
        || (!zoomed.current && fit);
    if (shouldFit) {
      fitPending.current = false;
      fitKey.current = viewKey;
      fitCount.current = candlesData.length;
      // Open on the newest session's own width, not on five days squeezed
      // into a few hundred pixels: at 464 bars a full fit draws one-pixel
      // candles. The earlier sessions are a pan away, which is what a
      // continuous series is for.
      const newest = Math.min(WINDOW_BARS, candlesData.length);
      const showAll = candlesData.length <= WINDOW_BARS;
      const range = {
        from: Math.max(0, candlesData.length - newest - 1),
        to: candlesData.length - 1 + RIGHT_OFFSET_BARS,
      };
      const token = fitToken.current + 1;
      fitToken.current = token;
      const apply = () => {
        // A newer fit, the reader's own gesture, or a rebuilt engine wins.
        if (fitToken.current !== token || zoomed.current
            || engine.current?.chart !== state.chart) {
          return;
        }
        if (showAll) {
          // fitContent is the engine's own full-tape fit. A logical range
          // with from=0 can be ignored while the chart is still laying out,
          // leaving the oldest sessions cut off at the left edge. Fit first,
          // then expand by one bar so the first and last candles are whole.
          timeScale.fitContent();
          timeScale.setVisibleLogicalRange({
            from: -1,
            to: candlesData.length,
          });
        } else {
          timeScale.setVisibleLogicalRange(range);
        }
      };
      apply();
      // The engine lays out its own scale once the first data lands. A second
      // pass on the next task keeps the opening window instead of the default
      // spacing, which otherwise left a 43-bar chart two-thirds empty.
      setTimeout(apply, 0);
      requestAnimationFrame(apply);
    }
    refreshHistoryEdge.current?.();
  }

  useEffect(() => {
    paintData();
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
    // The drawing positions: built from the tape's own bar list, so a
    // drawing is mapped in bar-index space and never dropped for sitting
    // between bars.
    const positions = makePositions(state.chart, state.candles,
      state.barTimes, state.realTimes);
    const drag = dragRef.current;
    const midDrag: MeasureResult | null = drag !== null
      && drag.kind === "measure" && drag.b !== null
      ? measureBetween(drag.a, drag.b)
      : null;
    // The profile tool's own bars, handed in as the columns the chart is
    // already drawing. Null when nothing has arrived: the tool then says so
    // rather than inventing a distribution.
    const bars: ProfileBarSource | null = state.data === null ? null : {
      time: state.data.time,
      high: state.data.high,
      low: state.data.low,
      volume: state.data.volume,
    };
    paintOverlay(context, state.chart, state.candles, frame, {
      drawings: overlayProps.current.drawings ?? [],
      hidden: overlayProps.current.drawingsHidden ?? false,
      toolColor: "#2962ff",
      midDrag,
      positions,
      bars,
    });
    // The dotted session rules: one blue rule at every exchange session
    // change, through the price pane and every study pane beneath it. The
    // x-axis supplies the date labels, TradingView style; only the lines
    // belong on the plot. Daily backfill month rules and real intraday
    // session rules obey one crowding law, so a zoomed-out chart reads one
    // cadence instead of a sparse calendar beside a dashed pile.
    const ruleColors = { line: "rgba(41, 98, 255, 0.62)", label: "#8f9bb3" };
    if (state.calendarBreaks.length > 1) {
      paintSessionBreaks(context, state.chart, frame, state.calendarBreaks,
        ruleColors, true, cssHeight, dpr);
    }
    if (state.breaks.length > 1) {
      paintSessionBreaks(context, state.chart, frame, state.breaks,
        ruleColors, false, cssHeight, dpr);
    }
    if (drag !== null) {
      paintLive(context, state.chart, state.candles, frame, drag, positions,
        bars);
    }
  };

  const paintLive = (
    context: CanvasRenderingContext2D,
    chart: ReturnType<typeof createChart>,
    candles: ISeriesApi<"Candlestick", Time>,
    frame: ReturnType<typeof frameFor>,
    drag: NonNullable<typeof dragRef.current>,
    positions: OverlayPositions,
    bars: ProfileBarSource | null,
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
    }, positions, bars);
  };

  /**
   * The pointer back into tape coordinates, margins and all.
   *
   * `anchorAt` answers exactly when the point sits on the engine's own
   * clock; the margin after the newest bar (where every fresh drawing
   * naturally starts when the window refuses to scroll further) and the
   * slivers between bars answered null, which is why tools used to feel
   * dead there. The fallback rides the engine's own logical index out of
   * the data, at the series' own bar pace, so the same instant maps back
   * the same way the overlay paints it.
   */
  const anchorFromPointer = (
    state: EngineState,
    x: number,
    y: number,
  ): AnchoredPoint | null => {
    const direct = anchorAt(state.chart, state.candles, x, y,
      (chartMs) => realFromChartMs(state, chartMs));
    if (direct !== null) {
      return direct;
    }
    const logical = state.chart.timeScale().coordinateToLogical(x);
    const price = state.candles.coordinateToPrice(y);
    const times = state.barTimes;
    if (logical === null || price === null || times.length === 0) {
      return null;
    }
    const index = Number(logical);
    const last = times.length - 1;
    const firstTime = times[0]!;
    const secondTime = times[1] ?? firstTime;
    const lastTime = times[last]!;
    const beforeLast = times[last - 1] ?? firstTime;
    if (index <= 0) {
      const pace = secondTime - firstTime;
      return { t: realFromChartMs(state, firstTime + index * pace), price };
    }
    if (index >= last) {
      const pace = beforeLast - lastTime;
      return { t: realFromChartMs(state, lastTime + (index - last) * pace), price };
    }
    const floorIndex = Math.floor(index);
    const t0 = times[floorIndex]!;
    const t1 = times[floorIndex + 1] ?? lastTime;
    return {
      t: realFromChartMs(state, t0 + (t1 - t0) * (index - floorIndex)),
      price,
    };
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
    const anchor = anchorFromPointer(state, x, y);
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
      kind: activeTool === "measure" ? "measure"
        : activeTool === "trend" ? "trend"
        : activeTool === "ob" ? "ob"
        : activeTool === "flatTop" ? "flatTop"
        : activeTool === "fib" ? "fib"
        : activeTool === "profile" ? "profile"
        : "flatBottom",
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
    const anchor = anchorFromPointer(
      state,
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
      ) : (
        <p className="chart__edge" ref={historyEdge} hidden />
      )}
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
  const bought = state.data.buy?.[i];
  const sold = state.data.sell?.[i];
  const net = bought !== undefined && sold !== undefined
    ? bought - sold : Number.NaN;

  // The reader can turn delta on or off; when active the legend labels the
  // measured tape split, otherwise it reports the venue's raw volume counter.
  const volumeHtml = !withVolume || !state.volumeShown
    ? ""
    : state.deltaShown && Number.isFinite(net)
      ? `<span class="tv-legend__field">Δ <b style="color:${
        net >= 0 ? "var(--tv-up)" : "var(--tv-down)"
      }">${formatVolume(net)}</b></span>`
      : `<span class="tv-legend__field">V <b>` +
        `${formatVolume(stampedVolume)}</b></span>`;
  legendEl.innerHTML =
    `<span class="tv-legend__stamp">` +
    `<span class="tv-legend__day">` + karachiDay.format(new Date(stampMs)) +
    `</span> ` + karachiClock.format(new Date(stampMs)) +
    `</span>` +
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
  positions: OverlayPositions,
  bars: ProfileBarSource | null,
): void {
  // The live shape draws through the same painter as the kept ones.
  paintOverlay(context, chart, candles, frame, {
    drawings: [shape],
    hidden: false,
    toolColor: "#2962ff",
    midDrag: null,
    positions,
    bars,
  });
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
  // Pane 0 is the price (volume rides its own overlay scale), so the first
  // study pane is pane 1.
  let nextPane = 1;
  // A study the reader switched off draws no output at all, so the loop
  // below never reaches it: sweep the specs first and take every series
  // their pane still holds back off the chart, then give the pane itself
  // back to the chart.
  const drawn = new Set(outputs
    .filter((output) => output.error === undefined)
    .map((output) => output.id));
  for (const spec of specs) {
    if (drawn.has(spec.id) || !state.panes.has(spec.id)) {
      continue;
    }
    const stale = state.panes.get(spec.id)!;
    for (const gone of stale.lines) {
      state.chart.removeSeries(gone);
    }
    if (stale.histogram !== undefined) {
      state.chart.removeSeries(stale.histogram);
    }
    const stalePane = stale.pane;
    if (stalePane !== undefined) {
      state.chart.removePane(stalePane);
    }
    state.panes.delete(spec.id);
  }
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
          priorLine.setData(lineData(data, nextLine.values, state.chartTimes));
        }
      }
      if (existing.histogram !== undefined && output.histogram !== undefined) {
        existing.histogram.setData(histData(data, output, state.chartTimes));
      }
      continue;
    }

    const paneIndex = isPane ? nextPane : 0;
    if (isPane) {
      // Every study pane shares the height left under the price pane, never
      // the price pane's own share.
      state.chart.addPane().setStretchFactor(1);
      nextPane += 1;
    }
    const lines: ISeriesApi<"Line", Time>[] = [];
    for (const line of output.lines) {
      const points = lineData(data, line.values, state.chartTimes);
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
      const bars = histData(data, output, state.chartTimes);
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
    state.panes.set(output.id,
      isPane ? { ...ref, pane: paneIndex } : ref);
  }
  // The pane stretch is what a fresh build loses: with the series attached
  // and measured, pin the price pane at four shares and every study pane
  // at one, so a pane never collapses back to zero height.
  state.chart.panes().forEach((pane, index) => {
    pane.setStretchFactor(index === 0 ? 4 : 1);
  });
}

/** A fixed indicator range (RSI 0-100) pins its pane's scale. */
function fixRange(
  series: ISeriesApi<"Line", Time> | ISeriesApi<"Histogram", Time>,
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

function lineData(
  data: SeriesData,
  values: Float64Array,
  chartTimes: readonly number[],
): LineData[] {
  const length = Math.min(data.time.length, values.length);
  const points: LineData[] = [];
  for (let i = 0; i < length; i += 1) {
    const value = values[i];
    const t = chartTimes[i];
    if (value === undefined || t === undefined || !Number.isFinite(value)
        || !Number.isFinite(t)) {
      continue; // the warm-up bars an indicator does not have yet
    }
    points.push({ time: (t / 1000) as UTCTimestamp, value });
  }
  return points;
}

function histData(
  data: SeriesData,
  output: IndicatorOutput,
  chartTimes: readonly number[],
): HistogramData[] {
  const histogram = output.histogram;
  if (histogram === undefined) {
    return [];
  }
  const length = Math.min(data.time.length, histogram.values.length);
  const points: HistogramData[] = [];
  for (let i = 0; i < length; i += 1) {
    const value = histogram.values[i];
    const t = chartTimes[i];
    if (value === undefined || t === undefined || !Number.isFinite(value)
        || !Number.isFinite(t)) {
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

