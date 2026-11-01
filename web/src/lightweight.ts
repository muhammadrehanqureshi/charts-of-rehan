/**
 * Browser-side machine budget.
 *
 * Charts of Rehan is a guest on the owner's PC. The chart's own stream is
 * server-driven and may tick at most once per second while the tab is visible;
 * everything in this file is deliberately slower. The tests assert these
 * floors so a future change cannot quietly turn the UI into a request storm.
 */

export const AUXILIARY_POLL_MS = 5_000;
export const FLOW_REFRESH_MS = 5_000;
export const CATALOGUE_REFRESH_MS = 15_000;
export const FEED_HEALTH_REFRESH_MS = 10_000;
