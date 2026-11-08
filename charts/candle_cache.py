"""The persistent candle cache: every rung on disk, cheap to read.

The durable archive (`charts/archive.py`) answers one question well: what did
a finished session's tape print, minute by minute. It deliberately stores one
grain. Everything coarser than a minute is folded again on every request, and
everything finer than a minute exists only while that session's capture file
is still on disk. That is honest, and it is also the reason a weekend research
pass pays for the same folds over and over.

This module is the second, disposable layer: a keyed store of *whatever rungs
were actually built*, so a chart opened for the fifth time at midnight reads
rows out of an index instead of re-walking a capture. Three rules shape it.

* **The cache is never the authority.** It stores only bars that some other
  module already produced and validated (`charts.contract.Bar`), and a read
  that finds nothing answers nothing. An empty cache is a cache miss, never a
  zero price, and never an excuse to invent a candle.
* **A session is identified, not re-read.** Each `(symbol, resolution, day)`
  row carries the identity of the capture it was built from, exactly the way
  the archive's manifest does, so re-running an import for an unchanged
  capture writes nothing at all. That is the machine-budget rule in code: do
  not re-walk a whole capture per request.
* **It is bounded and it can be thrown away.** Retention is a per-series
  session count, enforcement happens on write, and a corrupt database file is
  quarantined rather than allowed to break a chart. Losing this file costs a
  rebuild; it never costs data, because the archive and the captures remain.

Storage is SQLite from the standard library: one file, no daemon, indexed
range reads, and a transaction that either commits a whole session or none of
it. Timestamps keep the exchange's own Karachi stamp as text, beside an epoch
millisecond key for indexed ordering, so nothing is re-derived on the way in
or out (SO-8).
"""

from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Iterable

from charts import resolutions as ladder
from charts.contract import Bar, ContractError

ROOT = Path(__file__).resolve().parents[1]

#: Bumped when the on-disk shape changes in a way a reader must know. A
#: mismatch rebuilds the cache in place: this file is disposable by design.
CACHE_VERSION = 1

#: Where the cache lives by default. ``data/`` is gitignored: it is the
#: owner's runtime state, never the repository's.
DEFAULT_CACHE_PATH = ROOT / "data" / "cache" / "candles.sqlite3"

#: One year of sessions per series by default. Enough for a chart's history,
#: bounded enough that a decade-long import cannot grow without limit.
DEFAULT_KEEP_SESSIONS = 260

