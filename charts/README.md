# Charts of Rehan: the local chart service

The small chart app lives in two layers: a standard-library Python service under
`charts/`, and a React/TypeScript page under `web/`. It only draws what its source
actually returned. It does not place orders or emit signals. Its replay source is
synthetic, is explicitly selected, and is labelled synthetic in every response.

## What works on a Saturday

Minute bars held live in memory disappear when a process stops. That is okay for
today's poll, but it is not enough for research. A session archive saves a
finished tape session to `data/archive/YYYY-MM-DD/`: each symbol gets a full
precision NDJSON series, and the day's manifest ties all those files back to
the exact capture file by name, byte size, modified time and SHA-256. Every
symbol series is hashed independently. On reading, the service verifies the
manifest, every file hash, the session date, and the individual series; a broken
archive is rebuilt only from its still-present capture, never guessed at.

When `TapeSource` starts, it adds discoverable archived dates to the symbol
catalog and reads each request from that date's checked archive. Today, tape
bars come from the recorder's existing capture file. Finished sessions can be
written with `--build-archive latest` or `--build-archive YYYY-MM-DD`; available
dates are listed with `--sessions`. If the capture set is not configured, it
uses the small set of existing project data directories it can discover. For a
large or remote encrypted disk, configure `--archive-dir DIR` or
`CHART_ARCHIVE_DIR` and make your own protected backups.

This is an offline history store, not a collection daemon, and 24/7 access is
not 24/7 collection: it makes each day's actual recorded observations queryable
when you want. It cannot recreate the hours before you started recording, and
it does not retrieve, fabricate, round, fill or interpolate missing data.
Use and retention remain subject to your market data provider agreement. Never
commit the archive or raw capture files to GitHub.

## Start

```bash
# One-shot, predictable walkthrough. No network and no exchange data.
python examples/charts_demo.py

# One pass and a JSON report, then exit. Synthetic bars are visibly labelled.
python -m charts --source replay --symbols REPLAY1 --once

# Real recording, local interface only, process stays in the foreground.
python -m charts --source tape --port 8788

# Archive the latest recorded session before future research, then list dates.
python -m charts --source tape --build-archive latest
python -m charts --source tape --sessions

# Serve the app and historical archives; if it has no history, the UI says so.
cd web && npm ci && npm run build
cd .. && python -m charts --source tape --static web/dist --port 8788
```

The service defaults to `127.0.0.1`. A LAN bind is a deliberate exposure
choice and requires both a non-loopback `--host` and `--allow-public-bind`; the
service has no authentication. It is foreground-only and starts no scheduled
task, watcher, daemon, background loop, or autostart registration.

## API

See `docs/API.md`. REST and Server-Sent Events use the same schema version 2
payload. The default request tail is 500 bars. API and HTML responses are
`no-store`; the actual timestamp and market session are always Asia/Karachi.

## Tests

```bash
python -m pytest tests -q
cd web && npm run typecheck && npm test && npm run build
python tools/sanitize.py
```
