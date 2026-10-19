/**
 * The chart surface, with the controls a charting terminal is expected to have.
 *
 * The drawing rule that matters, unchanged from the first version: React
 * re-renders for metadata, the canvas redraws imperatively from typed arrays.
 * A pointer move updates refs and repaints, and it writes the readout through
 * a DOM ref, so hovering never re-renders the tree.
 *
 * What is new here is time control. The visible window lives in a ref, the
 * reader owns it (wheel to zoom, drag to pan, keyboard for both, buttons for
 * fit and for the newest bar), and a bar arriving extends a window that is
 * following the market without ever moving a window that has been scrolled
 * back. Every one of those decisions is delegated to `chart/viewport.ts`,
 * which is pure and tested; this file only wires it to events.
 *
 * The volume pane is drawn by the same canvas, below the candles rather than
 * through them, and it says in words when the source reported no volume at
 * all: an absent measurement must not look like a measured zero.
 */

import {
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { Gap } from "../api/types";
import { formatClock, formatPrice, formatVolume } from "../chart/format";
import { drawChart, type Crosshair, geometryFor, themeFor } from "../chart/render";
import { displayBucket, type ColumnSeries } from "../chart/series";
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

const MIN_WIDTH = 320;
const MIN_HEIGHT = 220;
const ZOOM_STEP = 0.18;
const PAN_STEP = 0.18;

export interface ChartCanvasProps {
  readonly series: ColumnSeries;
  readonly gaps: readonly Gap[];
  readonly version: number;
  readonly volumeAvailable: boolean;
  readonly theme: "dark" | "light";
  /** A sentence for the accessible description: which session is on screen. */
  readonly sessionLabel: string;
  /** What to say when there is nothing to draw, and why. */
  readonly emptyNote: string;
}

interface DragState {
  readonly startX: number;
  readonly viewport: Viewport;
}

export function ChartCanvas(props: ChartCanvasProps) {
  const { series, gaps, version, volumeAvailable, theme, sessionLabel, emptyNote } =
    props;
  const wrapper = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const crosshair = useRef<Crosshair | null>(null);
  const viewport = useRef<Viewport | null>(null);
  const following = useRef(true);
  const visibleBars = useRef(DEFAULT_VISIBLE_BARS);
  const drag = useRef<DragState | null>(null);
  const folded = useRef<ColumnSeries | null>(null);
  const readout = useRef<HTMLDivElement | null>(null);
  const rangeReadout = useRef<HTMLSpanElement | null>(null);
  const [size, setSize] = useState({ width: 800, height: 400 });
  const [hasBars, setHasBars] = useState(false);

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

  const paint = useCallback(() => {
    const surface = canvas.current;
    if (surface === null) {
      return;
    }
    const context = surface.getContext("2d");
    if (context === null) {
      return;
    }
    const dpr = window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    if (surface.width !== Math.round(size.width * dpr) ||
        surface.height !== Math.round(size.height * dpr)) {
      surface.width = Math.round(size.width * dpr);
      surface.height = Math.round(size.height * dpr);
      surface.style.width = `${size.width}px`;
      surface.style.height = `${size.height}px`;
    }
    const bounds: SeriesBounds | null = series.bounds();
    if (viewport.current === null && bounds !== null) {
      // A fresh chart opens on the newest bars by counting bars, not minutes:
      // an illiquid symbol's recent bars can be spread over hours, and a
      // minute-sized window would show one candle and hide the day.
      viewport.current = viewportOfLastBars(
        series.timesOfLast(visibleBars.current), visibleBars.current,
        bounds.stepMs);
    }
    viewport.current = followViewport(viewport.current, bounds,
                                      following.current, visibleBars.current);
    const view = viewport.current;
    const frame = geometryFor(size.width, size.height);
    const plotWidth = frame.plotRight - frame.plotLeft;
    let drawn = series;
    if (view !== null && bounds !== null && plotWidth > 0) {
      // Folding is sized by the bars the window covers, not by its clock span:
      // an illiquid symbol's window is far wider than its bars, and a
      // span-sized bucket folded minute candles away that had room to draw.
      const shown = series.countInWindow(view.fromMs, view.toMs);
      const bucket = displayBucket(shown, bounds.stepMs, plotWidth);
      if (bucket > bounds.stepMs) {
        // Aggregation is display only: the minute series stays untouched, so
        // zooming back in shows every minute again.
        drawn = series.aggregate(bucket);
      }
    }
    folded.current = drawn;
    if (view !== null && bounds !== null) {
      // A measurable trace of what is on screen, for a reader inspecting the
      // page and for the performance harness: the window, the bar count and
      // the step the renderer derived from the data itself.
      surface.dataset["window"] = `${view.fromMs}-${view.toMs}`;
      surface.dataset["stepMs"] = String(Math.round(bounds.stepMs));
      surface.dataset["drawn"] = String(drawn.length);
      surface.dataset["aggregated"] = String(drawn !== series);
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
      });
    }
    if (rangeReadout.current !== null && view !== null) {
      const shown = series.countInWindow(view.fromMs, view.toMs);
      rangeReadout.current.textContent =
        `${formatClock(new Date(view.fromMs).toISOString())} to ` +
        `${formatClock(new Date(view.toMs).toISOString())} · ` +
        `${barsInViewportLabel(shown, series.length)}` +
        (following.current ? " · following" : " · paused");
    }
  }, [series, gaps, size, theme, volumeAvailable]);

  useEffect(() => {
    setHasBars(series.length > 0);
    paint();
  }, [paint, version, series]);

  /** Apply a viewport change, remember whether the reader is still following. */
  const apply = useCallback(
    (next: Viewport | null) => {
      viewport.current = next;
      const bounds = series.bounds();
      following.current = bounds === null || next === null
        ? true
        : isAtNewest(next, bounds);
      paint();
    },
    [paint, series],
  );

  const boundsNow = useCallback((): SeriesBounds | null => series.bounds(), [series]);

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
    (event: WheelEvent<HTMLCanvasElement>) => {
      const surface = canvas.current;
      if (surface === null) {
        return;
      }
      event.preventDefault();
      const frame = geometryFor(size.width, size.height);
      const rect = surface.getBoundingClientRect();
      const ratio = (event.clientX - rect.left - frame.plotLeft) /
        Math.max(1, frame.plotRight - frame.plotLeft);
      const factor = event.deltaY > 0 ? 1 + ZOOM_STEP : 1 / (1 + ZOOM_STEP);
      zoomBy(factor, ratio);
    },
    [size.height, size.width, zoomBy],
  );

  const locate = useCallback(
    (clientX: number, clientY: number) => {
      const surface = canvas.current;
      const drawn = folded.current;
      const view = viewport.current;
      if (surface === null || drawn === null || view === null) {
        return null;
      }
      const rect = surface.getBoundingClientRect();
      const frame = geometryFor(size.width, size.height);
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
    [size.height, size.width],
  );

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (viewport.current === null) {
        return;
      }
      drag.current = { startX: event.clientX, viewport: viewport.current };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const dragging = drag.current;
      if (dragging !== null) {
        const frame = geometryFor(size.width, size.height);
        const width = Math.max(1, frame.plotRight - frame.plotLeft);
        // Dragging right moves the window back in time, the way every chart
        // the owner has ever used behaves.
        const shift = -(event.clientX - dragging.startX) / width;
        if (Math.abs(shift) > 0.0005) {
          panBy(shift);
          drag.current = { startX: event.clientX, viewport: viewport.current ??
            dragging.viewport };
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
        readout.current.textContent =
          `${formatClock(new Date(bar.timeMs).toISOString())}  ` +
          `O ${formatPrice(bar.o)}  H ${formatPrice(bar.h)}  ` +
          `L ${formatPrice(bar.l)}  C ${formatPrice(bar.c)}  ` +
          `V ${formatVolume(bar.v)}`;
      }
      paint();
    },
    [locate, paint, panBy, size.height, size.width],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  const onPointerLeave = useCallback(() => {
    drag.current = null;
    crosshair.current = null;
    if (readout.current !== null) {
      readout.current.textContent = "";
    }
    paint();
  }, [paint]);

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

  return (
    <div className="chart" ref={wrapper}>
      <canvas
        ref={canvas}
        className="chart__canvas"
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onKeyDown={onKeyDown}
        aria-label={`candlestick chart. ${sessionLabel} ${series.length} bars. ${volumeNote}. Arrow keys pan, plus and minus zoom, f fits, n goes to the newest bar.`}
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
        <div className="chart__hint">hover to read a bar, wheel to zoom, drag to pan</div>
      </div>
    </div>
  );
}
