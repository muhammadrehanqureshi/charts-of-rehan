import { describe, expect, it } from "vitest";

import {
  dayBreaks,
  expectedBucketTime,
  expectedSessionCount,
  expectedSessionGrid,
  expectedSessionTimes,
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

describe("expected timeframe slots", () => {
  it("counts the complete Monday to Thursday session at each chart rung", () => {
    const expected = new Map([
      ["1m", 358], ["5m", 72], ["10m", 36], ["15m", 24],
      ["30m", 12], ["1h", 6], ["4h", 2],
    ] as const);
    for (const [rung, count] of expected) {
      expect(expectedSessionCount("2026-10-12", rung)).toBe(count);
    }
  });

  it("counts Friday's two bands without adding lunch candles", () => {
    const expected = new Map([
      ["1m", 281], ["5m", 57], ["10m", 29], ["15m", 19],
      ["30m", 10], ["1h", 5], ["4h", 2],
    ] as const);
    for (const [rung, count] of expected) {
      expect(expectedSessionCount("2026-10-30", rung)).toBe(count);
    }
    const slots = expectedSessionTimes("2026-10-30", "15m");
    expect(slots).toHaveLength(19);
    expect(slots[11]).toBe(pkt("2026-10-30", "14:32"));
  });

  it("keeps missing slots on the timeframe grid without inventing bars", () => {
    const observed = [pkt("2026-10-12", "10:17"), pkt("2026-10-12", "10:47")];
    const grid = expectedSessionGrid(observed, "15m", undefined,
      pkt("2026-10-12", "11:00"));
    expect(grid).toHaveLength(6);
    expect(grid[0]).toBe(pkt("2026-10-12", "09:32"));
    expect(grid[1]).toBe(pkt("2026-10-12", "09:47"));
    expect(grid[3]).toBe(pkt("2026-10-12", "10:17"));
    expect(expectedBucketTime(pkt("2026-10-12", "10:19"), "15m"))
      .toBe(pkt("2026-10-12", "10:17"));
  });

  it("anchors session dividers to band opens when the first candle is missing", () => {
    const observed = [
      pkt("2026-10-15", "11:47"),
      pkt("2026-10-16", "10:17"),
    ];
    const grid = expectedSessionGrid(observed, "15m");
    const breaks = sessionBreaks(grid, "15m");
    expect(breaks.map((item) => item.t)).toEqual([
      pkt("2026-10-15", "09:32"),
      pkt("2026-10-16", "09:17"),
      pkt("2026-10-16", "14:32"),
    ]);
    expect(breaks[1]?.previous).toBe(pkt("2026-10-15", "15:17"));
    expect(breaks[2]?.previous).toBe(pkt("2026-10-16", "11:47"));
  });

  it("places Friday's afternoon divider after its expected morning slots", () => {
    const observed = [pkt("2026-10-30", "11:47")];
    const grid = expectedSessionGrid(observed, "15m");
    const breaks = sessionBreaks(grid, "15m");
    expect(breaks.map((item) => item.t)).toEqual([
      pkt("2026-10-30", "09:17"),
      pkt("2026-10-30", "14:32"),
    ]);
    expect(breaks[1]?.previous).toBe(pkt("2026-10-30", "11:47"));
  });
});

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

  it("treats noon as daily context, not an intraday rule", () => {
    const times = [
      pkt("2026-10-21", "09:32"),
      pkt("2026-10-21", "12:00"),
      pkt("2026-10-21", "15:29"),
    ];
    // Noon is the daily backfill's stamp. The row is a real stored session,
    // but it is not a captured intraday candle and never opens a block.
    expect(isDailyGrainStamp(times[1] ?? 0)).toBe(true);
    for (const rung of ["1m", "5m", "1h"] as const) {
      expect(isIntradayStamp(times[1] ?? 0, rung)).toBe(false);
      expect(intradayStamps(times, rung)).toEqual([times[0], times[2]]);
      expect(sessionBreaks(times, rung)).toHaveLength(1);
    }
  });

  it("drops daily backfill rows from the intraday rules", () => {
    const times = [
      pkt("2016-11-01", "12:00"),
      pkt("2016-11-02", "12:00"),
      pkt("2026-10-12", "09:32"),
      pkt("2026-10-12", "10:32"),
      pkt("2026-10-13", "09:32"),
    ];
    // The decade behind the tape is daily grain at noon; the captured tape
    // is the only stretch the intraday rules divide.
    for (const rung of ["1s", "10s", "1m", "5m", "10m", "15m", "30m",
      "1h", "4h"] as const) {
      expect(isIntradayStamp(times[0] ?? 0, rung)).toBe(false);
      expect(intradayStamps(times, rung)).toEqual([
        times[2], times[3], times[4],
      ]);
      expect(sessionBreaks(times, rung).map((item) => item.day)).toEqual([
        "2026-10-12", "2026-10-13",
      ]);
    }
  });

  it("gives a daily-grain row its own session rule when the payload flags it", () => {
    const times = [
      pkt("2016-11-01", "12:00"),
      pkt("2016-11-02", "12:00"),
      pkt("2026-10-12", "09:32"),
      pkt("2026-10-12", "10:32"),
    ];
    const flags = [1, 1, 0, 0];
    // One daily candle is one whole session, so the date change is a real
    // break - and the flag, not the noon stamp, says which rows those are.
    expect(isIntradayStamp(times[0] ?? 0, "1m", true)).toBe(false);
    expect(isIntradayStamp(times[2] ?? 0, "1m", false)).toBe(true);
    const breaks = sessionBreaks(times, "1h", undefined, flags);
    expect(breaks.map((item) => item.day)).toEqual([
      "2016-11-01", "2016-11-02", "2026-10-12",
    ]);
    expect(breaks[0]?.daily).toBe(true);
    expect(breaks[2]?.daily).toBe(false);
  });

  it("keeps a real noon minute bar when the payload says it is intraday", () => {
    const times = [
      pkt("2026-10-12", "11:59"),
      pkt("2026-10-12", "12:00"),
      pkt("2026-10-12", "12:01"),
    ];
    // 12:00 is a real minute on Monday to Thursday; the grain flag protects
    // it from the legacy noon heuristic.
    expect(sessionBreaks(times, "1m", undefined, [0, 0, 0])).toHaveLength(1);
    expect(isIntradayStamp(times[1] ?? 0, "1m", false)).toBe(true);
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
    // Every intraday rung carries the bounded daily context behind its
    // captured tape; calendar rungs already are that grain.
    for (const rung of ["1s", "10s", "1m", "5m", "10m", "15m", "30m",
      "1h", "4h"] as const) {
      expect(hasDailyBackfill(rung)).toBe(true);
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
