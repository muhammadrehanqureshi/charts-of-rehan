/**
 * The per-minute buy/sell split, polled.
 *
 * The tape's counters grow during the session, so the split is re-read on
 * a one-second cadence: the server serves the ask from a streaming fold,
 * one tail stat plus a small parse, never a re-walk of the day. Nothing
 * here runs while the page is hidden or the chart is showing a stored
 * session that cannot move.
 */

import { useEffect, useRef, useState } from "react";

import type { ChartClient } from "../api/client.js";
import type { DeltaReport } from "../api/types.js";
import { useVisibility } from "./useVisibility.js";

export interface DeltaState {
  readonly report: DeltaReport | null;
  readonly error: string | null;
}

export function useDelta(
  client: ChartClient,
  symbol: string,
  day: string,
  enabled: boolean,
  intervalMs = 1_000,
): DeltaState {
  const [report, setReport] = useState<DeltaReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useVisibility();
  const runRef = useRef(0);

  useEffect(() => {
    if (!enabled || symbol.length === 0) {
      return;
    }
    runRef.current += 1;
    const run = runRef.current;
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async (): Promise<void> => {
      try {
        const next = await client.delta(symbol, day, controller.signal);
        if (cancelled || runRef.current !== run) {
          return;
        }
        setReport(next);
        setError(null);
      } catch (caught) {
        if (cancelled || runRef.current !== run || controller.signal.aborted) {
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        // One read on mount is what the chart already on screen needs; the
        // repeat reads wait until the page is in front of somebody.
        if (!cancelled && runRef.current === run && visible) {
          timer = setTimeout(poll, intervalMs);
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [client, symbol, day, enabled, intervalMs, visible]);

  return { report, error };
}
