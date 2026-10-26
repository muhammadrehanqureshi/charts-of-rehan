/**
 * One symbol's top of the venue's own book, polled.
 *
 * The book is not a poller that scans: the read rides the day build the
 * bars already cache, so an answer costs the service one dictionary lookup,
 * and the plate is refreshed on a cadence with a stop condition - a stored
 * session never moves, and a hidden tab stops asking, the way the
 * never-hammer law asks of every repeating job. Reopening the tab fetches
 * once and the cadence resumes.
 */

import { useEffect, useState } from "react";

import { type BookReport, ChartClient } from "../api/client";
import { useVisibility } from "./useVisibility";

/** One refresh every five seconds while the tab is shown. */
const BOOK_INTERVAL_MS = 5_000;

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

  useEffect(() => {
    if (symbol.length === 0) {
      setReport(null);
      return;
    }
    const controller = new AbortController();
    let timer: number | undefined;
    let cancelled = false;
    const ask = (): void => {
      void client.book(symbol, day, controller.signal)
        .then((next) => {
          if (!cancelled) {
            setReport(next);
          }
        })
        .catch(() => {
          // A cadence read reports the last good answer rather than a
          // failure state on top of the chart's own error plate; the next
          // tick tries again and the chart still says what happened.
        });
    };
    ask();
    if (visible && live) {
      timer = window.setInterval(ask, BOOK_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
    };
  }, [client, symbol, day, visible, live]);

  return report;
}
