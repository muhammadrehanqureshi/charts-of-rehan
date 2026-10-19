"""Payload assembly: one code path from data to a wire ready chart.

Every consumer of a series (the HTTP API, the SSE snapshot, the runnable
example and the tests) builds its payload here. That is the point: there is
exactly one place where notes, gaps and provenance are attached, so a chart
cannot be honest through one door and quiet through another.

The rules this module implements, in order:

1. Bars come from the store for the session that is running, and from the
   durable archive for a session that is finished. Neither path makes a
   network call while a chart is being drawn, so a slow upstream cannot become
   a slow page.
2. A missing series is an empty payload with a measured sentence, not a row of
   zeroes (SO-3).
3. Gaps are computed against the session law's own expected minutes, so the
   Friday midday break and a holiday are never reported as missing data. For a
   finished session the whole day is expected, not the part of it that had
   already happened.
4. Provenance travels with the bars: which source, which session, which file,
   whether that session is archived, how delayed the source is, how many bars
   were revised, and what the source itself says about its limits.
5. **The chart works at any hour.** When the clock says today is a trading day
   but nothing has been ingested (the recorder is off, the machine was asleep,
   it is the middle of the night before a session), the newest archived
   session that holds this symbol is served instead, and the payload says so in
   one sentence and in its ``session`` block. An empty frame is never dressed
   up as a price, and a real previous session is never hidden behind one.
"""

from __future__ import annotations

from datetime import date, datetime
from itertools import islice

from charts import sessions
from charts.adapters.base import BarSource
from charts.contract import ChartPayload, ChartSession, ContractError
from charts.store import BarStore, Series


def _stamp(moment) -> str:
    """A session minute as the store's own bar timestamps spell it."""
    return moment.replace(second=0, microsecond=0).isoformat(timespec="seconds")

#: Below this many missing minutes a hole is a print artefact, not a gap: a
#: single absent minute inside a live tape is normal, and calling every one of
#: them a data gap would train a reader to ignore the list.
GAP_FLOOR_MINUTES = 2


def series_notes(series: Series | None, *, expected_minutes: int,
                 bars: int) -> list[str]:
    lines: list[str] = []
    if series is not None:
        lines.extend(series.notes)
        if series.revisions:
            lines.append(f"{series.revisions} bar(s) were revised after they "
                         f"first appeared, which is normal for the minute "
                         f"still forming")
        if series.updated_at:
            lines.append(f"last updated {series.updated_at}")
    if bars and expected_minutes:
        lines.append(f"{bars} bar(s) held against {expected_minutes} expected "
                     f"session minute(s)")
    return lines


def _current_session(moment: datetime | None) -> date:
    return sessions.law.as_karachi(moment).date()


def _live_source_name(source: BarSource) -> str:
    """The file behind a live series, when the source can name one.

    A chart should be able to say which recording it is drawing, and the tape
    adapter is the only source that can: the portal reads a page and the
    replay source is synthetic, so both honestly report no file.
    """
    namer = getattr(source, "live_capture_name", None)
    if not callable(namer):
        return ""
    try:
        return str(namer() or "")
    except Exception:  # noqa: BLE001 - naming a file may never break a chart
        return ""


def newest_archived_day(source: BarSource, symbol: str,
                        before: date | None = None) -> str | None:
    """The newest session the source has bars for this symbol in, or None.

    Asked of the source itself rather than guessed from the clock: a symbol
    that only ever traded last Tuesday must fall back to last Tuesday, and a
    source that cannot list its sessions simply returns None and gets an empty
    chart with a sentence instead of a wrong one.
    """
    lister = getattr(source, "sessions", None)
    if not callable(lister):
        return None
    try:
        rows = lister() or []
    except Exception:  # noqa: BLE001 - a listing may never break a chart
        return None
    for row in rows:
        day = str(row.get("day", ""))
        if not day or (before is not None and day >= before.isoformat()):
            continue
        has = getattr(source, "history", None)
        if not callable(has):
            return day
        try:
            if has(symbol, "1m", limit=1, day=day):
                return day
        except Exception:  # noqa: BLE001 - try the next session
            continue
    return None


def _served_from_archive(source: BarSource, symbol: str, day) -> bool:
    """Did the source read this series from its durable archive?

    Asked of the source, because only the source knows: a finished day it has
    stored is served from the archive, and a session read from a recording
    file is not. A source that cannot answer is treated as live, which is the
    honest reading of a series this service did not store itself.
    """
    ask = getattr(source, "served_from_archive", None)
    if not callable(ask):
        return False
    try:
        return bool(ask(symbol, day=day))
    except Exception:  # noqa: BLE001 - labelling may never break a chart
        return False


