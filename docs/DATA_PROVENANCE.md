# Data provenance

A chart is only as honest as its statement of where its bars came from. This
document is that statement.

## Where first minute bars come from

The `tape` source reads a read-only recording of the exchange's own market feed.
The recorder subscribes to the venue for the eligible symbol universe, writes
every frame it receives verbatim to an append only file under `data/`, and exits;
it never sends an order, never logs in and never reconnects into a session it was
not asked to be in.

Measured on the live venue, 2026-10-16, inside a trading band:

| Fact | Measurement |
|---|---|
| sweeps per connection | exactly 32 full market sweeps, then silence |
| rows per sweep | about 315 symbols |
| refresh achieved by the recorder | one burst every 23 seconds while it is running, after a stall watchdog was added |
| stall without the watchdog | silence of 150 to 363 seconds while the socket looked healthy |
| bar resolution built from the tape | 1 minute, by `src/data/tape_bars.py` |
| tape growth | about 13 KB per second while the venue is pushing |

Those numbers are the reason the chart says "1m from the tape" rather than
claiming a tick feed: the venue pushes bursts, not a continuous stream, and every
bar in a payload is a completed minute built from banked prints.

### The two honest limits of the tape source

1. **Coverage.** A minute that the recorder did not capture is a gap, and it is
   reported as a measured gap rather than interpolated. A symbol whose trading
   did not print in a minute carries the previous close across the gap, and those
   carried bars are counted separately in the payload's notes.
2. **Late starts.** A series that begins mid session says when it begins and how
   many session minutes it did not see, instead of drawing the whole morning as
   one enormous gap.

## Where the portal source's session bar comes from

The `portal` source reads a public company page and takes the session panel the
exchange itself publishes. Measured 2026-10-14, `/timeseries/eod/{symbol}`
answered an HTML shell and `/timeseries/int/{symbol}` answered 404, so this source
claims **one bar per trading day, about five minutes delayed**, and it does not
claim an intraday series at all. A cleared panel is a named failure against that
symbol, never a zero bar.

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
