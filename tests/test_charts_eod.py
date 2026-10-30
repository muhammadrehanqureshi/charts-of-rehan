"""The PSX historical-day store, and what the calendar rungs owe to it."""

from __future__ import annotations

import gzip
import json
import shutil
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from charts.adapters.tape import TapeSource  # noqa: E402
from charts.eod import (  # noqa: E402
    EodStore, backfill, eod_bar, fetch_day, import_csv,
    parse_history_table, weekday_range,
)
from charts.ratelimit import UpstreamError  # noqa: E402

KARACHI = timezone(timedelta(hours=5), name="Asia/Karachi")
MONDAY = date(2026, 10, 12)
TUESDAY = date(2026, 10, 13)
FRIDAY = date(2026, 10, 16)
MONDAY_1100 = datetime(2026, 10, 12, 11, 0, tzinfo=KARACHI)


def her_table(*rows: list[str]) -> str:
    """A history table exactly as the page builds it, header row included."""
    head = ("<thead><tr>"
            "<th>SYMBOL</th><th>LDCP</th><th>OPEN</th><th>HIGH</th>"
            "<th>LOW</th><th>CLOSE</th><th>CHANGE</th><th>CHANGE (%)</th>"
            "<th>VOLUME</th></tr></thead>")
    body = "<tbody>" + "".join(
        "<tr>" + "".join(f"<td>{cell}</td>" for cell in row) + "</tr>"
        for row in rows) + "</tbody>"
    return f"<table>{head}{body}</table>"


OGDC_ROW = ["OGDC", "212.50", "213.00", "215.00", "211.00", "214.00",
            "1.50", "0.71%", "1,234,567"]
PRL_ROW = ["PRL", "93.20", "93.00", "94.10", "92.50", "93.65",
           "0.45", "0.48%", "886,812"]


