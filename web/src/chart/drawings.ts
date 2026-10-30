/**
 * Drawings: what a reader has drawn on one chart, and how it is kept.
 *
 * A drawing belongs to one chart (symbol|session) and is two anchored
 * points on the tape's own coordinates - a Karachi-clock instant and a
 * price - so it lands back on the same bars after reload, zoom, a
 * timeframe switch or a merged-session shift. The screen holds the
 * notebook on every commit; the rail's Save button flushes it on demand.
 * One tool measures and is never kept: measurement is read, not recorded,
 * exactly like TradingView's ruler.
 */

/** The rail's tools, in the order the rail draws them. */
export type DrawTool =
  | "cursor"
  | "trend"
  | "ob"
  | "flatTop"
  | "flatBottom"
  | "hline"
  | "hray"
  | "measure";

/** The shapes a drawing can carry once committed. */
export type DrawingKind =
  | "trend"
  | "ob"
  | "flatTop"
  | "flatBottom"
  | "hline"
  | "hray";

export interface AnchoredPoint {
  /** Bar time, epoch ms in the tape's Karachi clock. */
  readonly t: number;
  readonly price: number;
}

export interface Drawing {
  readonly id: string;
  readonly kind: DrawingKind;
  readonly points: readonly [AnchoredPoint, AnchoredPoint | null];
}

const STORE_KEY = "charts-drawings";

/** Every drawing on a chart key, oldest first. */
export function loadDrawings(viewKey: string): Drawing[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    const list = record[viewKey];
    return parseDrawings(list);
  } catch {
    // A corrupt notebook is still a notebook, not a crash.
    return [];
  }
}

/**
 * The drawings on one chart, and whatever the older notebook held.
 *
 * The drawings used to live per timeframe (`symbol|day|1m`), so a trend
 * line vanished the moment a reader switched from 1m to 30m - the chart
 * with the other key loaded an empty page. They are keyed by chart now;
 * this load additionally adopts the richest old timeframe shard and
 * retires it, so work drawn before the fix survives the notebook's move.
 */
export function loadChartDrawings(chartKey: string): Drawing[] {
  const own = loadDrawings(chartKey);
  if (own.length > 0) {
    return own;
  }
  return migrateChartDrawings(chartKey);
}

/**
 * The migration itself: read every string shard `chartKey|x`, keep the
 * richest, write it under `chartKey` and delete the shards. Read-only on
 * any failure, exactly like `loadDrawings`.
 */
export function migrateChartDrawings(chartKey: string): Drawing[] {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return [];
    }
    const record = { ...(parsed as Record<string, unknown>) };
    let best: Drawing[] = [];
    for (const key of Object.keys(record)) {
      if (!key.startsWith(`${chartKey}|`)) {
        continue;
      }
      const list = parseDrawings(record[key]);
      if (list.length > best.length) {
        best = list;
      }
      delete record[key];
    }
    if (best.length === 0) {
      return [];
    }
    record[chartKey] = best;
    window.localStorage.setItem(STORE_KEY, JSON.stringify(record));
    return best;
  } catch {
    // A refusing store loses the migration, not the session.
    return [];
  }
}

export function saveDrawings(viewKey: string, drawings: readonly Drawing[]): void {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    const record: Record<string, unknown> = {};
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        Object.assign(record, parsed as Record<string, unknown>);
      }
    }
    record[viewKey] = drawings;
    window.localStorage.setItem(STORE_KEY, JSON.stringify(record));
  } catch {
    // Full or blocked storage: the drawing lives for the session only.
  }
}

export function clearDrawings(viewKey: string, storage: Storage): void {
  try {
    const raw = storage.getItem(STORE_KEY);
    if (raw === null) {
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const record = { ...(parsed as Record<string, unknown>) };
      delete record[viewKey];
      storage.setItem(STORE_KEY, JSON.stringify(record));
    }
  } catch {
    // Blocked storage: nothing to clean.
  }
}

/** What survives a round-trip: well-shaped drawings only. */
export function parseDrawings(value: unknown): Drawing[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Drawing[] = [];
  for (const item of value) {
    const drawing = parseOne(item);
    if (drawing !== null) {
      out.push(drawing);
    }
  }
  return out;
}

function parseOne(value: unknown): Drawing | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0
    || !isKind(kind)) {
    return null;
  }
  const points = record["points"];
  if (!Array.isArray(points) || points.length < 1) {
    return null;
  }
  const first = parsePoint(points[0]);
  if (first === null) {
    return null;
  }
  const second = points.length > 1 ? parsePoint(points[1]) : null;
  // One-point kinds carry exactly one anchor (a second real anchor is a
  // corrupt entry); segment kinds need both.
  const single = kind === "hline" || kind === "hray";
  if (single) {
    return second === null ? { id, kind, points: [first, null] } : null;
  }
  if (second === null) {
    return null;
  }
  return { id, kind, points: [first, second] };
}

function isKind(value: unknown): value is DrawingKind {
  return value === "trend" || value === "ob" || value === "flatTop"
    || value === "flatBottom" || value === "hline" || value === "hray";
}

function parsePoint(value: unknown): AnchoredPoint | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const t = record["t"];
  const price = record["price"];
  if (typeof t !== "number" || !Number.isFinite(t)
    || typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }
  return { t, price };
}

/** A new drawing's identity (collision-safe enough for one reader). */
export function newDrawingId(): string {
  return `d-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The measure readout between two anchors: the price move, the percent
 * move, the bar distance in minutes. Coloured TV's way: profit is teal,
 * loss is red, flat is grey.
 */
export interface MeasureResult {
  readonly from: AnchoredPoint;
  readonly to: AnchoredPoint;
  readonly delta: number;
  readonly pct: number;
  readonly minutes: number;
  readonly up: boolean | null;
}

export function measureBetween(
  from: AnchoredPoint,
  to: AnchoredPoint,
): MeasureResult {
  const delta = to.price - from.price;
  const pct = from.price !== 0 ? (delta / from.price) * 100 : 0;
  const minutes = Math.abs(to.t - from.t) / 60_000;
  return {
    from, to, delta, pct, minutes,
    up: delta > 0 ? true : delta < 0 ? false : null,
  };
}
