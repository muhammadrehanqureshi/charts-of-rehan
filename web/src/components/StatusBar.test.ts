import { describe, expect, it } from "vitest";

import type { HealthReport } from "../api/types";
import { recorderStateText } from "./StatusBar";

type Recorder = NonNullable<HealthReport["recorder"]>;

function recorder(overrides: Partial<Recorder> = {}): Recorder {
  return {
    state: "RUNNING",
    feed_connected: false,
    capturing: false,
    last_frame_age_seconds: null,
    ...overrides,
  };
}

describe("the recorder chip", () => {
  it("names the next window while capture is closed", () => {
    const text = recorderStateText(recorder({
      window: { opens: "2026-11-10T08:55:00+05:00", closes: "2026-11-10T16:00:00+05:00" },
    }));
    expect(text.startsWith("idle · opens ")).toBe(true);
    expect(text).toContain("08:55");
  });

  it("says so when no window is within the law's reach", () => {
    expect(recorderStateText(recorder({ window: null })))
      .toBe("idle · no window scheduled");
    // An older service sends no window at all: the same sentence, not a fault.
    expect(recorderStateText(recorder())).toBe("idle · no window scheduled");
  });

  it("reports capture and the last frame inside the window", () => {
    expect(recorderStateText(recorder({
      capturing: true,
      feed_connected: true,
      last_frame_age_seconds: 12,
    }))).toBe("capturing · last frame 12s ago");
  });

  it("does not claim a frame it has not received", () => {
    expect(recorderStateText(recorder({ capturing: true })))
      .toBe("capturing · no frame yet");
  });
});
