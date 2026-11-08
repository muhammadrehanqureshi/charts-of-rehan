"""The pane cache: per-capture folds for the side panels, bounded and disposable.

The delta pane and the tape box ask the same question every page load: what
did the finished sessions' captures print? Answering it means folding a whole
capture file, about a second per session on the owner's machine, and the
in-memory folds die with the process. The candles already have a durable
cache; these two panel answers need the same treatment.

The key is the capture's own identity (name, size, mtime), never a day alone:
an appended or replaced file is a different capture and must be folded again.
An empty identity is never written and never trusted as fresh, because a
caller that cannot prove which bytes it read cannot prove the answer matches.

This is a cache, not an authority. A miss, a stale identity, a malformed row,
a read failure or a corrupt file all answer None, and the caller folds the
capture exactly as it did before. Retention is a bounded session count per
symbol, enforced on write; losing the file costs one fold, never a price.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: Bumped when the on-disk shape changes in a way a reader must know. A
#: mismatch rebuilds the cache in place: this file is disposable by design.
CACHE_VERSION = 1

#: Beside the candle cache, under the owner's gitignored runtime state.
DEFAULT_CACHE_PATH = ROOT / "data" / "cache" / "panes.sqlite3"

#: Two months of sessions per symbol. Delta rows are a few hundred minutes a
#: day and print totals are one small object, so this stays a few megabytes
#: at most while covering every span the UI can ask for.
DEFAULT_KEEP_SESSIONS = 60

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS delta (
    symbol  TEXT NOT NULL,
    day     TEXT NOT NULL,
    capture TEXT NOT NULL,
    minutes TEXT NOT NULL,
    n       INTEGER NOT NULL,
    PRIMARY KEY (symbol, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS prints (
    symbol      TEXT NOT NULL,
    day         TEXT NOT NULL,
    capture     TEXT NOT NULL,
    totals      TEXT NOT NULL,
    events_total INTEGER NOT NULL,
    PRIMARY KEY (symbol, day)
) WITHOUT ROWID;
"""


class PaneCacheError(RuntimeError):
    """The pane cache could not be read or written.

    Recoverable by the caller: fall back to folding the capture. The caller
    never turns this into a chart failure.
    """


def _day_text(day: date | str) -> str:
    text = day.isoformat() if isinstance(day, date) else str(day).strip()
    try:
        date.fromisoformat(text)
    except ValueError as exc:
        raise PaneCacheError(f"{text!r} is not a YYYY-MM-DD session day") from exc
    return text


def _json(payload: object) -> str:
    return json.dumps(payload, separators=(",", ":"), sort_keys=True)


