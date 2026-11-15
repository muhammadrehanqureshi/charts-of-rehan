import { describe, expect, it } from "vitest";

import {
  AggregationConfigError,
  aggregateCandles,
  CandleParseError,
  type Candle,
  clockToMinutes,
  parseCandle,
  parseCandles,
  type SessionBand,
  type TradingSession,
  validateSessionIntegrity,
} from "./sessionAggregation";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function at(day: string, clock: string): number {
  return Date.parse(`${day}T${clock}:00+05:00`);
}

function session(
  day: string,
  bands: readonly (readonly [string, string])[],
): TradingSession {
  return {
    day,
    bands: bands.map(([open, close]): SessionBand => ({
      open: clockToMinutes(open),
      close: clockToMinutes(close),
    })),
  };
}

/** A deterministic source series: open 100+i, high +2, low -2, close +1. */
function sources(
  day: string,
  bands: readonly (readonly [string, string])[],
  intervalMinutes: number,
  startIndex = 0,
): Candle[] {
  const out: Candle[] = [];
  let index = startIndex;
  for (const [openClock, closeClock] of bands) {
    const open = at(day, openClock);
    const close = at(day, closeClock);
    for (let t = open; t < close; t += intervalMinutes * MINUTE) {
      const price = 100 + index;
      out.push({
        t,
        open: price,
        high: price + 2,
        low: price - 2,
        close: price + 1,
        volume: 10,
      });
      index += 1;
    }
  }
  return out;
}

const WEEKDAY = session("2026-10-26", [["09:32", "15:30"]]);
const FRIDAY = session("2026-10-30", [
  ["09:17", "12:00"],
  ["14:32", "16:30"],
]);

describe("clock parsing", () => {
  it("turns exchange clocks into minutes and refuses a bad clock", () => {
    expect(clockToMinutes("09:32")).toBe(572);
    expect(clockToMinutes("14:32")).toBe(872);
    expect(() => clockToMinutes("9.32")).toThrow(RangeError);
    expect(() => clockToMinutes("24:10")).toThrow(RangeError);
  });
});

describe("session-aware aggregation", () => {
  it("folds six 10-minute candles into one 1-hour candle", () => {
    const source = sources("2026-10-26", [["09:32", "15:30"]], 10);
    expect(source).toHaveLength(36);

    const { candles, issues } = aggregateCandles(source, {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });

    expect(issues).toEqual([]);
    expect(candles).toHaveLength(6);
    expect(candles.map((candle) => new Date(candle.t).toISOString().slice(11, 16)))
      .toEqual(["04:32", "05:32", "06:32", "07:32", "08:32", "09:32"]);
    // 09:32-10:32 PKT, from source candles i=0..5.
    expect(candles[0]).toMatchObject({
      open: 100, high: 107, low: 98, close: 106, volume: 60,
    });
    // 14:32-15:30 PKT, from i=30..35.
    expect(candles[5]).toMatchObject({
      open: 130, high: 137, low: 128, close: 136, volume: 60,
    });
  });

  it("keeps Friday's lunch out of every candle: 3 morning and 2 afternoon", () => {
    const source = sources("2026-10-30", [
      ["09:17", "12:00"], ["14:32", "16:30"],
    ], 10);
    const { candles } = aggregateCandles(source, {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [FRIDAY],
    });

    expect(candles).toHaveLength(5);
    const clocks = candles.map((candle) =>
      new Date(candle.t).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Karachi", hour12: false, hour: "2-digit", minute: "2-digit",
      }));
    expect(clocks).toEqual(["09:17", "10:17", "11:17", "14:32", "15:32"]);
    // No bucket starts inside 12:00-14:32 and none crosses it.
    expect(clocks).not.toContain("12:17");
    expect(clocks).not.toContain("13:32");
  });

  it("folds 358 one-minute candles into 6 hours, the last holding 58", () => {
    const source = sources("2026-10-26", [["09:32", "15:30"]], 1);
    expect(source).toHaveLength(358);
    const { candles, issues } = aggregateCandles(source, {
      sourceMs: MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });
    expect(issues).toEqual([]);
    expect(candles).toHaveLength(6);
    expect(candles[5]?.volume).toBe(580);
  });

  it("keeps a partial hour but reports how many sources it was missing", () => {
    const source = sources("2026-10-26", [["09:32", "15:30"]], 10);
    // Drop 11:02, one of the six sources of the 10:32-11:32 bucket.
    const holed = source.filter((candle) => candle.t !== at("2026-10-26", "11:02"));
    const { candles, issues } = aggregateCandles(holed, {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });
    expect(candles).toHaveLength(6);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("PARTIAL_BUCKET");
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.detail).toContain("5 of 6");
  });

  it("drops a holiday print rather than opening a session on it", () => {
    const source = sources("2026-10-25", [["09:32", "15:30"]], 10);
    const { candles, issues } = aggregateCandles(source, {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });
    expect(candles).toEqual([]);
    expect(issues.every((item) => item.code === "OUT_OF_SESSION")).toBe(true);
    expect(issues).toHaveLength(source.length);
  });

  it("rejects an off-grid source stamp instead of folding it into a bucket", () => {
    const bad: Candle = {
      t: at("2026-10-26", "09:37"), open: 100, high: 101, low: 99, close: 100, volume: 1,
    };
    const { candles, issues } = aggregateCandles([bad], {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });
    expect(candles).toEqual([]);
    expect(issues[0]?.code).toBe("OFF_GRID");
    expect(issues[0]?.severity).toBe("error");
  });

  it("keeps the later duplicate and reports it", () => {
    const t = at("2026-10-26", "09:32");
    const first: Candle = { t, open: 100, high: 101, low: 99, close: 100, volume: 1 };
    const second: Candle = { t, open: 200, high: 202, low: 198, close: 201, volume: 2 };
    const { candles, issues } = aggregateCandles([first, second], {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });
    expect(candles[0]?.open).toBe(200);
    expect(candles[0]?.volume).toBe(2);
    expect(issues[0]?.code).toBe("DUPLICATE_TIMESTAMP");
  });

  it("refuses a target that is not a whole multiple of the source", () => {
    expect(() => aggregateCandles([], {
      sourceMs: 10 * MINUTE,
      targetMs: 7 * MINUTE,
      sessions: [WEEKDAY],
    })).toThrow(AggregationConfigError);
  });
});

