"""The rolling read window, not just the maintenance prune.

The store can still hold an old file in the minutes before a maintenance
pass. A chart read must already obey the ten-year anniversary rule, so on
2 Nov 2026 the first served row is 2 Nov 2016 even if a 1 Nov 2016 file is
still on disk.
"""

from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from charts.adapters.tape import TapeSource
from charts.eod import EodStore

KARACHI = ZoneInfo("Asia/Karachi")


class RollingReadWindowTest(unittest.TestCase):
    def test_the_first_row_moves_from_one_november_to_two_november(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            eod = EodStore(root / "eod")
            eod.save(date(2016, 11, 1), [
                {"symbol": "AAA", "o": 100, "h": 101, "l": 99,
                 "c": 100, "v": 10},
            ])
            eod.save(date(2016, 11, 2), [
                {"symbol": "AAA", "o": 101, "h": 102, "l": 100,
                 "c": 101, "v": 11},
            ])
            now = [datetime(2026, 11, 1, 12, 0, tzinfo=KARACHI)]
            source = TapeSource(
                clock=lambda: now[0],
                capture_dirs=(),
                archive_dir=root / "archive",
                eod_dir=root / "eod",
                indices_dir=root / "indices",
            )
            before = source.history("AAA", "1D", limit=0)
            self.assertEqual([bar.t[:10] for bar in before],
                             ["2016-11-01", "2016-11-02"])

            now[0] = datetime(2026, 11, 2, 12, 0, tzinfo=KARACHI)
            after = source.history("AAA", "1D", limit=0)
            self.assertEqual([bar.t[:10] for bar in after], ["2016-11-02"])


if __name__ == "__main__":
    unittest.main()
