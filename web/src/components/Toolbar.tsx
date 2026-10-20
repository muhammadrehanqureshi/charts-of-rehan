/**
 * The top toolbar: symbol, resolution, session, and the two view controls.
 *
 * Every option here comes from the service's own answer, never from the
 * browser's clock: the resolutions are the ones the source says it serves, and
 * the sessions are the days the service says it can draw. So the UI cannot
 * ask for something that does not exist, and a reader cannot be shown a
 * choice that silently fails.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { Resolution, SessionRow } from "../api/types";
import { formatDay } from "../chart/format";
import {
  TIMEFRAME_GROUPS,
  TIMEFRAMES,
  timeframeLabel,
} from "../chart/timeframes";

export interface ToolbarProps {
  readonly symbol: string;
  readonly onSymbol: (symbol: string) => void;
  readonly catalogue: readonly string[];
  readonly resolution: Resolution;
  readonly onResolution: (resolution: Resolution) => void;
  readonly resolutions: readonly Resolution[];
  /** The chosen session day, or "" for the live one. */
  readonly day: string;
  readonly onDay: (day: string) => void;
  readonly sessions: readonly SessionRow[];
  readonly today: string;
  readonly theme: "dark" | "light";
  readonly onTheme: (theme: "dark" | "light") => void;
  readonly onRefresh: () => void;
  readonly busy: boolean;
  readonly watchlistOpen: boolean;
  readonly onToggleWatchlist: () => void;
  readonly indicatorsOpen: boolean;
  readonly onToggleIndicators: () => void;
}

export function Toolbar(props: ToolbarProps) {
  const {
    symbol, onSymbol, catalogue, resolution, onResolution, resolutions,
    day, onDay, sessions, today, theme, onTheme, onRefresh, busy,
    watchlistOpen, onToggleWatchlist, indicatorsOpen, onToggleIndicators,
  } = props;
  const [query, setQuery] = useState<string | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const available = useMemo(
    () => TIMEFRAMES.filter((item) => resolutions.includes(item.id)),
    [resolutions],
  );

  const matches = useMemo(() => {
    if (query === null) {
      return [];
    }
    const needle = query.trim().toUpperCase();
    if (needle.length === 0) {
      return catalogue.slice(0, 12);
    }
    return catalogue.filter((item) => item.includes(needle)).slice(0, 12);
  }, [catalogue, query]);

  useEffect(() => {
    if (query === null) {
      return;
    }
    const close = (event: MouseEvent) => {
      if (box.current !== null && !box.current.contains(event.target as Node)) {
        setQuery(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [query]);

  const choose = (next: string) => {
    setQuery(null);
    onSymbol(next);
  };

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__mark">CR</span>
        <span className="toolbar__title">Charts of Rehan</span>
      </div>

      <div className="toolbar__group" ref={box}>
        <button
          type="button"
          className="toolbar__toggle"
          aria-expanded={watchlistOpen}
          aria-label={watchlistOpen ? "hide watchlist" : "show watchlist"}
          onClick={onToggleWatchlist}
          title="Show or hide the watchlist"
        >
          {watchlistOpen ? "◧" : "◨"}
        </button>
        <label className="toolbar__field toolbar__field--search">
          <span className="visually-hidden">symbol</span>
          <input
            type="text"
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls="symbol-options"
            aria-label="symbol"
            value={query ?? symbol}
            spellCheck={false}
            autoComplete="off"
            placeholder="symbol"
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setQuery("")}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const first = matches[0];
                if (first !== undefined) {
                  choose(first);
                } else if ((query ?? "").trim().length > 0) {
                  choose((query ?? "").trim().toUpperCase());
                }
              }
              if (event.key === "Escape") {
                setQuery(null);
              }
            }}
          />
        </label>
        {query !== null && matches.length > 0 ? (
          <ul className="toolbar__options" id="symbol-options" role="listbox">
            {matches.map((item) => (
              <li key={item}>
                <button type="button" role="option" aria-selected={item === symbol}
                        onClick={() => choose(item)}>
                  {item}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="toolbar__group toolbar__group--indices"
           role="group" aria-label="index charts">
        {["KSE100", "KMIALLSHR"].map((name) => (
          <button
            key={name}
            type="button"
            className={name === symbol ? "chip chip--on" : "chip"}
            aria-pressed={name === symbol}
            title={`${name} computed proxy from this session's tape`}
            onClick={() => onSymbol(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <label className="toolbar__field toolbar__field--timeframe">
        <span className="visually-hidden">timeframe</span>
        <select
          aria-label="timeframe"
          value={resolutions.includes(resolution) ? resolution : "1m"}
          onChange={(event) => onResolution(event.target.value as Resolution)}
        >
          {TIMEFRAME_GROUPS.map((group) => {
            const options = available.filter((item) => item.group === group.key);
            return options.length === 0 ? null : (
              <optgroup key={group.key} label={group.label}>
                {options.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </optgroup>
            );
          })}
        </select>
        <span className="toolbar__timeframe-hint" aria-hidden="true">
          {timeframeLabel(resolution)}
        </span>
      </label>

      <label className="toolbar__field">
        <span className="visually-hidden">session</span>
        <select
          aria-label="session"
          value={day}
          onChange={(event) => onDay(event.target.value)}
        >
          <option value="">live{today.length > 0 ? ` (${formatDay(`${today}T00:00:00+05:00`)})` : ""}</option>
          {sessions.map((row) => (
            <option key={row.day} value={row.day}>
              {formatDay(`${row.day}T00:00:00+05:00`)}
              {row.current ? " (today)" : ""}
              {row.archived ? " · stored" : ""}
            </option>
          ))}
        </select>
      </label>

      <div className="toolbar__group toolbar__group--end">
        <button
          type="button"
          className={indicatorsOpen ? "chip chip--on" : "chip"}
          aria-pressed={indicatorsOpen}
          title="Show or hide the indicator panel"
          onClick={onToggleIndicators}
        >
          indicators
        </button>
        <button type="button" onClick={onRefresh} disabled={busy}>
          {busy ? "loading…" : "reload"}
        </button>
        <button
          type="button"
          onClick={() => onTheme(theme === "dark" ? "light" : "dark")}
          aria-label={`switch to the ${theme === "dark" ? "light" : "dark"} theme`}
          title="Light or dark"
        >
          {theme === "dark" ? "☾" : "☀"}
        </button>
      </div>
    </header>
  );
}
