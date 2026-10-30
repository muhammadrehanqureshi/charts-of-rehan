/**
 * The overlay's own math, detached from the canvas: the frame the price
 * pane gets from the engine's sizes, the labels a measure carries, and the
 * bar-index mapping a drawing rides - the one that must never drop a line
 * just because it ends between bars or in the margin.
 */

import { describe, expect, it } from "vitest";
import { anchorAt, breakPlan, frameFor, makePositions, monthText } from "./overlay";
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
