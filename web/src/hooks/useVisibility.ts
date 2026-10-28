/**
 * Whether the page is in front of the reader.
 *
 * A chart left in a background tab must not keep a stream open, keep polling
 * the tape or keep parsing the same JSON every few seconds: that is a laptop
 * working for a page nobody is looking at. Everything that polls reads this
 * and stops while it is false, then catches up once on the way back.
 *
 * The boundary is the tab's own hidden/visible state, which
 * ``visibilitychange`` already carries. Window focus is deliberately not
 * part of the answer: a chart the reader can see but whose window lacks the
 * keyboard focus (a split screen, a second monitor) is a chart somebody is
 * reading, and freezing it because something else got clicked is the
 * "stopped ticking" morning.
 */

import { useEffect, useState } from "react";

function now(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState !== "hidden";
}

export function useVisibility(): boolean {
  const [visible, setVisible] = useState(now);

  useEffect(() => {
    const change = () => setVisible(now());
    document.addEventListener("visibilitychange", change);
    return () => {
      document.removeEventListener("visibilitychange", change);
    };
  }, []);

  return visible;
}