_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS sessions (
    symbol      TEXT NOT NULL,
    resolution  TEXT NOT NULL,
    day         TEXT NOT NULL,
    capture     TEXT NOT NULL DEFAULT '',
    bars        INTEGER NOT NULL,
    ingested_at TEXT NOT NULL,
    PRIMARY KEY (symbol, resolution, day)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS bars (
    symbol     TEXT NOT NULL,
    resolution TEXT NOT NULL,
    t          TEXT NOT NULL,
    t_ms       INTEGER NOT NULL,
    day        TEXT NOT NULL,
    o          REAL NOT NULL,
    h          REAL NOT NULL,
    l          REAL NOT NULL,
    c          REAL NOT NULL,
    v          REAL NOT NULL,
    PRIMARY KEY (symbol, resolution, t_ms)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS bars_by_day
    ON bars(symbol, resolution, day);
"""

_INSERT_BAR = """
INSERT INTO bars (symbol, resolution, t, t_ms, day, o, h, l, c, v)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(symbol, resolution, t_ms) DO UPDATE SET
    t = excluded.t, day = excluded.day,
    o = excluded.o, h = excluded.h, l = excluded.l,
    c = excluded.c, v = excluded.v
"""

_INSERT_SESSION = """
INSERT INTO sessions (symbol, resolution, day, capture, bars, ingested_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(symbol, resolution, day) DO UPDATE SET
    capture = excluded.capture,
    bars = excluded.bars,
    ingested_at = excluded.ingested_at
"""


class CacheError(RuntimeError):
    """The cache could not be read or written.

    Distinct from `ContractError`, which means the caller handed over
    something that is not a bar. A cache failure is recoverable by the caller
    (fall back to the source, or rebuild); a contract failure is a bug.
    """


@dataclass(frozen=True)
class CacheCoverage:
    """What the cache holds for one series, as a caller can state it."""

    symbol: str
    resolution: str
    sessions: int
    bars: int
    first: str | None
    last: str | None
    bytes_on_disk: int

    def as_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "resolution": self.resolution,
            "sessions": self.sessions,
            "bars": self.bars,
            "first": self.first,
            "last": self.last,
            "bytes_on_disk": self.bytes_on_disk,
        }


def _epoch_ms(stamp: str) -> int:
    """An ISO stamp with an offset as epoch milliseconds."""
    return int(datetime.fromisoformat(stamp).timestamp() * 1000)


def _now_text() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class CandleCache:
    """A bounded, indexed store of built candles, keyed by symbol and rung.

    Safe to share between threads: one connection, one lock, and a whole
    session written inside one transaction. Every public method validates its
    arguments before touching the file, so a bad call fails with a sentence
    rather than a half-written session.
    """

    def __init__(self, path: Path | str = DEFAULT_CACHE_PATH) -> None:
        self.path = Path(path)
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None

    # ------------------------------------------------------------ lifecycle
    def __enter__(self) -> "CandleCache":
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
        """Open (or create) the database, with the pragmas a cache wants.

        WAL keeps a read from blocking the write that is importing a session.
        The cache size is small on purpose: this file is an index beside the
        archive, not a second copy of the market in RAM.
        """
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            str(self.path), timeout=5.0, isolation_level=None,
            check_same_thread=False)
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA synchronous=NORMAL")
            connection.execute("PRAGMA temp_store=MEMORY")
            connection.execute("PRAGMA cache_size=-8000")
            connection.execute("PRAGMA busy_timeout=3000")
            connection.executescript(_SCHEMA)
            row = connection.execute(
                "SELECT value FROM meta WHERE key='version'").fetchone()
            if row is not None and row[0] != str(CACHE_VERSION):
                # A cache from another schema is not migrated; it is replaced.
                connection.executescript(
                    "DELETE FROM bars; DELETE FROM sessions;")
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
            # A cache that cannot be opened is a cache that can be discarded.
            # Quarantine the bytes (so a post-mortem is possible) and start
            # clean rather than refusing to draw a chart.
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

    # -------------------------------------------------------------- writing
    def put_session(
        self,
        symbol: str,
        resolution: str,
        bars: Iterable[Bar],
        *,
        day: date | str,
        capture: str = "",
        keep_sessions: int = DEFAULT_KEEP_SESSIONS,
    ) -> int:
        """Store one session's bars for one rung; return how many were written.

        ``capture`` is the identity of the file the bars were built from. When
        it matches what this session already holds, nothing is written and 0
        is returned: an unchanged capture is never re-imported. Passing an
        empty capture means "identity unknown", which always rewrites, because
        a caller that cannot prove freshness must not be trusted as fresh.

        Bars must belong to ``day``. A bar stamped with another Karachi date
        is refused instead of filed under the wrong session: a misfiled candle
        is worse than a missing one, because nothing downstream can tell.
        """
        key = symbol.strip().upper()
        if not key:
            raise ContractError("a symbol cannot be empty")
        rung = ladder.normalise(resolution)
        day_text = day.isoformat() if isinstance(day, date) else str(day).strip()
        try:
            date.fromisoformat(day_text)
        except ValueError as exc:
            raise ContractError(
                f"day must be a YYYY-MM-DD session date, not {day_text!r}"
            ) from exc

        # Last value wins for a repeated stamp, matching the store's upsert
        # semantics: the minute still forming is revised, never duplicated.
        rows: dict[int, Bar] = {}
        for bar in bars:
            if not isinstance(bar, Bar):
                raise ContractError(
                    f"the cache stores contract bars, not {type(bar).__name__}")
            if not bar.t.startswith(day_text):
                raise ContractError(
                    f"a bar stamped {bar.t} does not belong to session {day_text}")
            rows[_epoch_ms(bar.t)] = bar
        if not rows:
            # An empty session is an absence. Writing a zero-row session row
            # would make "nothing was traded" and "nothing was cached" look
            # the same, which is exactly the distinction this project keeps.
            return 0
        ordered = [rows[moment] for moment in sorted(rows)]

        with self._lock:
            connection = self._connection_or_open()
            try:
                if self._is_current(connection, key, rung, day_text, capture,
                                    len(ordered)):
                    return 0
                connection.execute("BEGIN IMMEDIATE")
                try:
                    connection.executemany(_INSERT_BAR, [
                        (key, rung, bar.t, _epoch_ms(bar.t), day_text,
                         bar.o, bar.h, bar.l, bar.c, bar.v)
                        for bar in ordered
                    ])
                    connection.execute(
                        _INSERT_SESSION,
                        (key, rung, day_text, capture, len(ordered),
                         _now_text()))
                    self._trim(connection, key, rung, keep_sessions)
                    connection.execute("COMMIT")
                except BaseException:
                    connection.execute("ROLLBACK")
                    raise
            except sqlite3.Error as exc:
                raise CacheError(
                    f"the cache could not store {key} {rung} {day_text}: {exc}"
                ) from exc
        return len(ordered)

    @staticmethod
    def _is_current(connection: sqlite3.Connection, symbol: str,
                    resolution: str, day: str, capture: str,
                    bars: int) -> bool:
        """Is this exact capture already stored for this session?"""
        if not capture:
            return False
        row = connection.execute(
            "SELECT capture, bars FROM sessions "
            "WHERE symbol=? AND resolution=? AND day=?",
            (symbol, resolution, day)).fetchone()
        return row is not None and row[0] == capture and int(row[1]) == bars

    @staticmethod
    def _trim(connection: sqlite3.Connection, symbol: str, resolution: str,
              keep: int) -> None:
        """Drop whole sessions beyond the retention count, oldest first.

        Whole sessions, never individual bars: half a session on disk would
        make a chart look like a partial tape, and pruning is a storage
        decision, not a market event.
        """
        limit = max(1, int(keep))
        row = connection.execute(
            "SELECT day FROM sessions "
            "WHERE symbol=? AND resolution=? ORDER BY day DESC "
            "LIMIT 1 OFFSET ?",
            (symbol, resolution, limit)).fetchone()
        if row is None:
            return
        cut = row[0]
        # `cut` is the first session beyond the retention count, so it is
        # removed together with everything older than it.
        connection.execute(
            "DELETE FROM bars WHERE symbol=? AND resolution=? AND day <= ?",
            (symbol, resolution, cut))
        connection.execute(
            "DELETE FROM sessions WHERE symbol=? AND resolution=? AND day <= ?",
            (symbol, resolution, cut))

    # --------------------------------------------------------------- reading
    def read(
        self,
        symbol: str,
        resolution: str,
        *,
        limit: int | None = None,
        day: date | str | None = None,
    ) -> list[Bar]:
        """Bars for one series, oldest first; an empty list is a cache miss.

        ``limit`` takes the *newest* N bars, because that is the part a chart
        opens on, and asks the index for them directly instead of reading a
        decade and slicing it. The rows come back ascending so the caller
        never has to know which direction the query ran.
        """
        key = symbol.strip().upper()
        rung = ladder.normalise(resolution)
        day_text = (day.isoformat() if isinstance(day, date)
                    else (str(day).strip() if day else ""))
        clauses = ["symbol = ?", "resolution = ?"]
        params: list[object] = [key, rung]
        if day_text:
            clauses.append("day = ?")
            params.append(day_text)
        where = " AND ".join(clauses)

        with self._lock:
            connection = self._connection_or_open()
            try:
                if limit is not None and limit > 0:
                    rows = connection.execute(
                        f"SELECT t, o, h, l, c, v FROM ("
                        f"  SELECT t, t_ms, o, h, l, c, v FROM bars "
                        f"  WHERE {where} ORDER BY t_ms DESC LIMIT ?"
                        f") ORDER BY t_ms ASC",
                        (*params, int(limit))).fetchall()
                else:
                    rows = connection.execute(
                        f"SELECT t, o, h, l, c, v FROM bars "
                        f"WHERE {where} ORDER BY t_ms ASC",
                        tuple(params)).fetchall()
            except sqlite3.Error as exc:
                raise CacheError(
                    f"the cache could not read {key} {rung}: {exc}") from exc
        # Rows were validated by `Bar.build` on the way in, and `Bar` still
        # re-checked its own invariants in __post_init__ on the way out.
        return [Bar(t=row[0], o=row[1], h=row[2], l=row[3], c=row[4], v=row[5])
                for row in rows]

    def coverage(self, symbol: str, resolution: str) -> CacheCoverage:
        """How much of one series the cache holds, and what it spans."""
        key = symbol.strip().upper()
        rung = ladder.normalise(resolution)
        with self._lock:
            connection = self._connection_or_open()
            try:
                sessions = connection.execute(
                    "SELECT COUNT(*) FROM sessions "
                    "WHERE symbol=? AND resolution=?",
                    (key, rung)).fetchone()[0]
                bars, first, last = connection.execute(
                    "SELECT COUNT(*), MIN(t), MAX(t) FROM bars "
                    "WHERE symbol=? AND resolution=?",
                    (key, rung)).fetchone()
            except sqlite3.Error as exc:
                raise CacheError(
                    f"the cache could not describe {key} {rung}: {exc}"
                ) from exc
        return CacheCoverage(
            symbol=key, resolution=rung, sessions=int(sessions),
            bars=int(bars), first=first, last=last,
            bytes_on_disk=self.size_bytes())

    def session_capture(self, symbol: str, resolution: str,
                        day: date | str) -> str | None:
        """The capture identity stored for one session, or None.

        Kept separate from `read` so a caller can decide *before* paying for
        a query whether the stored rows describe the bytes it is about to
        read. An entry stored without an identity returns "" rather than
        None: "stored, identity unknown" and "not stored" lead a caller to
        different decisions, and collapsing them would hide a stale read.
        """
        key = symbol.strip().upper()
        rung = ladder.normalise(resolution)
        day_text = day.isoformat() if isinstance(day, date) else str(day).strip()
        with self._lock:
            connection = self._connection_or_open()
            try:
                row = connection.execute(
                    "SELECT capture FROM sessions "
                    "WHERE symbol=? AND resolution=? AND day=?",
                    (key, rung, day_text)).fetchone()
            except sqlite3.Error as exc:
                raise CacheError(
                    f"the cache could not describe {key} {rung} {day_text}: "
                    f"{exc}") from exc
        return None if row is None else str(row[0])

    def sessions(self, symbol: str, resolution: str) -> list[dict]:
        """Every cached session for a series, newest first."""
        key = symbol.strip().upper()
        rung = ladder.normalise(resolution)
        with self._lock:
            connection = self._connection_or_open()
            try:
                rows = connection.execute(
                    "SELECT day, capture, bars, ingested_at FROM sessions "
                    "WHERE symbol=? AND resolution=? ORDER BY day DESC",
                    (key, rung)).fetchall()
            except sqlite3.Error as exc:
                raise CacheError(
                    f"the cache could not list {key} {rung}: {exc}") from exc
        return [{"day": row[0], "capture": row[1], "bars": int(row[2]),
                 "ingested_at": row[3]} for row in rows]

    def size_bytes(self) -> int:
        """The cache's footprint on disk, including its WAL sidecar."""
        total = 0
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(self.path) + suffix)
            try:
                total += candidate.stat().st_size
            except OSError:
                continue
        return total

    # ---------------------------------------------------------- maintenance
    def prune(self, *, keep_sessions: int = DEFAULT_KEEP_SESSIONS) -> int:
        """Apply the retention count to every series; return sessions removed."""
        with self._lock:
            connection = self._connection_or_open()
            try:
                series = connection.execute(
                    "SELECT DISTINCT symbol, resolution FROM sessions"
                ).fetchall()
                before = connection.execute(
                    "SELECT COUNT(*) FROM sessions").fetchone()[0]
                connection.execute("BEGIN IMMEDIATE")
                try:
                    for symbol, resolution in series:
                        self._trim(connection, symbol, resolution,
                                   keep_sessions)
                    connection.execute("COMMIT")
                except BaseException:
                    connection.execute("ROLLBACK")
                    raise
                after = connection.execute(
                    "SELECT COUNT(*) FROM sessions").fetchone()[0]
            except sqlite3.Error as exc:
                raise CacheError(f"the cache could not be pruned: {exc}") from exc
        return int(before) - int(after)

    def clear(self) -> None:
        """Forget everything. The captures and the archive are untouched."""
        with self._lock:
            connection = self._connection_or_open()
            try:
                connection.executescript("DELETE FROM bars; DELETE FROM sessions;")
            except sqlite3.Error as exc:
                raise CacheError(f"the cache could not be cleared: {exc}") from exc
