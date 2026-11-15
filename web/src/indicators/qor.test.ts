/**
 * The full QoR study a reader pasted, not a reduced formula.
 *
 * It mixes Pine type declarations, drawing arrays, nested `if`/`for` blocks,
 * ATR offsets, pivots and a boolean input. The chart keeps only the last
 * numeric plot, but it must read the whole script without refusing it.
 */
import { describe, expect, it } from "vitest";

import { compileFormula, validateFormula } from "./expression";
import type { SeriesData } from "./types";

const QOR = String.raw`//@version=5
indicator("QoR", overlay=true, max_boxes_count=60)

// Visual-only chart overlay. Strategy trades, signal labels, and quantities are intentionally absent.
// Liquidity zones are confirmed swing-price references, NOT order-book liquidity.

string G_TREND = "Trend EMA"
int trendLen = input.int(200, "Trend EMA length", minval=20, group=G_TREND)
bool showTrendEMA = input.bool(true, "Show thick yellow Trend EMA", group=G_TREND)

string G_LIQ = "Liquidity zones"
int pivotLen = input.int(5, "Pivot confirmation bars", minval=2, maxval=20, group=G_LIQ)
float zoneHalfAtr = input.float(0.15, "Zone half-width (ATR)", minval=0.05, maxval=1.0, step=0.05, group=G_LIQ)
float maxZoneDistancePct = input.float(8.0, "Hide zones farther than current price (%)", minval=1.0, maxval=30.0, step=1.0, group=G_LIQ)
int maxZonesPerSide = input.int(6, "Maximum visible zones per side", minval=1, maxval=15, group=G_LIQ)
bool showZones = input.bool(true, "Show nearby liquidity boxes", group=G_LIQ)

float emaTrend = ta.ema(close, trendLen)
float atrValue = ta.atr(14)
float pivotHigh = ta.pivothigh(high, pivotLen, pivotLen)
float pivotLow = ta.pivotlow(low, pivotLen, pivotLen)
var box[] supplyBoxes = array.new_box()
var box[] demandBoxes = array.new_box()

if not na(pivotHigh)
    float pivotHighAtr = atrValue[pivotLen]
    float highDistancePct = close > 0 ? math.abs(pivotHigh / close - 1.0) * 100.0 : 1000.0
    if showZones and not na(pivotHighAtr) and highDistancePct <= maxZoneDistancePct
        float halfWidthHigh = math.max(syminfo.mintick, pivotHighAtr * zoneHalfAtr)
        box bHigh = box.new(left=bar_index-pivotLen, top=pivotHigh+halfWidthHigh, right=bar_index, bottom=pivotHigh-halfWidthHigh, xloc=xloc.bar_index, extend=extend.right, bgcolor=color.new(color.red, 90), border_color=color.new(color.red, 45))
        array.push(supplyBoxes, bHigh)
        if array.size(supplyBoxes) > maxZonesPerSide
            box.delete(array.shift(supplyBoxes))

if not na(pivotLow)
    float pivotLowAtr = atrValue[pivotLen]
    float lowDistancePct = close > 0 ? math.abs(pivotLow / close - 1.0) * 100.0 : 1000.0
    if showZones and not na(pivotLowAtr) and lowDistancePct <= maxZoneDistancePct
        float halfWidthLow = math.max(syminfo.mintick, pivotLowAtr * zoneHalfAtr)
        box bLow = box.new(left=bar_index-pivotLen, top=pivotLow+halfWidthLow, right=bar_index, bottom=pivotLow-halfWidthLow, xloc=xloc.bar_index, extend=extend.right, bgcolor=color.new(color.lime, 90), border_color=color.new(color.lime, 45))
        array.push(demandBoxes, bLow)
        if array.size(demandBoxes) > maxZonesPerSide
            box.delete(array.shift(demandBoxes))

// Remove zones once they are no longer near the current price.
if array.size(supplyBoxes) > 0
    for i = array.size(supplyBoxes) - 1 to 0
        box bx = array.get(supplyBoxes, i)
        float zoneMid = (box.get_top(bx) + box.get_bottom(bx)) / 2.0
        float zoneDistance = close > 0 ? math.abs(zoneMid / close - 1.0) * 100.0 : 1000.0
        if not showZones or zoneDistance > maxZoneDistancePct
            box.delete(bx)
            array.remove(supplyBoxes, i)
if array.size(demandBoxes) > 0
    for i = array.size(demandBoxes) - 1 to 0
        box bx = array.get(demandBoxes, i)
        float zoneMid = (box.get_top(bx) + box.get_bottom(bx)) / 2.0
        float zoneDistance = close > 0 ? math.abs(zoneMid / close - 1.0) * 100.0 : 1000.0
        if not showZones or zoneDistance > maxZoneDistancePct
            box.delete(bx)
            array.remove(demandBoxes, i)

plot(showTrendEMA ? emaTrend : na, "Trend EMA (Yellow)", color=color.yellow, linewidth=4)`;

function dataFor(closes: readonly number[]): SeriesData {
  const length = closes.length;
  const time = new Float64Array(length);
  const open = new Float64Array(length);
  const high = new Float64Array(length);
  const low = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);
  closes.forEach((value, index) => {
    time[index] = index * 60_000;
    open[index] = value;
    high[index] = value + 1;
    low[index] = value - 1;
    close[index] = value;
    volume[index] = 100 + index;
  });
  return { length, time, open, high, low, close, volume };
}

describe("QoR study", () => {
  it("reads the whole pasted script and draws its trend EMA", () => {
    expect(() => validateFormula(QOR)).not.toThrow();
    const out = compileFormula(QOR)(
      dataFor(Array.from({ length: 300 }, (_, index) => 100 + index)));
    expect(Number.isFinite(out[299])).toBe(true);
  });

  it("honours a true input.bool default", () => {
    const out = compileFormula(
      'flag = input.bool(true, "Show")\nflag ? close : na',
    )(dataFor([1, 2, 3]));
    expect(out[2]).toBeCloseTo(3);
  });
});