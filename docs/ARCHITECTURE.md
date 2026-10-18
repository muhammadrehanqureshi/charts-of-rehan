# Architecture

## The seam

```
market recording (read-only) --> charts.adapters.tape --+
                                                        +--> ChartService --> HTTP/SSE --> browser
exchange portal (delayed) -----> charts.adapters.portal -+
synthetic replay (explicit) ---> charts.adapters.replay -+
```

The adapter boundary is `charts/adapters/base.py`: a source states its
capabilities, its available symbols, its history, and its latest bars. The rest
of the service knows only this protocol. In particular, neither the browser nor
the HTTP handler knows how to parse a tape file or how the exchange's market
sessions work.

## Authorities stay singular

Market sessions come from `src/data/sessions.py`, the same authority the parent
system uses; the chart never copies a calendar or infers a holiday. One-minute
bars come from `src/data/tape_bars.py`, which understands the venue's recorded
counter semantics. The registry (`src/data/registry.py`) states which symbols
may be inspected. These are imported as data facts only: no scanner, order
path, strategy engine, notification runner, or decision gate is in the runtime
import graph.

## Data flow

1. The chosen adapter supplies bars and explicit source capabilities.
2. `ChartStore` stores them in memory for the live service, keyed by symbol and
   resolution. Revisions replace a candle rather than adding a second candle.
3. Missing expected session minutes are calculated from the authoritative
   session law and exposed as gaps; they are not filled with made-up candles.
4. `ChartService` produces one validated schema-v2 payload, used by both REST
   and SSE. A source with no history returns an empty series and a reason, not a
   fake price.
5. The optional archive under local `data/archive/YYYY-MM-DD/` preserves
   finished sessions losslessly for later charting and research. Its manifests
   record the exact capture SHA-256 and per-symbol bar file hashes. Historical
   source timestamps, receipt timestamps, venue volume counters, print counts,
   and carry flags stay distinct.

## Local-only by intent

The server runs in the foreground and binds to loopback unless the operator
explicitly opts into a public bind. It starts no scheduler, background daemon,
autostart entry or permanent watcher. CI tests modules and the deterministic
replay path; it does not start the data collector or access the network.