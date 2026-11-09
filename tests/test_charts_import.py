"""The caller-supplied one-minute import path."""

from __future__ import annotations

import sys
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from charts.archive import SessionArchive  # noqa: E402
from charts.import_intraday import import_file  # noqa: E402
from charts.resolutions import expected_minutes_for  # noqa: E402

DAY = date(2026, 10, 12)


class ImportTest(unittest.TestCase):

    def test_a_one_minute_export_is_archived_for_the_session(self):
        minutes = expected_minutes_for(DAY)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prl.csv"
            path.write_text(
                "time,open,high,low,close,volume\n"
                f"{minutes[0].isoformat()},100,101,99,100.5,10\n"
                f"{minutes[1].isoformat()},100.5,102,100,101,20\n",
                encoding="utf-8")
            result = import_file(path, symbol="PRL",
                                 archive_dir=Path(directory) / "archive")
            self.assertEqual(result, {"days": 1, "bars": 2})
            archive = SessionArchive(Path(directory) / "archive")
            bars = archive.read(DAY, "PRL")
            self.assertEqual([bar.c for bar in bars], [100.5, 101.0])
            self.assertEqual([bar.v for bar in bars], [10.0, 20.0])
            self.assertIsNotNone(archive.manifest(DAY))
            self.assertTrue(archive.summary(DAY).notes)

    def test_an_off_grid_row_is_refused_before_anything_is_written(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prl.csv"
            path.write_text(
                "time,open,high,low,close,volume\n"
                "2026-10-12T09:31:00+05:00,100,101,99,100,1\n",
                encoding="utf-8")
            with self.assertRaises(ValueError):
                import_file(path, symbol="PRL",
                            archive_dir=Path(directory) / "archive")
            self.assertEqual(
                SessionArchive(Path(directory) / "archive").days(), [])

    def test_a_naive_timestamp_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "prl.csv"
            path.write_text(
                "time,open,high,low,close,volume\n"
                "2026-10-12T09:32:00,100,101,99,100,1\n",
                encoding="utf-8")
            with self.assertRaises(ValueError):
                import_file(path, symbol="PRL",
                            archive_dir=Path(directory) / "archive")

    def test_import_keeps_another_symbol_already_on_the_day(self):
        from charts.contract import Bar

        with tempfile.TemporaryDirectory() as directory:
            archive = SessionArchive(Path(directory) / "archive")
            first = Bar.build(t=expected_minutes_for(DAY)[0],
                              o=50, h=51, l=49, c=50, v=5)
            archive.write_import(DAY, "OGDC", [first])
            path = Path(directory) / "prl.csv"
            path.write_text(
                "time,open,high,low,close,volume\n"
                f"{expected_minutes_for(DAY)[0].isoformat()},"
                "100,101,99,100,10\n",
                encoding="utf-8")
            import_file(path, symbol="PRL", archive_dir=archive.root)
            self.assertEqual([bar.c for bar in archive.read(DAY, "OGDC")],
                             [50.0])
            self.assertEqual([bar.c for bar in archive.read(DAY, "PRL")],
                             [100.0])


if __name__ == "__main__":
    unittest.main()
