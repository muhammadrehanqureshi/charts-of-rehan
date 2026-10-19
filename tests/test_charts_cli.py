"""The two maintenance commands a 24/7 charting service needs, run as commands.

`python -m charts --sessions` answers "what can I draw right now" and
`python -m charts --build-archive DAY` stores one session for good. Both are
run here through `main(argv)` with a temporary capture directory and a
temporary archive, so the test exercises the real argument parsing, the real
exit codes and the real JSON a shell would read.

What is deliberately checked:

  * `--sessions` names the directories it searched and the sessions it found;
  * `--build-archive` stores a session, is idempotent for an unchanged
    capture, and resolves `today` and `latest`;
  * a failure is an exit code and a sentence on stderr, never a traceback and
    never a success;
  * `--sessions` on a source that keeps no archive is refused in words.

No test starts the listener, registers anything on the machine, or waits for a
schedule: a run happens when a command is typed and finishes when it prints.
"""

from __future__ import annotations

import contextlib
import io
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

from charts import app  # noqa: E402

KARACHI = timezone(timedelta(hours=5), name="Asia/Karachi")
MONDAY = date(2026, 10, 12)
MONDAY_OPEN = datetime(2026, 10, 12, 9, 32, tzinfo=KARACHI)
MONDAY_1100 = datetime(2026, 10, 12, 11, 0, tzinfo=KARACHI)


def tick(symbol: str, price, volume, at: datetime) -> dict:
    return {"scrip": f"{symbol}:REG", "last": str(price), "volume": str(volume),
            "tick_time": f"{at:%H:%M:%S}"}


def frame(at: datetime, *rows: dict) -> dict:
    return {"kind": "MKT-FEED*x", "ts": at.isoformat(), "ticks": list(rows)}


def records(minutes: int = 3) -> list[dict]:
    out: list[dict] = []
    for index in range(minutes):
        moment = MONDAY_OPEN + timedelta(minutes=index + 1)
        out.append(frame(moment + timedelta(seconds=5),
                         tick("OGDC", 100.0 + index, 1000 * (index + 1), moment)))
    return out


