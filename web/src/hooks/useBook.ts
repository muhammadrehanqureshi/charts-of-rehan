/**
 * One symbol's top of the venue's own book, polled.
 *
 * The book rides the incremental day build the bars already cache, so an
 * answer costs the service one tail read, and the plate is refreshed to the
 * one-second tick with a stop condition - a stored
 * session never moves, and a hidden tab stops asking, the way the
 * never-hammer law asks of every repeating job. Reopening the tab fetches
 * once and the cadence resumes.
 */

import { useEffect, useRef, useState } from "react";

import { type BookReport, ChartClient } from "../api/client";
import { useVisibility } from "./useVisibility";

/** One refresh every second while the tab is shown. */
const BOOK_INTERVAL_MS = 1_000;

/**
 * @param client  the shared API client.
 * @param symbol  the symbol the plate belongs to.
 * @param day     the resolved session the chart is showing ("" lets the
 *                service follow its own newest session).
 * @param live    true when the chart itself is live; a stored session's
 *                book is its final observation and is fetched once.
 */
export function useBook(
  client: ChartClient,
  symbol: string,
  day: string,
  live: boolean,
): BookReport | null {
  const visible = useVisibility();
  const [report, setReport] = useState<BookReport | null>(null);
  const reportRef = useRef<BookReport | null>(null);

  useEffect(() => {
    if (symbol.length === 0) {
      reportRef.current = null;
      setReport(null);
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    let cancelled = false;
    const ask = async (): Promise<void> => {
      try {
        const next = await client.book(symbol, day, controller.signal);
        if (!cancelled) {
          reportRef.current = next;
          setReport(next);
        }
      } catch {
        // A cadence read reports the last good answer rather than a
        // failure state on top of the chart's own error plate; the next
        // tick tries again and the chart still says what happened.
      } finally {
        // Schedule after the response completes: a slow local file read can
        // never overlap another book request and pile work onto the PC.
        if (!cancelled && visible && live) {
          timer = window.setTimeout(() => void ask(), BOOK_INTERVAL_MS);
        }
      }
    };
    if (visible) {
      // Keep a successful quote on temporary tab refocus while the fresh
      // request is in flight; discard it only when the chart identity changes.
      if (reportRef.current !== null && reportRef.current.symbol !== symbol) {
        reportRef.current = null;
        setReport(null);
      }
      void ask();
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [client, symbol, day, visible, live]);

  return report;
}