class ImportCsvTest(unittest.TestCase):
    """Folding a dataset of day rows into the per-day store."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.store = EodStore(self.tmp)

    def test_a_dataset_week_is_stored_day_whole(self):
        file = Path(self.tmp) / "week.csv"
        file.write_text(
            "date,symbol,open,high,low,close,volume\n"
            "2026-01-05,OGDC,213.00,215.00,211.00,214.00,1234567\n"
            "2026-01-05,PRL,93.00,94.10,92.50,93.65,886812\n"
            "2026-01-06,OGDC,214.00,216.00,213.00,215.50,2345678\n",
            encoding="utf-8")
        summary = import_csv(self.store, file)
        self.assertEqual(summary["groups"], 2)
        self.assertEqual(summary["stored"], 2)
        read = self.store.read(date(2026, 1, 5))
        self.assertEqual(len(read), 2)
        self.assertEqual(read["OGDC"], {"symbol": "OGDC", "o": 213.0,
            "h": 215.0, "l": 211.0, "c": 214.0, "v": 1234567.0})

    def test_a_day_the_exchange_already_answered_is_left_alone(self):
        file = Path(self.tmp) / "week.csv"
        file.write_text(
            "date,symbol,open,high,low,close,volume\n"
            "2026-01-07,OGDC,214.00,216.00,213.00,215.50,1\n",
            encoding="utf-8")
        summary = import_csv(self.store, file)
        self.assertEqual(summary["skipped"], 0)
        # The same file again: one day, now already stored.
        summary = import_csv(self.store, file)
        self.assertEqual(summary["skipped"], 1)
        self.assertEqual(summary["stored"], 0)

    def test_a_crowded_dataset_file_is_read_decoded(self):
        start = date(2020, 3, 1)
        rows = ["date,symbol,open,high,low,close,volume"]
        for index in range(119):
            day = (start + timedelta(days=index)).isoformat()
            rows.append(f"{day},X,1,2,0.5,1.5,10")
        file = Path(self.tmp) / "big.csv.gz"
        with gzip.open(file, "wt", encoding="utf-8") as stream:
            stream.write("\n".join(rows) + "\n")
        summary = import_csv(self.store, file)
        self.assertEqual(summary["stored"], 119)


class ParseTest(unittest.TestCase):

    def test_a_closed_day_is_an_empty_recipe_not_yesterdays_rows(self):
        # A Saturday answers HTTP 200 with an empty tbody (measured, 2026).
        self.assertEqual(parse_history_table("<table><tbody></tbody></table>"),
                         [])

    def test_rows_carry_the_tablenes_own_meaning(self):
        rows = parse_history_table(her_table(OGDC_ROW, PRL_ROW))
        self.assertEqual([row["symbol"] for row in rows], ["OGDC", "PRL"])
        self.assertEqual(rows[0]["o"], 213.0)
        self.assertEqual(rows[0]["h"], 215.0)
        self.assertEqual(rows[0]["l"], 211.0)
        self.assertEqual(rows[0]["c"], 214.0)
        self.assertEqual(rows[0]["v"], 1234567.0)
        self.assertEqual(rows[1]["v"], 886812.0)

    def test_a_table_without_its_columns_is_a_schema_change(self):
        # The header row is clean: a table that arrives without it (its rows
        # are data) is refused rather than parsed by position.
        with self.assertRaises(UpstreamError) as caught:
            parse_history_table(
                "<table><tbody>"
                "<tr><td>OGDC</td><td>212.50</td><td>213.00</td></tr>"
                "</tbody></table>")
        self.assertEqual(caught.exception.category, UpstreamError.SCHEMA_CHANGE)


class StoreTest(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-eod-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.store = EodStore(self.tmp / "eod")

    def test_a_saved_day_reads_back_whole(self):
        rows = parse_history_table(her_table(OGDC_ROW, PRL_ROW))
        self.assertEqual(self.store.save(TUESDAY, rows), 2)
        self.assertEqual(self.store.days(), [TUESDAY.isoformat()])
        read = self.store.read(TUESDAY)
        self.assertEqual(read["OGDC"]["c"], 214.0)

    def test_a_bar_sits_at_calendar_noon_karachi(self):
        rows = parse_history_table(her_table(OGDC_ROW))
        self.store.save(TUESDAY, rows)
        bar = self.store.bar(TUESDAY, "ogdc")
        self.assertIsNotNone(bar)
        self.assertEqual(bar.t, "2026-10-13T12:00:00+05:00")
        self.assertEqual((bar.o, bar.h, bar.l, bar.c), (213.0, 215.0, 211.0,
                                                        214.0))
        self.assertEqual(bar.v, 1234567.0)

    def test_an_unknown_symbol_and_an_unknown_day_are_none(self):
        self.assertIsNone(self.store.bar(TUESDAY, "OGDC"))
        rows = parse_history_table(her_table(OGDC_ROW))
        self.store.save(TUESDAY, rows)
        self.assertIsNone(self.store.bar(TUESDAY, "WYETH"))

    def test_rows_without_the_price_columns_are_not_stored(self):
        kept = [{"symbol": "OGDC", "o": None, "h": 1.0, "l": 1.0,
                 "c": 1.0, "v": 0.0},
                {"symbol": "PRL", "o": 1.0, "h": 2.0, "l": 0.5,
                 "c": 1.5, "v": 0.0}]
        self.assertEqual(self.store.save(TUESDAY, kept), 1)
        self.assertEqual(list(self.store.read(TUESDAY)), ["PRL"])

    def test_a_second_save_overwrites_atomically(self):
        rows = parse_history_table(her_table(OGDC_ROW))
        self.store.save(TUESDAY, rows)
        rows2 = parse_history_table(her_table(PRL_ROW, OGDC_ROW))
        self.store.save(TUESDAY, rows2)
        self.assertEqual(list(self.store.read(TUESDAY)), ["OGDC", "PRL"])


class WeekdayRangeTest(unittest.TestCase):

    def test_saturdays_are_refused_everything_else_is_asked(self):
        first = date(2026, 10, 10)  # a Saturday
        last = date(2026, 10, 17)   # the next Saturday
        wanted = [date(2026, 10, 11), MONDAY, TUESDAY, date(2026, 10, 14),
                  date(2026, 10, 15), FRIDAY]
        self.assertEqual(weekday_range(first, last), wanted)


class FakeResponse:
    def __init__(self, status: int, text: str) -> None:
        self.status_code = status
        self.text = text


class FatSession:
    """POST per date, GET per symbol page: the two calls the facade needs."""

    def __init__(self, days: dict[date, str]) -> None:
        self.days = days
        self.posted: list[date] = []
        self.headers: dict[str, str] = {}
        self.got: list[str] = []

    def get(self, url: str, timeout=None):
        self.got.append(url)
        return FakeResponse(200, '<script>window.__ps={"_k":"key-1"};</script>')

    def post(self, url: str, data=None, headers=None, timeout=None):
        day = date.fromisoformat(data["date"])
        self.posted.append(day)
        assert headers["X-Req-Id"] == "key-1", headers
        return FakeResponse(200, self.days.get(day, "<table><tbody></tbody>"
                                               "</table>"))


class FetchTest(unittest.TestCase):

    def test_the_signed_header_travels_and_a_closed_day_is_empty(self):
        session = FatSession(
            {TUESDAY: her_table(OGDC_ROW), FRIDAY: "<table><tbody></tbody>"
                                                   "</table>"})
        key, rows = fetch_day(TUESDAY, session=session)
        self.assertEqual(key, "key-1")
        self.assertEqual([row["symbol"] for row in rows], ["OGDC"])
        saturday = date(2026, 10, 17)
        for day in (saturday,):
            _, rows = fetch_day(day, session=session)
            self.assertEqual(rows, [], "Saturday is closed: no rows")
        self.assertIn(saturday, session.posted)

    def test_a_schema_change_is_named_not_swallowed(self):
        session = FatSession({TUESDAY: "<table><tbody></tbody></table>"})
        # A server that lost its header row is upstream change, not silence.
        session.days[TUESDAY] = "<table><tr><td>garbage</td></tr></table>"
        with self.assertRaises(UpstreamError) as caught:
            fetch_day(TUESDAY, session=session)
        self.assertEqual(caught.exception.category,
                         UpstreamError.SCHEMA_CHANGE)


class BackfillTest(unittest.TestCase):

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-fill-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.store = EodStore(self.tmp / "eod")

    def test_a_range_fills_and_skips_what_it_banked(self):
        session = FakeFill({
            TUESDAY: her_table(OGDC_ROW, PRL_ROW),
            FRIDAY: "<table><tbody></tbody></table>",
        })
        summary = backfill(self.store, session=session,
                           first=MONDAY, last=FRIDAY)
        # Monday closed, Tuesday saved, Wednesday Thursday Friday... the
        # fake only graded Tuesday and Friday; the others closed.
        self.assertEqual(summary["stored"], 1)
        self.assertGreaterEqual(summary["closed"], 2)
        self.assertEqual(self.store.days(), [TUESDAY.isoformat()])
        # A second run: the banked day is skipped, the real days (the fake)
        # still answer nothing new to store.
        summary2 = backfill(self.store, session=session,
                            first=MONDAY, last=FRIDAY)
        self.assertEqual(summary2["stored"], 0)
        self.assertEqual(len(session.posted), session.total_days - 0)


class FakeFill(FatSession):

    def __init__(self, days: dict[date, str]) -> None:
        super().__init__(days)
        self.total_days = 0

    def post(self, url: str, data=None, headers=None, timeout=None):
        self.total_days += 1
        return super().post(url, data=data, headers=headers,
                            timeout=timeout)


class TapeFallback(unittest.TestCase):
    """When a calendar rung has no tape for a day, the store answers."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-tape-eod-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.store = EodStore(self.tmp / "eod")
        rows = parse_history_table(her_table(OGDC_ROW))
        self.store.save(TUESDAY, rows)

    def source(self) -> TapeSource:
        return TapeSource(clock=lambda: MONDAY_1100,
                          universe_path=self.tmp / "universe.json",
                          capture_dirs=(self.tmp,),
                          archive_dir=self.tmp / "archive",
                          eod_dir=self.tmp / "eod")

    def test_a_banked_day_answers_on_the_daily_rung(self):
        # Tuesday has no capture and no archive: the exchange table's own
        # close is the bar.
        bars = self.source().history("OGDC", "1D", day=TUESDAY)
        self.assertEqual(len(bars), 1)
        self.assertEqual(bars[0].c, 214.0)
        self.assertEqual(bars[0].v, 1234567.0)

    def test_the_default_daily_series_reaches_back_into_the_year(self):
        universe = self.tmp / "universe.json"
        universe.write_text(json.dumps(["OGDC"]), encoding="utf-8")
        capture = self.tmp / "capture_20261012.ndjson"
        # Monday's capture is on disk; Tuesday is banked history; the clock
        # says Thursday.
        frame = {"kind": "MKT-FEED*x",
                 "ts": "2026-10-12T09:33:05+05:00",
                 "ticks": [{"scrip": "OGDC:REG", "last": "105.0",
                            "volume": "1000", "tick_time": "09:33:05",
                            "high": "106.0", "low": "104.0"}]}
        capture.write_text(json.dumps(frame) + "\n", encoding="utf-8")
        clock = datetime(2026, 10, 15, 11, 0, tzinfo=KARACHI)
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=capture):
            source = TapeSource(clock=lambda: clock,
                                universe_path=universe,
                                capture_dirs=(self.tmp,),
                                archive_dir=self.tmp / "archive",
                                eod_dir=self.tmp / "eod")
            bars = source.history("OGDC", "1D", limit=0)
        # The capture's own Monday minute is folded into a daily bar, and
        # Tuesday's banked row is a second one: the year's depth is no
        # longer bounded by how many nights the recorder happened to run.
        self.assertEqual(len(bars), 2)
        sessions = [bar.t[:10] for bar in bars]
        self.assertEqual(sessions, ["2026-10-12", "2026-10-13"])


if __name__ == "__main__":
    unittest.main()
