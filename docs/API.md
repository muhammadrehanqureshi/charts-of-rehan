# API

All routes are served by `charts/http.py`. Every answer is JSON with
`Cache-Control: no-store`, except the static files of the built front end.

## Routes

| Method and path | Answer |
|---|---|
| `GET /api/health` | service identity, the Karachi clock, the resolved market phase, the source's own claims, ingest counters, per-symbol failures |
| `GET /api/symbols` | the symbols this deployment can serve, with each one's coverage note |
| `GET /api/bars?symbol=..&resolution=..&limit=..` | one chart payload |
| `GET /api/bars?symbol=..&resolution=..&limit=..&day=..&days=N` | one chart payload; `day` names one stored session, `days` bigger than one merges that many newest sessions into a single intraday chart with gaps kept honest |
| `GET /api/sessions` | every session this service can draw, newest first, with today and the timezone stated |
| `GET /api/prints?symbol=..&day=..&limit=..` | one symbol's order-print report for a day, see below |
| `GET /api/stream?symbol=..&resolution=..` | Server-Sent Events, see below |
| `GET /api/stream/health` | the same health object, streamed once, for a dashboard that does not want to poll |
| everything else | the built web app from `--static`, with single page app fallback |
| `OPTIONS` on `/api/*` | the CORS preflight answer for the allowed origins |

`limit` is a tail request: a live chart asks for the last N bars, not the series.

## The payload

```json
{
  "ok": true,
  "schema_version": 1,
  "as_of": "2026-10-14T15:54:44+05:00",
  "symbol": "OGDC",
  "resolution": "1m",
  "source": {
    "id": "broker_tape",
    "label": "this project's read-only market feed recording",
    "delay_seconds": 0,
    "note": "..."
  },
  "market": {
    "phase": "OPEN",
    "state": "MARKET",
    "trading_day": true,
    "timezone": "Asia/Karachi",
    "band": { "open": "09:32", "close": "15:30" },
    "next_event": { "event": "CLOSE", "at": "2026-10-14T15:30:00+05:00" },
    "as_of": "2026-10-14T15:54:44+05:00"
  },
  "bars": [
    { "t": "2026-10-14T15:30:00+05:00", "o": 118.03, "h": 118.87,
      "l": 118.0, "c": 118.41, "v": 20138 }
  ],
  "bar_count": 357,
  "gaps": [
    { "start": "...", "end": "...", "minutes": 2,
      "reason": "no bar was printed in this minute" }
  ],
  "notes": ["..."],
  "ingest": { "polls": 3, "subscribers": 2, "dropped_events": 0, "errors": {} }
}
```

Every field is required unless the contract says otherwise, and `schema_version`
is checked in both directions, so a client that does not understand a payload
refuses it instead of guessing.

### What the payload promises

- **Timestamps are ISO 8601 with the Karachi offset** (+05:00), produced server
  side. A naive timestamp is refused by the contract rather than assumed.
- **The session the bars are from is stated.** At 09:00 the tape still holds
  yesterday, and the replay source serves the last session on purpose, so the
  newest candle is never read as today's price.
- **A gap is measured, not implied.** Missing minutes come from the session law's
  own expected list, so a holiday produces no gaps at all and a Friday midday
  break is never reported as missing data.
- **Revisions are counted.** Replacing a bar that was still forming increments a
  counter that the payload discloses.
- **An empty series explains itself.** A symbol with nothing to show carries a
  note saying why, instead of a row of zeroes.


## The order prints report

`GET /api/prints?symbol=..&day=..&limit=..` turns the broker tape's own order
events for one session into the ledger a chart can draw beside the candles:

```json
{
  "ok": true, "day": "2026-10-22", "symbol": "OGDC",
  "totals": { "orders": .., "volume": .., "prints": .., "buy_volume": ..,
              "sell_volume": .., "classified_volume": ..,
              "unclassified_volume": .., "windows": ..,
              "quote_windows": .., "tick_windows": .., "gap_windows": ..,
              "backward_windows": .., "coverage": 0.81 },
  "events": [ { "t": "10:05:41+05:00", "price": 118.41, "size": ..,
                "trades": .., "volume": .., "change": "up", "side": "B" } ],
  "events_total": 812
}
```

`limit` bounds the tail (at most 8000) and `events_total` always names how
many events the day produced, so a client that wants more knows to ask.
The totals are the tape's own running counters split by the same window
rules the volume card uses, so the ledger and the card can never disagree;
everything traded before the tape first saw the symbol is reported as
`unclassified_volume`, never attributed to a side.

A source that serves bars without a tape answers a documented empty report
(`totals: null`, no events) rather than an error, because "no print ledger"
is a fact about the source, not a failure.

## The event stream

`GET /api/stream?symbol=..&resolution=..` answers `text/event-stream`:

| Event | When | Data |
|---|---|---|
| `snapshot` | once, immediately on connect | the same payload `GET /api/bars` returns |
| `bars` | after each poll that changed the series | the tail that moved, plus `as_of` |
| `idle` | a poll with nothing new | the reason, so a silent feed is visible |
| `: keep-alive` | every five seconds | a comment line, so a proxy does not close the socket |

The stream reconnects by itself on the client. Subscriber queues are bounded and
drop the oldest event rather than growing, and the drop is counted in `/api/health`.

## Error taxonomy

| HTTP | `category` | When |
|---|---|---|
| 400 | `MISSING_SYMBOL` | `?symbol=` absent |
| 400 | `UNSUPPORTED_RESOLUTION` | the source does not serve it; the body names what it does |
| 400 | `CONTRACT` | a payload that is malformed or internally inconsistent |
| 404 | `UNKNOWN_SYMBOL` | outside the source's catalogue |
| 502 | `HTTP_ERROR` | the source answered a 4xx that is not 404, or a 5xx after retries |
| 503 | `RATE_LIMITED` | the token bucket refused after one bounded retry |
| 503 | `CIRCUIT_OPEN` | repeated failures; the breaker refuses for its cooldown, one probe per window |
| 504 | `TIMEOUT` | the source did not answer in time, with `Retry-After` |

An empty but successful source answer is **not** an error: it is recorded as
`EMPTY_ACK` against that symbol, which is visible in `/api/health` and in the
payload's notes, because "the exchange told us nothing" and "we could not reach
the exchange" are different facts and a chart must not confuse them.
