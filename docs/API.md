# API

All responses are `application/json`, carry `Cache-Control: no-store`, and use
Asia/Karachi in their human-readable times. The wire schema is version 2.

## `GET /api/health`

Returns service status, the authoritative Karachi market phase and next event,
the source's own capabilities and delay, ingest health, per-symbol errors and
whether the tape archive is verified.

## `GET /api/symbols`

Returns the symbols the selected source can serve; this is not a promise of the
whole exchange universe.

## `GET /api/bars?symbol=OGDC&resolution=1m&limit=500`

Returns one series with OHLC, volume and print count when genuinely available,
source and provenance, missing expected session minutes, revisions and an
explicit no-history reason. `limit` is bounded. Unsupported resolutions and
unknown symbols are distinct errors. Empty data is not a transport error.

## `GET /api/stream?symbol=OGDC&resolution=1m`

Server-Sent Events send one `snapshot`, followed by `bars` when the source has
changed, or `idle` when the poll produced the same series. A keep-alive comment
maintains the connection. Subscriber queues are bounded; slow clients are
removed rather than allowed to retain unbounded memory. Clients close the
subscription when changing symbol or leaving the page.

## Synthetic replay

Replay data is deterministic and synthetic. It is available only after the
operator explicitly chooses `--source replay`; every payload labels it
synthetic. It must not be treated as an exchange observation.