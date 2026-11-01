"""The decade index proxy: equal-weight daily returns from the EOD store.

The exchange's daily table has stock rows, not index levels. These tests pin
the two rules the chart depends on: the first banked day sets the level to
1000, and later days compound the selected members' equal-weight returns.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import date
from pathlib import Path

from charts.adapters.tape import eod_index_daily
from charts.eod import EodStore


class EodIndexDailyTest(unittest.TestCase):
    def store(self, root: Path) -> EodStore:
        store = EodStore(root)
        store.save(date(2016, 11, 1), [
            {"symbol": "AAA", "o": 100, "h": 110, "l": 90, "c": 100, "v": 10},
            {"symbol": "BBB", "o": 50, "h": 55, "l": 45, "c": 50, "v": 5},
        ])
        store.save(date(2016, 11, 2), [
            {"symbol": "AAA", "o": 110, "h": 120, "l": 105, "c": 110, "v": 12},
            {"symbol": "BBB", "o": 50, "h": 52, "l": 49, "c": 50, "v": 6},
        ])
        return store

    def test_first_day_sets_the_level_and_the_next_day_compounds(self):
        with tempfile.TemporaryDirectory() as directory:
            store = self.store(Path(directory))
            bars = eod_index_daily(store, "KMIALLSHR")
        self.assertEqual([bar.t[:10] for bar in bars],
                         ["2016-11-01", "2016-11-02"])
        self.assertAlmostEqual(bars[0].c, 1000.0)
        # AAA +10%, BBB flat: the equal-weight close-to-close return is +5%.
        self.assertAlmostEqual(bars[1].c, 1050.0)
        self.assertGreaterEqual(bars[1].h, bars[1].c)
        self.assertLessEqual(bars[1].l, bars[1].c)

    def test_a_new_listing_enters_on_the_day_after_its_first_row(self):
        with tempfile.TemporaryDirectory() as directory:
            store = self.store(Path(directory))
            store.save(date(2016, 11, 3), [
                {"symbol": "AAA", "o": 110, "h": 111, "l": 109, "c": 110, "v": 1},
                {"symbol": "BBB", "o": 50, "h": 50, "l": 50, "c": 50, "v": 1},
                {"symbol": "CCC", "o": 20, "h": 20, "l": 20, "c": 20, "v": 1},
            ])
            bars = eod_index_daily(store, "KMIALLSHR")
        self.assertEqual(len(bars), 3)
        # The third day is flat for AAA and BBB; CCC has no prior close, so it
        # cannot contribute a return on the day it first appears.
        self.assertAlmostEqual(bars[2].c, 1050.0)

    def test_an_unknown_symbol_has_no_series(self):
        with tempfile.TemporaryDirectory() as directory:
            store = self.store(Path(directory))
            self.assertEqual(eod_index_daily(store, "NOT_AN_INDEX"), [])


if __name__ == "__main__":
    unittest.main()
