/**
 * The property the renderer actually promises: one rule set, every rung.
 *
 * These tests exist because the previous shape of `sessions.ts` decided
 * break behaviour in two separate sets, so a rung could gain an intraday
 * rule (or lose one) without any type noticing. The assertions below are
 * about agreement across the ladder, not about a single rung's arithmetic.
 */

import { describe, expect, it } from "vitest";

import { RESOLUTIONS } from "../api/types";
import {
  RUNG_POLICY,
  dayBreaks,
  hasDailyBackfill,
  hasSessionBreaks,
  isDailyGrainStamp,
  scheduleFrom,
  sessionBreaks,
} from "./sessions";

/** A Karachi wall-clock stamp as epoch milliseconds. */
function at(day: string, hour: number, minute: number): number {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return Date.parse(`${day}T${hh}:${mm}:00+05:00`);
}

const INTRADAY = [
  "1s", "10s", "1m", "5m", "10m", "15m", "30m", "1h", "4h",
] as const;

describe("RUNG_POLICY", () => {
  it("declares an answer for every rung the ladder serves", () => {
    for (const rung of RESOLUTIONS) {
      expect(RUNG_POLICY[rung]).toBeDefined();
    }
  });

  it("gives calendar rungs no intraday rule and no daily backfill", () => {
    for (const rung of ["1D", "1W", "1M"] as const) {
      expect(hasSessionBreaks(rung)).toBe(false);
      expect(hasDailyBackfill(rung)).toBe(false);
      expect(sessionBreaks(
        [at("2026-10-12", 9, 32), at("2026-10-13", 9, 32)],
        rung,
      )).toEqual([]);
    }
  });

  it("gives no rung a daily backfill: each rung is its own grain", () => {
    for (const rung of INTRADAY) {
      expect(hasDailyBackfill(rung)).toBe(false);
    }
    for (const rung of ["1D", "1W", "1M"] as const) {
      expect(hasDailyBackfill(rung)).toBe(false);
    }
  });
});

describe("sessionBreaks across the ladder", () => {
  it("places identical rules for identical stamps on every intraday rung", () => {
    const times = [
      at("2026-10-15", 9, 32),
      at("2026-10-15", 11, 0),
      at("2026-10-16", 9, 17),
      at("2026-10-16", 14, 32),
    ];
    const expected = [times[0], times[2], times[3]];
    for (const rung of INTRADAY) {
      expect(sessionBreaks(times, rung).map((item) => item.t))
        .toEqual(expected);
    }
  });

  it("draws the Friday midday break as its own band", () => {
    const times = [
      at("2026-10-16", 9, 17),
      at("2026-10-16", 11, 59),
      at("2026-10-16", 14, 32),
    ];
    const breaks = sessionBreaks(times, "1h");
    expect(breaks).toHaveLength(2);
    expect(breaks[1]?.t).toBe(times[2]);
    expect(breaks[1]?.day).toBe("2026-10-16");
  });

  it("keeps every date whole: Friday is one five-candle day, not 3+2", () => {
    const times = [
      at("2026-10-30", 9, 17),
      at("2026-10-30", 10, 17),
      at("2026-10-30", 11, 17),
      at("2026-10-30", 14, 32),
      at("2026-10-30", 15, 32),
      at("2026-11-02", 9, 32),
      at("2026-11-02", 10, 32),
    ];
    const breaks = dayBreaks(times, "1h");
    expect(breaks.map((item) => item.day)).toEqual(["2026-11-02"]);
    expect(breaks[0]?.previous).toBe(times[4]);
  });

  it("divides every date, so each block is one session", () => {
    const times = [
      at("2026-11-04", 12, 0),
      at("2026-11-05", 12, 0),
      at("2026-11-06", 12, 0),
      at("2026-11-10", 9, 32),
      at("2026-11-10", 10, 32),
      at("2026-11-11", 9, 32),
      at("2026-11-11", 10, 32),
    ];
    const breaks = dayBreaks(times, "1h");
    expect(breaks.map((item) => item.day)).toEqual([
      "2026-11-05", "2026-11-06", "2026-11-10", "2026-11-11",
    ]);
    expect(breaks[2]?.previous).toBe(times[2]);
  });

  it("rules each date even when a date holds a single candle", () => {
    const times = [
      at("2026-10-30", 15, 32),
      at("2026-11-04", 12, 0),
      at("2026-11-06", 12, 0),
    ];
    expect(dayBreaks(times, "1h").map((item) => item.day))
      .toEqual(["2026-11-04", "2026-11-06"]);
  });

  it("anchors the first rule without drawing one before the series", () => {
    const breaks = sessionBreaks([at("2026-10-12", 9, 32)], "1m");
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.first).toBe(true);
    expect(breaks[0]?.previous).toBeUndefined();
  });

  it("reports the previous bar on every later rule", () => {
    const times = [at("2026-10-15", 15, 29), at("2026-10-16", 9, 17)];
    const breaks = sessionBreaks(times, "1m");
    expect(breaks[1]?.previous).toBe(times[0]);
  });

  it("opens one session on a lone candle, whatever its stamp", () => {
    const noon = at("2026-10-15", 12, 0);
    expect(isDailyGrainStamp(noon)).toBe(true);
    // No intraday rung carries daily rows, so a candle at noon is that
    // rung's own candle and the block it belongs to starts there.
    for (const rung of INTRADAY) {
      const breaks = sessionBreaks([noon], rung);
      expect(breaks).toHaveLength(1);
      expect(breaks[0]?.first).toBe(true);
    }
  });
});

describe("a schedule sent by the service", () => {
  it("replaces the mirrored weekday table for the days it names", () => {
    const schedule = scheduleFrom([{
      day: "2026-10-16",
      bands: [
        { open: "09:00", close: "12:00" },
        { open: "13:00", close: "16:00" },
      ],
    }]);
    const preOpen = at("2026-10-16", 8, 30);
    const lunch = at("2026-10-16", 12, 30);
    const afternoon = at("2026-10-16", 13, 0);
    const breaks = sessionBreaks([preOpen, lunch, afternoon], "1m", schedule);
    // The pre-open print belongs to the first band; the lunch belongs to it
    // too; only the move into the 13:00 band is a new session.
    expect(breaks.map((item) => item.t)).toEqual([preOpen, afternoon]);
  });

  it("falls back to the weekday mirror for a day the schedule omits", () => {
    const schedule = scheduleFrom([{
      day: "2026-10-16",
      bands: [{ open: "09:00", close: "12:00" }],
    }]);
    const monday = [
      at("2026-10-19", 9, 32),
      at("2026-10-19", 10, 0),
    ];
    expect(sessionBreaks(monday, "1m", schedule)).toHaveLength(1);
  });

  it("ignores malformed rows instead of inventing bands", () => {
    const schedule = scheduleFrom([
      { day: "not-a-day", bands: [{ open: "09:00", close: "15:00" }] },
      { day: "2026-10-16", bands: [{ open: "noon", close: "late" }] },
      { day: "2026-10-16", bands: [{ open: "13:00", close: "09:00" }] },
    ]);
    expect(schedule.byDay.size).toBe(0);
    // The mirror still answers, so a broken schedule never deletes rules.
    expect(sessionBreaks([at("2026-10-16", 14, 32)], "1m", schedule))
      .toHaveLength(1);
  });
});
