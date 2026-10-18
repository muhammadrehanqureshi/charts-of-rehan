# Contributing

This project is proprietary and is not accepting outside contributions. If you
have been given access, these are the rules that keep it honest.

## The four laws

1. **Never invent market data.** No placeholder price, no filled gap, no synthetic
   bar outside the `replay` source, and no zero standing in for "no data". If a
   source has nothing, the payload says so.
2. **Never weaken a test to make it pass.** A failing test is information. Fix the
   cause, or replace an obsolete test with a stronger one and say why.
3. **Never commit a secret or a private path.** `python tools/sanitize.py` is the
   publish gate and it runs in CI. It exits non-zero on a finding, and it will not
   rewrite a credential for you.
4. **State every clock in tests.** No test may depend on the wall clock. Pass the
   moment in, so the suite passes at 03:00 and at noon alike.

## Before you push

```bash
python tools/sanitize.py            # must print PASS and exit 0
python -m pytest tests -q           # 119 tests
cd web && npm run typecheck && npm test && npm run build
```

## Changing the wire contract

`schema_version` is bumped for any change a client can observe: a new required
field, a renamed field, a changed type, a changed meaning. Additive optional
fields do not require a bump. Update `docs/API.md` and the tests in
`tests/test_charts_contract.py` in the same change, because the contract is
validated in both directions and a client that does not understand a payload
must refuse it rather than guess.

## Adding a source

Implement the four methods of the adapter protocol in `charts/adapters/base.py`:
`capabilities`, `catalog`, `history`, `latest`. Declare the resolutions you serve,
the measured delay, and a sentence naming your limits. Then:

* register it in `charts/adapters/__init__.py`;
* add a test that proves the capability declaration matches what the source
  actually returns;
* extend `docs/DATA_PROVENANCE.md` with what the source is allowed to claim.

A source that cannot state its delay is not ready to be a source.
