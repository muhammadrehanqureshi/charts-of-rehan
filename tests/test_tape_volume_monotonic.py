"""Buy, sell, unclear and total can only grow during a session.

The tape is a sequence of running snapshots. Every increase is new volume,
and a backward snapshot is a bad repeat, never a refund. The new shares after
a backward snapshot must be measured from the session high-water mark, or the
four displayed numbers stop reconciling.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

from src.data import tape_bars, tick_volume

DAY = datetime.fromisoformat("2026-10-12T00:00:00+05:00").date()
START = datetime.fromisoformat("2026-10-12T09:15:00+05:00")


def tick(volume: int, price: float, at: datetime) -> dict:
    return {
        "scrip": "OGDC:REG",
        "last": str(price),
        "volume": str(volume),
        "bid": str(price - 0.1),
        "ask": str(price + 0.1),
        "bid_size": "1000",
        "ask_size": "1000",
        "tick_time": f"{at:%H:%M:%S}",
        "capture_ts": at.isoformat(),
    }


def frame(at: datetime, row: dict) -> dict:
    return {"kind": "MKT-FEED*x", "ts": at.isoformat(), "ticks": [row]}


def records() -> list[dict]:
    return [
        frame(START, tick(1000, 100.0, START)),
        frame(START + timedelta(seconds=30),
              tick(1600, 101.0, START + timedelta(seconds=30))),
        # A backward snapshot: it is observed, but it carries no refund.
        frame(START + timedelta(minutes=1),
              tick(1500, 100.5, START + timedelta(minutes=1))),
        # Only 400 shares are new above the 1600 high-water mark, not 500
        # above the immediate 1500 snapshot.
        frame(START + timedelta(minutes=1, seconds=30),
              tick(2000, 102.0, START + timedelta(minutes=1, seconds=30))),
    ]


class MonotonicVolumeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="tape-monotonic-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.capture = self.tmp / "capture_20261012.ndjson"

    def test_batch_flow_uses_the_high_water_mark_and_never_decreases(self):
        self.capture.write_text(
            "\n".join(json.dumps(record) for record in records()) + "\n",
            encoding="utf-8")
        flow = tick_volume.session_flow(self.capture)["OGDC"]
        self.assertEqual(flow.observed_total, 2000)
        self.assertEqual(flow.buy_volume, 1000)
        self.assertEqual(flow.sell_volume, 0)
        self.assertEqual(flow.unclassified_volume, 1000)
        self.assertEqual(flow.total_volume, 2000)
        self.assertEqual(flow.classified_total + flow.unclassified_volume,
                         flow.total_volume)

    def test_every_incremental_prefix_is_monotonic_and_reconciles(self):
        fold = tape_bars.FlowFold(DAY)
        previous = {"buy": 0, "sell": 0, "unclear": 0, "total": 0}
        for record in records():
            rows = tick_volume.parse_tick_line(json.dumps(record))
            fold.feed(rows, START + timedelta(hours=1))
            row = next(item for item in fold.rows()
                       if item["symbol"] == "OGDC")
            values = {
                "buy": row["buy_volume"],
                "sell": row["sell_volume"],
                "unclear": row["unclassified_volume"],
                "total": row["volume"],
            }
            for key in values:
                self.assertGreaterEqual(values[key], previous[key], key)
            self.assertEqual(values["buy"] + values["sell"]
                             + values["unclear"], values["total"])
            previous = values

    def test_prints_and_delta_folds_use_the_same_high_water_mark(self):
        self.capture.write_text(
            "\n".join(json.dumps(record) for record in records()) + "\n",
            encoding="utf-8")
        as_of = START + timedelta(hours=1)
        ledger = tape_bars.prints(self.capture, "OGDC", DAY, as_of, limit=0)
        totals = ledger["totals"]
        self.assertEqual(totals["volume"], 2000)
        self.assertEqual(totals["buy_volume"], 1000)
        self.assertEqual(totals["sell_volume"], 0)
        self.assertEqual(totals["unclassified_volume"], 1000)
        minutes = tape_bars.delta_minutes(self.capture, "OGDC", DAY, as_of)
        self.assertEqual([(row["buy"], row["sell"], row["unclassified"])
                          for row in minutes], [(600, 0, 0), (400, 0, 0)])


if __name__ == "__main__":
    unittest.main()