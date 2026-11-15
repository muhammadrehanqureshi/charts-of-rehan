/**
 * Session-aware candle aggregation.
 *
 * The chart's candles are not clock buckets. PSX trades Monday to Thursday
 * 09:32-15:30 and Friday in two bands, 09:17-12:00 and 14:32-16:30, so an
 * hourly candle is the first hour of a band, not 10:00-11:00 UTC+5. A fold
 * anchored to the epoch (or to midnight) puts a candle across the Friday
 * lunch, makes a six-candle session read five, and moves the first candle off
 * the opening print.
 *
 * This module therefore keys every bucket by (Karachi day, band, step):
 *
 *     bucketOpen = bandOpen + floor((candleOpen - bandOpen) / targetMs) * targetMs
 *
 * A bucket can never cross a band edge. For a full Monday-to-Thursday session
 * a 10-minute series folds into exactly six 1-hour candles; Friday folds into
 * three morning candles and two afternoon candles. A candle is only built
 * from source candles that exist: a hole stays a hole and is reported, never
 * filled with a synthetic price.
 *
 * Karachi has no daylight saving time, so the offset is a constant and the
 * hot path is integer arithmetic. `Date` is used only to name a day, once.
 */

/** One OHLCV candle. `t` is the epoch-millisecond open of the bucket. */
export interface Candle {
  readonly t: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

/** One trading band, `[open, close)` in minutes after Karachi midnight. */
export interface SessionBand {
  readonly open: number;
  readonly close: number;
}

/** The bands a specific Karachi date actually traded; empty means holiday. */
export interface TradingSession {
  readonly day: string;
  readonly bands: readonly SessionBand[];
}

export type IssueCode =
  | "MALFORMED_CANDLE"
  | "MALFORMED_SESSION"
  | "DUPLICATE_SESSION"
  | "DUPLICATE_TIMESTAMP"
  | "DUPLICATE_BUCKET"
  | "UNSORTED"
  | "OUT_OF_SESSION"
  | "OFF_GRID"
  | "MISALIGNED_BUCKET"
  | "PARTIAL_BUCKET"
  | "MISSING_BUCKET";

export type IssueSeverity = "error" | "warning";

/** One measured problem. Data problems are collected, never thrown. */
export interface IntegrityIssue {
  readonly code: IssueCode;
  readonly at: number;
  readonly detail: string;
  readonly severity: IssueSeverity;
}

export interface AggregateOptions {
  /** Source interval in ms, e.g. 10 * 60_000. */
  readonly sourceMs: number;
  /** Target interval in ms, e.g. 60 * 60_000. */
  readonly targetMs: number;
  /** Every session in the range. A date absent here is a holiday. */
  readonly sessions: readonly TradingSession[];
  /** Karachi offset. Defaults to +05:00; PSX has no DST. */
  readonly utcOffsetMs?: number;
}

export interface AggregateResult {
  readonly candles: readonly Candle[];
  readonly issues: readonly IntegrityIssue[];
}

export interface SessionCheck {
  readonly day: string;
  readonly expected: number;
  readonly actual: number;
  /** Epoch-ms opens of the target buckets this session is missing. */
  readonly missing: readonly number[];
  readonly complete: boolean;
}

export interface IntegrityReport {
  /** True only when the structure is sound and every expected bucket is present. */
  readonly ok: boolean;
  readonly complete: boolean;
  readonly sessions: readonly SessionCheck[];
  readonly issues: readonly IntegrityIssue[];
}

/** A programming error, not a data problem: the caller's intervals are wrong. */
export class AggregationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AggregationConfigError";
  }
}

/** A wire row that cannot become a candle. */
export class CandleParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandleParseError";
  }
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_OFFSET_MS = 5 * 60 * 60 * 1000;
const DAY_TEXT = /^\d{4}-\d{2}-\d{2}$/;

