/**
 * The script language, beyond a single line.
 *
 * A reader pastes their own study: several statements, names they assigned
 * themselves, a plot wrapper, and a length that used to be refused at four
 * hundred characters. These pin the behaviour of that surface, and the
 * refusals that must stay refusals.
 */

import { describe, expect, it } from "vitest";

import {
  compileFormula,
  FormulaError,
  placementFromScript,
  validateFormula,
} from "./expression";
import type { SeriesData } from "./types";

function dataFor(closes: readonly number[]): SeriesData {
  const length = closes.length;
  const time = new Float64Array(length);
  const open = new Float64Array(length);
  const high = new Float64Array(length);
  const low = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);
  closes.forEach((value, index) => {
    time[index] = index * 60_000;
    open[index] = value;
    high[index] = value + 1;
    low[index] = value - 1;
    close[index] = value;
    volume[index] = 100 + index;
  });
  return { length, time, open, high, low, close, volume };
}

describe("multi-statement scripts", () => {
  it("reads names assigned on earlier lines", () => {
    const run = compileFormula("fast = sma(close, 2)\nslow = sma(close, 3)\nfast - slow");
    const out = run(dataFor([1, 2, 3, 4, 5]));
    expect(out[4]).toBeCloseTo(0.5);
  });

  it("draws the last line even when it is an assignment", () => {
    const run = compileFormula("window = sma(close, 2)");
    const out = run(dataFor([2, 4, 6]));
    expect(out[2]).toBeCloseTo(5);
  });

  it("accepts plot() and hline() as the drawing wrappers a script carries", () => {
    expect(() => validateFormula("plot(ema(close, 3))")).not.toThrow();
    const run = compileFormula("hline(100) + change(close)");
    // hline is a constant, change(close) is one bar's move: 100 + (15 - 12).
    expect(run(dataFor([10, 12, 15]))[2]).toBeCloseTo(103);
  });

  it("survives a wrapped call, which is one statement not two", () => {
    expect(() => validateFormula("sma(\n  close,\n  3\n)")).not.toThrow();
  });

  it("names an unassigned identifier instead of guessing a series", () => {
    // Parsing cannot know an assignment that never happened, so the refusal
    // arrives when the script is run against the bars - which is exactly what
    // the editor does before it commits the line.
    expect(() => validateFormula("mystery + 1"))
      .toThrow(/unknown series or variable/);
  });

  it("answers a comparison with 1 or 0, the way a Pine condition does", () => {
    const out = compileFormula("close >= 12")(dataFor([10, 12, 14]));
    expect([...out]).toEqual([0, 1, 1]);
  });

  it("reads Pine's and/or/not as logic", () => {
    const out = compileFormula("not (close > 11 and close < 13)")
      (dataFor([10, 12, 14]));
    expect([...out]).toEqual([1, 0, 1]);
  });

  it("holds a script far longer than the old 400-character ceiling", () => {
    const lines: string[] = [];
    for (let index = 1; index <= 80; index += 1) {
      lines.push(`a${index} = sma(close, ${index})`);
    }
    lines.push("a80");
    const script = lines.join("\n");
    expect(script.length).toBeGreaterThan(400);
    expect(() => validateFormula(script)).not.toThrow();
  });

  it("reads a pasted Pine banner, declaration and namespace", () => {
    const script = [
      "//@version=5",
      'indicator("EMA study", overlay=true)',
      "// the fast leg",
      "len = input.int(3, \"Length\")",
      "heavy = ta.ema(close, len)",
      "plot(heavy)",
    ].join("\n");
    const run = compileFormula(script);
    const out = run(dataFor([1, 1, 1, 1, 1]));
    expect(out[4]).toBeCloseTo(1);
    expect(() => validateFormula(script)).not.toThrow();
  });

  it("stores a type-prefixed declaration, the way Pine writes it", () => {
    const run = compileFormula([
      "var float G_TREND = na",
      "G_TREND := sma(close, 2)",
      "G_TREND",
    ].join("\n"));
    const out = run(dataFor([2, 4, 6]));
    expect(out[2]).toBeCloseTo(5);
  });

  it("reads a qualified type prefix on the very first line as well", () => {
    const run = compileFormula("simple int width = 2\nsma(close, width)");
    const out = run(dataFor([1, 2, 3, 4]));
    expect(out[3]).toBeCloseTo(3.5);
  });

  it("shows the offending statement when a line cannot be read", () => {
    try {
      validateFormula("heavy = sma(close, 2)\nheavy extra");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(FormulaError);
      const message = (error as Error).message;
      expect(message).toContain("unexpected \"extra\"");
      expect(message).toContain('statement 2: "heavy extra"');
    }
  });

  it("drops a drawing call it cannot express instead of failing the study", () => {
    const script = 'plot(close)\nplotshape(close > open, style=shape.triangleup)';
    expect(() => validateFormula(script)).not.toThrow();
  });

  it("reads a Pine study with drawings, a ternary and named plot settings", () => {
    const script = [
      "//@version=5",
      'indicator("Trend EMA (Yellow)", overlay=true)',
      "// the leg the reader cares about",
      'len = input.int(3, "EMA Length")',
      "emaTrend = ta.ema(close, len)",
      "showTrendEMA = close > emaTrend",
      "bx = box.new(bar_index, high, bar_index + 1, low)",
      "box.delete(bx)",
      "array.remove(demandBoxes, i)",
      "plot(showTrendEMA ? emaTrend : na, \"Trend EMA (Yellow)\", " +
        "color=color.yellow, linewidth=4)",
    ].join("\n");
    const run = compileFormula(script);
    const out = run(dataFor([10, 12, 14, 16, 18]));
    // Rising bars: the condition holds, so the EMA is drawn as itself.
    expect(out[4]).toBeCloseTo(16);
    // Flat bars: nothing holds, so the plot is na rather than a shifted line.
    const flat = compileFormula(script)(dataFor([5, 5, 5, 5, 5]));
    expect(Number.isNaN(flat[4])).toBe(true);
  });

  it("reads Pine history, comparisons and math namespace", () => {
    const run = compileFormula(
      "up = close > close[1]\nmath.round(close[1], 0) * up");
    const out = run(dataFor([10, 12, 14]));
    expect(out[2]).toBeCloseTo(12);
  });

  it("drops an if block with the drawings inside it", () => {
    const script = [
      "len = input.int(2, \"Length\")",
      "avg = ta.sma(close, len)",
      "if close > avg",
      "    box.new(bar_index, high, bar_index + 1, low)",
      "    array.push(demandBoxes, bar_index)",
      "plot(avg)",
    ].join("\n");
    const out = compileFormula(script)(dataFor([2, 4, 6]));
    expect(out[2]).toBeCloseTo(5);
  });

  it("keeps a study where its own declaration puts it", () => {
    expect(placementFromScript('indicator("Trend EMA", overlay=true)'))
      .toBe("overlay");
    expect(placementFromScript('indicator("RSI", overlay=false)'))
      .toBe("pane");
    expect(placementFromScript("ema(close, 20)")).toBeNull();
  });

  it("still refuses a script that never ends", () => {
    const script = "x = 1\n".repeat(4_000);
    expect(() => compileFormula(script)).toThrow(FormulaError);
  });
});
