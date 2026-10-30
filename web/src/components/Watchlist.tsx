/**
 * The watchlist, on the right, in the terminal's own shape.
 *
 * Four facts and a name per row - the session's last price, its change in
 * percent, and the tape's own buy and sell share counts - right aligned and
 * tabular, in a list that is nothing but rows: a hairline under the header,
 * no grid, no badges shouting. The row being charted sits in a lighter plate
 * with a teal edge, so the eye finds it without reading. Removing a symbol is
 * the small x that appears while the pointer is on its row (or on keyboard
 * focus), not furniture on every line.
 *
 * The list is the reader's own: adding a symbol appends it and keeps it,
 * whatever the chart is showing. There is no ceiling on how many rows a
 * watchlist may hold - the panel scrolls.
 *
 * Under the list, the detail card: the symbol's last price, the change
 * against the session's first print, the session range, and the tape's own
 * volume split (buy, sell, delta) exactly as the venue's counters measured
 * them, never an estimate.
 */

import { useMemo } from "react";

import type { BookReport, PrintReport, SymbolFlow, SymbolRow } from "../api/types";
import {
  formatClock,
  formatClockSeconds,
  formatPrice,
  formatVolume,
} from "../chart/format";
import { SymbolSearch } from "./SymbolSearch";

export interface WatchlistProps {
  readonly rows: readonly SymbolRow[];
  /** The user's own symbols, in their order. */
  readonly watch: readonly string[];
  readonly symbol: string;
  readonly day: string;
  /** The session itself the reader chose, "" for the live one; the note is
   * the only place the two must be told apart. */
  readonly storedDay?: string;
  readonly loading: boolean;
  readonly onSymbol: (symbol: string) => void;
  /** Append one symbol to the list and open it. */
  readonly onAdd: (symbol: string) => void;
  readonly onWatchChange: (next: readonly string[]) => void;
  /** The quick-add dialog is owned by the parent so the toolbar shares it. */
  readonly searchOpen: boolean;
  readonly onSearchOpen: () => void;
  readonly onSearchClose: () => void;
  /** Every symbol's buy/sell split for this session, when the tape has one. */
  readonly flow?: ReadonlyMap<string, SymbolFlow>;
  /** The active symbol's top of the venue's own book, as the tape saw it. */
  readonly book?: BookReport | null;
  /** The active symbol's own print ledger: the orders as they came. */
  readonly tape?: PrintReport | null;
}

/** The change of the session so far, measured against its first print. */
export function sessionChange(
  row: SymbolRow | undefined,
): { change: number; percent: number } | null {
  if (row === undefined || row.close == null || row.open == null
      || row.open === 0) {
    return null;
  }
  const change = row.close - row.open;
  return { change, percent: change / row.open * 100 };
}

function tone(percent: number | null | undefined): string {
  if (percent === null || percent === undefined || percent === 0) {
    return "";
  }
  return percent > 0 ? " wrow__cell--up" : " wrow__cell--down";
}

/**
 * The day's own total: the shares the evidence named a side, buy plus sell.
 * A split the tape could not attribute stays out of it, exactly as the venue
 * measured nothing firm about it.
 */
export function dayTotal(flow: SymbolFlow | null | undefined,
): number | null {
  if (flow === undefined || flow === null) {
    return null;
  }
  if (flow.classified_volume != null) {
    return flow.classified_volume;
  }
  if (flow.buy_volume == null && flow.sell_volume == null) {
    return null;
  }
  return (flow.buy_volume ?? 0) + (flow.sell_volume ?? 0);
}

function side(
  value: number | null | undefined,
  kind: "buy" | "sell",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)
      || value <= 0) {
    return "-";
  }
  return `${kind === "buy" ? "" : ""}${formatVolume(value)}`;
}

