# Running and deploying Charts of Rehan

## Local personal use

The intended installation is local. The browser is a client of a foreground
service on the same machine; the service binds `127.0.0.1` and stops when the
operator stops it. It creates no scheduled task, autostart entry or daemon.

Build the web app once, then run the server:

```bash
cd web && npm ci && npm run build
cd ..
python -m charts --source tape --static web/dist --port 8788
```

Open `http://127.0.0.1:8788`. When there is a local tape capture, the chart is
available immediately. To prepare a previously captured day for offline
research:

```bash
python -m charts --source tape --build-archive latest
python -m charts --source tape --sessions
```

By default, the archive is at `data/archive/`. Keep that folder and raw capture
files on the private machine; it is excluded from Git. `--archive-dir PATH` or
the `CHART_ARCHIVE_DIR` environment variable can point it to a protected local
volume with enough room and backups. Data is written to a temporary file and
atomically replaced; manifests and bar files are hashed and checked on read.
Review the provider agreement before storing market data long term.

A `--sessions` listing makes it easy to select historical dates. Archived
sessions are readable after market hours and with the recorder switched off;
the archive is not a collector and cannot recover a session that was never
recorded. Store copies on a separate private backup if those are required. Use
all supported history offline through the app while the service is running;
the software itself intentionally starts only when the user asks.

## Frontend development

```bash
cd web && npm ci && npm run dev
```

The Vite server proxies `/api` to `http://127.0.0.1:8788`. Typecheck, tests and
build:

```bash
cd web
npm run typecheck
npm test
npm run build
```

Backend tests and the sanitizer:

```bash
python tools/sanitize.py
python -m pytest tests -q
python examples/charts_demo.py
```

## Exposure is an explicit decision

The server binds only to loopback by default. To share it over a trusted LAN, pass
an explicit host and acknowledgement:

```bash
python -m charts --host 0.0.0.0 --allow-public-bind
```

This exposes the service to that network and adds no authentication. Do not
forward the port to the public internet. The service refuses a non-loopback
bind without `--allow-public-bind`.

Do not deploy the service to shared hosting with private recordings. The tape and
archive are personal runtime data. They are never part of the source release.