/**
 * The status and provenance bar: what this chart is, and how much to trust it.
 *
 * Three rules shape it. It never claims live data from a healthy HTTP
 * response: a 200 says the service answered, and the age of the newest bar is
 * what says whether the market is moving. It shows the session's own facts
 * (which day, whether it is stored, which file answered) because a chart of
 * Friday read on a Sunday must say so. And it reports staleness as a measured
 * number of minutes, with a visible warning once a session in play is older
 * than the reader could reasonably assume.
 *
 * The staleness clock is the service's own `as_of`, not the browser's, so a
 * laptop in another timezone cannot change the reading (SO-8).
 */

import { useEffect, useState } from "react";
import { useVisibility } from "../hooks/useVisibility";

import type { HealthReport, MarketContext, Resolution } from "../api/types";
import type { FeedStatus } from "../hooks/useChartFeed";
import type { DayCount } from "../chart/dayCounts";
import { formatClock, formatMinutes, formatStamp } from "../chart/format";
import { timeframeLabel } from "../chart/timeframes";

export interface StatusBarProps {
  readonly status: FeedStatus;
  readonly resolution: Resolution;
  /** The session facts the server resolved, never computed in the browser. */
  readonly market: MarketContext | null;
  readonly symbol: string;
  readonly day: string;
  readonly sessionNote: string;
  readonly archived: boolean;
  readonly captureName: string;
  readonly sha256: string;
  readonly bars: number;
  /** How many of those bars are fill=flat placeholders, not trades. */
  readonly syntheticBars: number;
  /** Candles per Karachi date, oldest first: the chart's own blocks. */
  readonly dayCounts: readonly DayCount[];
  /** Distinct older dates the list leaves out. */
  readonly earlierDays: number;
  readonly fillMode: boolean;
  readonly gaps: number;
  readonly missingMinutes: number;
  readonly sourceLabel: string;
  readonly delaySeconds: number;
  /** The stamp of the newest bar in the series, which is what ages. */
  readonly lastBarAt: string;
  /** When the service answered. A healthy answer is not a fresh price. */
  readonly asOf: string;
  readonly volumeAvailable: boolean;
  readonly staleAfterMinutes: number;
  /** The venue's own cumulative order counter for this session, when it has one. */
  readonly ordersTotal: number | null;
  readonly error: { category: string; detail: string } | null;
  /** The expanded reading: the second detail line the toggle reveals. */
  readonly details: boolean;
  readonly tape?: HealthReport["tape"];
  readonly recorder?: HealthReport["recorder"];
}

const STATUS_TEXT: Record<FeedStatus, string> = {
  loading: "loading",
  connecting: "connecting",
  live: "live",
  reconnecting: "reconnecting",
  closed: "closed",
  snapshot: "finished session",
};

