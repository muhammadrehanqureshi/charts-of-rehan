"""The durable index store: the exchange's own index minutes, by day.

The session archive deliberately holds scrips, because its symbol list is also
the universe a proxy is computed from. The exchange's KSE100 and KMIALLSHR
frames are a different fact: they arrive in the capture's ``EXS-FEED`` rows,
they are the real published levels, and a capture is a working file that can
be replaced or deleted. Keeping them here, in their own directory, means the
index history grows even after the recording is gone, and it never pollutes a
symbol list.

Layout::

    data/indices/2026-10-30.ndjson    one line per index minute

A row carries the same fields as a bar plus the index name. A day is written
once, whole, and never edited: a partial day is not a day, so banking happens
only for a finished session. ``data/`` is gitignored; the market data is the
owner's.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import date
from pathlib import Path

from charts.contract import Bar

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INDEX_DIR = ROOT / "data" / "indices"


def _day_text(day: date | str) -> str:
    return day.isoformat() if isinstance(day, date) else str(day)


class IndexStore:
    """``data/indices/YYYY-MM-DD.ndjson``: read, write and prune one day."""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root else DEFAULT_INDEX_DIR

    def day_path(self, day: date | str) -> Path:
        return self.root / f"{_day_text(day)}.ndjson"

    def has(self, day: date | str) -> bool:
        return self.day_path(day).is_file()

    def days(self) -> list[str]:
        """Every banked day, newest first."""
        if not self.root.is_dir():
            return []
        return sorted((entry.stem for entry in self.root.glob("*.ndjson")),
                      reverse=True)

    def read(self, day: date | str) -> dict[str, list[Bar]]:
        """The day's bars per index, or {} when the day was never banked."""
        path = self.day_path(day)
        if not path.is_file():
            return {}
        out: dict[str, list[Bar]] = {}
        with path.open("r", encoding="utf-8") as stream:
            for number, line in enumerate(stream, start=1):
                text = line.strip()
                if not text:
                    continue
                try:
                    row = json.loads(text)
                    symbol = str(row["symbol"]).strip().upper()
                    bar = Bar.build(t=row["t"], o=row["o"], h=row["h"],
                                    l=row["l"], c=row["c"],
                                    v=row.get("v", 0.0))
                except (KeyError, TypeError, ValueError) as exc:
                    raise ValueError(
                        f"{path.name} line {number} is not a stored index "
                        f"row: {exc}") from exc
                if symbol:
                    out.setdefault(symbol, []).append(bar)
        return out

    def write(self, day: date | str, series: dict[str, list[Bar]]) -> int:
        """Bank one finished day, whole. Returns rows written, 0 if present."""
        path = self.day_path(day)
        if path.exists():
            return 0
        rows: list[str] = []
        for symbol in sorted(series):
            for bar in series[symbol]:
                rows.append(json.dumps(
                    {"symbol": symbol, "t": bar.t, "o": bar.o, "h": bar.h,
                     "l": bar.l, "c": bar.c, "v": bar.v},
                    separators=(",", ":")))
        if not rows:
            return 0
        path.parent.mkdir(parents=True, exist_ok=True)
        handle, temporary = tempfile.mkstemp(dir=str(path.parent),
                                             prefix=f".{path.name}.",
                                             suffix=".tmp")
        try:
            with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as out:
                out.write("\n".join(rows) + "\n")
            os.replace(temporary, path)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        return len(rows)

    def prune(self, before: date) -> list[str]:
        """Drop every banked day older than the decade window's start."""
        cut = before.isoformat()
        removed: list[str] = []
        for text in sorted(self.days()):
            if text >= cut:
                break
            try:
                self.day_path(text).unlink()
            except OSError:
                continue
            removed.append(text)
        return removed
