# Data provenance and honest bars

A candle is a record, not an illustration. This project never creates a bar to
make the chart look continuous.

## The tape source

`tape` reads this project's local market-feed recordings, parses exchange time
and local receipt time separately, and builds one-minute bars using the same
logic as the recorder's other consumers. Its resolution is `1m`. It can only
show what was recorded; symbols that were absent from the feed have no candles.
The live source cannot recover days before capture began.

Finished sessions can be written to a private local archive. Archive rows retain
exact source timestamps, separate receipt timestamps, full-precision OHLC,
venue-derived volume, print counts and carried/missing markers. A day manifest
pins the original capture's size, modification time and SHA-256 and hashes each
symbol series, so later reads verify the archival record. This lets the chart
serve old sessions when PSX is closed or the original recorder is offline.
The archive does not restore data that was never captured, and data remains
subject to the source venue's personal-use and redistribution rules.

## Delayed portal source

`portal` reads the exchange's public company page. It has a measured delay of
about five minutes and provides one session observation per trading day, not an
intraday series. A source response with a cleared panel is reported as an empty
acknowledgement, not a zero price.

## What the replay source is

`replay` generates deterministic synthetic bars. It is labelled synthetic in every
payload, it is refused unless it is named on the command line, and it exists so
the pipeline can be demonstrated and tested offline. It is never a market print
and must never be presented as one.

## What this project does not do

- It does not fill a missing minute with an interpolated price.
- It does not present a still forming minute as a completed candle.
- It does not claim a delay it has not measured. Each source declares
  `delay_seconds`, and the value is the measured one.
- It does not redistribute market data. The tape stays on the machine that made
  it and is never committed, never uploaded and never served to a third party.
  Finished-session archives are also local and excluded from this public source
  release. Archive a session on the user's machine before it is needed for
  offline research; the repository intentionally ships no market history.
