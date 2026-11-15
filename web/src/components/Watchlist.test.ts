import { describe, expect, it } from "vitest";

import { dayTotal, totalVolume } from "./Watchlist";

describe("watchlist volume total", () => {
  it("uses the venue's overall volume, including unclassified prints", () => {
    expect(totalVolume(5_662_340, 951_902, 548_174, 403_728))
      .toBe(5_662_340);
    expect(dayTotal({
      symbol: "PRL",
      buy_volume: 548_174,
      sell_volume: 403_728,
      unclassified_volume: 4_710_438,
      classified_volume: 951_902,
      volume: 5_662_340,
      orders: 9_032,
      prints: 217,
      delta: 144_446,
      coverage: 0.1681,
    })).toBe(5_662_340);
  });

  it("falls back when an older answer carries no overall volume", () => {
    expect(totalVolume(undefined, 951_902, 548_174, 403_728))
      .toBe(951_902);
    expect(totalVolume(undefined, undefined, 548_174, 403_728))
      .toBe(951_902);
    expect(totalVolume(undefined, undefined, undefined, undefined))
      .toBeNull();
  });
});