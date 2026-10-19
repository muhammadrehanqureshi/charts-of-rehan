# Deployment

## Where it may run

The service is a **foreground tool**. It is started by a person, it serves until
it is stopped, and it leaves nothing behind: no schedule, no daemon, no watcher,
no autostart entry. Running it means a terminal is open.

| Environment | Allowed | Why |
|---|---|---|
| a developer machine, loopback | yes | the intended use |
| a workstation serving a local dashboard | yes, with `--allow-public-bind` stated explicitly | a network bind is a decision |
| GitHub Actions | **no**, refused at startup | runner minutes belong to market hours work, and a scheduled chart server would be a daemon by another name |
| a serverless platform | not as written | the service holds state in process and polls; a stateless platform would need a different ingest design |

## Running it

```bash
# One pass, print health, exit. Good for a smoke test.
python -m charts --source tape --once

# Serve the API and the built front end on loopback.
python -m charts --source tape --port 8788 --static web/dist

# Keep a set of symbols warm so the first chart a browser asks for is instant.
python -m charts --source tape --symbols OGDC,ENGRO,HBL --port 8788

# Allow an extra origin to call the API (the Vite dev server is always allowed).
python -m charts --source tape --cors http://192.168.1.20:5173

# Offline demonstration, deterministic, no exchange and no network.
python -m charts --source replay --symbols REPLAY1 --once
```

## Front end

```bash
cd web
npm install
npm run typecheck     # strict TypeScript, both projects
npm test              # 121 unit tests
npm run build         # writes web/dist
```

`web/dist` is build output and is never committed. Serve it with `--static`.

## Operating notes

- **Politeness.** The portal source paces its requests through a token bucket with
  bounded retries and a circuit breaker. Do not raise the interval below the
  default without measuring the effect on the upstream page.
- **Memory.** Subscriber queues are bounded per chart. A stale tab drops events
  rather than growing the process; the drop count is in `/api/health`.
- **Ports.** The default port 8788 is high and uncommon so it does not collide
  with a development server or another tool on the same machine.
- **Clock.** All session logic is Karachi time (Asia/Karachi, UTC+5) and is never
  derived from the host's local timezone.
- **Logs.** Structured logging at INFO by default; `--log-level DEBUG` for
  diagnosis. Nothing logs a credential because nothing holds one.

## Data files and 24/7 research

The tape source reads a capture from the path named by `--tape-dir`,
`CHART_TAPE_DIR`, or its documented local candidates. Finished sessions can be
stored once in a durable archive and read later without a running recorder:

```bash
python -m charts --source tape --build-archive latest
python -m charts --source tape --sessions
python -m charts --source tape --day 2026-10-16 --port 8788
```

The archive defaults to `data/archive/`, is local runtime data, and must not be
committed or redistributed. Configure `--archive-dir PATH` to keep it outside
the checkout or restore a separately held private archive. The exact session
values, `prints`, carried-bar flags, and capture hashes are retained for local
research. This app does not fetch or reconstruct missing market observations.
The service does not create an account or contact an authenticated endpoint.