def _session_payload(source: BarSource, symbol: str, resolution: str, *,
                     day: str, limit: int, context, moment: datetime | None,
                     ) -> ChartPayload:
    """One named session, read from the source's own store for that day."""
    day_date = date.fromisoformat(day)
    bars = list(source.history(symbol, resolution, limit=limit or 1500,
                               day=day_date))
    expected = sessions.session_minutes(day_date)
    gaps = ([gap for gap in BarStore.gaps(bars, expected)
             if gap.minutes >= GAP_FLOOR_MINUTES] if bars else [])
    notes = list(_source_notes(source, symbol, day=day_date))
    if bars:
        first = bars[0].t
        window = [minute for minute in expected if _stamp(minute) >= first]
        late_start = len(expected) - len(window)
        notes.append(f"{len(bars)} bar(s) held against {len(expected)} "
                     f"session minute(s) in a finished session")
        if late_start:
            notes.append(
                f"this series starts at {bars[0].t[11:16]} Karachi, "
                f"{late_start} session minute(s) after the session opened; "
                f"the earlier minutes are not in it")
    else:
        notes.append(
            f"no {resolution} bar exists for {symbol} on {day}: the session is "
            f"stored and this symbol printed nothing in it, which is not the "
            f"same as a price of zero")
    summary = getattr(source, "archive_summary", lambda _day: None)(day)
    capture = None
    built_at = ""
    volume_available = any(bar.v > 0 for bar in bars)
    if summary is not None:
        capture = summary.capture
        built_at = summary.built_at
        volume_available = volume_available or summary.volume_available
    info = getattr(source, "source_info", None)
    source_info = (info(symbol, day=day_date) if callable(info)
                   else source.capabilities().source)
    archived = _served_from_archive(source, symbol, day_date)
    current = day == _current_session(moment).isoformat()
    # The recording behind this series is named either by the archive's own
    # manifest (a stored session) or by the source's live capture (a session
    # read from the file the recorder is still writing).
    file_name = (capture or {}).get("name", "") or _live_source_name(source)
    if archived:
        note = (f"this is the archived {day} session, so nothing in it is a "
                f"live price")
    elif current:
        note = (f"this is today's {day} session read from its recording file"
                + (f" ({file_name})" if file_name else "")
                + ", so the newest candle may still be forming")
    else:
        note = (f"this is the finished {day} session, read from its recording "
                f"file" + (f" ({file_name})" if file_name else "")
                + ", so nothing in it is a live price")
    return ChartPayload(
        symbol=symbol, resolution=resolution, source=source_info,
        market=context, as_of=context.as_of, bars=bars, gaps=gaps, notes=notes,
        session=ChartSession(
            day=day, current=current, archived=archived,
            source=file_name, capture=capture,
            built_at=built_at, volume_available=volume_available,
            note=note))


def _source_notes(source: BarSource, symbol: str, *, day=None) -> list[str]:
    """The source's own caveats for a symbol, when it can report them."""
    if day is None:
        reporter = getattr(source, "notes", None)
        if not callable(reporter):
            return []
        try:
            return list(reporter(symbol))
        except TypeError:
            return []
    reporter = getattr(source, "notes", None)
    if not callable(reporter):
        return []
    try:
        return list(reporter(symbol, day=day))
    except TypeError:
        try:
            return list(reporter(symbol))
        except Exception:  # noqa: BLE001
            return []
    except Exception:  # noqa: BLE001
        return []


