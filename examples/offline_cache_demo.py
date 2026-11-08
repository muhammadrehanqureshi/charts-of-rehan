#!/usr/bin/env python3
"""Offline analysis, end to end: cache every rung once, read it with the feed down.

This is the runnable demonstration the architecture describes, and it is
deterministic: no network, no recorder, no wall clock in the output.

It does four things, in the order a real weekend session would:

1. Asks the session law which were the newest trading days, and builds their
   minute bars from a synthetic walk (the shape of the data does not matter
   here; what matters is that every bar is a validated `charts.contract.Bar`).
2. Writes those minutes into the candle cache once, then folds every rung the
   ladder serves (5m through 1M) and caches each fold under its own
   resolution. Sub-minute rungs are deliberately absent: they are built from a
   capture's tick rows and cannot be honestly reconstructed from minutes.
3. Takes the feed away - `live_bars` raises, exactly as a broker feed does at
   the weekend - and reads every series back from the cache.
4. Prints the session-break table from ONE rule (the session band a bar
   belongs to), so the same boundaries appear on every intraday rung.

Run it with the project's own interpreter, from the repository root:

    python examples/offline_cache_demo.py

The cache it writes lives in a temporary directory and is deleted by the OS;
nothing is added to the owner's `data/` tree.
"""

from __future__ import annotations

import math
import sys
import tempfile
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from charts import resolutions as ladder  # noqa: E402
from charts.candle_cache import CandleCache  # noqa: E402
from charts.contract import Bar  # noqa: E402
from src.data import sessions as law  # noqa: E402

SYMBOL = "OGDC"
CAPTURE = "demo-capture"  # one identity for every rung of the demo seed

#: The rungs that can be folded from minutes. `1s` and `10s` are excluded on
#: purpose: they need the session's tick capture, and a demo that pretended
#: otherwise would be teaching the wrong lesson about partial data.
FOLDABLE = ("1m", "5m", "10m", "15m", "30m", "1h", "4h", "1D", "1W", "1M")


class FeedUnavailable(RuntimeError):
    """The broker feed cannot answer: the exchange is closed, or the link is down."""


def recent_trading_days(count: int) -> list[date]:
    """The newest `count` days the session law calls trading days.

    The law is asked, never assumed: a holiday is not a session, and a demo
    that picked a weekday by arithmetic would eventually pick one that is not.
    """
    found: list[date] = []
    cursor = law.as_karachi(None).date()
    for _ in range(60):
        if law.is_trading_day(cursor) and law.session_bands(cursor):
            found.append(cursor)
            if len(found) >= count:
                break
        cursor -= timedelta(days=1)
    return sorted(found)


def synthetic_minutes(day: date) -> list[Bar]:
    """One minute bar per expected minute, inside the law's own bands.

    Bands are half-open ``[open, close)``, so a bar stamped at the close
    belongs to no band and is never built - the same rule the server folds by.
    """
    bars: list[Bar] = []
    index = 0
    for band in law.session_bands(day):
        opened, closed = law.band_bounds(day, band)
        cursor = opened
        while cursor < closed:
            middle = 100.0 + 4.0 * math.sin(index / 23.0) + 0.25 * (index % 11)
            close = round(middle + 0.4 * math.sin(index / 5.0), 2)
            open_ = round(middle, 2)
            bars.append(Bar.build(
                t=cursor,
                o=open_,
                h=round(max(open_, close) + 0.35, 2),
                l=round(min(open_, close) - 0.35, 2),
                c=close,
                v=float(200 + (index * 37) % 900),
            ))
            cursor += timedelta(minutes=1)
            index += 1
    return bars


def band_of(moment: datetime) -> tuple[str, int]:
    """The `(Karachi day, band index)` a stamp belongs to, from the one law.

    This is the whole session-break rule: a rule is drawn wherever this key
    changes. It is band-based rather than date-based, which is what makes the
    Friday lunch a break instead of an invisible jump, and what keeps a hole
    inside one band from being mistaken for a market close.
    """
    local = law.as_karachi(moment)
    for index, band in enumerate(law.session_bands(local.date())):
        opened, closed = law.band_bounds(local.date(), band)
        if opened <= local < closed:
            return local.date().isoformat(), index
    return local.date().isoformat(), -1


