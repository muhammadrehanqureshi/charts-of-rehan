"""The candle cache's own contract: identity, ordering, bounds, recovery."""

from __future__ import annotations

from datetime import date, timedelta

import pytest

from charts.candle_cache import CandleCache, CacheCoverage
from charts.contract import Bar, ContractError
from src.data import sessions as law


def minutes(day: str, count: int = 5) -> list[Bar]:
    """`count` one-minute bars from the day's first band, strictly ascending."""
    session_day = date.fromisoformat(day)
    band = law.session_bands(session_day)[0]
    opened = law.band_bounds(session_day, band)[0]
    rows: list[Bar] = []
    for index in range(count):
        middle = 100.0 + index
        rows.append(Bar.build(t=opened + timedelta(minutes=index),
                              o=middle, h=middle + 1, l=middle - 1,
                              c=middle + 0.5, v=float(index + 1)))
    return rows


@pytest.fixture()
def cache(tmp_path) -> CandleCache:
    instance = CandleCache(tmp_path / "candles.sqlite3")
    yield instance
    instance.close()


def test_round_trip_preserves_full_precision(cache):
    day = "2026-10-16"
    rows = minutes(day, 4)
    assert cache.put_session("ogdc", "1m", rows, day=day,
                             capture="cap-a") == 4
    stored = cache.read("OGDC", "1m")
    assert [bar.t for bar in stored] == [bar.t for bar in rows]
    assert [bar.c for bar in stored] == [bar.c for bar in rows]
    assert stored[0].t.endswith("+05:00")


def test_each_rung_is_its_own_series(cache):
    day = "2026-10-16"
    cache.put_session("OGDC", "1m", minutes(day, 4), day=day, capture="cap-a")
    folded = [Bar.build(t=minutes(day, 1)[0].t, o=100, h=110, l=99, c=108,
                        v=10)]
    cache.put_session("OGDC", "1h", folded, day=day, capture="cap-a")
    assert len(cache.read("OGDC", "1m")) == 4
    assert len(cache.read("OGDC", "1h")) == 1
    assert cache.read("OGDC", "1h")[0].h == 110


def test_an_unchanged_capture_is_not_imported_twice(cache):
    day = "2026-10-16"
    rows = minutes(day, 3)
    assert cache.put_session("OGDC", "5m", rows, day=day, capture="cap-a") == 3
    assert cache.put_session("OGDC", "5m", rows, day=day, capture="cap-a") == 0
    assert len(cache.read("OGDC", "5m")) == 3


def test_a_changed_capture_replaces_the_session(cache):
    day = "2026-10-16"
    rows = minutes(day, 3)
    cache.put_session("OGDC", "1m", rows, day=day, capture="cap-a")
    revised = list(rows)
    revised[-1] = Bar.build(t=rows[-1].t, o=rows[-1].o, h=rows[-1].h + 5,
                            l=rows[-1].l, c=rows[-1].c, v=rows[-1].v)
    assert cache.put_session("OGDC", "1m", revised, day=day,
                             capture="cap-b") == 3
    assert cache.read("OGDC", "1m")[-1].h == rows[-1].h + 5


def test_unknown_capture_always_rewrites(cache):
    day = "2026-10-16"
    rows = minutes(day, 2)
    cache.put_session("OGDC", "1m", rows, day=day)
    assert cache.put_session("OGDC", "1m", rows, day=day) == 2


def test_a_bar_from_another_session_is_refused(cache):
    day = "2026-10-16"
    other = minutes("2026-10-19", 1)
    with pytest.raises(ContractError):
        cache.put_session("OGDC", "1m", other, day=day, capture="cap-a")
    assert cache.read("OGDC", "1m") == []


def test_an_empty_session_is_a_miss_not_a_zero_row(cache):
    assert cache.put_session("OGDC", "1m", [], day="2026-10-16",
                             capture="cap-a") == 0
    assert cache.read("OGDC", "1m") == []
    assert cache.coverage("OGDC", "1m").sessions == 0


def test_limit_returns_the_newest_bars_oldest_first(cache):
    day = "2026-10-16"
    cache.put_session("OGDC", "1m", minutes(day, 6), day=day, capture="cap-a")
    newest = cache.read("OGDC", "1m", limit=2)
    assert [bar.c for bar in newest] == [104.5, 105.5]


def test_retention_drops_whole_oldest_sessions(cache):
    for index, day in enumerate(("2026-10-12", "2026-10-13", "2026-10-14")):
        rows = minutes(day, 2)
        cache.put_session("OGDC", "1m", rows, day=day, capture=f"cap-{index}",
                          keep_sessions=2)
    kept = [row["day"] for row in cache.sessions("OGDC", "1m")]
    assert kept == ["2026-10-14", "2026-10-13"]
    assert len(cache.read("OGDC", "1m")) == 4


def test_coverage_names_what_is_held(cache):
    day = "2026-10-16"
    cache.put_session("OGDC", "1m", minutes(day, 3), day=day, capture="cap-a")
    coverage = cache.coverage("OGDC", "1m")
    assert isinstance(coverage, CacheCoverage)
    assert coverage.sessions == 1
    assert coverage.bars == 3
    assert coverage.first == minutes(day, 3)[0].t
    assert coverage.last == minutes(day, 3)[-1].t
    assert coverage.bytes_on_disk > 0


def test_a_corrupt_file_is_quarantined_not_fatal(tmp_path):
    path = tmp_path / "candles.sqlite3"
    path.write_bytes(b"this is not a database" * 100)
    cache = CandleCache(path)
    try:
        assert cache.read("OGDC", "1m") == []
        assert cache.put_session("OGDC", "1m", minutes("2026-10-16", 2),
                                 day="2026-10-16", capture="cap-a") == 2
    finally:
        cache.close()


def test_a_legacy_schema_is_replaced(tmp_path):
    import sqlite3

    path = tmp_path / "candles.sqlite3"
    connection = sqlite3.connect(str(path))
    connection.executescript(
        "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
        "INSERT INTO meta (key, value) VALUES ('version', '0');")
    connection.commit()
    connection.close()

    cache = CandleCache(path)
    try:
        assert cache.put_session("OGDC", "1m", minutes("2026-10-16", 2),
                                 day="2026-10-16", capture="cap-a") == 2
    finally:
        cache.close()
