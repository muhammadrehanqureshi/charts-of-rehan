"""The pane cache's contract: identity, round trips, bounds, recovery."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from charts.pane_cache import PaneCache

DAY = "2026-10-16"


def minutes(count: int = 3) -> list[dict]:
    return [
        {"t": f"2026-10-16T09:{32 + index:02d}:00+05:00",
         "buy": index, "sell": index * 2, "unclassified": 0}
        for index in range(count)
    ]


class PaneCacheTest(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.path = Path(self._directory.name) / "panes.sqlite3"
        self.cache = PaneCache(self.path)
        self.addCleanup(self.cache.close)

    def test_delta_round_trip(self) -> None:
        rows = minutes(3)
        self.assertEqual(
            self.cache.put_delta("ogdc", DAY, "cap-a", rows), 3)
        self.assertEqual(self.cache.get_delta("OGDC", DAY, "cap-a"), rows)

    def test_a_changed_capture_is_a_miss(self) -> None:
        self.cache.put_delta("OGDC", DAY, "cap-a", minutes(2))
        self.assertIsNone(self.cache.get_delta("OGDC", DAY, "cap-b"))

    def test_an_empty_identity_is_never_trusted(self) -> None:
        self.assertEqual(
            self.cache.put_delta("OGDC", DAY, "", minutes(2)), 0)
        self.assertIsNone(self.cache.get_delta("OGDC", DAY, ""))
        self.assertEqual(self.cache.delta_days("OGDC"), [])

    def test_print_totals_round_trip(self) -> None:
        totals = {"orders": 2, "volume": 1100.0, "prints": 2}
        self.cache.put_prints("OGDC", DAY, "cap-a", totals, 2)
        self.assertEqual(
            self.cache.get_prints("OGDC", DAY, "cap-a"), (totals, 2))
        self.assertIsNone(self.cache.get_prints("OGDC", DAY, "cap-b"))

    def test_retention_keeps_the_newest_sessions(self) -> None:
        for index in range(4):
            day = f"2026-10-{12 + index:02d}"
            self.cache.put_delta("OGDC", day, f"cap-{index}", minutes(1),
                                 keep_sessions=2)
            self.cache.put_prints("OGDC", day, f"cap-{index}",
                                  {"volume": 1.0}, 0, keep_sessions=2)
        self.assertEqual(self.cache.delta_days("OGDC"),
                         ["2026-10-15", "2026-10-14"])
        self.assertEqual(self.cache.prints_days("OGDC"),
                         ["2026-10-15", "2026-10-14"])

    def test_a_corrupt_file_is_quarantined_not_fatal(self) -> None:
        path = Path(self._directory.name) / "corrupt.sqlite3"
        path.write_bytes(b"not a database" * 200)
        cache = PaneCache(path)
        try:
            self.assertIsNone(cache.get_delta("OGDC", DAY, "cap-a"))
            self.assertEqual(
                cache.put_delta("OGDC", DAY, "cap-a", minutes(2)), 2)
        finally:
            cache.close()

    def test_clear_forgets_every_panel(self) -> None:
        self.cache.put_delta("OGDC", DAY, "cap-a", minutes(2))
        self.cache.put_prints("OGDC", DAY, "cap-a", {"volume": 1.0}, 0)
        self.assertGreater(self.cache.size_bytes(), 0)
        self.cache.clear()
        self.assertEqual(self.cache.delta_days("OGDC"), [])
        self.assertEqual(self.cache.prints_days("OGDC"), [])


if __name__ == "__main__":
    unittest.main()