export function Watchlist(props: WatchlistProps) {
  const {
    rows, watch, symbol, day, loading, onSymbol, onAdd, onWatchChange,
    searchOpen, onSearchOpen, onSearchClose, flow, book, tape, storedDay,
  } = props;
  const bySymbol = useMemo(() => {
    const map = new Map<string, SymbolRow>();
    for (const row of rows) {
      map.set(row.symbol, row);
    }
    return map;
  }, [rows]);

  const traded = rows.filter((row) => (row.bars ?? 0) > 0).length;
  const detail = bySymbol.get(symbol);
  const detailFlow = flow?.get(symbol);
  const detailChange = sessionChange(detail);

  const remove = (name: string) => {
    onWatchChange(watch.filter((item) => item !== name));
  };

  /**
   * The live order columns: the newest classified prints split apart.
   *
   * The reader asked for the buys and the sells in their own columns,
   * not one interleaved list, so each side reads top-down the way it
   * arrives - newest first, the price and the size of every print, the
   * side letter itself redundant inside its own column. A print the
   * ledger could not attribute belongs to neither column; the day
   * table above always carries the full measured split.
   */
  const buys = tape === null || tape === undefined
    ? [] : tape.events.filter((event) => event.side === "B").slice(-25).reverse();
  const sells = tape === null || tape === undefined
    ? [] : tape.events.filter((event) => event.side === "S").slice(-25).reverse();

  return (
    <div className="watchpane">
      <SymbolSearch
        open={searchOpen}
        rows={rows}
        loading={loading}
        action="add"
        onPick={onAdd}
        onClose={onSearchClose}
      />

      <section className="watchlist" aria-label="watchlist">
        <header className="watchlist__head">
          <h2 className="watchlist__title">Watchlist</h2>
          <div className="watchlist__tools">
            <button
              type="button"
              className="watchlist__tool"
              aria-label="search the catalogue"
              title="Search the catalogue"
              onClick={onSearchOpen}
            >
              ⌕
            </button>
            <button
              type="button"
              className="watchlist__tool"
              aria-label="add symbol to the watchlist"
              title="Add a symbol"
              onClick={onSearchOpen}
            >
              +
            </button>
          </div>
        </header>

        <div className="watchlist__body">
          <table className="watchlist__table">
            <thead>
              <tr>
                <th scope="col" className="watchlist__th watchlist__th--symb">
                  Symbol
                </th>
                <th scope="col" className="watchlist__th">Last</th>
                <th scope="col" className="watchlist__th">Chg%</th>
                <th scope="col" className="watchlist__th">Buy</th>
                <th scope="col" className="watchlist__th">Sell</th>
                <th scope="col" className="watchlist__th watchlist__th--total">Total</th>
              </tr>
            </thead>
            <tbody>
              {watch.length === 0 ? (
                <tr>
                  <td colSpan={6} className="watchlist__quiet">
                    {loading
                      ? "reading the catalogue…"
                      : "Your list is empty. Use + to put symbols on it."}
                  </td>
                </tr>
              ) : watch.map((name) => {
                const row = bySymbol.get(name);
                const change = sessionChange(row);
                const active = name === symbol;
                const bars = row?.bars ?? 0;
                const own = tone(change?.percent);
                const money = flow?.get(name);
                return (
                  <tr
                    key={name}
                    className={active ? "wrow wrow--active" : "wrow"}
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSymbol(name)}
                  >
                    <th scope="row" className="wrow__cell wrow__cell--symb">
                      <button
                        type="button"
                        className="wrow__open"
                        onClick={(event) => {
                          event.stopPropagation();
                          onSymbol(name);
                        }}
                        title={`open ${name} on the chart`}
                      >
                        {name}
                      </button>
                      {row?.index === true
                        ? <span className="wrow__tag">IDX</span>
                        : null}
                      <button
                        type="button"
                        className="wrow__remove"
                        aria-label={`remove ${name} from the watchlist`}
                        title={`remove ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          remove(name);
                        }}
                      >
                        ✕
                      </button>
                    </th>
                    <td className="wrow__cell">
                      {row?.close === null || row === undefined
                        ? <span className="wrow__absent">
                            {loading ? "…" : bars > 0 ? "no price" : "no bars"}
                          </span>
                        : formatPrice(row.close)}
                    </td>
                    <td className={"wrow__cell" + own}>
                      {change === null
                        ? "-"
                        : `${change.percent >= 0 ? "+" : ""}` +
                          `${change.percent.toFixed(2)}%`}
                    </td>
                    <td className="wrow__cell wrow__cell--buy">
                      {side(money?.buy_volume, "buy")}
                    </td>
                    <td className="wrow__cell wrow__cell--sell">
                      {side(money?.sell_volume, "sell")}
                    </td>
                    <td className="wrow__cell wrow__cell--total">
                      {side(dayTotal(money), "buy")}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="watchlist__note">
          {traded} of {rows.length} traded ·{" "}
          {(storedDay ?? day).length > 0
            ? `stored session ${storedDay ?? day}`
            : "this live session"}{" "}
          · change against the first print
        </p>
      </section>

      <section className="detail" aria-label="symbol detail">
        {detail === undefined ? (
          <p className="detail__quiet">
            {symbol.length === 0
              ? "no symbol chosen"
              : `${symbol} has no row in this session's catalogue`}
          </p>
        ) : (
          <>
            <div className="detail__who">
              <span className="detail__symbol">{detail.symbol}</span>
              <span className="detail__market">
                {detail.index === true ? "INDEX · PSX" : "PSX"}
              </span>
            </div>
            <p className="detail__price">
              {detail.close === null
                ? <span className="detail__absent">no price this session</span>
                : formatPrice(detail.close)}
              {detailChange !== null && detail.close !== null ? (
                <span className={detailChange.change < 0
                  ? "detail__chg detail__chg--down"
                  : "detail__chg detail__chg--up"}>
                  {" "}{detailChange.change.toFixed(2)}{" "}
                  ({detailChange.percent >= 0 ? "+" : ""}
                  {detailChange.percent.toFixed(2)}%)
                </span>
              ) : null}
            </p>
            {typeof detail.high === "number" && typeof detail.low === "number"
              && detail.close !== null
              ? (
                <div className="detail__range">
                  <span className="detail__rangelow">{formatPrice(detail.low)}</span>
                  <span className="detail__rangebar" aria-hidden="true">
                    <span className="detail__rangepoint" style={{
                      left: `${Math.min(100, Math.max(0,
                        (detail.close - detail.low)
                        / Math.max(1e-9, detail.high - detail.low) * 100))}%`,
                    }} />
                  </span>
                  <span className="detail__rangehigh">{formatPrice(detail.high)}</span>
                </div>
              )
              : null}
            <dl className="detail__stats detail__stats--flow">
              <div>
                <dt>buy</dt>
                <dd className="detail__buy">
                  {detailFlow?.buy_volume == null
                    ? "-" : formatVolume(detailFlow.buy_volume)}
                </dd>
              </div>
              <div>
                <dt>sell</dt>
                <dd className="detail__sell">
                  {detailFlow?.sell_volume == null
                    ? "-" : formatVolume(detailFlow.sell_volume)}
                </dd>
              </div>
              <div>
                <dt>total</dt>
                <dd className="detail__total">
                  {dayTotal(detailFlow) == null
                    ? "-" : formatVolume(dayTotal(detailFlow) as number)}
                </dd>
              </div>
              <div>
                <dt>delta</dt>
                <dd className={(detailFlow?.delta ?? 0) < 0
                  ? "detail__sell" : "detail__buy"}>
                  {detailFlow?.delta == null
                    ? "-"
                    : `${detailFlow.delta > 0 ? "+" : ""}` +
                      formatVolume(detailFlow.delta)}
                </dd>
              </div>
            </dl>
            <dl className="detail__stats">
              <div>
                <dt>volume</dt>
                <dd>{detail.volume == null
                  ? "-" : formatVolume(detail.volume)}</dd>
              </div>
              <div>
                <dt>bars</dt>
                <dd>{detail.bars ?? 0}</dd>
              </div>
              <div>
                <dt>first</dt>
                <dd>{detail.first === null ? "-" : formatClock(detail.first)}</dd>
              </div>
              <div>
                <dt>last</dt>
                <dd>{detail.last === null ? "-" : formatClock(detail.last)}</dd>
              </div>
            </dl>
            {book !== undefined && book !== null
              ? (
                <dl className="detail__book" aria-label="order book">
                  <div>
                    <dt>bid</dt>
                    <dd className="detail__buy">
                      {book.bid === null
                        ? "-"
                        : `${formatPrice(book.bid)}`}
                      <span className="detail__booksize">
                        {book.bid_size == null ? "" : formatVolume(book.bid_size)}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>ask</dt>
                    <dd className="detail__sell">
                      {book.ask === null
                        ? "-"
                        : `${formatPrice(book.ask)}`}
                      <span className="detail__booksize">
                        {book.ask_size == null ? "" : formatVolume(book.ask_size)}
                      </span>
                    </dd>
                  </div>
                  <>
                      <div>
                        <dt className="detail__bookhead">buy (session)</dt>
                        <dd className="detail__buy">
                          {detailFlow?.buy_volume == null
                            ? "-" : formatVolume(detailFlow.buy_volume)}
                        </dd>
                      </div>
                      <div>
                        <dt className="detail__bookhead">sell (session)</dt>
                        <dd className="detail__sell">
                          {detailFlow?.sell_volume == null
                            ? "-" : formatVolume(detailFlow.sell_volume)}
                        </dd>
                      </div>
                      <div>
                        <dt className="detail__bookhead">B+S total</dt>
                        <dd className="detail__total">
                          {dayTotal(detailFlow) == null
                            ? "-" : formatVolume(dayTotal(detailFlow) as number)}
                        </dd>
                      </div>
                  </>
                </dl>
              )
              : null}
            {book !== undefined && book !== null
              && (book.note.length > 0 || book.at === null)
              ? <p className="watchlist__note">{book.note}</p>
              : book !== undefined && book !== null && book.at !== null
                ? <p className="watchlist__note">
                    the broker's own book, as observed {formatClock(book.at)}
                  </p>
                : null}
            {tape !== undefined && tape !== null
              ? (
                <section className="tape" aria-label="live tape">
                  <div className="tape__head">
                    <h3 className="tape__title">Live tape</h3>
                    <span className="tape__count">
                      {tape.totals?.prints ?? tape.events_total} prints
                    </span>
                  </div>
                  {tape.days.length > 0 ? (
                    <table className="tape__days" aria-label="volume totals by day">
                      <thead>
                        <tr>
                          <th scope="col">day</th>
                          <th scope="col">buy</th>
                          <th scope="col">sell</th>
                          <th scope="col">total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tape.days.map((row) => (
                          <tr key={row.day}
                            className={row.day === tape.day
                              ? "tape__day tape__day--now" : "tape__day"}>
                            <td>
                              {row.day === tape.day ? "today" : row.day}
                            </td>
                            <td className="detail__buy">
                              {row.totals.buy_volume == null
                                ? "-" : formatVolume(row.totals.buy_volume)}
                            </td>
                            <td className="detail__sell">
                              {row.totals.sell_volume == null
                                ? "-" : formatVolume(row.totals.sell_volume)}
                            </td>
                            <td className="detail__total">
                              {row.totals.classified_volume == null
                                ? "-"
                                : formatVolume(row.totals.classified_volume)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    // No day table came back with the ledger: build the
                    // same column plate for the day this ledger covers,
                    // because the totals below it are that day's buy, sell
                    // and buy+sell exactly as the by-day table reads them.
                    <table className="tape__days" aria-label="volume totals by day">
                      <thead>
                        <tr>
                          <th scope="col">day</th>
                          <th scope="col">buy</th>
                          <th scope="col">sell</th>
                          <th scope="col">total</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="tape__day tape__day--now">
                          <td>{tape.day === day ? "today" : tape.day}</td>
                          <td className="detail__buy">
                            {tape.totals?.buy_volume == null
                              ? "-" : formatVolume(tape.totals.buy_volume)}
                          </td>
                          <td className="detail__sell">
                            {tape.totals?.sell_volume == null
                              ? "-" : formatVolume(tape.totals.sell_volume)}
                          </td>
                          <td className="detail__total">
                            {tape.totals?.classified_volume == null
                              ? "-"
                              : formatVolume(tape.totals.classified_volume)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                  <div className="tape__cols" aria-label="live orders, buy and sell sides">
                    <div className="tape__col tape__col--buy">
                      <div className="tape__colhead tape__colhead--buy">buy</div>
                      <ul className="tape__list tape__list--side">
                        {buys.length > 0
                          ? buys.map((event, at) => (
                            <li key={`b-${event.t}-${at}`} className="tape__row">
                              <span className="tape__time">
                                {formatClockSeconds(event.t)}
                              </span>
                              <span className="tape__price">
                                {formatPrice(event.price)}
                              </span>
                              <span className="tape__size">
                                {event.size == null ? "–" : formatVolume(event.size)}
                              </span>
                            </li>
                          ))
                          : (
                            <li className="tape__empty">no buys yet</li>
                          )}
                      </ul>
                    </div>
                    <div className="tape__col tape__col--sell">
                      <div className="tape__colhead tape__colhead--sell">sell</div>
                      <ul className="tape__list tape__list--side">
                        {sells.length > 0
                          ? sells.map((event, at) => (
                            <li key={`s-${event.t}-${at}`} className="tape__row">
                              <span className="tape__time">
                                {formatClockSeconds(event.t)}
                              </span>
                              <span className="tape__price">
                                {formatPrice(event.price)}
                              </span>
                              <span className="tape__size">
                                {event.size == null ? "–" : formatVolume(event.size)}
                              </span>
                            </li>
                          ))
                          : (
                            <li className="tape__empty">no sells yet</li>
                          )}
                      </ul>
                    </div>
                  </div>
                  {tape.notes.length > 0
                    ? <p className="watchlist__note">{tape.notes.join(" ")}</p>
                    : null}
                </section>
              )
              : null}
          </>
        )}
      </section>
    </div>
  );
}
