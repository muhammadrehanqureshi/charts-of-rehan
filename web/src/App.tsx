/**
 * The application shell, in TradingView's shape for the PSX tape.
 *
 * A thin rail on the left for the working toggles, the chart taking every
 * pixel between it and the watchlist, and the watchlist pane on the right
 * holding exactly the symbols the reader put on it. The heavy status text
 * lives behind a single "data detail" fold, and the chart's own state bar
 * stays where a reader reads it: under the candles.
 *
 * What lives here is only what a human chooses (symbol, resolution, session,
 * theme, watchlist) and what the service says about itself. The series
 * belongs to the feed hook and the pixels belong to the canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiError, ChartClient } from "./api/client";
import {
  type DeltaMinute,
  type Resolution,
  type SessionRow,
  type SymbolFlow,
  type SymbolRow,
  parseHealth,
} from "./api/types";
import { ChartCanvas } from "./components/ChartCanvas";
import { Screener } from "./components/Screener";
import {
  ChartSettingsDialog,
  IndicatorSettingsDialog,
} from "./components/SettingsDialog";
import { DrawToolRail } from "./components/DrawToolRail";
import { IndicatorsPanel } from "./components/IndicatorsPanel";
import { NotesPanel } from "./components/NotesPanel";
import { StatusBar } from "./components/StatusBar";
import { SymbolSearch } from "./components/SymbolSearch";
import { Toolbar } from "./components/Toolbar";
import { Watchlist } from "./components/Watchlist";
import { useBook } from "./hooks/useBook";
import { useChartFeed } from "./hooks/useChartFeed";
import { useAppearance } from "./hooks/useAppearance";
import { useIndicators } from "./hooks/useIndicators";
import { useDelta } from "./hooks/useDelta";
import { usePrints } from "./hooks/usePrints";
import { useVisibility } from "./hooks/useVisibility";

import { timeframeShort } from "./chart/timeframes";
import { definitionFor } from "./indicators/registry";
import {
  clearDrawings,
  loadChartDrawings,
  saveDrawings,
  type Drawing,
  type DrawTool,
} from "./chart/drawings";

const FALLBACK_RESOLUTIONS: readonly Resolution[] = ["1m"];

/**
 * Sessions the merged chart spans, by rung.
 *
 * A fixed five sessions starves the coarse rungs: a 1h chart of five
 * trading days is barely a dozen bars, drawn as wide plates rather than a
 * chart. The span grows with the rung so every merged chart carries a
 * few hundred bars - a minute chart a week, an hour chart a quarter,
 * and the daily rung a full year of Karachi sessions.
 */
function spanFor(resolution: Resolution): number {
  switch (resolution) {
    case "1s": case "10s": return 3;
    case "1m": case "5m": return 7;
    case "10m": case "15m": return 15;
    case "30m": return 25;
    case "1h": return 32;
    case "4h": return 70;
    case "1D": return 260;   // a year of trading days
    case "1W": return 160;   // three years of weeks
    case "1M": return 160;   // over a decade of months
    // Legacy spellings a pre-v3 deployment still answers behind aliases.
    case "1d": return 260;
    case "session": return 260;
  }
}

/**
 * How much older, coarser-grained history a rung's chart asks for, in
 * whole sessions. The mirror rungs already fold identical session
 * windows, so every whole number of them keeps daily-grain archive bars
 * aligned with the intraday ones; small values keep each chart inside
 * the ten-year store without carrying a decade of candles in memory.
 */
function backfillFor(resolution: Resolution): number {
  switch (resolution) {
    case "1s": case "10s": return 3;
    case "1m": case "5m": return 8;
    case "10m": case "15m": return 6;
    case "30m": return 7;
    case "1h": return 7;
    case "4h": return 35;
    case "1D": case "1W": case "1M":
    case "1d": case "session": return 0;
  }
}

