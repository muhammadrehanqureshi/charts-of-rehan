import { describe, expect, it } from "vitest";

import { axisSpanRank, karachiDayText, opensDay } from "./axis";

/** A Karachi wall-clock stamp as epoch milliseconds. */
function at(day: string, hour: number, minute: number): number {
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute)
    .padStart(2, "0")}:00+05:00`);
}

describe("the axis date rule", () => {
  it("ranks a decade as years, a year as months and a month as days", () => {
    expect(axisSpanRank(3_650)).toBe("year");
    expect(axisSpanRank(400)).toBe("month");
    expect(axisSpanRank(35)).toBe("day");
    expect(axisSpanRank(0)).toBe("day");
    expect(axisSpanRank(Number.NaN)).toBe("day");
  });

  it("reads the Karachi date of an instant", () => {
    expect(karachiDayText(at("2026-10-20", 15, 32))).toBe("2026-10-20");
    // 22:30 Karachi is already the next UTC day; the label follows Karachi.
    expect(karachiDayText(at("2026-10-20", 22, 30))).toBe("2026-10-20");
    expect(karachiDayText(Number.NaN)).toBe("");
  });

  it("opens a day only on its first bar", () => {
    const times = [
      at("2026-10-20", 9, 32),
      at("2026-10-20", 10, 32),
      at("2026-10-20", 11, 32),
      at("2026-10-21", 9, 32),
    ];
    expect(times.map((_t, i) => opensDay(times, i)))
      .toEqual([true, false, false, true]);
  });

  it("never claims a day for a bar that is not there", () => {
    expect(opensDay([], 0)).toBe(false);
    expect(opensDay([Number.NaN], 0)).toBe(false);
  });

  it("treats the series' first bar as an opening", () => {
    expect(opensDay([at("2026-10-20", 9, 32)], 0)).toBe(true);
  });

  it("names the day when the predecessor is unknown", () => {
    expect(opensDay([Number.NaN, at("2026-10-20", 9, 32)], 1)).toBe(true);
  });
});
