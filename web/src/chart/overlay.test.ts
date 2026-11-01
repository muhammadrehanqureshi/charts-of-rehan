/**
 * The overlay's own math, detached from the canvas: the frame the price
 * pane gets from the engine's sizes, the labels a measure carries, and the
 * bar-index mapping a drawing rides - the one that must never drop a line
 * just because it ends between bars or in the margin.
 */

import { describe, expect, it } from "vitest";
import {
  anchorAt, breakPlan, fibLevels, frameFor, makePositions,
  monthText, paintSessionBreaks, profileLevels, volumeProfile,
} from "./overlay";
import type { SessionBreak } from "./sessions";

type Chartish = Parameters<typeof frameFor>[0];

function fakeChart(sizes: { axis?: number } = {}): Chartish {
  return {
    priceScale: () => ({
      width: () => sizes.axis ?? 60,
    }),
    panes: () => [],
  } as unknown as Chartish;
}

describe("overlay frame", () => {
  it("subtracts the price axis from the plot width", () => {
    const frame = frameFor(fakeChart({ axis: 60 }), 800, 500);
    expect(frame.plotWidth).toBe(740);
    expect(frame.plotHeight).toBe(500);
  });

  it("a chart that hides its sizes still yields a sane frame", () => {
    const broken = {
      priceScale: () => {
        throw new Error("no scale yet");
      },
      panes: () => [],
    } as unknown as Chartish;
    const frame = frameFor(broken, 800, 500);
    expect(frame.plotWidth).toBe(740);
  });

  it("pane 0 never borrows from the panes below it", () => {
    const paged = {
      priceScale: () => ({ width: () => 58 }),
      panes: () => [
        { getHeight: () => 360 },
        { getHeight: () => 110 },
      ],
    } as unknown as Chartish;
    const frame = frameFor(paged, 900, 520);
    expect(frame.plotHeight).toBe(360);
    expect(frame.plotWidth).toBe(842);
  });
});

