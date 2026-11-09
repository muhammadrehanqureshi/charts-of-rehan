import { describe, expect, it } from "vitest";

import type { Bar } from "../api/types";
import { dayLabel, perDayCounts } from "./dayCounts";

/** A bar at a Karachi stamp; synthetic ones carry zero volume and range. */
function at(stamp: string, synthetic = false): Bar {
  return {
    t: stamp,
    o: 100,
    h: synthetic ? 100 : 101,
    l: synthetic ? 100 : 99,
    c: 100,
    v: synthetic ? 0 : 5_000,
    ...(synthetic ? { synthetic: true } : {}),
  };
}

describe("perDayCounts", () => {
  it("counts each date's block, flat buckets included", () => {
    const bars = [
      at("2026-10-30T09:17:00+05:00"),
      at("2026-10-30T10:17:00+05:00"),
      at("2026-10-30T11:17:00+05:00"),
      at("2026-10-30T14:32:00+05:00", true),
      at("2026-10-30T15:32:00+05:00", true),
      at("2026-11-02T09:32:00+05:00", true),
      at("2026-11-02T10:32:00+05:00"),
      at("2026-11-02T11:32:00+05:00"),
      at("2026-11-02T12:32:00+05:00"),
      at("2026-11-02T13:32:00+05:00"),
      at("2026-11-02T14:32:00+05:00"),
    ];
    const result = perDayCounts(bars);
    expect(result.days.map((item) => item.day))
      .toEqual(["2026-10-30", "2026-11-02"]);
    expect(result.days.map((item) => item.count)).toEqual([5, 6]);
    expect(result.days.map((item) => item.synthetic)).toEqual([2, 1]);
    expect(result.earlierDays).toBe(0);
  });

  it("keeps the newest dates, oldest first, and names what it left out", () => {
    const bars: Bar[] = [];
    for (let day = 1; day <= 10; day += 1) {
      const text = String(day).padStart(2, "0");
      bars.push(at(`2026-10-${text}T09:32:00+05:00`));
      bars.push(at(`2026-10-${text}T10:32:00+05:00`));
    }
    const result = perDayCounts(bars, 3);
    expect(result.days.map((item) => item.day)).toEqual([
      "2026-10-08", "2026-10-09", "2026-10-10",
    ]);
    expect(result.days.every((item) => item.count === 2)).toBe(true);
    expect(result.earlierDays).toBe(7);
  });

  it("ignores a stamp that carries no date", () => {
    const result = perDayCounts([at("not a stamp"), at("2026-11-06T12:00:00+05:00")]);
    expect(result.days).toHaveLength(1);
    expect(result.days[0]?.day).toBe("2026-11-06");
    expect(result.earlierDays).toBe(0);
  });

  it("is empty for an empty series", () => {
    expect(perDayCounts([])).toEqual({ days: [], earlierDays: 0 });
  });

  it("writes a date the way the strip reads it", () => {
    expect(dayLabel("2026-11-06")).toBe("06 Nov");
    expect(dayLabel("2026-10-30")).toBe("30 Oct");
  });
});
