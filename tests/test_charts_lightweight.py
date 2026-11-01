from __future__ import annotations

import unittest

from charts import app
from charts.ingest import Ingestor
from charts.lightweight import (
    DEFAULT_INGEST_SECONDS,
    EOD_MAINTENANCE_SECONDS,
    MIN_INGEST_SECONDS,
)


class MachineBudgetTest(unittest.TestCase):
    def test_source_polling_defaults_to_fifteen_seconds(self):
        args = app.build_parser().parse_args([])
        self.assertEqual(args.interval, DEFAULT_INGEST_SECONDS)
        self.assertGreaterEqual(DEFAULT_INGEST_SECONDS, 15.0)

    def test_source_polling_cannot_go_below_five_seconds(self):
        ingestor = Ingestor(object(), object(), resolution="1m",
                            interval_seconds=0)
        self.assertEqual(ingestor.interval_seconds, MIN_INGEST_SECONDS)
        self.assertGreaterEqual(MIN_INGEST_SECONDS, 5.0)

    def test_eod_maintenance_is_not_a_hot_loop(self):
        self.assertGreaterEqual(EOD_MAINTENANCE_SECONDS, 15 * 60.0)
