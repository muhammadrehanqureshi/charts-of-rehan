# Architecture

## The shape

```
                     +-----------------------------+
   market feed tape --> |  charts/adapters/tape.py    |
   exchange page   --> |  charts/adapters/portal.py  |  one BarSource protocol:
   replay bars     --> |  charts/adapters/replay.py  |  capabilities, catalog,
                     +--------------+--------------+  history, latest
                                    |
                       charts/ratelimit.py (pacing, bounded retries, breaker)
                                    |
                     +--------------v--------------+
                     |  charts/ingest.py           |  one polling thread,
                     |  poll -> upsert -> fan out  |  bounded subscriber queues
                     +--------------+--------------+
                                    |
                     +--------------v--------------+
                     |  charts/store.py            |  upserts, revision counts,
                     |  series, gaps               |  thread safe, copy on read
                     +--------------+--------------+
                                    |
                     +--------------v--------------+
                     |  charts/service.py          |  one payload builder:
                     |  bars + gaps + provenance   |  notes, limits, gap floor
                     +--------------+--------------+
                                    |
                     +--------------v--------------+
                     |  charts/http.py             |  REST, SSE, static files,
                     |  contract / error taxonomy  |  CORS allow list
                     +-----------------------------+
```

## The modules

| Module | Responsibility |
|---|---|
| `charts/contract.py` | defines the wire shape once, validates it in both directions, and refuses a bar that is internally inconsistent (a high below its own close) or out of order |
| `charts/adapters/` | the seam. An adapter declares what it can honestly serve (`capabilities`), what it knows (`catalog`), past bars (`history`) and the newest bars (`latest`). Adding a source touches nothing else |
| `charts/ratelimit.py` | token bucket, bounded retries with proportional jitter, circuit breaker, all injectable with a clock so tests prove them without sleeping. A 404 is never retried |
| `charts/ingest.py` | polls only the symbols a chart is watching, forgets them after fifteen idle minutes, drops the oldest event when a slow reader falls behind (and counts it), and names every per-symbol failure |
| `charts/store.py` | replaces the minute still forming instead of duplicating it, counts those revisions, and measures gaps against the session law's own expected minutes |
| `charts/service.py` | the single path from the store to the wire, so the API, the event stream, the example and the tests cannot disagree |
| `charts/sessions.py` | shapes session facts for a chart by asking the one session law |
| `charts/http.py` | serves the API, the event stream and the built UI |
| `charts/app.py` | the command line entry point: a foreground process and nothing else |

## Threading model

One polling thread in `Ingestor`, one HTTP server thread per request, and a
bounded queue per subscriber. The store hands readers a copy, so a payload is
assembled without holding the write lock. A stale browser tab cannot slow the
poller or grow the process: its queue drops the oldest event and the drop is
counted and reported.

## The dependency on the data layer, stated plainly

This project was extracted from a larger monorepo and it still reads that
project's data layer. The two connections are:

1. **Session facts.** `charts/sessions.py` imports `src/data/sessions.py`, which
   owns PSX hours, holidays, the Friday two band day and the expected minute list.
   This is deliberate: a chart that re-derived its own calendar would eventually
   disagree with the scanner about whether a minute should exist.
2. **Bar construction and the data registry.** `charts/adapters/tape.py` imports
   `src/data/tape_bars.py`, and `charts/adapters/portal.py` imports
   `src/data/market_snapshot.py` and `src/data/registry.py`.

Measured 2026-10-16, those imports resolve to a closure of **14 vendored files**
under `src/`, not one. The extra ones appear because `src/__init__.py` imports the
data registry at package level, which drags in `src/config.py`, the feed recorder,
the polite poller, the volume split and, indirectly, the daemon guards their
modules carry. PROVENANCE.md lists every file with a hash.

### The seam that should replace it

Vendoring works and the tests pass, but it is the wrong long term shape: a chart
service should not ship a market-hours daemon guard it never calls. Two clean
options, in order of preference:

- **Extract a small shared package** (`qor_data`) holding the session law, the
  bar builder and the data registry, as its own versioned artifact. Both the
  scanner and this service depend on it; neither vendors the other.
- **Invert the dependency**: this service receives bars and session facts through
  a provider object passed in at construction, with the monorepo supplying the
  real provider. The chart side then imports nothing from `src/`, which makes the
  boundary testable by construction.

Until one of those lands, the export script is the single source of truth for what
gets copied, and `PROVENANCE.md` is regenerated on every export.

## Why the front end is separate

`web/` is a Vite and React application with strict TypeScript. It talks to the
service over the documented API only, and it is built to `web/dist`, which the
service then serves. The service has no build step, no bundler and no dependency,
which is what lets it run on a machine with nothing installed but Python.