/** `"09:32"` to 572. Throws rather than guessing a malformed clock. */
export function clockToMinutes(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (match === null) {
    throw new RangeError(`not a clock: ${JSON.stringify(text)}`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  // 24:00 is the only spelling of midnight-at-the-end-of-day a band close
  // may use; 24:10 is not a clock.
  if (!Number.isInteger(hour) || !Number.isInteger(minute)
      || hour < 0 || hour > 24 || minute < 0 || minute > 59
      || (hour === 24 && minute !== 0)) {
    throw new RangeError(`not a clock: ${JSON.stringify(text)}`);
  }
  return hour * 60 + minute;
}

function assertInterval(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value % MINUTE_MS !== 0) {
    throw new AggregationConfigError(
      `${name} must be a positive whole number of minutes, got ${value}`);
  }
}

function assertOptions(options: AggregateOptions): void {
  assertInterval("sourceMs", options.sourceMs);
  assertInterval("targetMs", options.targetMs);
  if (options.sourceMs > options.targetMs) {
    throw new AggregationConfigError(
      `sourceMs (${options.sourceMs}) is coarser than targetMs (${options.targetMs})`);
  }
  if (options.targetMs % options.sourceMs !== 0) {
    throw new AggregationConfigError(
      `targetMs (${options.targetMs}) is not a whole multiple of sourceMs (${options.sourceMs})`);
  }
}

/** The integer Karachi day of an instant, without allocating a Date. */
function dayNumber(t: number, offsetMs: number): number {
  return Math.floor((t + offsetMs) / DAY_MS);
}

/** The `YYYY-MM-DD` Karachi date of a day number. */
function dayText(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function dayNumberFromText(text: string): number | null {
  if (!DAY_TEXT.test(text)) {
    return null;
  }
  const midnight = Date.parse(`${text}T00:00:00Z`);
  if (!Number.isFinite(midnight)
      || new Date(midnight).toISOString().slice(0, 10) !== text) {
    return null;
  }
  return midnight / DAY_MS;
}

/** Why this candle cannot be folded, or null when it can. */
function candleProblem(candle: Candle): string | null {
  if (!Number.isFinite(candle.t)) return "timestamp is not finite";
  if (!Number.isFinite(candle.open)) return "open is not finite";
  if (!Number.isFinite(candle.high)) return "high is not finite";
  if (!Number.isFinite(candle.low)) return "low is not finite";
  if (!Number.isFinite(candle.close)) return "close is not finite";
  if (!Number.isFinite(candle.volume)) return "volume is not finite";
  if (candle.high < Math.max(candle.open, candle.close, candle.low)) {
    return "high is below another price";
  }
  if (candle.low > Math.min(candle.open, candle.close, candle.high)) {
    return "low is above another price";
  }
  if (candle.volume < 0) return "volume is negative";
  return null;
}

/**
 * Build a candle from an untyped wire row.
 *
 * Accepts `{ t, o, h, l, c, v }` with `t` as epoch ms or an ISO stamp. Every
 * field is checked; a row that cannot be a candle raises instead of becoming
 * a zero. Use `parseCandles` when one bad row must not stop a whole batch.
 */
export function parseCandle(raw: unknown): Candle {
  if (typeof raw !== "object" || raw === null) {
    throw new CandleParseError("row is not an object");
  }
  const row = raw as Record<string, unknown>;
  const stamp = row["t"];
  const t = typeof stamp === "string" ? Date.parse(stamp) : stamp;
  if (typeof t !== "number" || !Number.isFinite(t)) {
    throw new CandleParseError(`timestamp is not a date or epoch ms: ${String(stamp)}`);
  }
  const numeric = (key: string): number => {
    const value = row[key];
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
      throw new CandleParseError(`${key} is not a finite number: ${String(value)}`);
    }
    return parsed;
  };
  const candle: Candle = {
    t,
    open: numeric("o"),
    high: numeric("h"),
    low: numeric("l"),
    close: numeric("c"),
    volume: row["v"] === undefined ? 0 : numeric("v"),
  };
  const problem = candleProblem(candle);
  if (problem !== null) {
    throw new CandleParseError(problem);
  }
  return candle;
}

/** Parse a batch, keeping every good row and naming every rejected one. */
export function parseCandles(raw: readonly unknown[]): {
  candles: Candle[];
  rejected: CandleParseError[];
} {
  const candles: Candle[] = [];
  const rejected: CandleParseError[] = [];
  for (const row of raw) {
    try {
      candles.push(parseCandle(row));
    } catch (error) {
      rejected.push(error instanceof CandleParseError
        ? error
        : new CandleParseError(String(error)));
    }
  }
  return { candles, rejected };
}

function issue(
  issues: IntegrityIssue[],
  code: IssueCode,
  at: number,
  detail: string,
  severity: IssueSeverity,
): void {
  issues.push({ code, at, detail, severity });
}

/** Index the session law by Karachi day number. */
function indexSessions(
  sessions: readonly TradingSession[],
  issues: IntegrityIssue[],
): Map<number, readonly SessionBand[]> {
  const byDay = new Map<number, readonly SessionBand[]>();
  for (const session of sessions) {
    const day = dayNumberFromText(session.day);
    if (day === null) {
      issue(issues, "MALFORMED_SESSION", Number.NaN,
        `session day is not YYYY-MM-DD: ${session.day}`, "error");
      continue;
    }
    if (byDay.has(day)) {
      issue(issues, "DUPLICATE_SESSION", day * DAY_MS,
        `two session rows for ${session.day}`, "error");
      continue;
    }
    const bands: SessionBand[] = [];
    let malformed = false;
    for (const band of session.bands) {
      if (!Number.isFinite(band.open) || !Number.isFinite(band.close)
          || band.open < 0 || band.close > 24 * 60
          || band.close <= band.open) {
        malformed = true;
        break;
      }
      bands.push({ open: band.open, close: band.close });
    }
    if (malformed) {
      issue(issues, "MALFORMED_SESSION", day * DAY_MS,
        `${session.day} has a band outside 00:00-24:00 or with close <= open`,
        "error");
      continue;
    }
    bands.sort((left, right) => left.open - right.open);
    for (let i = 1; i < bands.length; i += 1) {
      if ((bands[i]?.open ?? 0) < (bands[i - 1]?.close ?? 0)) {
        malformed = true;
        break;
      }
    }
    if (malformed) {
      issue(issues, "MALFORMED_SESSION", day * DAY_MS,
        `${session.day} has overlapping bands`, "error");
      continue;
    }
    // An empty band list is a real holiday row, not a malformed session.
    byDay.set(day, bands);
  }
  return byDay;
}

/** Time order and one row per stamp. The later duplicate wins, as a store upsert does. */
function orderCandles(
  source: readonly Candle[],
  issues: IntegrityIssue[],
): Candle[] {
  let ascending = true;
  for (let i = 1; i < source.length; i += 1) {
    if ((source[i]?.t ?? 0) < (source[i - 1]?.t ?? 0)) {
      ascending = false;
      break;
    }
  }
  const ordered = ascending
    ? source.slice()
    : [...source].sort((left, right) => left.t - right.t);
  if (!ascending) {
    issue(issues, "UNSORTED", Number.NaN,
      "source candles were not in time order; a sorted copy was used", "warning");
  }
  let duplicate = false;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]?.t === ordered[i - 1]?.t) {
      duplicate = true;
      break;
    }
  }
  if (!duplicate) {
    return ordered;
  }
  const byTime = new Map<number, Candle>();
  for (const candle of ordered) {
    if (byTime.has(candle.t)) {
      issue(issues, "DUPLICATE_TIMESTAMP", candle.t,
        `two source candles share ${new Date(candle.t).toISOString()}; the later one wins`,
        "error");
    }
    byTime.set(candle.t, candle);
  }
  return [...byTime.values()];
}