/**
 * Age of the newest bar beyond which a chart in play is warned about
 * (minutes), by rung. A fixed dozen minutes lies about the coarse rungs:
 * a 1h bar is expected to sit up to an hour old mid-run, and a daily
 * session's own bar ages all day while the market is open. The threshold
 * rides the rung: a bar's step plus the same fifteen minutes of grace a
 * 1m chart used to get, so honesty scales instead of the bar chart's
 * clock.
 */
function staleFor(resolution: Resolution): number {
  switch (resolution) {
    case "1s": return 3;
    case "10s": return 6;
    case "1m": case "5m": return 12;
    case "10m": return 22;
    case "15m": return 30;
    case "30m": return 45;
    case "1h": return 75;
    case "4h": return 255;
    case "1D": return 375;   // the band ran its length and a quarter more
    case "1W": return 720;
    case "1M": return 3_000;
    case "1d": case "session": return 375;
  }
}

const WATCHLIST_KEY = "charts-watchlist";

/**
 * The chart this browser last opened.
 *
 * Opening the app used to land on whatever the catalogue listed first, which
 * is an index: every visit began on KSE100 no matter what the reader was
 * charting last night. The last symbol you charted is the one you meant to
 * see again, so it is kept beside the watchlist and reopened on the next
 * visit. A first visit has no last symbol and falls back to the session's
 * own most traded name.
 */
const LAST_SYMBOL_KEY = "charts-symbol";

/** The same, for a tape with no per-minute split. */
const EMPTY_DELTA: readonly DeltaMinute[] = [];

/** The list a reader starts with: the two breadth indexes the tape computes. */
const DEFAULT_WATCHLIST: readonly string[] = ["KSE100", "KMIALLSHR"];

function readWatchlist(): string[] {
  try {
    const raw = window.localStorage.getItem(WATCHLIST_KEY);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string =>
          typeof item === "string" && item.length > 0).slice(0, 64);
      }
    }
  } catch {
    // A corrupt note is still a note, not a crash: the default returns.
  }
  return [...DEFAULT_WATCHLIST];
}

function readLastSymbol(): string {
  try {
    const stored = window.localStorage.getItem(LAST_SYMBOL_KEY);
    return stored === null ? "" : stored.trim().toUpperCase();
  } catch {
    return ""; // a disabled storage is a first visit, not a crash
  }
}

/**
 * The name a first visit opens.
 *
 * The most traded scrip of the session, never a computed index: a reader who
 * has never chosen anything is better served by the tape's busiest symbol
 * than by a breadth gauge. An index answers only when nothing in the
 * catalogue traded at all.
 */
export function openingSymbol(
  items: readonly SymbolRow[],
): SymbolRow | undefined {
  const traded = items.filter((row) => (row.bars ?? 0) > 0);
  const named = traded.filter((row) => row.index !== true);
  const pool = named.length > 0 ? named : traded;
  if (pool.length === 0) {
    return items[0];
  }
  let best = pool[0];
  for (const row of pool) {
    if ((row.volume ?? 0) > (best?.volume ?? 0)) {
      best = row;
    }
  }
  return best;
}

function hash(): { symbol: string; day: string } {
  const raw = window.location.hash.replace(/^#/, "");
  const [symbol = "", day = ""] = raw.split("/");
  return { symbol: symbol.trim().toUpperCase(), day: day.trim() };
}

const CATALOGUE_REFRESH_MS = 15_000;
const FLOW_REFRESH_MS = 1_000;
const FEED_HEALTH_REFRESH_MS = 10_000;

function useVisibleRefresh(
  refresh: () => void | Promise<void>,
  intervalMs: number,
): void {
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const visible = useVisibility();

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            await latestRefresh.current();
          } finally {
            if (!cancelled && document.visibilityState === "visible") {
              schedule();
            }
          }
        })();
      }, intervalMs);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [intervalMs, visible]);
}

/**
 * Opening a fresh app always means opening the live session: a day named in
 * the URL is the day a review left behind, and reopening it days later is
 * how a chart showed Friday's last bar while Monday was printing - the
 * answer read as "the data is not updating". History stays one picker
 * click away; the boot itself never chooses a stored day.
 */
