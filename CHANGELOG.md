# Changelog

All notable changes to this project are recorded here. Versions follow
`MAJOR.MINOR.PATCH`; the wire contract has its own `schema_version`, which is
versioned separately and only moves when a client can observe a difference.

## 0.1.0

Initial standalone release, exported from the parent monorepo.

**Added**

- The chart service: `charts/contract.py` (wire contract, validated both ways),
  `charts/adapters/` (tape, portal, replay behind one protocol),
  `charts/ratelimit.py` (token bucket, bounded retries with jitter, circuit
  breaker), `charts/store.py` (upserts, revision counts, measured gaps),
  `charts/ingest.py` (one polling thread, bounded subscriber queues),
  `charts/service.py` (the single payload builder), `charts/http.py` (REST, SSE,
  static files), `charts/app.py` (the foreground entry point).
- The web front end: React and strict TypeScript, built by Vite, with 64 unit
  tests. Bars live in parallel typed arrays, and a pointer move repaints without
  re-rendering the React tree.
- `tools/sanitize.py`, the exposure scanner and publish gate: it reports
  secret-shaped and private-data-shaped strings without ever printing a value,
  rewrites local user paths on `--fix`, and exits non-zero on a secret.
- `tools/export_charts_of_rehan.py` in the parent project, which regenerates this
  tree from source and writes `PROVENANCE.md` with a SHA-256 per file.
- Documentation: architecture, API, deployment, data provenance, licence and
  assets, security policy.

**Known limits**

- The service is foreground only and refuses to start under GitHub Actions.
- The `portal` source serves one session bar per trading day, about five minutes
  delayed; it does not serve an intraday series.
- Fourteen modules of the parent project's data layer are vendored under `src/`.
  See `docs/ARCHITECTURE.md` for the seam that should replace that.

**Verified at release**

- 119 Python tests pass in this tree in under a second, with no network.
- 64 web unit tests pass; both TypeScript projects typecheck clean.
- `tools/sanitize.py` reports 0 secrets and 0 private-data findings across 71
  scanned files.