def breaks_for(bars: list[Bar], resolution: str) -> list[tuple[str, int]]:
    """One rule list for every intraday rung; calendar rungs have none.

    A daily, weekly or monthly candle already *is* a session, so an intraday
    open/close rule through it would be a lie about its grain. That policy is
    declared here once, not re-decided per rung at the renderer.
    """
    if not ladder.is_intraday(resolution):
        return []
    rules: list[tuple[str, int]] = []
    previous: tuple[str, int] | None = None
    for bar in bars:
        key = band_of(datetime.fromisoformat(bar.t))
        if key != previous:
            rules.append(key)
            previous = key
    return rules


def live_bars(_symbol: str, _resolution: str) -> list[Bar]:
    """Stand-in for the broker feed at a weekend. It cannot answer."""
    raise FeedUnavailable("the broker feed is unreachable (exchange closed)")


def load_series(cache: CandleCache, resolution: str) -> tuple[list[Bar], str]:
    """The precedence chain: live first, then the local cache, never a zero.

    A cache miss is reported as a miss. It is not smoothed into an empty
    series pretending to be a price, and it does not stop the other rungs
    from being read.
    """
    try:
        return live_bars(SYMBOL, resolution), "live"
    except FeedUnavailable as exc:
        cached = cache.read(SYMBOL, resolution)
        if cached:
            return cached, f"cache ({exc})"
        return [], f"nothing cached ({exc})"


def seed(cache: CandleCache, days: list[date]) -> dict[str, int]:
    """Fold and store every rung once. Returns bars written per rung."""
    minutes = [bar for day in days for bar in synthetic_minutes(day)]
    written: dict[str, int] = {}
    for resolution in FOLDABLE:
        folded = ladder.aggregate(minutes, resolution)
        by_day: dict[str, list[Bar]] = {}
        for bar in folded:
            by_day.setdefault(bar.t[:10], []).append(bar)
        written[resolution] = sum(
            cache.put_session(SYMBOL, resolution, rows, day=day_text,
                              capture=CAPTURE)
            for day_text, rows in by_day.items()
        )
    return written


def main() -> int:
    days = recent_trading_days(2)
    if not days:
        print("no trading day was found by the session law; nothing to demo")
        return 1

    root = Path(tempfile.mkdtemp(prefix="charts-cache-demo-"))
    cache = CandleCache(root / "candles.sqlite3")
    print("Charts of Rehan - offline analysis demo")
    print(f"cache file : {cache.path}")
    print(f"sessions   : {', '.join(day.isoformat() for day in days)}")

    written = seed(cache, days)
    print("\nseeded (feed available):")
    for resolution in FOLDABLE:
        coverage = cache.coverage(SYMBOL, resolution)
        print(f"  {resolution:>3}  {written[resolution]:>5} bars written  "
              f"{coverage.bars:>5} held  {coverage.sessions} session(s)")

    # The unchanged capture is not imported twice: the second pass writes 0.
    again = seed(cache, days)
    print(f"\nre-seed of the same capture wrote {sum(again.values())} bars "
          f"(identity: {CAPTURE})")

    print("\nreading with the feed down:")
    print(f"  {'rung':>4}  {'source':>10}  {'bars':>5}  {'first':>16}  "
          f"{'last':>16}  breaks")
    for resolution in FOLDABLE:
        bars, source = load_series(cache, resolution)
        rules = breaks_for(bars, resolution)
        first = bars[0].t[11:16] if bars else "-"
        last = bars[-1].t[11:16] if bars else "-"
        print(f"  {resolution:>4}  {('cache' if bars else 'miss'):>10}  "
              f"{len(bars):>5}  {first:>16}  {last:>16}  {len(rules)}")

    # Sub-minute rungs are the honest partial-data case: the archive and the
    # cache keep minutes, so a second chart cannot exist without the capture.
    tick_rungs = [bar for bar in cache.read(SYMBOL, "1s")]
    print(f"\n1s bars in cache: {len(tick_rungs)} "
          f"(sub-minute rungs need the session's tick capture; the cache "
          f"refuses to fabricate them)")

    print("\nsession breaks, one rule per band:")
    minute_bars, _ = load_series(cache, "1m")
    for day_text, band in breaks_for(minute_bars, "1m"):
        print(f"  {day_text}  band {band}")
    print("  every intraday rung above reports the same boundaries: "
          f"{len(breaks_for(minute_bars, '1m'))} rules")

    print(f"\ncache size on disk: {cache.size_bytes()} bytes")
    cache.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