/** How many source opens the band's grid puts inside this target bucket. */
function expectedSources(
  bandOpenMs: number,
  bandCloseMs: number,
  bucketOpenMs: number,
  targetMs: number,
  sourceMs: number,
): number {
  const from = Math.max(bandOpenMs, bucketOpenMs);
  const to = Math.min(bandCloseMs, bucketOpenMs + targetMs);
  if (to <= from) {
    return 0;
  }
  const steps = Math.ceil((from - bandOpenMs) / sourceMs);
  const first = bandOpenMs + steps * sourceMs;
  if (first >= to) {
    return 0;
  }
  return Math.floor((to - 1 - first) / sourceMs) + 1;
}

interface Bucket {
  readonly open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  count: number;
  readonly expected: number;
}

/**
 * Fold source candles into session-aligned target candles.
 *
 * Data problems (malformed rows, off-grid stamps, holiday prints, duplicates)
 * are returned in `issues`; a malformed row never becomes a price. A bucket
 * with fewer source candles than its band grid expects is still emitted - it
 * is what the tape holds - and flagged `PARTIAL_BUCKET`.
 */
export function aggregateCandles(
  source: readonly Candle[],
  options: AggregateOptions,
): AggregateResult {
  assertOptions(options);
  const offset = options.utcOffsetMs ?? DEFAULT_OFFSET_MS;
  const { sourceMs, targetMs } = options;
  const issues: IntegrityIssue[] = [];
  const byDay = indexSessions(options.sessions, issues);
  const ordered = orderCandles(source, issues);
  const buckets = new Map<number, Bucket>();

  for (const candle of ordered) {
    const problem = candleProblem(candle);
    if (problem !== null) {
      issue(issues, "MALFORMED_CANDLE", candle.t, problem, "error");
      continue;
    }
    const day = dayNumber(candle.t, offset);
    const bands = byDay.get(day);
    if (bands === undefined) {
      issue(issues, "OUT_OF_SESSION", candle.t,
        `${new Date(candle.t).toISOString()} is not a known trading day`, "error");
      continue;
    }
    const minute = Math.floor(((candle.t + offset) % DAY_MS) / MINUTE_MS);
    const band = bands.find((item) => minute >= item.open && minute < item.close);
    if (band === undefined) {
      issue(issues, "OUT_OF_SESSION", candle.t,
        `${new Date(candle.t).toISOString()} is outside every band of ${dayText(day)}`,
        "error");
      continue;
    }
    const dayStart = day * DAY_MS - offset;
    const bandOpen = dayStart + band.open * MINUTE_MS;
    const bandClose = dayStart + band.close * MINUTE_MS;
    const relative = candle.t - bandOpen;
    if (relative % sourceMs !== 0) {
      issue(issues, "OFF_GRID", candle.t,
        `${new Date(candle.t).toISOString()} is not on the ${sourceMs / MINUTE_MS}m grid anchored at ${dayText(day)} ${band.open}`,
        "error");
      continue;
    }
    const bucketOpen = bandOpen + Math.floor(relative / targetMs) * targetMs;
    const expected = expectedSources(bandOpen, bandClose, bucketOpen, targetMs, sourceMs);
    const existing = buckets.get(bucketOpen);
    if (existing === undefined) {
      buckets.set(bucketOpen, {
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        count: 1,
        expected,
      });
      continue;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    // `ordered` is ascending, so the last source candle read is the close.
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.count += 1;
  }

  for (const [bucketOpen, bucket] of buckets) {
    if (bucket.count < bucket.expected) {
      issue(issues, "PARTIAL_BUCKET", bucketOpen,
        `${bucket.count} of ${bucket.expected} source candles present in ` +
        `${new Date(bucketOpen).toISOString()}`,
        "warning");
    }
  }

  const candles = [...buckets.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([t, bucket]): Candle => ({
      t,
      open: bucket.open,
      high: bucket.high,
      low: bucket.low,
      close: bucket.close,
      volume: bucket.volume,
    }));
  return { candles, issues };
}

/**
 * Check a finished series against the session law.
 *
 * The report has two questions. `complete` says every target bucket the bands
 * expect exists. `ok` also requires that no structural error was found:
 * candles outside a band, bucket stamps not anchored to the band open,
 * duplicate stamps, malformed rows or sessions. A missing bucket is a warning
 * because a no-trade hour is an absence, not a corrupted price; it still makes
 * `complete` and `ok` false, which is what a 3-of-6 session must report.
 */
export function validateSessionIntegrity(
  candles: readonly Candle[],
  sessions: readonly TradingSession[],
  targetMs: number,
  options: { readonly utcOffsetMs?: number } = {},
): IntegrityReport {
  assertInterval("targetMs", targetMs);
  const offset = options.utcOffsetMs ?? DEFAULT_OFFSET_MS;
  const issues: IntegrityIssue[] = [];
  const byDay = indexSessions(sessions, issues);

  // Every bucket the bands expect, by Karachi day.
  const expectedByDay = new Map<number, Set<number>>();
  for (const [day, bands] of byDay) {
    const dayStart = day * DAY_MS - offset;
    const expected = new Set<number>();
    for (const band of bands) {
      const bandOpen = dayStart + band.open * MINUTE_MS;
      const bandClose = dayStart + band.close * MINUTE_MS;
      for (let bucket = bandOpen; bucket < bandClose; bucket += targetMs) {
        expected.add(bucket);
      }
    }
    // A holiday row is a real session list entry with no bands. It has no
    // expected buckets and must not appear as a zero-candle session check.
    if (expected.size > 0) {
      expectedByDay.set(day, expected);
    }
  }

  const actual = new Map<number, number>();
  for (const candle of candles) {
    const problem = candleProblem(candle);
    if (problem !== null) {
      issue(issues, "MALFORMED_CANDLE", candle.t, problem, "error");
      continue;
    }
    const day = dayNumber(candle.t, offset);
    const bands = byDay.get(day);
    if (bands === undefined || bands.length === 0) {
      issue(issues, "OUT_OF_SESSION", candle.t,
        `${new Date(candle.t).toISOString()} is not on a trading day`, "error");
      continue;
    }
    const minute = Math.floor(((candle.t + offset) % DAY_MS) / MINUTE_MS);
    const band = bands.find((item) => minute >= item.open && minute < item.close);
    if (band === undefined) {
      issue(issues, "OUT_OF_SESSION", candle.t,
        `${new Date(candle.t).toISOString()} is outside every band of ${dayText(day)}`,
        "error");
      continue;
    }
    const expected = expectedByDay.get(day);
    if (expected === undefined || !expected.has(candle.t)) {
      issue(issues, "MISALIGNED_BUCKET", candle.t,
        `${new Date(candle.t).toISOString()} is not the band-anchored open of a ` +
        `${targetMs / MINUTE_MS}m bucket`, "error");
      continue;
    }
    const seen = actual.get(candle.t) ?? 0;
    if (seen > 0) {
      issue(issues, "DUPLICATE_BUCKET", candle.t,
        `${new Date(candle.t).toISOString()} appears more than once`, "error");
    }
    actual.set(candle.t, seen + 1);
  }

  const checks: SessionCheck[] = [];
  for (const day of [...expectedByDay.keys()].sort((a, b) => a - b)) {
    const expected = [...(expectedByDay.get(day) ?? [])].sort((a, b) => a - b);
    const missing = expected.filter((bucket) => !actual.has(bucket));
    for (const bucket of missing) {
      issue(issues, "MISSING_BUCKET", bucket,
        `no candle for ${new Date(bucket).toISOString()} on ${dayText(day)}`,
        "warning");
    }
    checks.push({
      day: dayText(day),
      expected: expected.length,
      actual: expected.length - missing.length,
      missing,
      complete: missing.length === 0,
    });
  }

  const complete = checks.every((check) => check.complete);
  const structuralError = issues.some((item) => item.severity === "error");
  return { ok: complete && !structuralError, complete, sessions: checks, issues };
}
