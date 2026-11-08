/**
 * The footer chip must describe the market, not the socket.
 *
 * A live stream stays connected after the exchange closes; the chip used to
 * read LIVE beside MARKET CLOSED on the same row. These are the four states a
 * reader can actually meet.
 */

import { describe, expect, it } from "vitest";

import type { MarketContext } from "../api/types";
import { stateChip } from "./StatusBar";

function market(phase: string, tradingDay: boolean): MarketContext {
  return {
    phase,
    state: phase,
    trading_day: tradingDay,
    timezone: "Asia/Karachi",
    band: null,
    next_event: null,
    as_of: "2026-11-08T12:32:00+05:00",
  } as MarketContext;
}

describe("the footer state chip", () => {
  it("says the market is closed, not live, on a closed Sunday", () => {
    expect(stateChip("live", market("CLOSED", false)))
      .toEqual({ text: "market closed", tone: "closed" });
  });

  it("says live only while the exchange is open", () => {
    expect(stateChip("live", market("OPEN", true)))
      .toEqual({ text: "live", tone: "live" });
  });

  it("keeps the socket's own state when the stream is not live", () => {
    expect(stateChip("connecting", null).text).toBe("connecting");
    expect(stateChip("reconnecting", market("CLOSED", false)).text)
      .toBe("reconnecting");
    expect(stateChip("snapshot", market("CLOSED", false)).text)
      .toBe("finished session");
  });

  it("names a pre-open phase instead of claiming live data", () => {
    expect(stateChip("live", market("PRE_OPEN", true)).text).toBe("pre-open");
  });
});
