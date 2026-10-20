# Charts of Rehan, the web front end

React 18 and TypeScript, strict, no UI framework and no charting library. The
candles, viewport and indicator panes are drawn on a canvas by the renderer in
`src/chart/`, and the data layer is a typed client the tests drive with fake
transports.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173, /api proxied to http://127.0.0.1:8788
npm test           # 134 unit tests, no network, no browser
npm run typecheck  # tsc in strict mode over src and the Vite config
npm run build      # writes dist/, which the Python service can serve itself
```

Start the backend first (from the repository root):

```bash
python -m charts --source tape --port 8788
```

Then open the dev server, or build and let the service serve `web/dist`:

```bash
python -m charts --source tape --port 8788 --static web/dist
```

`vite.config.ts` holds the proxy target; change it there if you start the
service on another port. In a built deployment the service serves this bundle
itself, so the browser sees one origin in both cases and there is no CORS
preflight in normal use.

## How it is put together

```
src/
  api/types.ts        the server contract, typed and validated at the boundary
  api/client.ts       REST and SSE client: retries, timeouts, named failures
  chart/series.ts     typed-array series: upsert, window, aggregation
  chart/viewport.ts   pure pan, zoom, fit and follow rules
  chart/scale.ts      nice ticks and linear scales
  chart/format.ts     Karachi time and price formatting
  chart/render.ts     the canvas renderer: candles, volume, gaps, panes
  chart/timeframes.ts the twelve labels and their nominal widths
  indicators/         formula language, maths, registry and computation
  components/         ChartCanvas, Toolbar, Watchlist, IndicatorsPanel,
                      StatusBar, NotesPanel
  hooks/useChartFeed.ts   series, stream, status and metadata for one symbol
  hooks/useIndicators.ts  indicator instances, edited and persisted locally
  examples/CustomChart.tsx  a runnable chart with custom indicators
  App.tsx, main.tsx, styles.css
```

Three decisions shape the code.

**A payload is parsed, never cast.** `parsePayload` checks every field a chart
draws from, including that each timestamp carries a UTC offset, that bars are
ascending and unique, and that each bar's high and low are consistent with its
own open and close. A response that fails becomes a named `CONTRACT` error
rather than a chart of `undefined`s.

**React re-renders for metadata; the canvas repaints for pixels.** Bars live in
parallel `Float64Array` columns inside a ref. A poll, or a pointer move, marks
the canvas dirty and repaints from those arrays; nothing allocates per frame
and no hover re-renders the tree.

**Nothing is hidden.** The notes panel shows the series' own caveats, the
measured gaps and any ingest failure. The header shows which source the bars
came from and its delay. A status pill says `live`, `reconnecting` or
`closed`, and the stream reconnects with a bounded backoff instead of
pretending a dropped connection is still live.

## Rendering

`drawChart` is one function and one frame. It computes a price range over the
visible window, draws grid and axis labels from the tick maths, shades the
measured gaps with their minute count, draws candles, volume and indicator
panes, marks the last price, and draws a crosshair with an OHLCV readout when
the pointer is inside the plot.

When the visible window holds more bars than the plot has room for candles,
the series is folded into buckets first: `open` from the first bar of the
bucket, `high` and `low` from its extremes, `close` from its last bar, volume
summed. That is the exchange's own OHLC rule, and it means a session of
minutes still draws readable candles in a few hundred pixels. The underlying
minute series is untouched, so zooming back in shows every minute again.

The time axis always prints Karachi time (`Asia/Karachi`), never the viewer's
zone, matching the one clock rule the backend enforces (SO-8). The visible
window is owned by the reader: wheel and pinch zoom anchor at the pointer,
dragging pans, and `+`, `-`, `f` (fit), `n` (newest) and the arrow keys do the
same from the keyboard. A new bar extends a window that was following the
market and never moves one the reader panned away from.

`ChartCanvas` repaints from the typed arrays on an animation frame. Indicator
results are cached per bar version, so a pointer move does not recompute a
moving average. The server owns the twelve resolutions (`1s` through `1M`,
including `10s`, `10m` and `4h`); the toolbar only presents the ones the
running service says it serves. The two index buttons, `KSE100` and
`KMIALLSHR`, draw the session's computed breadth proxies and label them as
such, never as official exchange index levels.

Below 900px the layout becomes one scrolling column with the chart first, then
the watchlist and the indicator panel. Each panel has its own fixed height, so
the watchlist can never collapse to a border and an open keyboard does not
squeeze the candles out of existence.

## Custom indicators and a runnable example

The indicator registry separates a definition (`ema`, `bollinger`, `rsi`, ...)
from a configured instance (`ema` with period 9, a colour and a placement).
There is no cap on instances: the panel adds, removes, hides and recolours them,
and overlays share the price scale while pane indicators stack beneath volume.
The `formula` definition is a small safe expression language, not `eval`:

```
ema(close, 20) - ema(close, 50)
(close - sma(close, 20)) / stddev(close, 20)
roc(close, 10)
```

The editor validates the formula against a synthetic series before it is drawn,
so a call that compiles but cannot run says why. Instances are persisted in
local storage after field-by-field validation; a corrupt entry is dropped rather
than allowed to break the chart.

[`src/examples/CustomChart.tsx`](src/examples/CustomChart.tsx) is a complete
component: it opens the feed, initialises three custom instances (two overlays
and a formula pane), and passes them to `ChartCanvas` exactly as the terminal
does. It is mounted at `/?example=1`, so it can be run without copying a line;
copy the file into another application and mount `<CustomChart />` to use the
same initialisation on its own. There is no other setup beyond the service
running on the same origin.

## Known limits

* no offline caching of series, so a reload refetches history;
* no drawing tools (trendlines, annotations) beyond indicator lines;
* the computed index proxies are session breadth, not official PSX levels;
* the canvas renderer is verified by looking at it and through its pure
  viewport/series tests, not with pixel snapshots.

## Types and tooling

`tsconfig.json` runs with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`,
`noUnusedLocals` and `noUnusedParameters`. The test runner is Vitest in a Node
environment, because the tested modules are pure: a browser environment would
only slow the suite down without proving more.

The build is Vite. The decision to keep dependencies to React, Vite and the
type packages is deliberate: this front end reads one JSON contract and draws
candles, and a charting framework would have hidden the two things this
application most needs to be honest about (which bar came from where, and what
is missing).