export function StatusBar(props: StatusBarProps) {
  const {
    status, resolution, market, symbol, day, sessionNote, archived,
    captureName, sha256, bars, syntheticBars, dayCounts, earlierDays, fillMode,
    gaps, missingMinutes,
    sourceLabel, delaySeconds, lastBarAt, asOf, volumeAvailable,
    staleAfterMinutes,
    ordersTotal, error, details, tape, recorder,
  } = props;

  // Only tick the visible status display while this chart has focus. Once
  // per second while watched; no idle timer jobs behind other windows.
  const visible = useVisibility();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  // The age that matters is the age of the newest bar, not the age of the
  // answer: a service can reply in a millisecond about a price two hours old,
  // and calling that fresh is the mistake this whole bar exists to avoid.
  const ageMinutes = ageInMinutes(lastBarAt, now);
  const stale = ageMinutes !== null && ageMinutes >= staleAfterMinutes;
  // The chip describes the chart, not the socket: an open stream against a
  // closed market is not live data, and saying LIVE beside MARKET CLOSED is
  // the contradiction a reader notices first.
  const chip = stateChip(status, market);

  return (
    <section className="status" aria-label="data status">
      <div className="status__row">
        <span className={`status__state status__state--${chip.tone}`}>
          {chip.text}
        </span>
        <span className="status__item">
          <span className="status__key">market</span>{" "}
          {market === null
            ? "unknown"
            : `${market.phase}${market.trading_day ? " · trading day" : " · not a trading day"}`}
        </span>
        {recorder !== undefined && recorder !== null ? (
          <span className={recorder.capturing && !recorder.feed_connected
              ? "status__item status__item--stale"
              : "status__item"}
                title={recorderTitle(recorder)}>
            <span className="status__key">recorder</span>{" "}
            {recorderStateText(recorder)}
          </span>
        ) : null}
        {market?.band != null ? (
          <span className="status__item">
            <span className="status__key">band</span> {market.band.open} to{" "}
            {market.band.close}
          </span>
        ) : null}
        {market?.next_event != null ? (
          <span className="status__item">
            <span className="status__key">next</span>{" "}
            {market.next_event.event.toLowerCase()} at{" "}
            {formatStamp(market.next_event.at)}
          </span>
        ) : null}
        <span className="status__item">
          <span className="status__key">symbol</span> {symbol || "none"}
        </span>
        <span className="status__item">
          <span className="status__key">timeframe</span>{" "}
          {timeframeLabel(resolution)}
        </span>
        <span className="status__item">
          <span className="status__key">session</span> {day || "unknown"}
          {archived ? " (stored)" : ""}
        </span>
        <span className="status__item">
          <span className="status__key">bars</span> {bars}
        </span>
        {dayCounts.length > 1 ? (
          <span className="status__item"
                title={"candles per Karachi date on this chart, oldest first" +
                  "; * marks a date whose block includes fill=flat buckets"}>
            <span className="status__key">days</span>{" "}
            {dayCounts.map((item) =>
              `${item.label} ${item.count}${item.synthetic > 0 ? "*" : ""}`,
            ).join(" · ")}
            {earlierDays > 0 ? ` · +${earlierDays} earlier` : ""}
          </span>
        ) : null}
        {fillMode ? (
          <span className={syntheticBars > 0
            ? "status__item status__item--synthetic"
            : "status__item"}
                title="fill=flat adds zero-volume, zero-range buckets marked synthetic; they are not trades">
            <span className="status__key">flat fill</span>{" "}
            {syntheticBars > 0 ? `${syntheticBars} synthetic` : "no missing buckets"}
          </span>
        ) : null}
        {ordersTotal !== null ? (
          <span className="status__item" title="the venue's own cumulative order counter for this session">
            <span className="status__key">orders</span> {ordersTotal.toLocaleString("en-GB")}
          </span>
        ) : null}
        <span className="status__item">
          <span className="status__key">gaps</span> {gaps}
          {missingMinutes > 0 ? ` (${formatMinutes(missingMinutes)} missing)` : ""}
        </span>
        <span className={stale ? "status__item status__item--stale" : "status__item"}>
          <span className="status__key">newest bar</span>{" "}
          {lastBarAt.length > 0 ? formatClock(lastBarAt) : "none"}
          {ageMinutes !== null
            ? ` · ${formatMinutes(Math.max(0, Math.round(ageMinutes)))} ago`
            : ""}
        </span>
        <span className="status__item status__item--clock">
          {clockState(now)}{" "}UTC+5
        </span>
      </div>

      {stale ? (
        <p className="status__warning" role="status">
          The newest bar on this chart is {formatMinutes(Math.round(ageMinutes ?? 0))}{" "}
          old, so the last price shown is not a current one.
          {status === "live"
            ? " The stream is open, so the recorder may simply have nothing newer."
            : status === "snapshot"
              ? " This is a stored session and it will never update."
              : " Nothing is updating this chart right now."}
        </p>
      ) : null}

      {details ? (
        <div className="status__row status__row--provenance">
          <span className="status__item" title={sessionNote}>
            {sessionNote}
          </span>
          <span className="status__item" title={sourceLabel}>
            <span className="status__key">source</span> {sourceLabel || "unknown"}
            {delaySeconds > 0
              ? ` · ${Math.round(delaySeconds / 60)} min delayed`
              : " · no delay reported"}
          </span>
          <span className="status__item">
            <span className="status__key">volume</span>{" "}
            {volumeAvailable ? "reported" : "not reported"}
          </span>
          {captureName.length > 0 ? (
            <span className="status__item">
              <span className="status__key">file</span> {captureName}
              {sha256.length > 0 ? ` · sha256 ${sha256.slice(0, 12)}…` : ""}
            </span>
          ) : null}
          {tape?.capture !== undefined && tape.capture !== null ? (
          <span className={tape.capture.available ? "status__item" : "status__item status__item--stale"}
                title={tape.capture.path ?? tape.detail ?? "No live capture"}>
            <span className="status__key">capture</span>{" "}
            {tape.capture.available
              ? `${formatSeconds(tape.capture.capture_age_seconds)} old · ${formatBytes(tape.capture.capture_bytes)}`
              : "missing"}
          </span>
        ) : null}
        {asOf.length > 0 ? (
            <span className="status__item">
              <span className="status__key">service answered</span>{" "}
              {formatStamp(asOf)}
            </span>
          ) : null}
        </div>
      ) : null}

      {error !== null ? (
        <p className="status__error" role="status">
          {error.category}: {error.detail}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The state chip: a live stream is not a live market.
 *
 * The stream stays open after the exchange closes, so the chip used to read
 * "live" while the next item on the same row read "market closed · not a
 * trading day". The chip now follows the session law: a connected stream
 * under a closed market reports the market, and only an open phase reports
 * live. The socket's own states keep their names.
 */
export function stateChip(
  status: FeedStatus,
  market: MarketContext | null,
): { text: string; tone: string } {
  if (status !== "live" || market === null) {
    return { text: STATUS_TEXT[status], tone: status };
  }
  const phase = market.phase.trim().toLowerCase().replace(/_/g, "-");
  if (!market.trading_day || phase === "closed") {
    return { text: "market closed", tone: "closed" };
  }
  if (phase === "open" || phase === "trading") {
    return { text: "live", tone: "live" };
  }
  return { text: phase.length > 0 ? phase : "live", tone: status };
}

/**
 * What the recorder is doing, in the reader's terms.
 *
 * Outside the owner's recording window the process is alive and idle, which is
 * the correct state at 02:00 on a Sunday; calling that "stale" beside a live
 * service read as a fault. Inside the window it is capturing, and a silence
 * there is worth flagging.
 */
export function recorderStateText(
  recorder: NonNullable<HealthReport["recorder"]>,
): string {
  if (!recorder.capturing) {
    const window = recorder.window ?? null;
    return window === null
      ? "idle · no window scheduled"
      : `idle · opens ${formatStamp(window.opens)}`;
  }
  return recorder.feed_connected
    ? `capturing · last frame ${formatSeconds(recorder.last_frame_age_seconds)} ago`
    : "capturing · no frame yet";
}

/** The recorder chip's tooltip: the window it is inside, or its last error. */
function recorderTitle(
  recorder: NonNullable<HealthReport["recorder"]>,
): string {
  if (recorder.last_error) {
    return recorder.last_error;
  }
  const window = recorder.window ?? null;
  if (window === null) {
    return "the recorder has no recording window within the next week";
  }
  return `recording window ${formatStamp(window.opens)} to ${formatClock(window.closes)}`;
}

/** Minutes between a stamp and now, or null when the stamp is unusable. */
function formatSeconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "unknown";
  if (value < 60) return `${Math.round(value)}s`;
  return `${Math.floor(value / 60)}m ${Math.floor(value % 60)}s`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "unknown size";
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)} MB`
    : `${Math.round(value / 1_000)} KB`;
}

function ageInMinutes(stamp: string, now: number): number | null {
  const then = new Date(stamp).getTime();
  if (!Number.isFinite(then)) {
    return null;
  }
  return (now - then) / 60_000;
}

/** The reader's clock, on Karachi time, as a chart terminal shows it. */
function clockState(now: number): string {
  return new Date(now).toLocaleTimeString("en-GB", {
    timeZone: "Asia/Karachi",
    hour12: false,
  });
}
