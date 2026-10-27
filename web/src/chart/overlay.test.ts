/**
 * The overlay's own math, detached from the canvas: the frame the price
 * pane gets from the engine's sizes, the labels a measure carries, and the
 * bar-index mapping a drawing rides - the one that must never drop a line
 * just because it ends between bars or in the margin.
 */

import { describe, expect, it } from "vitest";
import { anchorAt, frameFor, makePositions } from "./overlay";

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
