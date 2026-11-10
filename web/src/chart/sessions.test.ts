import { describe, expect, it } from "vitest";

import {
  dayBreaks,
  hasDailyBackfill,
  hasSessionBreaks,
  intradayStamps,
  isDailyGrainStamp,
  isIntradayStamp,
  sessionBreaks,
} from "./sessions";

/** A Karachi clock instant as epoch milliseconds. */
function pkt(day: string, clock: string): number {
  return Date.parse(`${day}T${clock}+05:00`);
}

describe("sessionBreaks", () => {
  it("finds one break per trading day and labels it on the Karachi clock", () => {
    const times = [
      pkt("2026-10-21", "09:32"),
      pkt("2026-10-21", "11:59"),
      pkt("2026-10-23", "09:32"),
      pkt("2026-10-23", "11:59"),
    ];
    const breaks = sessionBreaks(times, "1h");
    expect(breaks.map((item) => item.day)).toEqual([
      "2026-10-21", "2026-10-23",
    ]);
    expect(breaks[0]?.label).toBe("21 Oct");
    expect(breaks[1]?.label).toBe("23 Oct");
    expect(breaks[0]?.first).toBe(true);
    expect(breaks[1]?.first).toBe(false);
  });

  it("marks Friday's midday break as a second session on the same day", () => {
    const times = [
      pkt("2026-10-30", "09:17"),
      pkt("2026-10-30", "10:17"),
      pkt("2026-10-30", "11:17"),
      pkt("2026-10-30", "14:32"),
      pkt("2026-10-30", "15:32"),
    ];
    const breaks = sessionBreaks(times, "1h");
    expect(breaks.map((item) => item.t)).toEqual([times[0], times[3]]);
    expect(breaks.map((item) => item.day)).toEqual([
      "2026-10-30", "2026-10-30",
    ]);
    expect(breaks[0]?.first).toBe(true);
    expect(breaks[1]?.first).toBe(false);
    expect(breaks[1]?.previous).toBe(times[2]);
  });

  it("does not invent a midday break on Monday through Thursday", () => {
    const times = [
      pkt("2026-10-28", "09:32"),
      pkt("2026-10-28", "13:32"),
      pkt("2026-10-28", "15:29"),
      pkt("2026-10-29", "09:32"),
    ];
    expect(sessionBreaks(times, "1h").map((item) => item.day))
      .toEqual(["2026-10-28", "2026-10-29"]);
  });

  it("reads the day in Karachi, not in UTC: morning bars belong to the same day", () => {
    // 04:00 PKT is 23:00 UTC of the previous day. A UTC-based key would put
    // this bar on 22 Oct and invent a break that never happened.
    const times = [
      pkt("2026-10-23", "00:30"),
      pkt("2026-10-23", "04:00"),
      pkt("2026-10-23", "09:32"),
    ];
    expect(sessionBreaks(times, "1h")).toHaveLength(1);
  });

  it("keeps a real noon candle: no rung carries daily rows any more", () => {
    const times = [
      pkt("2026-10-21", "09:32"),
      pkt("2026-10-21", "12:00"),
      pkt("2026-10-21", "15:29"),
    ];
    // Noon is still recognisable as the daily-row stamp, but an intraday rung
    // no longer carries those rows, so a noon candle here is the rung's own.
    expect(isDailyGrainStamp(times[1] ?? 0)).toBe(true);
    for (const rung of ["1m", "5m", "1h"] as const) {
      expect(isIntradayStamp(times[1] ?? 0, rung)).toBe(true);
      expect(intradayStamps(times, rung)).toEqual(times);
      expect(sessionBreaks(times, rung)).toHaveLength(1);
    }
  });

  it("carries no daily rows, so nothing is discarded from the tape", () => {
    const times = [
      pkt("2016-11-01", "12:00"),
      pkt("2016-11-02", "12:00"),
      pkt("2026-10-12", "09:32"),
      pkt("2026-10-12", "10:32"),
      pkt("2026-10-13", "09:32"),
    ];
    // The decade lives on the daily rung. An intraday rung is its own tape,
    // so every stamp it receives is a candle of that rung.
    for (const rung of ["1s", "10s", "1m", "5m", "10m", "15m", "30m",
      "1h", "4h"] as const) {
      expect(isIntradayStamp(times[0] ?? 0, rung)).toBe(true);
      expect(intradayStamps(times, rung)).toEqual(times);
      expect(sessionBreaks(times, rung).map((item) => item.day)).toEqual([
        "2016-11-01", "2016-11-02", "2026-10-12", "2026-10-13",
      ]);
    }
  });

  it("treats every date's candles as one session block", () => {
    const times = [
      pkt("2024-04-29", "12:00"),
      pkt("2024-04-30", "12:00"),
      pkt("2024-05-01", "12:00"),
      pkt("2024-05-02", "12:00"),
      pkt("2024-06-03", "12:00"),
    ];
    // Whatever a date holds, its candles are one block: the rule sits where
    // the date changes, and the first block is never ruled off.
    expect(dayBreaks(times, "1h").map((item) => item.day)).toEqual([
      "2024-04-30", "2024-05-01", "2024-05-02", "2024-06-03",
    ]);
  });

  it("divides one session from the next and never rules the first off", () => {
    const times = [
      pkt("2026-10-15", "09:32"),
      pkt("2026-10-15", "10:32"),
      pkt("2026-10-15", "15:29"),
      pkt("2026-10-16", "09:17"),
      pkt("2026-10-16", "10:17"),
    ];
    const breaks = dayBreaks(times, "1h");
    expect(breaks.map((item) => item.day)).toEqual(["2026-10-16"]);
    expect(breaks[0]?.label).toBe("16 Oct");
    expect(breaks[0]?.previous).toBe(times[2]);
    expect(breaks[0]?.first).toBe(false);
  });

  it("divides each rung's own candles at the same dates", () => {
    // A minute session is hundreds of candles, a 4h session is two. Both
    // divide where the day changes, because each pass reads its own series.
    const minute: number[] = [];
    for (const day of ["2026-10-28", "2026-10-29"]) {
      for (let step = 0; step < 380; step += 1) {
        minute.push(pkt(day, "09:32") + step * 60_000);
      }
    }
    const fourHour = [
      pkt("2026-10-28", "09:32"), pkt("2026-10-28", "13:32"),
      pkt("2026-10-29", "09:32"), pkt("2026-10-29", "13:32"),
    ];
    expect(dayBreaks(fourHour, "4h").map((item) => item.day))
      .toEqual(["2026-10-29"]);
    expect(dayBreaks(minute, "1m").map((item) => item.day))
      .toEqual(["2026-10-29"]);
  });

  it("covers every intraday rung and no calendar rung", () => {
    for (const rung of ["1s", "10s", "1m", "5m", "10m", "15m", "30m",
      "1h", "4h"] as const) {
      expect(hasSessionBreaks(rung)).toBe(true);
    }
    for (const rung of ["1D", "1W", "1M", "1d", "session"] as const) {
      expect(hasSessionBreaks(rung)).toBe(false);
    }
    // No rung carries the daily decade behind its own candles: a 30m block
    // must hold twelve half-hours, not a year of one-candle days.
    for (const rung of ["1s", "10s", "1m", "5m", "10m", "15m", "30m",
      "1h", "4h"] as const) {
      expect(hasDailyBackfill(rung)).toBe(false);
    }
    for (const rung of ["1D", "1d", "1W", "1M", "session"] as const) {
      expect(hasDailyBackfill(rung)).toBe(false);
    }
  });

  it("ignores holes and unusable stamps instead of inventing sessions", () => {
    const times = [
      pkt("2026-10-23", "09:32"),
      Number.NaN,
      pkt("2026-10-23", "11:59"),
    ];
    const breaks = sessionBreaks(times, "1h");
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.t).toBe(times[0]);
  });
});
