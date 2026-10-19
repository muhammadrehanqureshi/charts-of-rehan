/**
 * The application shell: a charting terminal, not a dashboard.
 *
 * The layout is deliberately the one a person who reads charts all day
 * expects: a thin toolbar, a watchlist on the left, the chart taking every
 * remaining pixel, a status bar under it, and one collapsible panel for the
 * detail (notes, measured gaps, ingestion health) that is available rather
 * than in the way.
 *
 * What lives here is only what a human chooses (symbol, resolution, session,
 * theme) and what the service says about itself (catalogue, sessions,
 * resolutions). The series belongs to the feed hook and the pixels belong to
 * the canvas.
 *
 * The session is the owner's own requirement: the chart has to work when the
 * exchange does not, so the day selector is built from the service's own
 * answer and offers the live session plus every stored one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, ChartClient } from "./api/client";
import { type Resolution, type SessionRow, type SymbolRow, parseHealth } from "./api/types";
import { ChartCanvas } from "./components/ChartCanvas";
import { NotesPanel } from "./components/NotesPanel";
import { StatusBar } from "./components/StatusBar";
import { Toolbar } from "./components/Toolbar";
import { Watchlist } from "./components/Watchlist";
import { useChartFeed } from "./hooks/useChartFeed";

const FALLBACK_RESOLUTIONS: readonly Resolution[] = ["1m"];

/** A session in play for longer than this gets a visible warning (minutes). */
const STALE_AFTER_MINUTES = 12;

function hash(): { symbol: string; day: string } {
  const raw = window.location.hash.replace(/^#/, "");
  const [symbol = "", day = ""] = raw.split("/");
  return { symbol: symbol.trim().toUpperCase(), day: day.trim() };
}

function useTheme(): ["dark" | "light", (mode: "dark" | "light") => void] {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    const stored = window.localStorage.getItem("charts-theme");
    return stored === "light" ? "light" : "dark";
  });
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    window.localStorage.setItem("charts-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}

export function App() {
  const client = useMemo(() => new ChartClient(), []);
  const initial = useMemo(hash, []);
  const [symbol, setSymbol] = useState(initial.symbol);
  const [day, setDay] = useState(initial.day);
  const [resolution, setResolution] = useState<Resolution>("1m");
  const [resolutions, setResolutions] =
    useState<readonly Resolution[]>(FALLBACK_RESOLUTIONS);
  const [rows, setRows] = useState<readonly SymbolRow[]>([]);
  const [sessions, setSessions] = useState<readonly SessionRow[]>([]);
  const [today, setToday] = useState("");
  const [catalogue, setCatalogue] = useState<readonly string[]>([]);
  const [bootError, setBootError] = useState<string | null>(null);
  const [catalogueLoading, setCatalogueLoading] = useState(true);
  const [watchlistOpen, setWatchlistOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [theme, setTheme] = useTheme();

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
          setToday(report.today);
        }
      })
      .catch(() => undefined);
    client
      .symbols()
      .then((items) => {
        if (!cancelled) {
          // The picker's own list. Choosing the starting symbol is the
          // watchlist's job, because only that answer says which symbols the
          // session actually printed.
          setCatalogue(items);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

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
          // The service orders traded symbols first, so opening on the first
          // row opens on a symbol the session actually printed: a chart that
          // starts on an empty symbol looks broken when it is only empty.
          const first = items.find((row) => (row.bars ?? 0) > 0) ?? items[0];
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

  const feed = useChartFeed(client, symbol, resolution, { day });

  const chooseSymbol = useCallback((next: string) => {
    setSymbol(next);
    window.location.hash = next;
  }, []);

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
    <div className={watchlistOpen ? "app app--with-watchlist" : "app"}>
      <Toolbar
        symbol={symbol}
        onSymbol={chooseSymbol}
        catalogue={catalogue}
        resolution={resolution}
        onResolution={setResolution}
        resolutions={resolutions}
        day={day}
        onDay={chooseDay}
        sessions={sessions}
        today={today}
        theme={theme}
        onTheme={setTheme}
        onRefresh={feed.refresh}
        busy={feed.status === "loading"}
        watchlistOpen={watchlistOpen}
        onToggleWatchlist={() => setWatchlistOpen((open) => !open)}
      />

      <div className="app__body">
        {watchlistOpen ? (
          <Watchlist
            rows={rows}
            symbol={symbol}
            day={day}
            loading={catalogueLoading}
            onSymbol={chooseSymbol}
          />
        ) : null}

        <main className="app__main">
          <ChartCanvas
            series={feed.series}
            gaps={feed.meta.gaps}
            version={feed.version}
            volumeAvailable={session?.volume_available ?? false}
            theme={theme}
            sessionLabel={sessionLabel}
            emptyNote={emptyNote}
          />
          <StatusBar
            status={feed.status}
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
            staleAfterMinutes={STALE_AFTER_MINUTES}
            error={feed.error ?? (bootError === null ? null
              : { category: "INTERNAL", detail: bootError })}
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
        </main>
      </div>
    </div>
  );
}
