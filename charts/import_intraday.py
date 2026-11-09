"""Import a genuine one-minute intraday export into the durable archive.

This exists because the PSX public portal does not retain historical intraday
data: its tick endpoint is only the current session and is reset at every
open. A broker or vendor export can still be imported, and then every 1h/30m/
15m candle is rebuilt by the same folding path the recorder uses.

Usage::

    python -m charts.import_intraday --file prl-20261104.csv --symbol PRL

The file must be one-minute OHLCV with Karachi timestamps (or epoch seconds)
and an explicit UTC offset. Rows outside the exchange's official bands are
rejected rather than clipped, and an existing archive day keeps every other
symbol it already holds.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

from charts.archive import DEFAULT_ARCHIVE_DIR, SessionArchive
from charts.contract import Bar, ContractError
from charts.resolutions import expected_minutes_for

KARACHI = timezone(timedelta(hours=5), name="Asia/Karachi")
_ALIASES = {
    "t": ("t", "time", "timestamp", "datetime", "date"),
    "o": ("o", "open"),
    "h": ("h", "high"),
    "l": ("l", "low"),
    "c": ("c", "close"),
    "v": ("v", "volume", "vol"),
    "symbol": ("symbol", "ticker", "scrip"),
}


def _field_map(names: Iterable[str]) -> dict[str, str]:
    lookup = {str(name).strip().lower().lstrip("\ufeff"): name for name in names}
    found: dict[str, str] = {}
    for key, aliases in _ALIASES.items():
        for alias in aliases:
            if alias in lookup:
                found[key] = lookup[alias]
                break
    missing = [key for key in ("t", "o", "h", "l", "c") if key not in found]
    if missing:
        raise ValueError(f"CSV is missing column(s): {', '.join(missing)}")
    return found


def _timestamp(text: str) -> datetime:
    text = str(text).strip()
    try:
        if text.replace(".", "", 1).isdigit():
            value = float(text)
            if value > 1_000_000_000_000:
                value /= 1000.0
            return datetime.fromtimestamp(value, KARACHI)
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"timestamp is not ISO 8601 or epoch: {text!r}") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(
            f"timestamp carries no UTC offset, so its zone is unknown: {text!r}")
    return parsed.astimezone(KARACHI)


def _rows(path: Path) -> list[dict[str, str]]:
    if path.suffix.lower() in (".json", ".ndjson"):
        text = path.read_text(encoding="utf-8")
        if path.suffix.lower() == ".json":
            raw = json.loads(text)
            if isinstance(raw, dict):
                raw = raw.get("bars") or raw.get("data") or []
            return [dict(row) for row in raw]
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    with path.open("r", encoding="utf-8-sig", newline="") as stream:
        return [dict(row) for row in csv.DictReader(stream)]


def import_file(path: Path, *, symbol: str, archive_dir: Path,
                source: str = "manual 1m import") -> dict[str, int]:
    """Read one export, validate every row, and archive it by session.

    Returns ``{"days": n, "bars": n}``. A row outside the official session
    grid, a duplicate, or an unknown symbol is an error; the import is
    all-or-nothing per request so a half-written day cannot masquerade as a
    complete one.
    """
    rows = _rows(path)
    if not rows:
        raise ValueError(f"{path} contains no rows")
    fields = _field_map(rows[0].keys())
    by_day: dict[date, list[Bar]] = {}
    grids: dict[date, set[datetime]] = {}
    for number, row in enumerate(rows, start=2):
        try:
            moment = _timestamp(row[fields["t"]])
            bar = Bar.build(
                t=moment,
                o=row[fields["o"]], h=row[fields["h"]],
                l=row[fields["l"]], c=row[fields["c"]],
                v=row[fields.get("v", "")] or 0,
            )
            file_symbol = symbol.strip().upper()
            if "symbol" in fields:
                from_file = str(row.get(fields["symbol"], "")).strip().upper()
                if from_file and from_file != file_symbol:
                    raise ValueError(
                        f"row is for {from_file}, not {file_symbol}")
            day = moment.date()
            expected = grids.get(day)
            if expected is None:
                expected = set(expected_minutes_for(day))
                grids[day] = expected
            if moment not in expected:
                raise ValueError(
                    f"{moment.isoformat()} is outside the official session grid")
        except (KeyError, TypeError, ValueError, ContractError) as exc:
            raise ValueError(f"{path.name} row {number}: {exc}") from exc
        by_day.setdefault(day, []).append(bar)

    archive = SessionArchive(archive_dir)
    for day, bars in sorted(by_day.items()):
        archive.write_import(
            day, symbol, bars, source=source,
            notes=[f"imported {len(bars)} one-minute bars from {path.name}; "
                   f"this is caller-supplied data, not a broker recording"])
    return {"days": len(by_day), "bars": sum(len(bars) for bars in by_day.values())}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m charts.import_intraday")
    parser.add_argument("--file", required=True, type=Path,
                        help="CSV/JSON export of one-minute OHLCV rows")
    parser.add_argument("--symbol", required=True,
                        help="symbol the export belongs to (e.g. PRL)")
    parser.add_argument("--archive-dir", type=Path,
                        default=DEFAULT_ARCHIVE_DIR,
                        help="archive root (default: data/archive)")
    parser.add_argument("--source", default="manual 1m import",
                        help="label recorded in the manifest")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = import_file(args.file, symbol=args.symbol,
                             archive_dir=args.archive_dir, source=args.source)
    except (OSError, ValueError, ContractError) as exc:
        print(f"import refused: {exc}", file=sys.stderr)
        return 1
    print(f"imported {result['bars']} bar(s) across {result['days']} "
          f"session(s) for {args.symbol.strip().upper()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
