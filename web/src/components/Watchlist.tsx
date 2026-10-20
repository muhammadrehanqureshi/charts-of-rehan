/**
 * The watchlist.
 *
 * It shows exactly what the service measured for the session in view: a
 * symbol with no bars in that session says "no bars" rather than showing a
 * blank price or, worse, a zero. The list is ordered by the service (symbols
 * that traded first), the filter is local, and clicking a row selects it.
 *
 * Nothing here fetches: the rows arrive with the session and the selecting
 * happens in the parent, so a click cannot start a request storm.
 */

import { useMemo, useState } from "react";

import type { SymbolRow } from "../api/types";
import { formatClock, formatPrice } from "../chart/format";

export interface WatchlistProps {
  readonly rows: readonly SymbolRow[];
  readonly symbol: string;
  readonly day: string;
  readonly loading: boolean;
  readonly onSymbol: (symbol: string) => void;
}

export function Watchlist(props: WatchlistProps) {
  const { rows, symbol, day, loading, onSymbol } = props;
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toUpperCase();
    const matching = needle.length === 0
      ? rows
      : rows.filter((row) => row.symbol.includes(needle));
    // The two index proxies are the session's own breadth, so they sit above
    // the stocks a reader has to scroll through.
    return [...matching].sort((left, right) =>
      Number(right.index === true) - Number(left.index === true));
  }, [filter, rows]);

  const traded = rows.filter((row) => (row.bars ?? 0) > 0).length;

  return (
    <aside className="watchlist" aria-label="watchlist">
      <div className="watchlist__head">
        <label className="watchlist__filter">
          <span className="visually-hidden">filter symbols</span>
          <input
            type="search"
            value={filter}
            spellCheck={false}
            autoComplete="off"
            placeholder="filter"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <span className="watchlist__count" title="symbols with bars in this session">
          {rows.length === 0
            ? "no catalogue"
            : `${traded} of ${rows.length} traded`}
        </span>
      </div>

      {loading ? (
        <p className="watchlist__quiet">reading the catalogue…</p>
      ) : shown.length === 0 ? (
        <p className="watchlist__quiet">
          {rows.length === 0
            ? "the service reported no symbols for this session"
            : `nothing matches ${filter.trim().toUpperCase()}`}
        </p>
      ) : (
        <ul className="watchlist__list">
          {shown.map((row) => {
            const active = row.symbol === symbol;
            const bars = row.bars ?? 0;
            return (
              <li key={row.symbol}>
                <button
                  type="button"
                  className={active ? "row row--active" : "row"}
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSymbol(row.symbol)}
                >
                  <span className="row__symbol">
                    {row.symbol}
                    {row.index === true ? <span className="row__badge">index</span> : null}
                  </span>
                  <span className="row__price">
                    {row.close === null ? (
                      <span className="row__note">
                        {bars > 0 ? "no price" : "no bars"}
                      </span>
                    ) : (
                      formatPrice(row.close)
                    )}
                  </span>
                  <span className="row__meta">
                    {bars > 0 && row.last !== null
                      ? `${bars} bars · to ${formatClock(row.last)}`
                      : day.length > 0
                        ? `nothing on ${day}`
                        : "nothing yet today"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