const JUST_LIVE = "";

export function App() {
  const client = useMemo(() => new ChartClient(), []);
  const initial = useMemo(hash, []);
  const [symbol, setSymbol] = useState(
    () => initial.symbol.length > 0 ? initial.symbol : readLastSymbol(),
  );
  const [day, setDay] = useState(JUST_LIVE);
  const [resolution, setResolution] = useState<Resolution>("1m");
  const [resolutions, setResolutions] =
    useState<readonly Resolution[]>(FALLBACK_RESOLUTIONS);
  const [rows, setRows] = useState<readonly SymbolRow[]>([]);
  const [flow, setFlow] = useState<ReadonlyMap<string, SymbolFlow>>(
    () => new Map(),
  );
  // The session the flow answer describes: the chart's own day when one is
  // named, otherwise whichever session the tape actually kept.
  const [flowDay, setFlowDay] = useState("");
  const [sessions, setSessions] = useState<readonly SessionRow[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [watchlistOpen, setWatchlistOpen] = useState(true);
  const [indicatorsOpen, setIndicatorsOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [screenerOpen, setScreenerOpen] = useState(false);
  const [watch, setWatch] = useState<readonly string[]>(readWatchlist);
  const indicators = useIndicators();
  const [appearance, setAppearance, resetAppearance] = useAppearance();
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  const [indicatorTarget, setIndicatorTarget] = useState<string | null>(null);

  // The drawings the reader keeps on this chart, one tool at a time.
  const [tool, setTool] = useState<DrawTool>("cursor");
  const [drawingsHidden, setDrawingsHidden] = useState(false);
  // The notebook lives per chart (symbol|session), not per timeframe: a
  // trend line is a drawing on the tape behind every rung, so switching
  // 1m -> 30m keeps it exactly where it was drawn.
  const drawingKey = `${symbol}|${day}`;
  const [drawings, setDrawings] = useState<readonly Drawing[]>(
    () => loadChartDrawings(`${initial.symbol}|${JUST_LIVE}`),
  );
  useEffect(() => {
    setDrawings(loadChartDrawings(drawingKey));
  }, [drawingKey]);
  const onDrawingComplete = useCallback((drawing: Drawing) => {
    setDrawings((current) => {
      const next = [...current, drawing];
      saveDrawings(drawingKey, next);
      return next;
    });
  }, [drawingKey]);
  const onClearDrawings = useCallback(() => {
    clearDrawings(drawingKey, window.localStorage);
    setDrawings([]);
  }, [drawingKey]);
  // The rail's Save button: the notebook already writes on every commit,
  // so this is the explicit flush the rail offers - the same bytes, now,
  // for a reader who wants the assurance.
  const onSaveDrawings = useCallback(() => {
    saveDrawings(drawingKey, drawings);
  }, [drawingKey, drawings]);

  useEffect(() => {
    window.localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watch));
  }, [watch]);

  // The URL keeps the symbol and drops the day a previous review wrote:
  // the boot above opens live regardless, and a hash naming Friday should
  // not outlive its session in the address bar.
  useEffect(() => {
    if (initial.day.length > 0) {
      window.location.hash = initial.symbol.length > 0
        ? initial.symbol
        : "";
    }
    // Run once at boot, when the stale hash is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The chart you were reading is the chart you get back.
  useEffect(() => {
    if (symbol.length > 0) {
      try {
        window.localStorage.setItem(LAST_SYMBOL_KEY, symbol);
      } catch {
        // A full storage must never stop the chart from opening.
      }
    }
  }, [symbol]);

  const [feedHealth, setFeedHealth] = useState<ReturnType<typeof parseHealth> | null>(null);

  // The service's own facts, read once per mount and again after a refresh.
  useEffect(() => {
    let cancelled = false;
    client
      .health()
      .then((raw) => {
        if (cancelled) {
          return;
        }
        try {
          const health = parseHealth(raw);
          setFeedHealth(health);
          setResolutions(
            health.resolutions.length > 0 ? health.resolutions : FALLBACK_RESOLUTIONS,
          );
          setResolution((current) =>
            health.resolutions.includes(current)
              ? current
              : (health.resolutions[0] ?? "1m"),
          );
        } catch (error) {
          setBootError(error instanceof Error ? error.message : String(error));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setBootError(
            error instanceof ApiError
              ? `${error.category}: ${error.detail}`
              : String(error),
          );
        }
      });
    client
      .sessions()
      .then((report) => {
        if (!cancelled) {
          setSessions(report.sessions);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);
  useVisibleRefresh(() => client.feedHealth().then((raw) => {
    try {
      const snapshot = raw as {
        tape?: ReturnType<typeof parseHealth>["tape"];
        recorder?: ReturnType<typeof parseHealth>["recorder"];
      };
      setFeedHealth((current) => current === null ? null : {
        ...current,
        ...(snapshot.tape === undefined ? {} : { tape: snapshot.tape }),
        ...(snapshot.recorder === undefined
          ? {} : { recorder: snapshot.recorder }),
      });
    } catch {
      // Keep the latest valid diagnostic if an older service returns a shape
      // this UI version does not understand.
    }
  }), FEED_HEALTH_REFRESH_MS);

  // The catalogue with the chosen session's own facts, for the watchlist.
  useEffect(() => {
    let cancelled = false;
    setCatalogueLoading(true);
    client
      .symbolRows(day)
      .then((items) => {
        if (!cancelled) {
          setRows(items);
          setCatalogueLoading(false);
          // Opening on a chart the reader put in the list is the point of a
          // watchlist; only when there is none does the session's own most
          // traded symbol answer.
          const first = openingSymbol(items);
          setSymbol((current) =>
            current.length > 0 ? current : (first?.symbol ?? ""));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRows([]);
          setCatalogueLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, day]);
  useVisibleRefresh(
    () => client.symbolRows(day).then(setRows).then(() => undefined)
      .catch(() => undefined),
    CATALOGUE_REFRESH_MS,
  );

  // The tape's own buy/sell split for every symbol: one call per session, so
  // a watchlist row costs no extra request. A source with no print tape
  // answers an empty map, and the columns say so rather than showing zero.
  useEffect(() => {
    let cancelled = false;
    client
      .orderFlow(day)
      .then((report) => {
        if (cancelled) {
          return;
        }
        const next = new Map<string, SymbolFlow>();
        for (const row of report.symbols) {
          next.set(row.symbol, row);
        }
        setFlow(next);
        setFlowDay(report.day);
      })
      .catch(() => {
        if (!cancelled) {
          setFlow(new Map());
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, day]);
  useVisibleRefresh(() => client.orderFlow(day).then((report) => {
    const next = new Map<string, SymbolFlow>();
    for (const row of report.symbols) next.set(row.symbol, row);
    setFlow(next);
    setFlowDay(report.day);
  }).then(() => undefined).catch(() => undefined), FLOW_REFRESH_MS);

  const feed = useChartFeed(client, symbol, resolution, {
    day,
    days: day.length === 0 ? spanFor(resolution) : undefined,
    backfillDays: day.length === 0 ? backfillFor(resolution) : undefined,
  });
  // The tape's own per-minute buy/sell split, for the volume-delta pane. A
  // live multi-day chart reads the merged span (days, unnamed), so every
  // pane's session is drawn from its own tape; a stored session reads only
  // its own capture. A wide span ships its whole ledger in one answer, so
  // its cadence is three seconds - the folds on the server are incremental
  // and always current, this only spaces out how often the browser redraws
  // a history the pane is not scrolling through.
  const deltaSpan = day.length === 0 ? spanFor(resolution) : 0;
  const delta = useDelta(client, symbol,
    day.length === 0 ? "" : (feed.meta.session?.day ?? day),
    symbol.length > 0, deltaSpan > 8 ? 3_000 : 1_000, deltaSpan);

  // The venue's own book, for the plate under the volume split: a cadence
  // read that stops with the stored session and with the hidden tab.
  const book = useBook(client, symbol, feed.meta.session?.day ?? day,
    day.length === 0);

  // The tape's own print ledger: every order as it came, polled to the
  // one-second tick. A stored drawn-from-archive session never grows, so
  // asking for its ledger would only read a file that is gone.
  const prints = usePrints(client, symbol, feed.meta.session?.day ?? day,
    symbol.length > 0 && !(feed.meta.session?.archived ?? false),
    1_000, day.length === 0 ? spanFor(resolution) : 0);

  const chooseSymbol = useCallback((next: string) => {
    setSymbol(next);
    setSearchOpen(false);
    window.location.hash = day.length > 0 ? `${next}/${day}` : next;
  }, [day]);

  /**
   * Put a symbol on the watchlist and open it.
   *
   * Adding used to mean nothing more than switching the chart, so the list
   * only ever showed the base rows plus whichever symbol was charted last -
   * a fourth add silently replaced the third. An add is an append now, kept
   * in the reader's own order and saved with the rest of the list.
   */
  const addToWatch = useCallback((next: string) => {
    setWatch((current) =>
      current.includes(next) ? current : [...current, next]);
    setSymbol(next);
    setSearchOpen(false);
    window.location.hash = day.length > 0 ? `${next}/${day}` : next;
  }, [day]);

  const chooseDay = useCallback((next: string) => {
    setDay(next);
    window.location.hash = next.length > 0 ? `${symbol}/${next}` : symbol;
  }, [symbol]);

  const bars = feed.meta.payload?.bar_count ?? feed.series.length;
  const session = feed.meta.session;
  const missingMinutes = feed.meta.gaps.reduce(
    (total, gap) => total + Math.round(gap.minutes), 0);

  const emptyNote = useMemo(() => {
    if (symbol.length === 0) {
      return "Choose a symbol to draw.";
    }
    if (feed.meta.payload === null) {
      return "Waiting for the service to answer…";
    }
    if (session !== null && session.note.length > 0) {
      return session.note;
    }
    return `No bar exists for ${symbol} in this session yet. That is an absence ` +
      `of data, not a price of zero.`;
  }, [feed.meta.payload, session, symbol]);

  const sessionLabel = session === null || session.day.length === 0
    ? "No session reported."
    : `${session.day}${session.archived ? ", stored session" : ""}.`;

  return (
    <div className={["app", watchlistOpen ? "app--with-watchlist" : ""]
      .filter(Boolean).join(" ")}>
      <Toolbar
        symbol={symbol}
        resolution={resolution}
        onResolution={setResolution}
        resolutions={resolutions}
        day={day}
        onDay={chooseDay}
        sessions={sessions}
        onRefresh={feed.refresh}
        busy={feed.status === "loading"}
        watchlistOpen={watchlistOpen}
        onToggleWatchlist={() => setWatchlistOpen((open) => !open)}
        indicatorsOpen={indicatorsOpen}
        onToggleIndicators={() => setIndicatorsOpen((open) => !open)}
        onSearch={() => setSearchOpen(true)}
        onOpenSettings={() => setChartSettingsOpen(true)}
        screenerOpen={screenerOpen}
        onToggleScreener={() => setScreenerOpen((open) => !open)}
      />

      {/* The studies sit in a strip above the chart, not in a side column:
          the candles keep every pixel of width. */}
      {indicatorsOpen ? (
        <IndicatorsPanel controller={indicators} onOpen={setIndicatorTarget} />
      ) : null}

      <div className="app__body">
        <DrawToolRail
          tool={tool}
          onTool={setTool}
          hidden={drawingsHidden}
          onHideToggle={() => setDrawingsHidden((hidden) => !hidden)}
          count={drawings.length}
          onClear={onClearDrawings}
          onSave={onSaveDrawings}
        />

        <main className="app__main">
          <ChartCanvas
            series={feed.series}
            gaps={feed.meta.gaps}
            resolution={resolution}
            viewKey={`${symbol}|${day}|${resolution}`}
            version={feed.version}
            volumeAvailable={session?.volume_available ?? false}
            sessionLabel={sessionLabel}
            emptyNote={emptyNote}
            indicators={indicators.specs}
            delta={delta.report?.minutes ?? EMPTY_DELTA}
            heading={symbol.length > 0
              ? `${symbol} · ${timeframeShort(resolution)} · PSX`
              : ""}
            live={feed.status === "live"}
            tool={tool}
            drawings={drawings as readonly Drawing[]}
            drawingsHidden={drawingsHidden}
            onDrawingComplete={onDrawingComplete}
            appearance={appearance}
          />
          <StatusBar
            status={feed.status}
            resolution={resolution}
            market={feed.meta.market}
            symbol={feed.meta.symbol || symbol}
            day={session?.day ?? day}
            sessionNote={session?.note ?? ""}
            archived={session?.archived ?? false}
            captureName={session?.source ?? ""}
            sha256={session?.capture?.sha256 ?? ""}
            bars={bars}
            gaps={feed.meta.gaps.length}
            missingMinutes={missingMinutes}
            sourceLabel={feed.meta.source?.label ?? ""}
            delaySeconds={feed.meta.source?.delay_seconds ?? 0}
            lastBarAt={feed.meta.payload?.bars.at(-1)?.t ?? ""}
            asOf={feed.meta.payload?.as_of ?? ""}
            volumeAvailable={session?.volume_available ?? false}
            staleAfterMinutes={staleFor(resolution)}
            ordersTotal={flow.get(symbol)?.orders ?? null}
            error={feed.error ?? (bootError === null ? null
              : { category: "INTERNAL", detail: bootError })}
            details={detailsOpen}
            tape={feedHealth?.tape}
            recorder={feedHealth?.recorder}
          />
          <button
            type="button"
            className="app__details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            {detailsOpen ? "hide data detail" : "show data detail"}
          </button>
          {detailsOpen ? <NotesPanel meta={feed.meta} /> : null}
          {screenerOpen ? (
            <Screener
              rows={rows}
              loading={catalogueLoading}
              day={day}
            flow={flow}
            onSymbol={(next) => {
              chooseSymbol(next);
              setScreenerOpen(false);
            }}
            onClose={() => setScreenerOpen(false)}
          />
          ) : null}
        </main>

        {watchlistOpen ? (
          <Watchlist
            rows={rows}
            watch={watch}
            symbol={symbol}
            day={day.length > 0 ? day : flowDay}
            storedDay={day}
            loading={catalogueLoading}
            onSymbol={(next) => {
              chooseSymbol(next);
            }}
            onAdd={addToWatch}
            onWatchChange={setWatch}
            flow={flow}
            book={book}
            tape={prints.report}
            searchOpen={searchOpen}
            onSearchOpen={() => setSearchOpen(true)}
            onSearchClose={() => setSearchOpen(false)}
          />
        ) : (
          <SymbolSearch
            open={searchOpen}
            rows={rows}
            loading={catalogueLoading}
            action="add"
            onPick={chooseSymbol}
            onClose={() => setSearchOpen(false)}
          />
        )}
      </div>

      {chartSettingsOpen ? (
        <ChartSettingsDialog
          appearance={appearance}
          onAppearance={setAppearance}
          onReset={resetAppearance}
          onClose={() => setChartSettingsOpen(false)}
        />
      ) : null}
      {indicatorTarget !== null ? (() => {
        const spec = indicators.specs.find((item) => item.id === indicatorTarget);
        if (spec === undefined) {
          return null;
        }
        return (
          <IndicatorSettingsDialog
            spec={spec}
            definition={definitionFor(spec.type)}
            controller={indicators}
            onClose={() => setIndicatorTarget(null)}
          />
        );
      })() : null}
    </div>
  );
}