class PaneCache:
    """A small SQLite store of finished-session folds, keyed by capture.

    Safe to share between threads: one connection, one lock, and each write is
    a single statement. Every read compares the stored identity with the one
    the caller supplies, so a capture that grew is a miss rather than a stale
    answer.
    """

    def __init__(self, path: Path | str = DEFAULT_CACHE_PATH) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None

    # ------------------------------------------------------------ lifecycle
    def __enter__(self) -> "PaneCache":
        self._connection_or_open()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None

    def _open(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            str(self.path), timeout=5.0, isolation_level=None,
            check_same_thread=False)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute("PRAGMA temp_store=MEMORY")
            connection.execute("PRAGMA cache_size=-4000")
            connection.execute("PRAGMA busy_timeout=3000")
            connection.executescript(_SCHEMA)
            row = connection.execute(
                "SELECT value FROM meta WHERE key='version'").fetchone()
            if row is not None and row[0] != str(CACHE_VERSION):
                connection.executescript(
                    "DELETE FROM delta; DELETE FROM prints;")
            connection.execute(
                "INSERT INTO meta (key, value) VALUES ('version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(CACHE_VERSION),))
        except BaseException:
            connection.close()
            raise
        return connection

    def _connection_or_open(self) -> sqlite3.Connection:
        if self._connection is not None:
            return self._connection
        try:
            self._connection = self._open()
        except sqlite3.DatabaseError:
            # A cache that cannot be opened is a cache that can be thrown
            # away: quarantine the bytes for a post-mortem and start clean.
            self._quarantine()
            self._connection = self._open()
        return self._connection

    def _quarantine(self) -> None:
        self.close()
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            if candidate.exists():
                try:
                    candidate.replace(
                        candidate.with_name(candidate.name + ".corrupt"))
                except OSError:
                    candidate.unlink(missing_ok=True)

    # ---------------------------------------------------------------- delta
    def get_delta(self, symbol: str, day: date | str,
                  capture: str) -> list[dict] | None:
        """The cached minute buckets for one finished session, or None."""
        key = symbol.strip().upper()
        if not key or not capture:
            return None
        text = _day_text(day)
        with self._lock:
            connection = self._connection_or_open()
            try:
                row = connection.execute(
                    "SELECT capture, minutes FROM delta "
                    "WHERE symbol=? AND day=?", (key, text)).fetchone()
                if row is None or row[0] != capture:
                    return None
                try:
                    minutes = json.loads(row[1])
                except ValueError:
                    connection.execute(
                        "DELETE FROM delta WHERE symbol=? AND day=?",
                        (key, text))
                    return None
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not read delta for {key} {text}: "
                    f"{exc}") from exc
        return minutes if isinstance(minutes, list) else None

    def put_delta(self, symbol: str, day: date | str, capture: str,
                  minutes: list[dict],
                  keep_sessions: int = DEFAULT_KEEP_SESSIONS) -> int:
        """Store one session's minute buckets; return how many were kept."""
        key = symbol.strip().upper()
        if not key or not capture:
            return 0
        text = _day_text(day)
        rows = list(minutes)
        with self._lock:
            connection = self._connection_or_open()
            try:
                connection.execute(
                    "INSERT INTO delta (symbol, day, capture, minutes, n) "
                    "VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(symbol, day) DO UPDATE SET "
                    "capture = excluded.capture, "
                    "minutes = excluded.minutes, n = excluded.n",
                    (key, text, capture, _json(rows), len(rows)))
                self._trim(connection, "delta", key, keep_sessions)
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not store delta for {key} {text}: "
                    f"{exc}") from exc
        return len(rows)

    # --------------------------------------------------------------- prints
    def get_prints(self, symbol: str, day: date | str,
                   capture: str) -> tuple[dict, int] | None:
        """The cached per-day totals for one finished session, or None."""
        key = symbol.strip().upper()
        if not key or not capture:
            return None
        text = _day_text(day)
        with self._lock:
            connection = self._connection_or_open()
            try:
                row = connection.execute(
                    "SELECT capture, totals, events_total FROM prints "
                    "WHERE symbol=? AND day=?", (key, text)).fetchone()
                if row is None or row[0] != capture:
                    return None
                try:
                    totals = json.loads(row[1])
                except ValueError:
                    connection.execute(
                        "DELETE FROM prints WHERE symbol=? AND day=?",
                        (key, text))
                    return None
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not read prints for {key} {text}: "
                    f"{exc}") from exc
        if not isinstance(totals, dict):
            return None
        return totals, int(row[2])

    def put_prints(self, symbol: str, day: date | str, capture: str,
                   totals: dict, events_total: int,
                   keep_sessions: int = DEFAULT_KEEP_SESSIONS) -> None:
        """Store one session's daily totals (not its events) under its capture."""
        key = symbol.strip().upper()
        if not key or not capture:
            return
        text = _day_text(day)
        with self._lock:
            connection = self._connection_or_open()
            try:
                connection.execute(
                    "INSERT INTO prints "
                    "(symbol, day, capture, totals, events_total) "
                    "VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(symbol, day) DO UPDATE SET "
                    "capture = excluded.capture, "
                    "totals = excluded.totals, "
                    "events_total = excluded.events_total",
                    (key, text, capture, _json(totals), int(events_total)))
                self._trim(connection, "prints", key, keep_sessions)
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not store prints for {key} {text}: "
                    f"{exc}") from exc

    # ---------------------------------------------------------- maintenance
    @staticmethod
    def _trim(connection: sqlite3.Connection, table: str, symbol: str,
              keep: int) -> None:
        """Keep the newest `keep` days for one symbol; whole days only."""
        limit = max(1, int(keep))
        connection.execute(
            f"DELETE FROM {table} WHERE symbol=? AND day NOT IN ("
            f"  SELECT day FROM {table} WHERE symbol=? "
            f"  ORDER BY day DESC LIMIT ?)",
            (symbol, symbol, limit))

    def prune(self, *, keep_sessions: int = DEFAULT_KEEP_SESSIONS) -> int:
        """Apply the retention count to every symbol; return rows removed."""
        with self._lock:
            connection = self._connection_or_open()
            try:
                before = (connection.execute(
                    "SELECT COUNT(*) FROM delta").fetchone()[0]
                    + connection.execute(
                        "SELECT COUNT(*) FROM prints").fetchone()[0])
                for table in ("delta", "prints"):
                    for (symbol,) in connection.execute(
                            f"SELECT DISTINCT symbol FROM {table}").fetchall():
                        self._trim(connection, table, symbol, keep_sessions)
                after = (connection.execute(
                    "SELECT COUNT(*) FROM delta").fetchone()[0]
                    + connection.execute(
                        "SELECT COUNT(*) FROM prints").fetchone()[0])
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not be pruned: {exc}") from exc
        return int(before) - int(after)

    def delta_days(self, symbol: str) -> list[str]:
        """The cached delta days for one symbol, newest first."""
        return self._days("delta", symbol)

    def prints_days(self, symbol: str) -> list[str]:
        """The cached print-total days for one symbol, newest first."""
        return self._days("prints", symbol)

    def _days(self, table: str, symbol: str) -> list[str]:
        key = symbol.strip().upper()
        with self._lock:
            connection = self._connection_or_open()
            try:
                rows = connection.execute(
                    f"SELECT day FROM {table} WHERE symbol=? "
                    f"ORDER BY day DESC", (key,)).fetchall()
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not list {table} for {key}: "
                    f"{exc}") from exc
        return [str(row[0]) for row in rows]

    def size_bytes(self) -> int:
        """The cache's footprint, including its WAL sidecar."""
        total = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            try:
                total += candidate.stat().st_size
            except OSError:
                continue
        return total

    def clear(self) -> None:
        """Forget everything. Captures and the archive are untouched."""
        with self._lock:
            connection = self._connection_or_open()
            try:
                connection.executescript("DELETE FROM delta; DELETE FROM prints;")
            except sqlite3.Error as exc:
                raise PaneCacheError(
                    f"the pane cache could not be cleared: {exc}") from exc