class CommandCase(unittest.TestCase):
    """A temporary capture directory, archive and universe, plus a clock."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="charts-cli-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.captures = self.tmp / "captures"
        self.captures.mkdir()
        self.archive_dir = self.tmp / "archive"
        self.capture = self.captures / "capture_20261012.ndjson"
        self.universe = self.tmp / "universe.json"
        self.universe.write_text(json.dumps(["OGDC"]), encoding="utf-8")

    def write_tape(self, lines: list[dict] | None = None,
                   path: Path | None = None) -> Path:
        target = path or self.capture
        target.write_text("\n".join(json.dumps(row) for row in (lines or records()))
                          + "\n", encoding="utf-8")
        return target

    def patched(self):
        """The clock and the capture lookup this command run should see."""
        return (
            mock.patch("charts.app.sessions.law.now_karachi",
                       return_value=MONDAY_1100),
            mock.patch("src.data.tape_bars.capture_path",
                       side_effect=lambda day: (
                           self.capture if day == MONDAY
                           else self.captures / f"capture_{day:%Y%m%d}.ndjson")),
            mock.patch("charts.adapters.tape.UNIVERSE_CANDIDATES",
                       (self.universe,)),
        )

    def run_main(self, *argv: str) -> tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.ExitStack() as stack:
            for patch in self.patched():
                stack.enter_context(patch)
            with contextlib.redirect_stdout(stdout), \
                    contextlib.redirect_stderr(stderr):
                code = app.main(["--tape-dir", str(self.captures),
                                 "--archive-dir", str(self.archive_dir),
                                 *argv])
        return code, stdout.getvalue(), stderr.getvalue()


class SessionsCommandTest(CommandCase):

    def test_it_names_what_it_searched_and_what_it_found(self):
        self.write_tape()
        code, out, _ = self.run_main("--sessions")
        self.assertEqual(code, 0)
        body = json.loads(out)
        self.assertEqual(body["capture_dirs"], [str(self.captures)])
        self.assertEqual(body["archive_dir"], str(self.archive_dir))
        self.assertEqual([row["day"] for row in body["sessions"]],
                         ["2026-10-12"])
        self.assertEqual(body["sessions"][0]["capture"]["name"],
                         "capture_20261012.ndjson")

    def test_it_reports_an_empty_service_honestly(self):
        code, out, _ = self.run_main("--sessions")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["sessions"], [])

    def test_it_lists_an_archived_session_after_the_capture_is_gone(self):
        self.write_tape()
        self.run_main("--build-archive", "2026-10-12")
        self.capture.unlink()
        code, out, _ = self.run_main("--sessions")
        self.assertEqual(code, 0)
        row = json.loads(out)["sessions"][0]
        self.assertEqual(row["day"], "2026-10-12")
        self.assertTrue(row["archived"])

    def test_a_source_without_an_archive_is_refused_in_words(self):
        code, _, err = self.run_main("--source", "replay", "--sessions")
        self.assertEqual(code, 2)
        self.assertIn("belong to the tape source", err)
        self.assertIn("--source is replay", err)


class BuildArchiveCommandTest(CommandCase):

    def test_it_stores_a_session_and_prints_what_it_stored(self):
        self.write_tape()
        code, out, _ = self.run_main("--build-archive", "2026-10-12")
        self.assertEqual(code, 0)
        body = json.loads(out)
        self.assertEqual(body["day"], "2026-10-12")
        self.assertEqual(body["bars"], 3)
        self.assertEqual(body["symbols"], 1)
        self.assertEqual(len(body["capture"]["sha256"]), 64)
        self.assertTrue((self.archive_dir / "2026-10-12" / "manifest.json").is_file())

    def test_an_unchanged_capture_is_not_rebuilt(self):
        self.write_tape()
        self.run_main("--build-archive", "2026-10-12")
        code, out, _ = self.run_main("--build-archive", "2026-10-12")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["builds"], 1)

    def test_a_grown_capture_is_rebuilt_so_the_archive_stays_current(self):
        self.write_tape(records(2))
        self.run_main("--build-archive", "2026-10-12")
        self.write_tape(records(5))
        code, out, _ = self.run_main("--build-archive", "2026-10-12")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["bars"], 5)
        self.assertEqual(json.loads(out)["builds"], 2)

    def test_today_resolves_to_the_clock_day(self):
        self.write_tape()
        code, out, _ = self.run_main("--build-archive", "today")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["day"], "2026-10-12")

    def test_latest_resolves_to_the_newest_session_that_exists(self):
        self.write_tape()
        code, out, _ = self.run_main("--build-archive", "latest")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["day"], "2026-10-12")

    def test_latest_with_nothing_recorded_is_a_named_failure(self):
        code, _, err = self.run_main("--build-archive", "latest")
        self.assertEqual(code, 2)
        self.assertIn("no latest session to store", err)

    def test_a_day_with_no_capture_is_a_sentence_not_a_traceback(self):
        code, out, err = self.run_main("--build-archive", "2026-10-08")
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertIn("cannot archive 2026-10-08", err)
        self.assertIn("no broker tape is banked", err)

    def test_a_nonsense_day_is_refused(self):
        self.write_tape()
        code, _, err = self.run_main("--build-archive", "yesterday")
        self.assertEqual(code, 2)
        self.assertIn("cannot archive yesterday", err)


class EnvironmentTest(CommandCase):

    def test_a_public_bind_still_needs_the_explicit_flag(self):
        parser = app.build_parser()
        args = parser.parse_args(["--host", "0.0.0.0"])
        self.assertIn("--allow-public-bind", app.check_environment(args) or "")
        args = parser.parse_args(["--host", "0.0.0.0", "--allow-public-bind"])
        self.assertIsNone(app.check_environment(args))

    def test_the_tape_dirs_are_exactly_what_was_named(self):
        parser = app.build_parser()
        args = parser.parse_args(["--tape-dir", str(self.tmp),
                                  "--tape-dir", str(self.captures)])
        self.assertEqual(app._tape_dirs(args), (self.tmp, self.captures))

    def test_with_no_flag_the_documented_directories_are_discovered(self):
        parser = app.build_parser()
        found = app._tape_dirs(parser.parse_args([]))
        self.assertIn(ROOT / "data" / "feed_capture", found)
        self.assertIn(ROOT / "data" / "tape", found)

    def test_the_defaults_of_the_day_and_archive_flags(self):
        args = app.build_parser().parse_args([])
        self.assertEqual(args.day, "")
        self.assertEqual(args.archive_dir, "")
        self.assertEqual(args.tape_dir, [])


if __name__ == "__main__":
    unittest.main()
