/**
 * The top bar, in TradingView's shape.
 *
 * Left: the brand, the symbol button that opens the quick search, the
 * timeframe chips, the labeled Indicators button and the session picker.
 * Right: reload and the theme. Group separators between the clusters, as on
 * the trading terminal. Everything offered here exists in the service's own
 * answer - the chips are only the resolutions it serves, and the session menu
 * only the days it can draw - so nothing on this bar can silently fail.
 *
 * The watchlist has no hide/show control here: the pane is part of the
 * terminal, always on, and its layout gives the list real height.
 */

import type { Resolution, SessionRow } from "../api/types";
import { formatDay } from "../chart/format";
import { TIMEFRAMES, timeframeLabel } from "../chart/timeframes";

export interface ToolbarProps {
  readonly symbol: string;
  readonly resolution: Resolution;
  readonly onResolution: (resolution: Resolution) => void;
  readonly resolutions: readonly Resolution[];
  /** The chosen session day, or "" for the live one. */
  readonly day: string;
  readonly onDay: (day: string) => void;
  readonly sessions: readonly SessionRow[];
  readonly onRefresh: () => void;
  readonly busy: boolean;
  readonly indicatorsOpen: boolean;
  readonly onToggleIndicators: () => void;
  readonly onSearch: () => void;
  readonly onOpenSettings: () => void;
  readonly screenerOpen: boolean;
  readonly onToggleScreener: () => void;
  /** Flat no-trade buckets for missing session buckets, visibly marked. */
  readonly fillFlat: boolean;
  readonly onToggleFillFlat: () => void;
  /** Daily rows attached behind an intraday rung, in days. */
  readonly tailDays: number;
  readonly onTailDays: (days: number) => void;
  /** True only on the rungs that can carry a daily tail at all. */
  readonly tailOn: boolean;
}

/**
 * The daily-history choices, in days.
 *
 * Zero is a real choice: only recorded sessions, no daily context candles. A
 * fortnight covers a gap the recorder may have missed; the full store is the
 * decade behind the tape, which is what a reader pans back through.
 */
const TAIL_CHOICES = [0, 15, 60, 2_600] as const;

export function Toolbar(props: ToolbarProps) {
  const {
    symbol, resolution, onResolution, resolutions, day, onDay, sessions,
    onRefresh, busy, indicatorsOpen, onToggleIndicators, onSearch,
    onOpenSettings, screenerOpen, onToggleScreener, fillFlat,
    onToggleFillFlat, tailDays, onTailDays, tailOn,
  } = props;
  const available = TIMEFRAMES.filter((item) => resolutions.includes(item.id));

  return (
    <header className="toolbar">
      <div className="toolbar__cell">
        <span
          className="toolbar__brand"
          aria-label="Charts of Rehan"
          title="Charts of Rehan - the PSX chart terminal"
        >
          <img
            className="toolbar__brand-mark"
            src="/logo.png"
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        </span>
      </div>

      <div className="toolbar__sep" aria-hidden="true" />

      <div className="toolbar__cell">
        <button
          type="button"
          className="toolbar__symbol"
          onClick={onSearch}
          title="Choose a symbol (opens the quick search)"
        >
          <span className="toolbar__symbol-name">{symbol || "symbol"}</span>
          <span className="toolbar__symbol-caret" aria-hidden="true">▾</span>
        </button>
      </div>

      <div className="toolbar__sep" aria-hidden="true" />

      <div className="toolbar__cell toolbar__cell--grow" role="group"
           aria-label="timeframe">
        {available.map((item) => (
          <button
            key={item.id}
            type="button"
            className={item.id === resolution
              ? "toolbar__chip toolbar__chip--on"
              : "toolbar__chip"}
            aria-pressed={item.id === resolution}
            title={timeframeLabel(item.id)}
            onClick={() => onResolution(item.id)}
          >
            {item.short}
          </button>
        ))}
      </div>

      <div className="toolbar__cell">
        <button
          type="button"
          className={screenerOpen ? "toolbar__menu toolbar__menu--on"
            : "toolbar__menu"}
          aria-expanded={screenerOpen}
          aria-label={screenerOpen ? "hide the screener" : "show the screener"}
          title="Screen every symbol in this session"
          onClick={onToggleScreener}
        >
          Screener
        </button>
      </div>

      <div className="toolbar__cell">
        <button
          type="button"
          className={fillFlat ? "toolbar__menu toolbar__menu--on"
            : "toolbar__menu"}
          aria-pressed={fillFlat}
          title={fillFlat
            ? "Missing session buckets are flat, synthetic zero-volume bars; click to show real bars only"
            : "Fill missing session buckets with explicitly marked flat zero-volume bars"}
          onClick={onToggleFillFlat}
        >
          Flat fill
        </button>
      </div>

      {tailOn ? (
        <div className="toolbar__cell">
          <label className="toolbar__session">
            <span className="visually-hidden">daily tail</span>
            <select
              aria-label="daily tail"
              value={tailDays}
              title="Daily candles attached behind the recorded sessions for days with no tape"
              onChange={(event) => onTailDays(Number(event.target.value))}
            >
              {TAIL_CHOICES.map((days) => (
                <option key={days} value={days}>
                  {days === 0 ? "no daily history"
                    : days >= 2_600 ? "full history" : `tail ${days}d`}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      <div className="toolbar__cell">
        <button
          type="button"
          className={indicatorsOpen ? "toolbar__menu toolbar__menu--on"
            : "toolbar__menu"}
          aria-expanded={indicatorsOpen}
          aria-label={indicatorsOpen ? "hide indicators" : "show indicators"}
          title="Show or hide the indicators panel"
          onClick={onToggleIndicators}
        >
          Indicators
          <span className="toolbar__symbol-caret" aria-hidden="true">▾</span>
        </button>
      </div>

      <div className="toolbar__sep" aria-hidden="true" />

      <div className="toolbar__cell toolbar__cell--end">
        <label className="toolbar__session">
          <span className="visually-hidden">session</span>
          <select
            aria-label="session"
            value={day}
            onChange={(event) => onDay(event.target.value)}
          >
            <option value="">this session (live)</option>
            {sessions.map((row) => (
              <option key={row.day} value={row.day}>
                {formatDay(`${row.day}T00:00:00+05:00`)}
                {row.current ? " (today)" : ""}
                {row.archived ? " · stored" : ""}
              </option>
            ))}
          </select>
        </label>

        <button type="button" className="toolbar__icon" onClick={onRefresh}
                disabled={busy}
                aria-label="reload the chart from the service"
                title={busy ? "loading…" : "Reload"}>
          ↻
        </button>
        <button type="button" className="toolbar__icon"
                aria-label="open the chart settings"
                title="Chart settings"
                onClick={onOpenSettings}>
          ⚙
        </button>
      </div>
    </header>
  );
}
