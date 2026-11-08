"""The tape's pane reads with the pane cache in front of them.

The promise is narrow and measurable: a finished session's delta minutes and
per-day print totals can be answered after a restart without walking the
capture again, and a forming session is never frozen into that cache.
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
from charts.pane_cache import PaneCache
from src.data import tick_volume
from src.data.sessions import KARACHI

MONDAY = datetime(2026, 10, 12, 9, 33, tzinfo=KARACHI)
TUESDAY = datetime(2026, 10, 13, 10, 0, tzinfo=KARACHI)


def frame(at: datetime, volume: int) -> dict:
    return {
        "kind": "MKT-FEED*x",
        "ts": at.isoformat(),
        "ticks": [{
            "scrip": "OGDC:REG",
            "last": "100",
            "volume": str(volume),
            "tick_time": at.strftime("%H:%M:%S"),
        }],
    }


class TapePaneCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-pane-cache-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"
        self.universe = self.tmp / "universe.json"
        self.universe.write_text(json.dumps(["OGDC"]), encoding="utf-8")
        self.pane_path = self.tmp / "panes.sqlite3"
        rows = [
            frame(MONDAY, 1000),
            frame(MONDAY + timedelta(minutes=1), 1100),
            frame(MONDAY + timedelta(minutes=2), 1200),
        ]
        self.capture.write_text(
            "\n".join(json.dumps(row) for row in rows) + "\n",
            encoding="utf-8")

    def source(self, clock: datetime) -> TapeSource:
        return TapeSource(
            clock=lambda: clock, universe_path=self.universe,
            capture_dirs=(self.tmp,), archive_dir=self.tmp / "archive",
            eod_dir=self.tmp / "eod", indices_dir=self.tmp / "indices",
            pane_cache_path=self.pane_path)

    def test_delta_minutes_survive_a_restart_without_refolding(self) -> None:
        first = self.source(TUESDAY).delta_for("OGDC", day=MONDAY.date())
        self.assertTrue(first["minutes"])

        # A second instance stands in for a restarted service: the in-memory
        # fold is gone, only SQLite remains. If the capture is walked at all,
        # the patch fails the test.
        restarted = self.source(TUESDAY)
        with mock.patch(
                "charts.adapters.tape.tick_volume.next_appended",
                side_effect=AssertionError("the capture was re-folded")):
            second = restarted.delta_for("OGDC", day=MONDAY.date())
        self.assertEqual(second["minutes"], first["minutes"])

    def test_print_totals_survive_a_restart_without_refolding(self) -> None:
        first = self.source(TUESDAY)._prints_day("OGDC", MONDAY.date())
        self.assertGreater(first["totals"]["volume"], 0)

        restarted = self.source(TUESDAY)
        with mock.patch(
                "charts.adapters.tape.tick_volume.next_appended",
                side_effect=AssertionError("the capture was re-folded")):
            second = restarted._prints_day("OGDC", MONDAY.date())
        # The cache stores the totals, not the event list: that is the only
        # part the span needs, and the assertion is about the same numbers.
        self.assertEqual(second["totals"], first["totals"])
        self.assertEqual(second["events_total"], first["events_total"])

    def test_todays_forming_session_is_never_cached(self) -> None:
        source = self.source(MONDAY + timedelta(seconds=30))
        self.assertTrue(source.delta_for("OGDC")["minutes"])
        self.assertEqual(PaneCache(self.pane_path).delta_days("OGDC"), [])

    def test_an_appended_capture_is_folded_again(self) -> None:
        first = self.source(TUESDAY).delta_for("OGDC", day=MONDAY.date())
        with self.capture.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(
                frame(MONDAY + timedelta(minutes=3), 1300)) + "\n")

        calls: list[int] = []
        real = tick_volume.next_appended

        def spy(path, offset: int = 0):
            calls.append(offset)
            return real(path, offset)

        with mock.patch("charts.adapters.tape.tick_volume.next_appended",
                        side_effect=spy):
            second = self.source(TUESDAY).delta_for(
                "OGDC", day=MONDAY.date())
        # The appended byte changed the identity, so the cache had to miss and
        # the fold had to run: the opposite of a stale answer.
        self.assertTrue(calls)
        self.assertGreater(len(second["minutes"]), len(first["minutes"]))


if __name__ == "__main__":
    unittest.main()
