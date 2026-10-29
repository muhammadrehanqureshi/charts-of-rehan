"""The PSX historical-data endpoint: one day of the whole market's EOD rows.

The data portal's per-symbol ``/timeseries/eod`` route is dead (404 with or
without a signed header, measured 2026-10-29), but its own Historical Data
page still answers one request per date with the full market's daily table:
``SYMBOL, LDCP, OPEN, HIGH, LOW, CLOSE, CHANGE, CHANGE (%), VOLUME`` for
every scrip that traded that day. The picker's own UI reaches five years
back, so a year of daily history for every symbol costs one paced POST per
trading day.

Two facts make that honest instead of dangerous:

* The table carries no date of its own. A closed day is answered with an
  *empty* ``tbody`` (verified against a Saturday: HTTP 200, zero rows), so
  an empty answer is stored as "no session", never as the previous day's
  rows. A day that returns rows is stored under the day that was asked for.
* Every call to the portal must carry the ``X-Req-Id`` header the page's own
  JavaScript attaches (``window.__ps._k``); without it the server answers
  404. The key is read off a company page and refreshed when a call stops
  being honoured.

The store is ``data/eod/YYYY-MM-DD.ndjson``, one JSON row per line, sorted
by symbol, written once and never edited: the same shape the session
archive uses, at daily grain. ``data/`` is gitignored - the market data is
the owner's, never the repository's.

Command line::

    python -m charts.eod backfill            # the last 370 days
    python -m charts.eod backfill --from 2025-11-01 --to 2026-10-28
    python -m charts.eod day 2026-10-28      # one day, for a rebuild
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from charts.contract import Bar  # noqa: E402
from src.data import sessions as law  # noqa: E402
from charts.ratelimit import (  # noqa: E402
    CircuitBreaker, Ledger, TokenBucket, UpstreamError, retry_call,
)

COMPANY_URL = "https://dps.psx.com.pk/company/{symbol}"
HISTORICAL_URL = "https://dps.psx.com.pk/historical"

#: The portal pages say data is delayed five minutes unless indicated
#: otherwise; a history table is a finished session, so this delay does not
#: touch it, but the note keeps the source's facts in one place.
HISTORY_DELAY_SECONDS = 300

#: One request every few seconds: a year's backfill is a background job,
#: and the portal's own memo asks for politeness.
BUCKET = TokenBucket(rate_per_second=0.33, burst=1)
BREAKER = CircuitBreaker(fail_threshold=3, reset_after_seconds=90.0)

#: The columns the history table promised on 2026-10-29. A table without
#: them is a shape change, not a quiet mis-parse.
_REQUIRED_COLUMNS = ("symbol", "ldcp", "open", "high", "low", "close", "volume")

_KEY = re.compile(r'window\.__ps\s*=\s*\{[^}]*?"_k":"([^"]+)"')
_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S)
_TAG = re.compile(r"<[^>]+>")


def _number(text: str | None) -> float | None:
    if text is None:
        return None
    cleaned = text.strip().replace(",", "").replace("%", "")
    if not cleaned or cleaned in {"-", "--"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_history_table(html: str) -> list[dict]:
    """Every scrip row of one day's history table, in the page's own order.

    Returns an empty list for a closed day (the server answers the POST with
    an empty ``tbody``, HTTP 200). Rows carry ``symbol``, the OHLC prices,
    ``volume`` and the named-change/percent fields when present; a column
    set that does not contain the required names is refused as a schema
    change rather than parsed by position and mis-banked.
    """
    rows: list[dict] = []
    header: list[str] | None = None
    for match in _ROW.finditer(html):
        cells = [_TAG.sub("", cell).strip()
                 for cell in _CELL.findall(match.group(1))]
        if not cells:
            continue
        lowered = [name.lower().replace(" ", "") for name in cells]
        if header is None:
            names = ([name.lower() for name in lowered])
            missing = [name for name in _REQUIRED_COLUMNS if name not in names]
            if missing:
                # Refused, not row-by-position: no file this store holds is
                # ever a mis-columned day table.
                raise UpstreamError(
                    UpstreamError.SCHEMA_CHANGE,
                    f"the history table lost {', '.join(missing)}")
            header = names
            continue
        row = dict(zip(header, cells))
        symbol = str(row.get("symbol", "")).strip().upper()
        if not symbol:
            continue
        rows.append({
            "symbol": symbol,
            "ldcp": _number(row.get("ldcp")),
            "o": _number(row.get("open")),
            "h": _number(row.get("high")),
            "l": _number(row.get("low")),
            "c": _number(row.get("close")),
            "change": _number(row.get("change")),
            "percent_change": _number(row.get("percentchange")),
            "v": _number(row.get("volume")),
        })
    return rows


def request_key(session=None, *, symbol: str = "OGDC") -> str:
    """Read the page's own request key, without which the portal 404s.

    The company page is fetched live; its ``window.__ps._k`` is the signed
    key the portal's script attaches to every call. A page that carries no
    key is an upstream change, not a retry.
    """
    if session is None:
        import requests

        session = requests.Session()
        session.headers.update({
            "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/124.0 Safari/537.36"),
        })
    response = session.get(COMPANY_URL.format(symbol=symbol), timeout=(5, 20))
    if response.status_code != 200:
        raise UpstreamError(
            UpstreamError.HTTP_ERROR,
            f"the portal company page answered {response.status_code}",
            status=response.status_code)
    found = _KEY.search(response.text)
    if not found:
        raise UpstreamError(
            UpstreamError.SCHEMA_CHANGE,
            "the portal company page carriesno signed request key "
            "(window.__ps._k is gone)")
    return found.group(1)


def fetch_day(day: date, *, session=None, key: str | None = None,
              key_fetcher=None) -> tuple[str | None, list[dict]]:
    """One day's table, with the signed header, using a str key.

    Returns ``(key_used, rows)``; ``rows`` is empty for a closed day. A 404
    is retried exactly once with a freshly read key, because the signed key
    is the one credential that can silently expire.
    """
    if session is None:
        import requests

        session = requests.Session()
        session.headers.update({
            "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/124.0 Safari/537.36"),
        })
    fetch_key = key_fetcher or (lambda: request_key(session))
    if key is None:
        key = fetch_key()

    def call():
        nonlocal key
        wait_day = BUCKET.acquire()
        if wait_day:
            # The caller's own sleep turns a paced call into a polite one.
            import time as _time
            _time.sleep(wait_day)
        # Request key and form body travel together.
        response = session.post(
            HISTORICAL_URL,
            data={"date": day.isoformat()},
            headers={
                "X-Req-Id": key,
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "text/html, */*; q=0.01",
                "Referer": f"{HISTORICAL_URL}",
            },
            timeout=(5, 30))
        if response.status_code == 404:
            # The key may have expired: a fresh page, a fresh key, once.
            new_key = fetch_key()
            response = session.post(
                HISTORICAL_URL,
                data={"date": day.isoformat()},
                headers={
                    "X-Req-Id": new_key,
                    "X-Requested-With": "XMLHttpRequest",
                    "Accept": "text/html, */*; q=0.01",
                    "Referer": f"{HISTORICAL_URL}",
                },
                timeout=(5, 30))
            key = new_key
        if response.status_code >= 400:
            raise UpstreamError(
                UpstreamError.HTTP_ERROR,
                f"{day.isoformat()}: HTTP {response.status_code}",
                status=response.status_code)
        return response

    response = retry_call(
        call, attempts=3, base_delay=1.5, max_delay=12.0,
        breaker=BREAKER,
        on_retry=lambda attempt, exc, delay: None)
    rows = parse_history_table(response.text)
    return key, rows


class EodStore:
    """The per-day daily-grain store: ``data/eod/YYYY-MM-DD.ndjson``."""

    def __init__(self, root: Path | str = ROOT / "data" / "eod") -> None:
        self.root = Path(root)
        #: Banked day reads. A stored day is immutable, so one 
        #: symbol -> row map per day is safe to keep for the process
        #: lifetime, and ~250 trading days is a few megabytes at most.
        self._read_cache: dict[str, dict[str, dict]] = {}

    # ------------------------------------------------------------ addresses
    def day_path(self, day: date | str) -> Path:
        text = day.isoformat() if isinstance(day, date) else str(day)
        return self.root / f"{text}.ndjson"

    # -------------------------------------------------------------- reading
    def days(self) -> list[str]:
        """Every stored day, oldest first."""
        if not self.root.is_dir():
            return []
        found = []
        for entry in self.root.iterdir():
            if entry.is_file() and entry.suffix == ".ndjson" \
                    and len(entry.stem) == 10:
                try:
                    date.fromisoformat(entry.stem)
                except ValueError:
                    continue
                found.append(entry.stem)
        return sorted(found)

    def read(self, day: date | str) -> dict[str, dict]:
        """The day's rows as a symbol -> row map, or {} when never stored."""
        text = day.isoformat() if isinstance(day, date) else str(day)
        found = self._read_cache.get(text)
        if found is not None:
            return found
        path = self.day_path(text)
        rows = self._read_file(path)
        self._read_cache[text] = rows
        return rows

    def _read_file(self, path: Path) -> dict[str, dict]:
        if not path.is_file():
            return {}
        rows: dict[str, dict] = {}
        for number, line in enumerate(path.open("r", encoding="utf-8"), 1):
            text = line.strip()
            if not text:
                continue
            try:
                row = json.loads(text)
            except ValueError as exc:
                raise ValueError(
                    f"{path.name} line {number} is not a stored EOD row: {exc}"
                ) from exc
            symbol = str(row.get("symbol", "")).upper()
            if symbol:
                rows[symbol] = row
        return rows

    def bar(self, day: date, symbol: str) -> Bar | None:
        """The day's own daily bar for one symbol, or None without a row.

        The minute is the day at noon Karachi, a calendar position rather
        than a trading moment: calendar bars group by the Karachi date, so
        noon keeps the bar inside its own day whatever the session clock.
        """
        row = self.read(day).get(symbol.strip().upper())
        if row is None:
            return None
        return eod_bar(day, row)

    # -------------------------------------------------------------- writing
    def save(self, day: date, rows: list[dict]) -> int:
        """Write the day whole, atomically, sorted by symbol."""
        kept = [row for row in rows if row.get("o") is not None
                and row.get("h") is not None and row.get("l") is not None
                and row.get("c") is not None]
        if not kept:
            return 0
        lines = [
            json.dumps({
                "symbol": row["symbol"],
                "o": row.get("o"), "h": row.get("h"),
                "l": row.get("l"), "c": row.get("c"),
                "v": row.get("v"),
            }, separators=(",", ":"))
            for row in sorted(kept, key=lambda row: row["symbol"])
        ]
        path = self.day_path(day)
        path.parent.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(path, "\n".join(lines) + "\n")
        stamp = day.isoformat() if isinstance(day, date) else str(day)
        self._read_cache.pop(stamp, None)
        return len(kept)


