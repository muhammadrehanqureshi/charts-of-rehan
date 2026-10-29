import { describe, expect, it } from "vitest";

import { ColumnSeries } from "../chart/series";
import { computeIndicators, seriesData } from "./compute";
import { compileFormula, FormulaError, validateFormula } from "./expression";
import { createIndicator } from "./registry";

function seriesFor(closes: readonly number[]): ColumnSeries {
  const series = new ColumnSeries();
  series.upsertMany(closes.map((close, index) => ({
    t: new Date(Date.UTC(2026, 9, 12, 4, 0, index)).toISOString(),
    o: close,
    h: close + 1,
    l: close - 1,
    c: close,
    v: 10 + index,
  })));
  return series;
}

function outputsFor(type: string, closes: readonly number[],
  params: Record<string, number | string> = {}) {
  const spec = createIndicator(type, { params });
  expect(spec).not.toBeNull();
  const data = seriesData(seriesFor(closes));
  return computeIndicators(spec === null ? [] : [spec], data);
}

describe("indicator engine", () => {
  it("computes an SMA with NaN before the window fills", () => {
    const output = outputsFor("sma", [1, 2, 3, 4, 5], { period: 3 })[0];
    expect(output).toBeDefined();
    const values = output?.lines[0]?.values;
    expect(values?.[0]).toBeNaN();
    expect(values?.[1]).toBeNaN();
    expect(values?.[2]).toBeCloseTo(2);
    expect(values?.[4]).toBeCloseTo(4);
  });

  it("computes an EMA that tracks a rising series", () => {
    const output = outputsFor("ema", [1, 2, 3, 4, 5], { period: 3 })[0];
    const values = output?.lines[0]?.values;
    expect(values?.[2]).toBeCloseTo(2);
    expect(values?.[4]).toBeGreaterThan(values?.[2] ?? 0);
  });

  it("keeps RSI inside its fixed 0 to 100 pane", () => {
    const output = outputsFor("rsi", [1, 2, 3, 2, 1, 2, 3, 4], { period: 3 })[0];
    expect(output?.range).toEqual([0, 100]);
    const values = output?.lines[0]?.values ?? [];
    for (const value of values) {
      if (Number.isFinite(value)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("draws the MACD and its histogram in a pane", () => {
    const output = outputsFor("macd", [1, 2, 3, 4, 5, 6, 7, 8, 9],
      { fast: 3, slow: 4, signal: 2 })[0];
    expect(output?.placement).toBe("pane");
    expect(output?.lines).toHaveLength(2);
    expect(output?.histogram).toBeDefined();
  });

  it("accepts a safe custom formula", () => {
    const output = outputsFor("formula", [1, 2, 3, 4, 5], {
      expr: "close - sma(close, 3)",
    })[0];
    expect(output?.error).toBeUndefined();
    const values = output?.lines[0]?.values;
    expect(values?.[4]).toBeCloseTo(1);
  });

  it("refuses an unknown function with a named error", () => {
    expect(() => compileFormula("magic(close)")).toThrow(FormulaError);
  });

  it("never calls eval on a formula with a statement", () => {
    expect(() => compileFormula("close; alert(1)")).toThrow(FormulaError);
  });

  it("validates a formula against data, not just its syntax", () => {
    expect(() => validateFormula("ema(close, 9) - ema(close, 21)"))
      .not.toThrow();
    expect(() => validateFormula("sma(close, close)"))
      .toThrow(/needs a single number/);
    expect(() => validateFormula("nz(close, close)"))
      .toThrow(/nz fallback needs a single number/);
  });

  it("creates unique ids for unlimited instances", () => {
    const first = createIndicator("sma");
    const second = createIndicator("sma");
    expect(first?.id).not.toBe(second?.id);
  });

  it("computes volume delta from the tape's split and accumulates it", () => {
    const series = seriesFor([10, 11, 10]);
    const data = seriesData(series);
    const bought = new Float64Array([100, 40, 10]);
    const sold = new Float64Array([60, 90, 30]);
    const spec = createIndicator("volumedelta");
    const output = computeIndicators(spec === null ? [] : [spec], {
      ...data, buy: bought, sell: sold,
    })[0];
    const histogram = output?.histogram?.values ?? new Float64Array();
    expect(histogram[0]).toBe(40);
    expect(histogram[1]).toBe(-50);
    expect(histogram[2]).toBe(-20);
    // Per-bar bars only: a panescale shared with the week's running sum
    // would flatten the bars, so the pane draws no cumulative line.
    expect(output?.lines.length ?? -1).toBe(0);
  });

  it("falls back to the bar's signed volume when the tape has no split", () => {
    const output = outputsFor("volumedelta", [10, 9])[0];
    const histogram = output?.histogram?.values ?? new Float64Array();
    // seriesFor closes at the open, so every bar is an up bar: +volume.
    expect(histogram[0]).toBe(10);
    expect(histogram[1]).toBe(11);
  });

  it("does not invent buy/sell delta for an unclassified tape bar", () => {
    const series = seriesFor([10, 11, 10]);
    const data = seriesData(series);
    const spec = createIndicator("volumedelta");
    const output = computeIndicators(spec === null ? [] : [spec], {
      ...data,
      buy: new Float64Array([10, Number.NaN, 4]),
      sell: new Float64Array([2, Number.NaN, 9]),
    })[0];
    const histogram = output?.histogram?.values ?? new Float64Array();
    expect(histogram[0]).toBe(8);
    expect(Number.isNaN(histogram[1])).toBe(true);
    expect(histogram[2]).toBe(-5);
  });

  it("reports an unknown indicator instead of throwing", () => {
    const data = seriesData(seriesFor([1, 2, 3]));
    const outputs = computeIndicators([{
      id: "x", type: "nope", params: {}, color: "#fff", visible: true,
    }], data);
    expect(outputs[0]?.error).toContain("unknown indicator");
  });
});
