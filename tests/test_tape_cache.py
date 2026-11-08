"""The tape's read path with the candle cache in front of it.

These tests are about one promise: a finished session's rung can be answered
without re-walking its capture. Everything else the adapter does - building a
day, archiving it, serving today live - must be unchanged, so the assertions
below deliberately check both the cache hit and the freshness rules that stop
the cache from ever serving a forming candle.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from charts.adapters.tape import TapeSource
from charts.candle_cache import CandleCache
from src.data.sessions import KARACHI

MONDAY = datetime(2026, 10, 12, 9, 33, tzinfo=KARACHI)
TUESDAY = datetime(2026, 10, 13, 10, 0, tzinfo=KARACHI)


def frame(at: datetime, symbol: str, price: float, volume: int) -> dict:
    return {
        "kind": "MKT-FEED*x",
        "ts": at.isoformat(),
        "ticks": [{
            "scrip": f"{symbol}:REG",
            "last": str(price),
            "volume": str(volume),
            "tick_time": at.strftime("%H:%M:%S"),
        }],
    }


class TapeCacheTest(unittest.TestCase):
    """A finished capture, read twice, with the second read answered locally."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-tape-cache-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"
        self.universe = self.tmp / "universe.json"
        self.universe.write_text(json.dumps(["OGDC"]), encoding="utf-8")
        self.cache_path = self.tmp / "candles.sqlite3"
        self.write_minutes(1)

    def write_prints(self, *prints: tuple[int, float, int]) -> None:
        """Write ticks inside the 09:33 minute: (second, price, volume)."""
        rows = [
            frame(MONDAY + timedelta(seconds=second), "OGDC", price, volume)
            for second, price, volume in prints
        ]
        self.capture.write_text(
            "\n".join(json.dumps(row) for row in rows) + "\n",
            encoding="utf-8")

    def write_minutes(self, count: int) -> None:
        """One print per minute, so `count` minute bars come out of a fold."""
        rows = []
        volume = 1000
        for index in range(count):
            moment = MONDAY + timedelta(minutes=index)
            volume += 100
            rows.append(frame(moment, "OGDC", 100.0 + index, volume))
        self.capture.write_text(
            "\n".join(json.dumps(row) for row in rows) + "\n",
            encoding="utf-8")

    def source(self, clock: datetime) -> TapeSource:
        return TapeSource(clock=lambda: clock, universe_path=self.universe,
                          capture_dirs=(self.tmp,),
                          archive_dir=self.tmp / "archive",
                          eod_dir=self.tmp / "eod",
                          indices_dir=self.tmp / "indices",
                          cache_path=self.cache_path)

    def read(self, source: TapeSource, resolution: str = "1m",
             limit: int = 0, day=None):
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=self.capture):
            return source.history("OGDC", resolution, limit=limit, day=day)

    def test_a_finished_session_is_answered_without_rereading_the_ndjson(self):
        first = self.read(self.source(TUESDAY), day=MONDAY.date())
        self.assertEqual(len(first), 1)

        # A second instance stands in for a restarted service: every
        # in-memory memo is gone, only the SQLite cache remains. If the
        # archive's bar file is read at all, this test fails - which is the
        # whole claim, that the read never walks the captured bars again.
        restarted = self.source(TUESDAY)
        with mock.patch("charts.adapters.tape.SessionArchive.read",
                        side_effect=AssertionError("the capture was re-walked")):
            second = self.read(restarted, day=MONDAY.date())
        self.assertEqual([bar.t for bar in second], [bar.t for bar in first])
        self.assertEqual([bar.c for bar in second], [bar.c for bar in first])

    def test_a_limited_read_takes_the_newest_bars_from_the_cache(self):
        self.write_minutes(4)
        full = self.read(self.source(TUESDAY), day=MONDAY.date())
        tail = self.read(self.source(TUESDAY), limit=2, day=MONDAY.date())
        self.assertEqual(len(full), 4)
        self.assertEqual([bar.t for bar in tail], [bar.t for bar in full[-2:]])

    def test_todays_forming_session_is_never_cached(self):
        clock = MONDAY + timedelta(seconds=30)
        source = self.source(clock)
        self.write_prints((5, 100.0, 1000))
        self.assertEqual(len(self.read(source)), 1)

        # The minute is still forming: a second print revises it. A cached
        # forming session would freeze the close at the first print.
        self.write_prints((5, 100.0, 1000), (20, 105.0, 2400))
        bars = self.read(source)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[-1].c, 105.0)
        coverage = CandleCache(self.cache_path).coverage("OGDC", "1m")
        self.assertEqual(coverage.sessions, 0)

    def test_a_changed_capture_replaces_the_cached_session(self):
        # No archive, so the identity is the capture's own (size, mtime): the
        # same rule the in-memory day cache has always used.
        with mock.patch.object(TapeSource, "_archive_session_best_effort",
                               return_value=None):
            first = self.read(self.source(TUESDAY), day=MONDAY.date())
            self.write_minutes(3)
            second = self.read(self.source(TUESDAY), day=MONDAY.date())
        self.assertLess(len(first), len(second))
        coverage = CandleCache(self.cache_path).coverage("OGDC", "1m")
        self.assertEqual(coverage.bars, len(second))

    def test_without_a_cache_path_the_adapter_writes_nothing(self):
        source = TapeSource(clock=lambda: TUESDAY,
                            universe_path=self.universe,
                            capture_dirs=(self.tmp,),
                            archive_dir=self.tmp / "archive",
                            eod_dir=self.tmp / "eod",
                            indices_dir=self.tmp / "indices")
        self.assertGreater(
            len(self.read(source, day=MONDAY.date())), 0)
        self.assertFalse(self.cache_path.exists())


if __name__ == "__main__":  # pragma: no cover - runnable on its own
    unittest.main()
