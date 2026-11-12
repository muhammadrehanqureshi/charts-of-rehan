"""The explicit flat no-trade fill, held to the session's own bucket grid.

The fill is a fallback, not a data source. These tests pin the facts that
keep it honest:

  * it fills only expected buckets between the first and last real bar, so a
    recording that starts at 15:09 cannot invent five flat morning hours;
  * every generated bar is marked ``synthetic=True``, has a zero range and
    zero volume, and the real bars are returned untouched;
  * a session with no real bar cannot be filled, because there is no price to
    carry forward.
"""

from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from charts import service  # noqa: E402
from charts.contract import Bar, ContractError  # noqa: E402
from charts.resolutions import expected_bucket_starts  # noqa: E402


def real_bar(bucket, close: float = 100.0) -> Bar:
    return Bar.build(t=bucket, o=close - 1, h=close + 1, l=close - 2,
                     c=close, v=25)


class FlatFillTest(unittest.TestCase):

    def assert_grid(self, day: date, resolution: str, count: int) -> None:
        expected = expected_bucket_starts(day, resolution)
        self.assertEqual(len(expected), count)
        # One real opening bar, then a partial later bar: every other bucket
        # is a gap the fill must make visible rather than leave absent.
        bars = [real_bar(expected[0], 101.0),
                real_bar(expected[-1], 103.0)]
        filled, added = service.fill_flat_bars(bars, expected, resolution)
        self.assertEqual(len(filled), count)
        self.assertEqual(added, count - 2)
        self.assertEqual([bar.t for bar in filled],
                         [bucket.isoformat(timespec="seconds")
                          for bucket in expected])
        self.assertEqual(sum(bar.synthetic for bar in filled), count - 2)
        self.assertEqual(filled[0].c, 101.0)
        self.assertTrue(filled[0].synthetic is False)
        self.assertEqual(filled[-1].c, 103.0)
        for bar in filled[1:-1]:
            self.assertTrue(bar.synthetic)
            self.assertEqual((bar.o, bar.h, bar.l, bar.c), (101.0,) * 4)
            self.assertEqual(bar.v, 0.0)

    def test_monday_to_thursday_has_the_six_twelve_twenty_four_grid(self):
        monday = date(2026, 10, 26)
        self.assert_grid(monday, "1h", 6)
        self.assert_grid(monday, "30m", 12)
        self.assert_grid(monday, "15m", 24)

    def test_friday_has_its_own_five_ten_nineteen_grid(self):
        friday = date(2026, 10, 30)
        self.assert_grid(friday, "1h", 5)
        self.assert_grid(friday, "30m", 10)
        self.assert_grid(friday, "15m", 19)

    def test_a_session_with_no_real_bar_is_not_invented(self):
        expected = expected_bucket_starts(date(2026, 10, 26), "1h")
        filled, added = service.fill_flat_bars([], expected, "1h")
        self.assertEqual(filled, [])
        self.assertEqual(added, 0)

    def test_a_late_recording_does_not_invent_the_morning(self):
        # 10 Nov's capture starts at 15:09; only its last hourly bucket exists.
        # The old fill laid five flat hours at 77.7 before it, hiding the real
        # 85.00 -> 77.26 session.
        expected = expected_bucket_starts(date(2026, 11, 10), "1h")
        bars = [real_bar(expected[-1], 77.44)]
        filled, added = service.fill_flat_bars(bars, expected, "1h")
        self.assertEqual([bar.t for bar in filled],
                         [expected[-1].isoformat(timespec="seconds")])
        self.assertEqual(added, 0)

    def test_an_early_stop_does_not_invent_the_afternoon(self):
        # 30 Oct's capture ends at 12:38, before Friday's second band. The
        # first three buckets are recorded; 14:32 and 15:32 are not.
        expected = expected_bucket_starts(date(2026, 10, 30), "1h")
        bars = [real_bar(expected[0], 101.0), real_bar(expected[2], 98.46)]
        filled, added = service.fill_flat_bars(bars, expected, "1h")
        self.assertEqual([bar.t for bar in filled],
                         [bucket.isoformat(timespec="seconds")
                          for bucket in expected[:3]])
        self.assertEqual(added, 1)

    def test_the_note_names_the_mode_the_volume_and_the_marker(self):
        note = service._fill_note(3, "1h")
        self.assertIn("fill=flat", note)
        self.assertIn("zero volume", note)
        self.assertIn("synthetic=true", note)
        self.assertEqual(service.normalise_fill(" FLAT "), "flat")
        self.assertEqual(service.normalise_fill(""), "")

    def test_an_unknown_mode_is_refused(self):
        with self.assertRaises(ContractError):
            service.normalise_fill("nearest")


if __name__ == "__main__":
    unittest.main()
