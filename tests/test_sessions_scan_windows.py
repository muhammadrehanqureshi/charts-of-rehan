"""The owner's hardcoded scan calendar, at every boundary.

The scanner must be live only in the Monday-Thursday pre-market 09:15-09:30
and in the continuous 09:32-15:49 live/post-market window. The 09:30-09:32
gap is closed. Friday keeps its own exchange bands and is not inferred from
the weekday calendar.
"""

from __future__ import annotations

import unittest
from datetime import date, datetime

from src.data import sessions

MONDAY = date(2026, 10, 12)
FRIDAY = date(2026, 10, 16)
SATURDAY = date(2026, 10, 17)


def at(day: date, hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hour, minute, second,
                    tzinfo=sessions.KARACHI)


class ScanCalendarTest(unittest.TestCase):
    def test_monday_thursday_scan_windows_are_exact(self):
        self.assertEqual(sessions.scan_windows(MONDAY), (
            ((9, 15), (9, 30)),
            ((9, 32), (15, 49)),
        ))
        self.assertEqual(sessions.pre_market_window(MONDAY),
                         ((9, 15), (9, 30)))

    def test_the_pre_market_is_strictly_0915_to_0930(self):
        self.assertFalse(sessions.is_scan_window(at(MONDAY, 9, 14, 59)))
        self.assertTrue(sessions.is_scan_window(at(MONDAY, 9, 15)))
        self.assertEqual(sessions.market_state_at(at(MONDAY, 9, 15)),
                         sessions.MarketState.PRE_MARKET)
        self.assertTrue(sessions.is_scan_window(at(MONDAY, 9, 29, 59)))
        self.assertFalse(sessions.is_scan_window(at(MONDAY, 9, 30)))
        self.assertEqual(sessions.market_state_at(at(MONDAY, 9, 30)),
                         sessions.MarketState.CLOSED)
        self.assertFalse(sessions.is_scan_window(at(MONDAY, 9, 31, 59)))

    def test_the_live_scan_carries_through_the_complete_post_market(self):
        for moment in (
            at(MONDAY, 9, 32),
            at(MONDAY, 15, 30),
            at(MONDAY, 15, 31),
            at(MONDAY, 15, 32),
            at(MONDAY, 15, 48, 59),
        ):
            self.assertTrue(sessions.is_scan_window(moment), moment)
        self.assertEqual(sessions.market_state_at(at(MONDAY, 15, 32)),
                         sessions.MarketState.POST_MARKET)
        self.assertFalse(sessions.is_scan_window(at(MONDAY, 15, 49)))

    def test_friday_keeps_its_own_timing(self):
        self.assertEqual(sessions.pre_market_window(FRIDAY),
                         ((9, 0), (9, 15)))
        self.assertEqual(sessions.scan_windows(FRIDAY),
                         sessions.FRIDAY_BANDS)
        self.assertFalse(sessions.is_scan_window(at(FRIDAY, 9, 0)))
        self.assertFalse(sessions.is_scan_window(at(FRIDAY, 9, 16)))
        self.assertTrue(sessions.is_scan_window(at(FRIDAY, 9, 17)))
        self.assertFalse(sessions.is_scan_window(at(FRIDAY, 12, 0)))
        self.assertFalse(sessions.is_scan_window(at(FRIDAY, 14, 31)))
        self.assertTrue(sessions.is_scan_window(at(FRIDAY, 14, 32)))
        self.assertFalse(sessions.is_scan_window(at(FRIDAY, 16, 30)))
        # Friday's post-market is reported, but its scan timings are separate
        # from the Monday-Thursday order and are not guessed here.
        self.assertEqual(sessions.market_state_at(at(FRIDAY, 16, 32)),
                         sessions.MarketState.POST_MARKET)
        self.assertFalse(sessions.is_scan_window(at(FRIDAY, 16, 32)))

    def test_weekend_is_never_scanned(self):
        self.assertEqual(sessions.scan_windows(SATURDAY), ())
        self.assertFalse(sessions.is_scan_window(at(SATURDAY, 10, 0)))


if __name__ == "__main__":
    unittest.main()