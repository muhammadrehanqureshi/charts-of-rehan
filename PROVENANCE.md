# Provenance

This standalone Charts release was generated from the Quant of Rehan
monorepo; release-specific sanitization and data-exclusion adjustments are
recorded in the public repository's commit history. Hashes below describe the
original export snapshot and are not asserted as hashes for the sanitized
release files.

- source repository: quant-of-rehan (`src/data` is the project's own data layer)
- source commit: `b820413361c078bdc05abfc3d79bba67d0e56dc4`
- exported: 2026-10-16T10:42:40+05:00
- files: 87 in the full generated export (78 files in the public release after private captures, builds, installed dependencies, and `.env.example` were excluded)

## Why the vendored session and tape modules ship with this project

The chart service uses the parent project's authoritative session law and
tape-bar builder rather than duplicating exchange rules or inventing bars.
The standalone export vendors the Python modules required for the app to run
without the parent checkout installed. This is a deliberate release boundary;
a smaller provider interface remains a future architectural improvement.

Local recordings and archived session data are explicitly excluded. To use
offline history, keep a private local archive outside GitHub and point Charts
to it with `--archive-dir PATH`.

## File hashes

| file | sha256 |
|---|---|
| `charts/__init__.py` | `f91a60ec323b7544577ddfbbaeb31973370ea25090395970604a775eeaa3e259` |
| `charts/__main__.py` | `e0acf0685a855c8323ab1377771206b9ab3c1ab744c06c9c5e74e2cf3ddae3b7` |
| `charts/adapters/__init__.py` | `af36ba1f758d605a1fa3379fe9888d3c0b5a1208f1111f1d6ea0ac21ecf01291` |
| `charts/adapters/base.py` | `04a5ecca5ccf9760eadc42bafa9660646da0acf6374b4778e8d273a33a4e0e36` |
| `charts/adapters/portal.py` | `6997b864964fd5621ffe71554331b227cea5c1fdf4ea6a4e62b64d50137f9718` |
| `charts/adapters/replay.py` | `018576d747b6f9b9fea44665391c87382e3fa319031cf4f9b8669c1c8d7bab1b` |
| `charts/adapters/tape.py` | `d45342ec19637e0a7c16f34ba3e6dc501c2640842c0b0d51eb1bf871a6756591` |
| `charts/app.py` | `90203dd1cc7d1a7bbefb85438545c669d806eb692e1c535b9d5f9552eae7f4` |
| `charts/contract.py` | `c70717cf6b8840654a4ef6e9e254c045f5228badf0f5b72e04db3a2b8b02e060`
