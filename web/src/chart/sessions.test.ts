import { describe, expect, it } from "vitest";

import { sessionBreaks } from "./sessions";

/** A Karachi clock instant as epoch milliseconds. */
function pkt(day: string, clock: string): number {
  return Date.parse(`${day}T${clock}+05:00`);
}

describe("sessionBreaks", () => {
  it("finds one break per trading day and labels it on the Karachi clock", () => {
    const times = [
      pkt("2026-10-21", "09:32"),
      pkt("2026-10-21", "11:59"),
      pkt("2026-10-23", "09:32"),
      pkt("2026-10-23", "11:59"),
    ];
    const breaks = sessionBreaks(times);
    expect(breaks.map((item) => item.day)).toEqual([
      "2026-10-21", "2026-10-23",
    ]);
    expect(breaks[0]?.label).toBe("21 Oct");
    expect(breaks[1]?.label).toBe("23 Oct");
    expect(breaks[0]?.first).toBe(true);
    expect(breaks[1]?.first).toBe(false);
  });

  it("reads the day in Karachi, not in UTC: morning bars belong to the same day", () => {
    // 04:00 PKT is 23:00 UTC of the previous day. A UTC-based key would put
    // this bar on 22 Oct and invent a break that never happened.
    const times = [
      pkt("2026-10-23", "00:30"),
      pkt("2026-10-23", "04:00"),
      pkt("2026-10-23", "09:32"),
    ];
    expect(sessionBreaks(times)).toHaveLength(1);
  });

  it("ignores holes and unusable stamps instead of inventing sessions", () => {
    const times = [
      pkt("2026-10-23", "09:32"),
      Number.NaN,
      pkt("2026-10-23", "11:59"),
    ];
    const breaks = sessionBreaks(times);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]?.t).toBe(times[0]);
  });
});
