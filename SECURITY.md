# Security and exposure policy

## What this project holds

Nothing secret. The service reads local files it already owns and public exchange
pages. It holds no token, no key, no account, no session and no credential of any
kind, and it calls no authenticated endpoint. That is a design property, not a
claim: `tools/sanitize.py` scans every published file on every run.

## The three rules

1. **No credential is ever committed.** Not in code, not in a test fixture, not
   in a comment, not in documentation, not in a screenshot. If a future source
   needs one, it lives in the environment where the service runs.
2. **No local absolute path is ever committed.** `C:\Users\<name>\...` and
   `/Users/<name>/...` leak who runs this and where. `tools/sanitize.py --fix`
   rewrites them to `<user>` placeholders; run it before publishing.
3. **No personal data is committed.** Phone numbers, national identity numbers
   and personal email addresses are reported by the scanner and must be replaced
   with obviously synthetic values (`+920000000000`, `example@example.com`). The
   scanner deliberately does not rewrite these automatically, because a real
   number and a test number look the same to a machine and the decision belongs
   to the person. It does skip values that are self evidently synthetic, so the
   documented placeholder above is not itself reported.

## Before publishing this tree

```bash
python tools/sanitize.py --fix     # rewrite local paths, then report
python -m pytest tests -q          # 119 tests
cd web && npm run typecheck && npm test
```

The publish gate is the exit status of `tools/sanitize.py`: it exits non-zero if
any secret-shaped value is present, and it will not rewrite a credential for you.
A credential that has ever been committed is compromised: remove it, rotate it,
then publish.

## Public visibility is a decision, not a default

A publicly readable repository is world readable, indexed by search engines and
cloned within minutes. That is fine for this project, which exists to draw
charts, and it is not fine for the pipeline that produces trading calls, whose
rule thresholds and evidence gates are the edge. Keep the two separate:

* this chart service may be public;
* the signal pipeline, its models, its tapes and its credentials stay private.

## Reporting a problem

Open an issue describing the class of problem without including the value. If a
secret has leaked, rotate it first and describe it afterwards.

## Supported versions

Only the current `master` is supported. This project ships no binary artifacts
and no long term support branches.