def build_payload(store: BarStore, source: BarSource, symbol: str,
                  resolution: str, *, limit: int = 1500,
                  moment: datetime | None = None,
                  day: date | str | None = None) -> ChartPayload:
    """One symbol's chart payload, ready for the wire.

    ``limit`` keeps a long session from shipping thousands of bars to a screen
    that can show a few hundred candles: the tail is the part a live chart
    reads, and the full series is on disk (live series in the store, finished
    sessions in the archive).

    ``moment`` is the session moment the payload describes, for the market
    context and the expected minutes the gaps are measured against. The
    default is the Karachi now, which is what a live service wants; a caller
    rendering a series that was ingested for another moment (a fixed replay
    clock, the offline demo) passes its own clock so the bars and the context
    describe the same session instead of two different days.

    ``day`` asks for one specific session by name. Without it, the payload
    describes the session the clock calls today, and falls back to the newest
    archived session that holds this symbol when today has nothing to show.
    """
    symbol = symbol.strip().upper()
    context = sessions.market_context(moment)
    today = _current_session(moment)
    wanted = day.isoformat() if isinstance(day, date) else (
        str(day).strip() if day else None)
    if wanted:
        # A caller that names a session gets that session, including today: a
        # chart that says "2026-10-16" must show 2026-10-16 rather than
        # whichever series the live store happens to hold. Only a source with
        # a session store can answer, so anything else is the caller's 400.
        if not callable(getattr(source, "sessions", None)):
            raise ContractError(
                f"source {getattr(source, 'name', source)} serves the running "
                f"session only; it keeps no store to read {wanted} from")
        return _session_payload(source, symbol, resolution, day=wanted,
                                limit=limit, context=context, moment=moment)

    series = store.series(symbol, resolution)
    bars = list(series.bars) if series else []
    if limit > 0 and len(bars) > limit:
        bars = bars[-limit:]

    if not bars:
        # Nothing has been ingested for today. Before showing an empty frame,
        # ask whether a finished session holds this symbol: a chart service
        # that only works during exchange hours is a chart service that is
        # useless when the owner actually has time to look at it.
        fallback = newest_archived_day(source, symbol, before=today)
        if fallback:
            payload = _session_payload(source, symbol, resolution,
                                       day=fallback, limit=limit,
                                       context=context, moment=moment)
            payload.notes.insert(
                0, f"today ({today.isoformat()}) has no bar for {symbol} yet, "
                   f"so this is the newest stored session, "
                   f"{fallback}; the newest candle is that session's last "
                   f"price, not a live one")
            payload.session = ChartSession(
                day=payload.session.day, current=False, archived=True,
                source=payload.session.source, capture=payload.session.capture,
                built_at=payload.session.built_at,
                volume_available=payload.session.volume_available,
                note=f"fallback to the newest stored session ({fallback}) "
                     f"because {today.isoformat()} holds no bar for {symbol}")
            return payload

    expected = sessions.expected_minutes(moment)
    # A series that begins mid-session is not a series with a morning long
    # gap: it is a series that begins mid-session. Gaps are only counted from
    # the first bar onward, and the late start gets its own sentence instead,
    # because the two are different facts about the day.
    window = expected
    late_start = 0
    if bars:
        first = bars[0].t
        window = [moment for moment in expected if _stamp(moment) >= first]
        late_start = len(expected) - len(window)
    # Gaps are only meaningful against bars that exist: with nothing at all
    # there is no series to be missing minutes from, and a list of 300
    # "gaps" would bury the one sentence that actually explains the chart.
    gaps = ([gap for gap in BarStore.gaps(bars, window)
             if gap.minutes >= GAP_FLOOR_MINUTES] if bars else [])
    if series is None:
        notes = [f"no {resolution} series exists yet for {symbol}: nothing "
                 f"has been ingested, which is not the same as a price of "
                 f"zero"]
    else:
        notes = series_notes(series, expected_minutes=len(expected),
                             bars=len(bars))
        if not bars and context.trading_day:
            notes.append(
                f"{symbol} is a known symbol but the source has published "
                f"no bar for it this session yet; it will appear when it "
                f"prints rather than being drawn as zero")
        if late_start:
            notes.append(
                f"this series starts at {bars[0].t[11:16]} Karachi, "
                f"{late_start} session minute(s) after the session opened; "
                f"the earlier minutes are not in it")
        # A series can belong to another day than the market context: at
        # 09:00 the tape is still yesterday's, and the offline replay
        # deliberately serves the last session rather than an empty frame.
        # Without this sentence a reader would take that day's close for
        # today's price, which is precisely the mistake the notes exist to
        # prevent.
        if bars and bars[-1].t[:10] != context.as_of[:10]:
            notes.append(
                f"these bars are the {bars[-1].t[:10]} session, and today "
                f"has no bar in this series yet: the newest candle is that "
                f"day's close, not today's price")
        delayed = source.capabilities().source.delay_seconds
        if delayed:
            notes.append(
                f"this source publishes with a delay of about "
                f"{delayed // 60} minute(s), so the newest bar is not the "
                f"newest trade")
    session_day = (bars[-1].t[:10] if bars else
                   (series.updated_at[:10] if series and series.updated_at
                    else today.isoformat()))
    return ChartPayload(symbol=symbol, resolution=resolution,
                        source=(series.source if series else
                                source.capabilities().source),
                        market=context, as_of=context.as_of, bars=bars,
                        gaps=gaps, notes=notes,
                        session=ChartSession(
                            day=session_day,
                            current=session_day == today.isoformat(),
                            archived=False, source=_live_source_name(source),
                            note="",
                            volume_available=any(bar.v > 0 for bar in bars)))


def build_many(store: BarStore, source: BarSource, symbols: list[str],
               resolution: str, *, limit: int = 1500,
               moment: datetime | None = None) -> dict[str, dict]:
    """Payloads for several symbols, keyed by symbol."""
    return {symbol: build_payload(store, source, symbol, resolution,
                                  limit=limit, moment=moment).as_dict()
            for symbol in islice(symbols, 0, 200)}
