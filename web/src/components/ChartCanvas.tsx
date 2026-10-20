/**
 * The chart surface, with the controls a charting terminal is expected to have.
 *
 * The drawing rule that matters: React re-renders for metadata, the canvas
 * redraws imperatively from typed arrays. A pointer move updates refs and
 * schedules one animation-frame paint; it writes the readout through a DOM
 * ref, so hovering never re-renders the tree.
 *
 * Time is owned by the reader. The visible window lives in a ref, wheel and
 * pinch zoom around the pointer, dragging pans, and keyboard does both. The
 * pure rules in `chart/viewport.ts` decide every boundary; this file only
 * wires them to events. A bar arriving extends a window that is following the
 * market but never moves one the reader scrolled back.
 *
 * Indicators are computed on the bars actually on screen. The fold and the
 * indicator result are cached per bar version, so a pointer move repaints the
 * same arrays instead of recalculating a moving average sixty times a second.
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Gap, Resolution } from "../api/types";
import { formatClock, formatDay, formatPrice, formatVolume } from "../chart/format";
import {
  drawChart,
  type Crosshair,
  geometryFor,
  themeFor,
} from "../chart/render";
import { displayBucket, type ColumnSeries } from "../chart/series";
import { timeframeMs } from "../chart/timeframes";
import {
  DEFAULT_VISIBLE_BARS,
  type SeriesBounds,
  type Viewport,
  barsInViewportLabel,
  fitViewport,
  followViewport,
  isAtNewest,
  panViewport,
  viewportOfLastBars,
  zoomViewport,
} from "../chart/viewport";
import { computeIndicators, outputsFor, seriesData } from "../indicators/compute";
import { placementOf } from "../indicators/registry";
import type { IndicatorOutput, IndicatorSpec } from "../indicators/types";

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const ZOOM_STEP = 0.18;
const PAN_STEP = 0.18;
const MAX_PANES = 8;

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
}

interface DragState {
  readonly startX: number;
  readonly lastX: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface PinchState {
  distance: number;
  centre: number;
}

interface FoldCache {
  readonly key: string;
  readonly drawn: ColumnSeries;
}

interface IndicatorCache {
  readonly source: ColumnSeries;
  readonly version: number;
  readonly key: string;
  readonly outputs: readonly IndicatorOutput[];
}

export function ChartCanvas(props: ChartCanvasProps) {
  const {
    series, gaps, resolution, viewKey, version, volumeAvailable, theme,
    sessionLabel, emptyNote, indicators,
  } = props;
  const wrapper = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const crosshair = useRef<Crosshair | null>(null);
  const viewport = useRef<Viewport | null>(null);
  const following = useRef(true);
  const visibleBars = useRef(DEFAULT_VISIBLE_BARS);
  const drag = useRef<DragState | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<PinchState | null>(null);
  const folded = useRef<ColumnSeries | null>(null);
  const foldCache = useRef<FoldCache | null>(null);
  const indicatorCache = useRef<IndicatorCache | null>(null);
  const readout = useRef<HTMLDivElement | null>(null);
  const rangeReadout = useRef<HTMLSpanElement | null>(null);
  const frameRequest = useRef<number | null>(null);
  const lastViewKey = useRef(viewKey);
  const [size, setSize] = useState({ width: 800, height: 400 });
  const [hasBars, setHasBars] = useState(false);

  const specKey = useMemo(() => JSON.stringify(indicators), [indicators]);
  const paneCount = useMemo(
    () => Math.min(MAX_PANES, indicators.filter((spec) =>
      spec.visible && placementOf(spec) === "pane").length),
    [indicators],
  );
  const frameNow = useCallback(
    () => geometryFor(size.width, size.height, paneCount),
    [paneCount, size.height, size.width],
  );
  /**
   * The step is the chosen timeframe, not the interval the rows happen to
   * show. `ColumnSeries.stepMs()` takes the median spacing, which is right for
   * a dense minute series with holes but wrong for sparse tick rungs: 232
   * one-second prints spread across two hours have a median spacing of 23
   * seconds, and using that as the candle width folded the series into
   * 23-second candles and mislabelled the axis. The server already built the
   * rows at the requested resolution, so that resolution is the width; a hole
   * is missing time, not a wider bar.
   */
  const boundsNow = useCallback((): SeriesBounds | null => {
    const bounds = series.bounds();
    return bounds === null
      ? null
      : { ...bounds, stepMs: timeframeMs(resolution) };
  }, [resolution, series]);

  useEffect(() => {
    const node = wrapper.current;
    if (node === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect === undefined) {
        return;
      }
      setSize({
        width: Math.max(MIN_WIDTH, Math.round(rect.width)),
        height: Math.max(MIN_HEIGHT, Math.round(rect.height)),
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const outputsForFrame = useCallback(
    (drawn: ColumnSeries): readonly IndicatorOutput[] => {
      const cached = indicatorCache.current;
      if (cached !== null && cached.source === drawn &&
          cached.version === version && cached.key === specKey) {
        return cached.outputs;
      }
      const data = seriesData(drawn);
      const outputs = computeIndicators(indicators, data);
      indicatorCache.current = {
        source: drawn, version, key: specKey, outputs,
      };
      return outputs;
    },
    [indicators, specKey, version],
  );

  const paint = useCallback(() => {
    const surface = canvas.current;
    if (surface === null) {
      return;
    }
    const context = surface.getContext("2d");
    if (context === null) {
      return;
    }
    if (lastViewKey.current !== viewKey) {
      // A symbol, session or timeframe switch is a new chart, not a poll of
      // the old one. Reset before the first paint of the new series so a
      // weekly view cannot inherit an intraday five-minute window and open
      // one week past its only candle.
      lastViewKey.current = viewKey;
      viewport.current = null;
      following.current = true;
      visibleBars.current = DEFAULT_VISIBLE_BARS;
      crosshair.current = null;
      foldCache.current = null;
      indicatorCache.current = null;
    }
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    if (surface.width !== Math.round(size.width * dpr) ||
        surface.height !== Math.round(size.height * dpr)) {
      surface.width = Math.round(size.width * dpr);
      surface.height = Math.round(size.height * dpr);
      surface.style.width = `${size.width}px`;
      surface.style.height = `${size.height}px`;
    }
    const bounds: SeriesBounds | null = boundsNow();
    if (bounds === null) {
      // A symbol, session or timeframe switch clears the series before the
      // new bars arrive. The old window describes timestamps that no longer
      // exist, so keep it would open the next chart on an empty slice of
      // time: the daily view would inherit a two-hour intraday window and
      // draw nothing. Reset here, where the absence is visible.
      viewport.current = null;
      following.current = true;
      visibleBars.current = DEFAULT_VISIBLE_BARS;
      folded.current = null;
      indicatorCache.current = null;
      crosshair.current = null;
      // Clear the pixels and the diagnostic attributes too. Leaving the old
      // candles underneath a "loading" overlay is exactly how a reader ends
      // up quoting yesterday's price while a new symbol is being fetched.
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, surface.width, surface.height);
      context.fillStyle = themeFor(theme).background;
      context.fillRect(0, 0, surface.width, surface.height);
      for (const name of ["data-window", "data-step-ms", "data-drawn",
                          "data-aggregated", "data-indicators", "data-panes"]) {
        surface.removeAttribute(name);
      }
      if (readout.current !== null) {
        readout.current.textContent = "";
      }
      if (rangeReadout.current !== null) {
        rangeReadout.current.textContent = "waiting for bars";
      }
    } else if (viewport.current === null) {
      viewport.current = viewportOfLastBars(
        series.timesOfLast(visibleBars.current), visibleBars.current,
        bounds.stepMs);
      following.current = true;
    }
    viewport.current = followViewport(viewport.current, bounds,
                                      following.current, visibleBars.current);
    const view = viewport.current;
    const frame = geometryFor(size.width, size.height, paneCount);
    const plotWidth = frame.plotRight - frame.plotLeft;
    let drawn = series;
    // Calendar bars are already the unit the server folded by the Karachi
    // calendar. Folding them again by an epoch-aligned width would merge two
    // trading days into one "day" (or a Friday into a Saturday), so the
    // renderer only compresses intraday series for screen density.
    const calendar = resolution === "1D" || resolution === "1d" ||
      resolution === "1W" || resolution === "1M";
    if (!calendar && view !== null && bounds !== null && plotWidth > 0) {
      const shown = series.countInWindow(view.fromMs, view.toMs);
      const bucket = displayBucket(shown, bounds.stepMs, plotWidth);
      if (bucket > bounds.stepMs) {
        const key = `${version}|${bucket}|${series.length}`;
        const cached = foldCache.current;
        if (cached !== null && cached.key === key) {
          drawn = cached.drawn;
        } else {
          drawn = series.aggregate(bucket);
          foldCache.current = { key, drawn };
        }
      }
    }
    folded.current = drawn;
    const outputs = outputsForFrame(drawn);
    const overlays = outputsFor(outputs, "overlay");
    const panes = outputsFor(outputs, "pane").slice(0, MAX_PANES);

    if (view !== null && bounds !== null) {
      surface.dataset["window"] = `${view.fromMs}-${view.toMs}`;
      surface.dataset["stepMs"] = String(Math.round(bounds.stepMs));
      surface.dataset["drawn"] = String(drawn.length);
      surface.dataset["aggregated"] = String(drawn !== series);
      surface.dataset["indicators"] = String(outputs.length);
      surface.dataset["panes"] = String(panes.length);
    }
    if (view !== null) {
      drawChart(context, {
        series: drawn,
        gaps,
        fromMs: view.fromMs,
        toMs: view.toMs,
        width: size.width,
        height: size.height,
        dpr,
        crosshair: crosshair.current,
        theme: themeFor(theme),
        volumeAvailable,
        overlays,
        panes,
      });
    }
    if (rangeReadout.current !== null && view !== null) {
      const shown = series.countInWindow(view.fromMs, view.toMs);
      const span = view.toMs - view.fromMs;
      const label = span > 36 * 3_600_000
        ? `${formatDay(new Date(view.fromMs).toISOString())} to ` +
          `${formatDay(new Date(view.toMs).toISOString())}`
        : `${formatClock(new Date(view.fromMs).toISOString())} to ` +
          `${formatClock(new Date(view.toMs).toISOString())}`;
      rangeReadout.current.textContent =
        `${label} · ${barsInViewportLabel(shown, series.length)}` +
        (following.current ? " · following" : " · paused");
    }
  }, [boundsNow, gaps, outputsForFrame, paneCount, resolution, series, size,
      theme, version, viewKey, volumeAvailable]);

  const schedulePaint = useCallback(() => {
    if (frameRequest.current !== null) {
      return;
    }
    frameRequest.current = window.requestAnimationFrame(() => {
      frameRequest.current = null;
      paint();
    });
  }, [paint]);

  useEffect(() => {
    setHasBars(series.length > 0);
    schedulePaint();
  }, [schedulePaint, version, series]);

  useEffect(() => () => {
    if (frameRequest.current !== null) {
      window.cancelAnimationFrame(frameRequest.current);
      frameRequest.current = null;
    }
  }, []);

  /** Apply a viewport change, remember whether the reader is still following. */
  const apply = useCallback(
    (next: Viewport | null) => {
      viewport.current = next;
      const bounds = boundsNow();
      following.current = bounds === null || next === null
        ? true
        : isAtNewest(next, bounds);
      schedulePaint();
    },
    [boundsNow, schedulePaint],
  );

  const zoomBy = useCallback(
    (factor: number, anchorRatio: number) => {
      const bounds = boundsNow();
      const view = viewport.current;
      if (bounds === null || view === null) {
        return;
      }
      apply(zoomViewport(view, bounds, factor, anchorRatio));
    },
    [apply, boundsNow],
  );

  const panBy = useCallback(
    (fraction: number) => {
      const bounds = boundsNow();
      const view = viewport.current;
      if (bounds === null || view === null) {
        return;
      }
      apply(panViewport(view, bounds, fraction));
    },
    [apply, boundsNow],
  );

  const fit = useCallback(() => {
    const bounds = boundsNow();
    if (bounds === null) {
      return;
    }
    visibleBars.current = bounds.count;
    apply(fitViewport(bounds));
  }, [apply, boundsNow]);

  const newest = useCallback(() => {
    const bounds = boundsNow();
    if (bounds === null) {
      return;
    }
    const span = viewport.current === null
      ? null
      : viewport.current.toMs - viewport.current.fromMs;
    apply(span === null
      ? fitViewport(bounds)
      : { fromMs: bounds.lastMs + bounds.stepMs - span,
          toMs: bounds.lastMs + bounds.stepMs });
  }, [apply, boundsNow]);

  const onWheel = useCallback(
    (event: globalThis.WheelEvent) => {
      const surface = canvas.current;
      if (surface === null) {
        return;
      }
      event.preventDefault();
      const frame = frameNow();
      const rect = surface.getBoundingClientRect();
      const ratio = (event.clientX - rect.left - frame.plotLeft) /
        Math.max(1, frame.plotRight - frame.plotLeft);
      // A smooth exponential response, bounded so a trackpad fling cannot
      // jump a month of bars in one event.
      const delta = Math.max(-160, Math.min(160, event.deltaY));
      const factor = Math.exp(delta * 0.0022);
      zoomBy(factor, ratio);
    },
    [frameNow, zoomBy],
  );

  // React registers `wheel` as a passive listener at the root, so calling
  // preventDefault from the JSX handler only produced a browser warning and
  // let the page scroll while the chart zoomed. A native listener with an
  // explicit non-passive option is the only way to own the gesture.
  useEffect(() => {
    const surface = canvas.current;
    if (surface === null) {
      return;
    }
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [onWheel]);

  const locate = useCallback(
    (clientX: number, clientY: number) => {
      const surface = canvas.current;
      const drawn = folded.current;
      const view = viewport.current;
      if (surface === null || drawn === null || view === null) {
        return null;
      }
      const rect = surface.getBoundingClientRect();
      const frame = frameNow();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const ratio = (x - frame.plotLeft) / (frame.plotRight - frame.plotLeft);
      const moment = view.fromMs + ratio * (view.toMs - view.fromMs);
      const index = drawn.indexAtOrBefore(moment);
      if (index < 0) {
        return null;
      }
      return { index, x, y };
    },
    [frameNow],
  );

  const describeIndicators = useCallback(
    (index: number): string => {
      const outputs = indicatorCache.current?.outputs ?? [];
      const parts: string[] = [];
      for (const output of outputs) {
        if (output.error !== undefined) {
          continue;
        }
        const values = output.lines
          .map((line) => {
            const value = line.values[index] ?? Number.NaN;
            return Number.isFinite(value)
              ? `${line.label} ${formatPrice(value, 2)}`
              : "";
          })
          .filter((text) => text.length > 0);
        if (values.length > 0) {
          parts.push(values.join(" "));
        }
      }
      return parts.join(" · ");
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (viewport.current === null) {
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      pointers.current.set(event.pointerId, point);
      event.currentTarget.setPointerCapture(event.pointerId);
      if (pointers.current.size === 1) {
        drag.current = { startX: event.clientX, lastX: event.clientX };
      } else if (pointers.current.size === 2) {
        const [first, second] = [...pointers.current.values()];
        if (first !== undefined && second !== undefined) {
          pinch.current = {
            distance: Math.max(1, Math.hypot(second.x - first.x,
              second.y - first.y)),
            centre: (first.x + second.x) / 2,
          };
          drag.current = null;
        }
      }
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (pointers.current.has(event.pointerId)) {
        pointers.current.set(event.pointerId,
          { x: event.clientX, y: event.clientY });
      }
      if (pointers.current.size >= 2 && pinch.current !== null) {
        const [first, second] = [...pointers.current.values()];
        if (first !== undefined && second !== undefined) {
          const distance = Math.max(1, Math.hypot(second.x - first.x,
            second.y - first.y));
          const frame = frameNow();
          const surface = canvas.current;
          if (surface !== null) {
            const rect = surface.getBoundingClientRect();
            const centre = (first.x + second.x) / 2;
            const ratio = (centre - rect.left - frame.plotLeft) /
              Math.max(1, frame.plotRight - frame.plotLeft);
            zoomBy(pinch.current.distance / distance, ratio);
          }
          pinch.current = { distance, centre: (first.x + second.x) / 2 };
        }
        return;
      }
      const dragging = drag.current;
      if (dragging !== null) {
        const frame = frameNow();
        const width = Math.max(1, frame.plotRight - frame.plotLeft);
        const shift = -(event.clientX - dragging.lastX) / width;
        if (Math.abs(shift) > 0.0005) {
          panBy(shift);
          drag.current = { startX: dragging.startX, lastX: event.clientX };
        }
        return;
      }
      const found = locate(event.clientX, event.clientY);
      if (found === null) {
        return;
      }
      crosshair.current = found;
      const bar = folded.current?.at(found.index);
      if (readout.current !== null && bar !== undefined) {
        const base =
          `${formatClock(new Date(bar.timeMs).toISOString())}  ` +
          `O ${formatPrice(bar.o)}  H ${formatPrice(bar.h)}  ` +
          `L ${formatPrice(bar.l)}  C ${formatPrice(bar.c)}  ` +
          `V ${formatVolume(bar.v)}`;
        const extra = describeIndicators(found.index);
        readout.current.textContent = extra.length > 0
          ? `${base}   ${extra}`
          : base;
      }
      schedulePaint();
    },
    [describeIndicators, frameNow, locate, panBy, schedulePaint, zoomBy],
  );

  const endPointer = useCallback((event: PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) {
      pinch.current = null;
    }
    if (pointers.current.size === 0) {
      drag.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onPointerLeave = useCallback(() => {
    if (drag.current !== null || pointers.current.size > 0) {
      return;
    }
    crosshair.current = null;
    if (readout.current !== null) {
      readout.current.textContent = "";
    }
    schedulePaint();
  }, [schedulePaint]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLCanvasElement>) => {
      const handled: Record<string, () => void> = {
        ArrowLeft: () => panBy(-PAN_STEP),
        ArrowRight: () => panBy(PAN_STEP),
        ArrowUp: () => zoomBy(1 / (1 + ZOOM_STEP), 0.5),
        ArrowDown: () => zoomBy(1 + ZOOM_STEP, 0.5),
        "+": () => zoomBy(1 / (1 + ZOOM_STEP), 0.5),
        "=": () => zoomBy(1 / (1 + ZOOM_STEP), 0.5),
        "-": () => zoomBy(1 + ZOOM_STEP, 0.5),
        Home: fit,
        End: newest,
        f: fit,
        F: fit,
        n: newest,
        N: newest,
        "0": fit,
      };
      const action = handled[event.key];
      if (action === undefined) {
        return;
      }
      event.preventDefault();
      action();
    },
    [fit, newest, panBy, zoomBy],
  );

  const volumeNote = volumeAvailable
    ? "volume pane below the candles, from the source's own counter"
    : "this source reported no volume counter, so no volume pane is drawn";
  const indicatorNote = indicators.length === 0
    ? "no indicators configured"
    : `${indicators.length} indicator(s) configured`;

  return (
    <div className="chart" ref={wrapper}>
      <canvas
        ref={canvas}
        className="chart__canvas"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onPointerLeave={onPointerLeave}
        onDoubleClick={fit}
        onKeyDown={onKeyDown}
        aria-label={`candlestick chart. ${sessionLabel} ${series.length} bars. ${volumeNote}. ${indicatorNote}. Arrow keys pan, plus and minus zoom, f fits, n goes to the newest bar.`}
        data-bars={series.length}
      />
      {!hasBars ? (
        <p className="chart__empty" role="status">
          {emptyNote}
        </p>
      ) : null}
      <div className="chart__overlay">
        <div className="chart__controls">
          <button type="button" onClick={() => zoomBy(1 / (1 + ZOOM_STEP), 0.5)}
                  aria-label="zoom in" title="Zoom in (keyboard: +)">
            +
          </button>
          <button type="button" onClick={() => zoomBy(1 + ZOOM_STEP, 0.5)}
                  aria-label="zoom out" title="Zoom out (keyboard: -)">
            {String.fromCharCode(8722)}
          </button>
          <button type="button" onClick={fit} title="Fit every bar (keyboard: f)">
            fit
          </button>
          <button type="button" onClick={newest} title="Newest bar (keyboard: n)">
            newest
          </button>
        </div>
        <span className="chart__range" ref={rangeReadout} aria-live="off" />
        <div className="chart__readout" ref={readout} aria-live="off" />
        <div className="chart__hint">hover to read, wheel or pinch to zoom, drag to pan</div>
      </div>
    </div>
  );
}
