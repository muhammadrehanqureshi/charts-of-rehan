import { describe, expect, it } from "vitest";

import {
  AUXILIARY_POLL_MS,
  CATALOGUE_REFRESH_MS,
  FEED_HEALTH_REFRESH_MS,
  FLOW_REFRESH_MS,
} from "./lightweight";

describe("machine budget", () => {
  it("keeps ancillary polls at or above five seconds", () => {
    expect(AUXILIARY_POLL_MS).toBeGreaterThanOrEqual(5_000);
    expect(FLOW_REFRESH_MS).toBeGreaterThanOrEqual(5_000);
  });

  it("keeps catalogue and health polling slow", () => {
    expect(CATALOGUE_REFRESH_MS).toBeGreaterThanOrEqual(10_000);
    expect(FEED_HEALTH_REFRESH_MS).toBeGreaterThanOrEqual(10_000);
  });
});
