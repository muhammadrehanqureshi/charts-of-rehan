/**
 * Where the app opens.
 *
 * A first visit has no last symbol, so the tape decides: the session's most
 * traded scrip. An index answers only when nothing traded, because a breadth
 * gauge is not a chart anyone opens the terminal to read.
 */

import { describe, expect, it } from "vitest";

import { backfillFor, limitFor, openingSymbol } from "./App";
import type { SymbolRow } from "./api/types";

function row(symbol: string, patch: Partial<SymbolRow> = {}): SymbolRow {
  return {
    symbol,
    source: "broker_tape",
    listed: true,
    index: false,
    bars: 40,
    first: "2026-10-23T09:32:00+05:00",
    last: "2026-10-23T11:59:00+05:00",
    close: 100,
    open: 98,
    high: 101,
    low: 97,
    volume: 1_000,
    day: "2026-10-23",
    ...patch,
  };
}

describe("the opening chart", () => {
  it("is the session's most traded scrip, not the first row", () => {
    const chosen = openingSymbol([
      row("KSE100", { index: true, volume: 9_000_000 }),
      row("QUIET", { volume: 200 }),
      row("BUSY", { volume: 8_000_000 }),
    ]);
    expect(chosen?.symbol).toBe("BUSY");
  });

  it("skips an index even when the index traded more", () => {
    const chosen = openingSymbol([
      row("KMIALLSHR", { index: true, volume: 5_000_000 }),
      row("PRL", { volume: 300_000 }),
    ]);
    expect(chosen?.symbol).toBe("PRL");
  });

  it("answers with an index when nothing traded", () => {
    const chosen = openingSymbol([
      row("KSE100", { index: true, bars: 0, volume: null }),
      row("IDLE", { bars: 0 }),
    ]);
    expect(chosen?.symbol).toBe("KSE100");
  });

  it("says nothing when the catalogue is empty", () => {
    expect(openingSymbol([])).toBeUndefined();
  });
});
describe("how much history a rung asks for", () => {
  it("every minute rung carries the decade the store holds", () => {
    for (const resolution of [
      "1m", "5m", "10m", "15m", "30m", "1h", "4h",
    ] as const) {
      expect(backfillFor(resolution)).toBe(2_600);
    }
  });

  it("the sub-second rungs stay at a year: their own ticks are heavy already", () => {
    expect(backfillFor("1s")).toBe(260);
    expect(backfillFor("10s")).toBe(260);
  });

  it("a calendar rung is its own history and asks for no backfill", () => {
    for (const resolution of ["1D", "1W", "1M"] as const) {
      expect(backfillFor(resolution)).toBe(0);
    }
  });

  it("the limit never eats the backfill it just asked for", () => {
    for (const resolution of ["10m", "15m", "30m", "1h", "4h"] as const) {
      expect(limitFor(resolution)).toBeGreaterThan(2_600);
    }
    expect(limitFor("1h")).toBe(3_400);
  });
});
