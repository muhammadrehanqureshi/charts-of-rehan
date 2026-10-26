"""The session's order flow: every scrip's buy/sell split and per-minute delta.

These are the numbers a watchlist column and a volume-delta pane draw, so the
tests pin the classification: a rising print's shares belong to the buyer, a
falling one's to the seller, a flat one is unclassified rather than guessed,
and the split is measured from the venue's own running counter.
"""

from __future__ import annotations

import http.client
import json
import shutil
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from charts.adapters.tape import TapeSource  # noqa: E402
from charts.http import ChartServer  # noqa: E402
from charts.ingest import Ingestor  # noqa: E402
from charts.store import BarStore  # noqa: E402
from src.data import tape_bars  # noqa: E402

MONDAY = datetime.fromisoformat("2026-10-12T09:33:00+05:00")
DAY = MONDAY.date()


def tick(symbol: str, price: float, volume: int, at: datetime,
         bid: str | None = None, bid_size: str | None = None,
         ask: str | None = None, ask_size: str | None = None) -> dict:
    row = {
        "scrip": f"{symbol}:REG",
        "last": str(price),
        "volume": str(volume),
        "tick_time": f"{at:%H:%M:%S}",
    }
    if bid is not None:
        row["bid"] = bid
        row["bid_size"] = bid_size or "0"
        row["ask"] = ask or ""
        row["ask_size"] = ask_size or "0"
    return row


def frame(at: datetime, *rows: dict) -> dict:
    return {"kind": "MKT-FEED*x", "ts": at.isoformat(), "ticks": list(rows)}


def sample_records() -> list[dict]:
    return [
        frame(MONDAY, tick("OGDC", 100.0, 1000, MONDAY,
                           bid="99.9", bid_size="5000",
                           ask="100.1", ask_size="7000")),
        frame(MONDAY + timedelta(seconds=30),
              tick("OGDC", 101.0, 1600, MONDAY + timedelta(seconds=30),
                   bid="100.9", bid_size="6100",
                   ask="101.1", ask_size="8200")),
        frame(MONDAY + timedelta(minutes=1),
              tick("OGDC", 100.5, 1900, MONDAY + timedelta(minutes=1))),
        # A flat print carries no evidence of a side: the print and its own
        # quote hold still, so the split stays unclassified.
        frame(MONDAY, tick("PPL", 50.0, 500, MONDAY,
                           bid="49.9", bid_size="1200",
                           ask="50.1", ask_size="900")),
        frame(MONDAY + timedelta(seconds=30),
              tick("PPL", 50.0, 700, MONDAY + timedelta(seconds=30),
                   bid="49.9", bid_size="2500",
                   ask="50.1", ask_size="1500")),
    ]


class FlowCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-flow-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"
        self.capture.write_text(
            "\n".join(json.dumps(record) for record in sample_records()) + "\n",
            encoding="utf-8")
        self.universe = self.tmp / "universe.json"
        self.universe.write_text(json.dumps(["OGDC", "PPL"]), encoding="utf-8")

    def source(self) -> TapeSource:
        clock = lambda: MONDAY + timedelta(minutes=5)  # noqa: E731
        return TapeSource(clock=clock, universe_path=self.universe,
                          capture_dirs=(self.tmp,),
                          archive_dir=self.tmp / "archive")

    def test_every_symbol_gets_its_own_split_in_one_pass(self):
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=self.capture):
            rows = {row["symbol"]: row
                    for row in self.source().flow_for(DAY)}
        self.assertEqual(set(rows), {"OGDC", "PPL"})
        o = rows["OGDC"]
        self.assertEqual((o["buy_volume"], o["sell_volume"]), (600, 300))
        self.assertEqual(o["delta"], 300)
        self.assertEqual(o["classified_volume"], 900)
        self.assertEqual(o["volume"], 1900)
        self.assertEqual(o["orders"], 0)  # the fixture never sent a counter
        # A flat print is not a buyer and not a seller.
        p = rows["PPL"]
        self.assertEqual((p["buy_volume"], p["sell_volume"]), (0, 0))
        self.assertEqual(p["unclassified_volume"], 700)
        self.assertEqual(p["delta"], 0)

    def test_per_minute_delta_credits_the_minute_the_window_landed_in(self):
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=self.capture):
            minutes = tape_bars.delta_minutes(self.capture, "OGDC", DAY,
                                              MONDAY + timedelta(minutes=5))
        self.assertEqual(len(minutes), 2)
        first, second = minutes
        self.assertEqual((first["buy"], first["sell"]), (600, 0))
        self.assertEqual((second["buy"], second["sell"]), (0, 300))

    def test_a_session_with_no_capture_answers_empty_with_a_reason(self):
        empty = self.tmp / "empty"
        empty.mkdir()
        source = TapeSource(clock=lambda: MONDAY + timedelta(minutes=5),
                            universe_path=self.universe,
                            capture_dirs=(empty,),
                            archive_dir=self.tmp / "archive")
        report = source.delta_for("OGDC", DAY)
        self.assertEqual(report["minutes"], [])
        self.assertIn("no broker tape", report["note"])


class FlowHttpCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-flow-http-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"
        self.capture.write_text(
            "\n".join(json.dumps(record) for record in sample_records()) + "\n",
            encoding="utf-8")
        universe = self.tmp / "universe.json"
        universe.write_text(json.dumps(["OGDC", "PPL"]), encoding="utf-8")
        self.clock = lambda: MONDAY + timedelta(minutes=5)  # noqa: E731
        source = TapeSource(clock=self.clock, universe_path=universe,
                            capture_dirs=(self.tmp,),
                            archive_dir=self.tmp / "archive")
        store = BarStore()
        ingestor = Ingestor(store, source, resolution="1m",
                            interval_seconds=5.0)
        for symbol in ("OGDC", "PPL"):
            store.register_symbol(symbol, source=source.name)
        self.patch = mock.patch(
            "charts.adapters.tape.tape_bars.capture_path",
            return_value=self.capture)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.server = ChartServer(("127.0.0.1", 0), store=store,
                                  ingestor=ingestor, source=source,
                                  static_dir=None, clock=self.clock)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        self.server.shutdown()
        self.server.shutdown_sources()
        self.server.server_close()

    def get(self, path: str) -> dict:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=5)
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return {"status": response.status, "body": json.loads(body)}

    def test_the_orderflow_route_reports_every_symbol(self):
        answer = self.get("/api/orderflow?day=2026-10-12")
        self.assertEqual(answer["status"], 200)
        rows = {row["symbol"]: row for row in answer["body"]["symbols"]}
        self.assertEqual(set(rows), {"OGDC", "PPL"})
        self.assertEqual(rows["OGDC"]["buy_volume"], 600)
        self.assertEqual(answer["body"]["timezone"], "Asia/Karachi")

    def test_the_delta_route_reports_the_minutes_for_one_symbol(self):
        answer = self.get("/api/delta?symbol=OGDC&day=2026-10-12")
        self.assertEqual(answer["status"], 200)
        minutes = answer["body"]["minutes"]
        self.assertEqual(len(minutes), 2)
        self.assertEqual(minutes[0]["buy"], 600)
        self.assertEqual(minutes[1]["sell"], 300)

    def test_the_delta_route_still_names_a_missing_symbol(self):
        answer = self.get("/api/delta?day=2026-10-12")
        self.assertEqual(answer["status"], 400)
        self.assertEqual(answer["body"]["error"]["code"], "MISSING_SYMBOL")


class BookCase(unittest.TestCase):
    """The venue's own top of book, served from the bars' own day build."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-book-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"
        self.capture.write_text(
            "\n".join(json.dumps(record) for record in sample_records()) + "\n",
            encoding="utf-8")
        self.universe = self.tmp / "universe.json"
        self.universe.write_text(json.dumps(["OGDC", "PPL"]), encoding="utf-8")

    def source(self) -> TapeSource:
        return TapeSource(clock=lambda: MONDAY + timedelta(minutes=5),
                          universe_path=self.universe,
                          capture_dirs=(self.tmp,),
                          archive_dir=self.tmp / "archive")

    def test_the_last_observed_book_wins(self):
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=self.capture):
            book = self.source().book_for("OGDC", DAY)
        self.assertEqual(book["bid"], 100.9)
        self.assertEqual(book["bid_size"], 6100)
        self.assertEqual(book["ask"], 101.1)
        self.assertEqual(book["ask_size"], 8200)
        self.assertNotEqual(book["at"], "")
        # A past session's book is its final observation, and it says so.
        self.assertIn("stored session", book["note"])

    def test_a_row_without_a_quote_leaves_the_last_book_standing(self):
        # The 09:34 frame carried no bid or ask; the 09:33 book is the answer.
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=self.capture):
            flow = self.source()
            self.assertEqual(flow.book_for("OGDC", DAY)["bid"], 100.9)

    def test_a_symbol_the_book_never_saw_answers_with_a_reason(self):
        with mock.patch("charts.adapters.tape.tape_bars.capture_path",
                        return_value=self.capture):
            book = self.source().book_for("ENGRO", DAY)
        self.assertEqual(book["bid"], None)
        self.assertIn("not been observed", book["note"])

    def test_an_index_answers_that_it_has_no_book(self):
        book = self.source().book_for("KSE100", DAY)
        self.assertIn("index", book["note"])


class BookHttpCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-book-http-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"
        self.capture.write_text(
            "\n".join(json.dumps(record) for record in sample_records()) + "\n",
            encoding="utf-8")
        universe = self.tmp / "universe.json"
        universe.write_text(json.dumps(["OGDC", "PPL"]), encoding="utf-8")
        clock = lambda: MONDAY + timedelta(minutes=5)  # noqa: E731
        source = TapeSource(clock=clock, universe_path=universe,
                            capture_dirs=(self.tmp,),
                            archive_dir=self.tmp / "archive")
        store = BarStore()
        ingestor = Ingestor(store, source, resolution="1m",
                            interval_seconds=5.0)
        for symbol in ("OGDC", "PPL"):
            store.register_symbol(symbol, source=source.name)
        self.patch = mock.patch(
            "charts.adapters.tape.tape_bars.capture_path",
            return_value=self.capture)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.server = ChartServer(("127.0.0.1", 0), store=store,
                                  ingestor=ingestor, source=source,
                                  static_dir=None, clock=clock)
        self.thread = threading.Thread(
            target=self.server.serve_forever,
            kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self._stop)

    def _stop(self) -> None:
        self.server.shutdown()
        self.server.shutdown_sources()
        self.server.server_close()

    def get(self, path: str) -> dict:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.server.server_address[1], timeout=5)
        connection.request("GET", path)
        response = connection.getresponse()
        body = response.read()
        connection.close()
        return {"status": response.status, "body": json.loads(body)}

    def test_the_book_route_serves_the_taped_quote(self):
        answer = self.get("/api/book?symbol=OGDC&day=2026-10-12")
        self.assertEqual(answer["status"], 200)
        self.assertEqual(answer["body"]["bid"], 100.9)
        self.assertEqual(answer["body"]["ask_size"], 8200)


if __name__ == "__main__":
    unittest.main()
