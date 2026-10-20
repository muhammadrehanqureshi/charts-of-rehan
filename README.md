# Charts of Rehan

A charting service for the exchange's own session, built from this project's own
market data. It serves candles at twelve resolutions from one second to one
month, volume, the Karachi session clock, two computed breadth proxies
(`KSE100` and `KMIALLSHR`), and a measured list of the minutes that are missing,
over a plain HTTP API plus a React front end.

Two ideas carry the whole design.

**The chart cannot know more than the data does.** Every payload states which
source the bars came from, how delayed that source is, how many bars were revised
after they first appeared, and which minutes the session expected but no bar
filled. A symbol with nothing to show is an empty series with a sentence
explaining it, never a row of zeroes.

**One authority per question.** Session facts are asked of a single session law
(`src/data/sessions.py`), minute bars are built by `src/data/tape_bars.py`, and
what data the project genuinely has is declared in `src/data/registry.py`. This
package wraps them. It never restates a session table, never re-derives a holiday
list, and never invents a bar.

- Status: working, standard library Python only, no runtime dependencies.
- This project generates **no orders and no signals**. It is a read-only viewer.
- Every timestamp is Asia/Karachi (UTC+5), produced server side.

## Contents

| Path | What it is |
|---|---|
| `charts/` | the service: contract, adapters, rate limiting, store, ingest, service, HTTP |
| `web/` | the front end: React and strict TypeScript, built by Vite |
| `src/data/` | the vendored data layer this project reads (see PROVENANCE.md) |
| `tests/` | deterministic Python tests, no live network calls |
| `examples/charts_demo.py` | the whole pipeline offline: replay bars, one gap, one revision |
| `docs/` | architecture, API, deployment, data provenance |
| `scripts/` | the guarded landing flow: repository identity, PR creation, merge |
| `tools/sanitize.py` | the exposure scan that must pass before this tree is published |

## Quick start

Nothing to install for the backend. The tape source stores finished sessions
in a local, full-precision archive under `data/archive/`; that directory is
private runtime data, excluded from this public source repository. Archived
sessions remain chartable when PSX is closed and the recorder is stopped. To
build a finished session before later research, run the one-shot archive
command with a capture available:

```bash
python examples/charts_demo.py                 # offline, deterministic, no network
python -m charts --source replay --once        # one pass, prints health JSON, exits
python -m charts --source tape --port 8788     # real service, loopback, foreground
python -m charts --source tape --build-archive latest  # store the latest session
python -m charts --source tape --sessions       # list chartable sessions
```

To use a private recorder archive, copy its `data/archive/` into this checkout
or configure an archive directory as documented in `docs/DEPLOYMENT.md`. Never
commit personal recordings or archive files to the public repository.

The front end needs Node for its development server and its build:

```bash
cd web
npm install
npm run dev        # http://localhost:5173, proxying /api to the service
npm test           # 134 unit tests
npm run build      # writes web/dist, which the service then serves
```

Then `python -m charts --source tape --static web/dist` serves the API and the
built UI on one loopback port.

## API

| Route | Answer |
|---|---|
| `GET /api/health` | the service, the Karachi clock, the resolved market phase, the source's own claims, ingest counters, per-symbol failures |
| `GET /api/symbols` | the symbols this deployment can serve |
| `GET /api/bars?symbol=..&resolution=..&limit=..` | one chart payload |
| `GET /api/stream?symbol=..&resolution=..` | Server-Sent Events: `snapshot` once, then `bars` per poll, plus `idle` and a keep-alive comment |
| everything else | the built web app from `--static`, with single page app fallback |

See [docs/API.md](docs/API.md) for the payload contract, the error taxonomy and
the event stream.

## Sources, and what each one may claim

| Source | Serves | Honest limits |
|---|---|---|
| `tape` | `1s` and `10s` from the recording's own ticks, `1m` from its prints, and `5m` through `1M` folded server-side under the session law | only what the recorder banked; a symbol that started late says so |
| `portal` | `session`: one bar per trading day from the exchange portal's company page | about five minutes delayed; not an intraday series; a cleared panel is a named failure, not a zero bar |
| `replay` | `1m` synthetic bars | labelled synthetic and refused unless named on the command line; it exists to test the pipeline offline |

## Failure behaviour

| Situation | Answer |
|---|---|
| source timeout | retried with backoff, then `504 TIMEOUT` with `Retry-After` |
| source 429 | retried once within the token bucket, then `503 RATE_LIMITED` |
| source 404 | not retried, `502 HTTP_ERROR` |
| source answers with no usable data | `EMPTY_ACK` recorded against the symbol, visible in `/api/health` and the payload notes |
| repeated failures | circuit breaker opens, `503 CIRCUIT_OPEN`, one probe per window |
| missing `?symbol=` | `400 MISSING_SYMBOL` |
| symbol outside the catalogue | `404 UNKNOWN_SYMBOL` |
| resolution the source does not serve | `400 UNSUPPORTED_RESOLUTION`, naming what it does serve |
| malformed or inconsistent payload | `400 CONTRACT` with the sentence that says why |

## Testing

```bash
python -m pytest tests -q     # 222 tests
cd web && npm run typecheck && npm test
python tools/sanitize.py      # must report zero findings before publishing
```

Every clock in the Python suite is stated rather than read, so it passes at 03:00
and at noon alike. The HTTP tests run a real server on an ephemeral port over a
real socket, including the event stream. The front-end tests use fake transports
and a fake clock, so none of them waits a real second or touches an exchange.

## Rules this project obeys

- **Foreground only.** It registers no schedule, no daemon, no watcher and no
  autostart entry.
- **It refuses GitHub Actions.** Runner minutes belong to the market-hours scans,
  so `python -m charts` declines to start there.
- **Loopback by default.** Binding to any other address needs
  `--allow-public-bind`, because a chart service opened to a network is a
  decision, not a default.
- **No secrets or personal history.** The service reads local capture files and
  public pages. Credentials are not required. Your session archive stays local
  and is excluded from Git.

## License and data

Proprietary, all rights reserved. See [LICENSE](LICENSE) and
[docs/LICENSE_AND_ASSETS.md](docs/LICENSE_AND_ASSETS.md). This source release
contains no bundled font binaries or personal market recordings. Your local
session archives are not part of this public repository and may have separate
venue redistribution restrictions.