describe("session integrity", () => {
  it("passes a complete six-hour weekday and a complete five-hour Friday", () => {
    const weekday = aggregateCandles(
      sources("2026-10-26", [["09:32", "15:30"]], 10),
      { sourceMs: 10 * MINUTE, targetMs: HOUR, sessions: [WEEKDAY] },
    ).candles;
    const friday = aggregateCandles(
      sources("2026-10-30", [["09:17", "12:00"], ["14:32", "16:30"]], 10),
      { sourceMs: 10 * MINUTE, targetMs: HOUR, sessions: [FRIDAY] },
    ).candles;

    const weekdayReport = validateSessionIntegrity(weekday, [WEEKDAY], HOUR);
    expect(weekdayReport.ok).toBe(true);
    expect(weekdayReport.sessions[0]).toMatchObject({
      day: "2026-10-26", expected: 6, actual: 6, complete: true,
    });
    const fridayReport = validateSessionIntegrity(friday, [FRIDAY], HOUR);
    expect(fridayReport.ok).toBe(true);
    expect(fridayReport.sessions[0]).toMatchObject({
      day: "2026-10-30", expected: 5, actual: 5, complete: true,
    });
  });

  it("reports a 3-of-6 session as incomplete with the missing opens", () => {
    // A capture that begins at 12:32 holds three of the day's six hours.
    const source = sources("2026-10-26", [["12:32", "15:30"]], 10);
    const { candles } = aggregateCandles(source, {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions: [WEEKDAY],
    });
    const report = validateSessionIntegrity(candles, [WEEKDAY], HOUR);
    expect(report.ok).toBe(false);
    expect(report.complete).toBe(false);
    expect(report.sessions[0]?.missing).toHaveLength(3);
    expect(report.issues.filter((item) => item.code === "MISSING_BUCKET"))
      .toHaveLength(3);
  });

  it("flags a bucket stamped off the band grid", () => {
    const aligned = aggregateCandles(
      sources("2026-10-26", [["09:32", "15:30"]], 10),
      { sourceMs: 10 * MINUTE, targetMs: HOUR, sessions: [WEEKDAY] },
    ).candles;
    // 09:45 is inside the band but is not a 1-hour bucket open.
    const wrong: Candle = { ...aligned[0]!, t: at("2026-10-26", "09:45") };
    const report = validateSessionIntegrity([wrong, ...aligned.slice(1)],
      [WEEKDAY], HOUR);
    expect(report.ok).toBe(false);
    expect(report.issues.some((item) => item.code === "MISALIGNED_BUCKET")).toBe(true);
  });

  it("does not count a holiday row as a session", () => {
    const holiday = session("2026-10-25", []);
    const report = validateSessionIntegrity([], [holiday], HOUR);
    expect(report.sessions).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("wire parsing", () => {
  it("parses ISO timestamps and numeric OHLCV", () => {
    const candle = parseCandle({
      t: "2026-10-26T09:32:00+05:00",
      o: 100, h: 102, l: 99, c: 101, v: 500,
    });
    expect(candle.t).toBe(at("2026-10-26", "09:32"));
    expect(candle.volume).toBe(500);
  });

  it("rejects a bad row but keeps the rest of the batch", () => {
    const parsed = parseCandles([
      { t: "2026-10-26T09:32:00+05:00", o: 100, h: 102, l: 99, c: 101, v: 1 },
      { t: "not a date", o: 100, h: 102, l: 99, c: 101, v: 1 },
      { t: "2026-10-26T09:42:00+05:00", o: 101, h: 100, l: 99, c: 101, v: 1 },
    ]);
    expect(parsed.candles).toHaveLength(1);
    expect(parsed.rejected).toHaveLength(2);
    expect(parsed.rejected[0]).toBeInstanceOf(CandleParseError);
  });
});

describe("a decade of data", () => {
  it("folds and validates ten years without a missed or crossed session", () => {
    const sessions: TradingSession[] = [];
    const source: Candle[] = [];
    let cursor = Date.UTC(2016, 10, 14);
    const last = Date.UTC(2026, 10, 12);
    while (cursor <= last) {
      const weekday = new Date(cursor).getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        const day = new Date(cursor).toISOString().slice(0, 10);
        const bands: (readonly [string, string])[] = weekday === 5
          ? [["09:17", "12:00"], ["14:32", "16:30"]]
          : [["09:32", "15:30"]];
        sessions.push(session(day, bands));
        source.push(...sources(day, bands, 10, source.length));
      }
      cursor += 86_400_000;
    }

    const { candles, issues } = aggregateCandles(source, {
      sourceMs: 10 * MINUTE,
      targetMs: HOUR,
      sessions,
    });
    expect(issues).toEqual([]);
    expect(candles.length).toBe(sessions.reduce(
      (total, item) => total + (item.bands.length === 2 ? 5 : 6), 0));

    const report = validateSessionIntegrity(candles, sessions, HOUR);
    expect(report.complete).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.sessions.length).toBe(sessions.length);
  });
});