describe("break plan", () => {
  /** A mapped chart: each Karachi day owns one pixel position. */
  function mappedChart(
    entries: readonly (readonly [day: string, x: number, first?: boolean])[],
  ): { breaks: SessionBreak[]; xOf: (t: number) => number | null } {
    const xByTime = new Map<number, number | null>();
    const breaks: SessionBreak[] = [];
    for (const [day, x, first = false] of entries) {
      const t = Date.parse(`${day}T09:30:00+05:00`);
      xByTime.set(t, x < 0 ? null : x);
      breaks.push({
        t,
        day,
        label: first || x < 0 ? day : day.slice(8, 10) + " Oct",
        first,
      });
    }
    return { breaks, xOf: (t: number) => xByTime.get(t) ?? null };
  }

  it("a roomy chart lines and labels every day join it can see", () => {
    const { breaks, xOf } = mappedChart([
      ["2026-10-19", 100, true],
      ["2026-10-20", 300],
      ["2026-10-21", 500],
    ]);
    const plan = breakPlan(breaks, xOf, 800);
    expect(plan.filter((item) => item.line)
      .map((item) => item.x)).toEqual([300, 500]);
    expect(plan.filter((item) => item.text !== null)
      .map((item) => item.text)).toEqual(["20 Oct", "21 Oct"]);
  });

  it("puts the rule on the new session's first bar, not in the gap", () => {
    const previous = Date.parse("2026-10-14T11:47:00+05:00");
    const first = Date.parse("2026-10-21T09:47:00+05:00");
    const breaks: SessionBreak[] = [{
      t: first, day: "2026-10-21", label: "21 Oct", first: false, previous,
    }];
    // The time axis spaces the weekend and the missing sessions, so the
    // old midpoint would put this rule in empty space before the 21st.
    const x = new Map([[previous, 100], [first, 700]]);
    const plan = breakPlan(breaks, (t) => x.get(t) ?? null, 700);
    expect(plan.find((item) => item.line)?.x).toBe(700);
  });

  it("a daily-grain dense chart says months, not one date per day", () => {
    // A year of month starts at one pixel each: the dashed forest.
    const entries: [string, number, boolean?][] = [];
    for (let i = 0; i < 12; i += 1) {
      entries.push([`2025-${String(i + 1).padStart(2, "0")}-01`, i, i === 0]);
    }
    const { breaks, xOf } = mappedChart(entries);
    const plan = breakPlan(breaks, xOf, 700);
    const lines = plan.filter((item) => item.line);
    const texts = plan.filter((item) => item.text !== null);
    // One pixel a month: nothing after the first join earns a line, and
    // the crowded month names collapse to the first one that fits.
    expect(lines).toHaveLength(1);
    expect(texts.map((item) => item.text)).toEqual(["Feb"]);
  });

  it("a month name carries its year only where it would be ambiguous", () => {
    expect(monthText("2025-07-21")).toBe("Jul");
    expect(monthText("2026-01-05")).toBe("Jan '26");
  });

  it("keeps every intraday rule even when two joins are pixels apart", () => {
    const entries: [string, number, boolean?][] = [];
    for (let i = 0; i < 6; i += 1) {
      entries.push([
        `2026-10-${String(12 + i).padStart(2, "0")}`, 100 + i * 10, i === 0,
      ]);
    }
    const { breaks, xOf } = mappedChart(entries);
    expect(breakPlan(breaks, xOf, 700, false)
      .filter((item) => item.line)).toHaveLength(5);
  });

  it("an intraday window keeps every session rule when days sit close", () => {
    const entries: [string, number, boolean?][] = [];
    for (let i = 0; i < 6; i += 1) {
      entries.push([
        `2026-10-${String(12 + i).padStart(2, "0")}`, 100 + i * 20, i === 0,
      ]);
    }
    const { breaks, xOf } = mappedChart(entries);
    // Twenty pixels per session is dense for a calendar chart and roomy
    // enough for an intraday one: every join keeps its dotted rule.
    expect(breakPlan(breaks, xOf, 700, false)
      .filter((item) => item.line)).toHaveLength(5);
    expect(breakPlan(breaks, xOf, 700)
      .filter((item) => item.line).length).toBeLessThan(5);
  });

  it("paints a dotted rule and the day's name at every visible join", () => {
    const { breaks } = mappedChart([
      ["2026-10-19", 100, true],
      ["2026-10-20", 300],
      ["2026-10-21", 500],
    ]);
    const ops: string[] = [];
    const context = {
      save: () => ops.push("save"),
      restore: () => ops.push("restore"),
      setLineDash: (dash: number[]) => ops.push(`dash:${dash.join(",")}`),
      beginPath: () => ops.push("begin"),
      moveTo: (x: number, y: number) => ops.push(`move:${x},${y}`),
      lineTo: (x: number, y: number) => ops.push(`line:${x},${y}`),
      stroke: () => ops.push("stroke"),
      fillText: (text: string) => ops.push(`text:${text}`),
      font: "", textBaseline: "", strokeStyle: "", lineWidth: 1,
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D;
    const x = new Map(breaks.map((item, index) => [item.t, 100 + index * 200]));
    const chart = {
      timeScale: () => ({
        timeToCoordinate: (t: number) => x.get(t * 1000) ?? null,
      }),
    } as unknown as Parameters<typeof paintSessionBreaks>[1];
    paintSessionBreaks(context, chart,
      { plotWidth: 700, plotHeight: 400 }, breaks,
      { line: "#2962ff", label: "#8f9bb3" }, false, 520);
    expect(ops).toContain("dash:2,4");
    expect(ops.filter((op) => op === "stroke")).toHaveLength(2);
    expect(ops).toContain("text:20 Oct");
    // The rule runs the full stack, not only the price pane.
    expect(ops).toContain("line:300.5,520");
  });

  it("a label never lands on its neighbour's words", () => {
    // Room for lines, not for two day names beside each other: only the
    // joins with space to the previous label keep their text.
    const { breaks, xOf } = mappedChart([
      ["2026-10-19", 100, true],
      ["2026-10-20", 110],
      ["2026-10-21", 130],
      ["2026-10-22", 660],
      ["2026-10-23", 680],
    ]);
    const plan = breakPlan(breaks, xOf, 700);
    const texts = plan.filter((item) => item.text !== null);
    expect(texts.map((item) => item.text)).toEqual(["20 Oct", "22 Oct"]);
  });

  it("breaks off the drawn panel are decided away entirely", () => {
    const { breaks, xOf } = mappedChart([
      ["2026-10-19", 50, true],
      ["2026-10-20", 300],
      ["2026-10-21", 900],
    ]);
    const plan = breakPlan(breaks, xOf, 700);
    expect(plan.filter((item) => item.line)).toHaveLength(1);
  });

  it("nothing visible is an empty plan", () => {
    const { breaks, xOf } = mappedChart([
      ["2026-10-19", -50, true],
      ["2026-10-20", -10],
    ]);
    expect(breakPlan(breaks, xOf, 700)).toEqual([]);
  });
});

describe("anchor mapping", () => {
  const chart = {
    timeScale: () => ({
      coordinateToTime: (x: number) =>
        x >= 0 && x <= 100 ? Math.floor(x * 1000) : null,
      coordinateToLogical: (x: number) =>
        x >= 0 && x <= 100 ? Math.floor(x / 100) : null,
      // The engine's own second-scale: only seconds 0..100 are on screen.
      timeToCoordinate: (t: number) =>
        (t >= 0 && t <= 100 ? t : null),
    }),
  } as unknown as Parameters<typeof anchorAt>[0];
  const candles = {
    coordinateToPrice: (y: number) => (y >= 0 && y <= 200 ? 1000 - y / 2 : null),
    priceToCoordinate: (price: number) => (price >= 900 && price <= 1000
      ? (1000 - price) * 2
      : null),
  } as unknown as Parameters<typeof anchorAt>[1];

  /** The engine's screen holds exactly two bars: seconds 0 and 100. */
  const positions = makePositions(chart, candles, [0, 100_000]);

  it("a click anchors onto the tape's own instant and price", () => {
    expect(anchorAt(chart, candles, 40, 120))
      .toEqual({ t: 40_000_000, price: 940 });
  });

  it("a point outside the drawn panel anchors to nothing", () => {
    expect(anchorAt(chart, candles, -5, 10)).toBe(null);
    expect(anchorAt(chart, candles, 40, 900)).toBe(null);
  });

  it("an instant between two bars still maps to its pixel", () => {
    // Second 40 is 40% of the way from bar 0 (x 0) to bar 1 (x 100).
    expect(positions.xAt(40_000)).toBeCloseTo(40, 6);
  });

  it("an instant past the newest bar extends at the bars' own pace", () => {
    // The margin: one bar's worth past the end lands at x 200, where the
    // click happened, not snapped back onto the newest candle.
    expect(positions.xAt(200_000)).toBeCloseTo(200, 6);
  });

  it("an instant before the first bar extends the other way", () => {
    expect(positions.xAt(-100_000)).toBeCloseTo(-100, 6);
  });

  it("a price maps through the candle pane's own scale", () => {
    expect(positions.yAt(950)).toBe(100);
  });

  it("a series with no bars maps nothing", () => {
    const blank = makePositions(chart, candles, []);
    expect(blank.xAt(40_000)).toBe(null);
  });

  it("a series of one bar pins every instant to that bar's pixel", () => {
    const single = makePositions(chart, candles, [0]);
    expect(single.xAt(40_000)).toBe(0);
  });
});

describe("fib retracement", () => {
  it("places the classic levels between the two anchors", () => {
    const levels = fibLevels({ t: 0, price: 100 }, { t: 1000, price: 200 });
    expect(levels.map((level) => level.ratio))
      .toEqual([0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]);
    expect(levels[0]?.price).toBe(100);
    expect(levels[3]?.price).toBe(150);
    expect(levels[6]?.price).toBe(200);
  });

  it("measures a down swing from its own first anchor", () => {
    const levels = fibLevels({ t: 0, price: 200 }, { t: 10, price: 100 });
    expect(levels[3]?.price).toBe(150);
    expect(levels[6]?.price).toBe(100);
  });
});

describe("fixed range volume profile", () => {
  it("spreads a bar's volume across the prices it traded", () => {
    const bars = {
      time: [0, 60_000],
      high: [110, 110],
      low: [90, 90],
      volume: [100, 100],
    };
    const profile = volumeProfile(bars,
      { t: -1, price: 90 }, { t: 120_000, price: 110 }, 10);
    expect(profile).not.toBeNull();
    expect(profile?.total).toBeCloseTo(200, 5);
    // A 20-point range in ten bins: each bin holds a tenth of the volume.
    expect(profile?.bins[0]?.volume).toBeCloseTo(20, 5);
    expect(profile?.poc).toBeCloseTo(91, 5);
  });

  it("counts only the bars inside the selected time range", () => {
    const bars = {
      time: [0, 600_000],
      high: [105, 105],
      low: [95, 95],
      volume: [50, 50],
    };
    const profile = volumeProfile(bars,
      { t: -1, price: 90 }, { t: 60_000, price: 110 }, 4);
    expect(profile?.total).toBeCloseTo(50, 5);
  });

  it("names the value area's edges and the point of control", () => {
    const bars = { time: [0], high: [110], low: [90], volume: [100] };
    const profile = volumeProfile(bars,
      { t: -1, price: 90 }, { t: 1, price: 110 }, 10);
    expect(profile).not.toBeNull();
    const levels = profileLevels(profile!);
    expect(levels.map((level) => level.key)).toEqual(["VAH", "POC", "VAL"]);
    const vah = levels[0]!.price;
    const poc = levels[1]!.price;
    const val = levels[2]!.price;
    expect(vah).toBeGreaterThanOrEqual(poc);
    expect(poc).toBeGreaterThanOrEqual(val);
  });

  it("is null when the range holds no bar or no price span", () => {
    const bars = { time: [0], high: [100], low: [90], volume: [5] };
    expect(volumeProfile(bars,
      { t: 5_000, price: 90 }, { t: 9_000, price: 100 })).toBeNull();
    expect(volumeProfile(bars,
      { t: 0, price: 100 }, { t: 1_000, price: 100 })).toBeNull();
  });
});
