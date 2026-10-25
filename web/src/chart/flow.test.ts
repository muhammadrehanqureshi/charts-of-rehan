import { describe, expect, it } from "vitest";

import { flowColumns } from "./flow";

function pkt(day: string, clock: string): number {
  return Date.parse(`${day}T${clock}+05:00`);
}

describe("flowColumns", () => {
  const start = pkt("2026-10-23", "09:32");

  it("sums the minutes inside a five-minute bar", () => {
    const times = new Float64Array([
      start,
      start + 5 * 60_000,
    ]);
    const { buy, sell } = flowColumns([
      { t: new Date(start).toISOString(), buy: 100, sell: 40 },
      { t: new Date(start + 60_000).toISOString(), buy: 20, sell: 10 },
      { t: new Date(start + 2 * 60_000).toISOString(), buy: 5, sell: 30 },
      { t: new Date(start + 5 * 60_000).toISOString(), buy: 7, sell: 3 },
    ], times, 5 * 60_000);
    expect(buy[0]).toBe(125);
    expect(sell[0]).toBe(80);
    expect(buy[1]).toBe(7);
    expect(sell[1]).toBe(3);
  });

  it("leaves a bar with no tape window as NaN, not zero", () => {
    const times = new Float64Array([start, start + 60_000]);
    const { buy } = flowColumns([
      { t: new Date(start).toISOString(), buy: 10, sell: 1 },
    ], times, 60_000);
    expect(buy[0]).toBe(10);
    expect(Number.isNaN(buy[1] ?? Number.NaN)).toBe(true);
  });

  it("refuses sub-minute charts instead of inventing detail", () => {
    const times = new Float64Array([start, start + 10_000]);
    const { buy } = flowColumns([
      { t: new Date(start).toISOString(), buy: 10, sell: 1 },
    ], times, 10_000);
    expect(Number.isNaN(buy[0] ?? Number.NaN)).toBe(true);
  });

  it("does not credit a minute that falls in a hole past its bar", () => {
    const times = new Float64Array([start]);
    // The chart's step is a minute but this minute printed 40 minutes after
    // the only bar: it belongs to no candle, so nothing is attributed.
    const { buy } = flowColumns([
      { t: new Date(start + 40 * 60_000).toISOString(), buy: 999, sell: 1 },
    ], times, 60_000);
    expect(Number.isNaN(buy[0] ?? Number.NaN)).toBe(true);
  });
});