def _atomic_write_text(path: Path, text: str) -> None:
    handle, temporary = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def eod_bar(day: date, row: dict) -> Bar:
    """One stored row back into the contract's own Bar, at calendar noon."""
    moment = law._at(day, (12, 0))
    return Bar.build(t=moment.isoformat(timespec="milliseconds"), o=row["o"],
                     h=row["h"], l=row["l"], c=row["c"], v=row.get("v") or 0.0)


def weekday_range(start: date, end: date) -> list[date]:
    """Inclusive calendar range, oldest first, Saturdays removed.

    Pakistan trades Monday-Friday (and, rarely, a shifted session the
    exchange itself announces); a Sunday cannot be skipped in code because a
    shifted session can land on almost any day, so the honest rule is: ask
    the server, keep what it answers, skip empty answers. Saturday is the
    one day the exchange never opens, so it is the one day the loop saves.
    """
    days: list[date] = []
    step = start
    while step <= end:
        if step.weekday() != 5:  # 5 is Saturday.
            days.append(step)
        step = step + timedelta(days=1)
    return days


def backfill(store: EodStore, *, session=None, key: str | None = None,
             key_fetcher=None, first: date, last: date,
             ledger: Ledger | None = None, progress=None) -> dict:
    """Backfill a range of days, newest last, skipping stored days.

    Returns a small summary dict: fetched, skipped-closed, already-stored,
    failed. Each fetched day is banked before the next request, so an
    interrupted run resumes without re-reading anything it got.
    """
    if session is None:
        import requests

        session = requests.Session()
        session.headers.update({
            "user-agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) "
                           "Chrome/124.0 Safari/537.36"),
        })
    ledger = ledger or Ledger()
    stored = 0
    closed = 0
    failed = 0
    already = 0
    key_fetcher = key_fetcher or (lambda: request_key(session))
    for day in weekday_range(first, last):
        if store.read(day):
            already += 1
            continue
        try:
            key, rows = fetch_day(day, session=session, key=key,
                                  key_fetcher=key_fetcher)
            ledger.record_attempt()
        except UpstreamError as exc:
            failed += 1
            if progress:
                progress(f"{day.isoformat()}: {exc}")
            continue
        if not rows:
            closed += 1
            continue
        kept = store.save(day, rows)
        stored += 1
        if progress:
            progress(f"{day.isoformat()}: {kept} scrips")
    return {"stored": stored, "closed": closed, "already": already,
            "failed": failed, "ledger": ledger}


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="charts.eod",
        description="Backfill the PSX historical-data day tables into the "
                    "per-day EOD store.")
    commands = parser.add_subparsers(dest="command", required=True)
    fill = commands.add_parser("backfill", help="a range of days, politely")
    fill.add_argument("--from", dest="first", type=date.fromisoformat,
                      default=None,
                      help="first day (default: 370 days back from last)")
    fill.add_argument("--to", dest="last", type=date.fromisoformat,
                      default=None,
                      help="last day (default: yesterday)")
    fill.add_argument("--root", default=None,
                      help="store root (default: data/eod)")
    day_cmd = commands.add_parser("day", help="one day")
    day_cmd.add_argument("day", type=date.fromisoformat)
    day_cmd.add_argument("--root", default=None)
    args = parser.parse_args()

    store = EodStore(args.root or (ROOT / "data" / "eod"))
    if args.command == "day":
        rows = fetch_day(args.day)[1]
        kept = store.save(args.day, rows)
        print(f"{args.day.isoformat()}: {kept} scrips"
              if kept else f"{args.day.isoformat()}: closed (no rows)")
        return 0

    last = args.last or law.now_karachi().date() - timedelta(days=1)
    first = args.first or last - timedelta(days=370)
    print(f"backfill {first.isoformat()} .. {last.isoformat()} "
          f"into {store.root}")
    summary = backfill(
        store, first=first, last=last,
        progress=lambda line: print(line, flush=True))
    print(f"done: {summary['stored']} days stored, "
          f"{summary['closed']} closed, {summary['already']} already, "
          f"{summary['failed']} failed")
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
