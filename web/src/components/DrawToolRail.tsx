/**
 * The drawing rail: TradingView's left toolbar, for this chart.
 *
 * The tool order follows the terminal: the crosshair cursor first, then
 * the trend tools (trend line, flat top, flat bottom, horizontal line,
 * horizontal ray), then the measure ruler, then the chart management
 * group (hide all drawings, clear them). Every icon is an inline path -
 * the style is monochrome line icons on hover-lit squares, exactly the
 * felt language, without borrowing anyone's asset files.
 */

import { useEffect, useState } from "react";

import type { DrawTool } from "../chart/drawings";

export interface DrawToolRailProps {
  /** The active tool, or "cursor" when none is drawing. */
  readonly tool: DrawTool;
  readonly onTool: (tool: DrawTool) => void;
  /** All drawings hidden (the eye toggle). */
  readonly hidden: boolean;
  readonly onHideToggle: () => void;
  /** Drawing count on this chart, for the clear button's title. */
  readonly count: number;
  readonly onClear: () => void;
  /** A save click: flush the notebook on demand. */
  readonly onSave?: () => void;
  readonly disabled?: boolean;
}

function Icon({ name }: { readonly name: string }) {
  const common = {
    width: 19,
    height: 19,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (name) {
    case "cursor":
      return (
        <svg {...common}>
          <path d="M8.5 3.5v10.4L11 11l1.5 3.5 2-.8-1.6-3.6H16Z" />
        </svg>
      );
    case "trend":
      return (
        <svg {...common}>
          <path d="M4 15.5 16 5" />
          <circle cx="4" cy="15.5" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="16" cy="5" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    case "flatTop":
      return (
        <svg {...common}>
          <path d="M4 7.5h12" />
          <circle cx="4" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
          <path d="M7 12l4 4 4-4" strokeDasharray="2 2" />
        </svg>
      );
    case "flatBottom":
      return (
        <svg {...common}>
          <path d="M4 13h12" />
          <circle cx="16" cy="13" r="1.5" fill="currentColor" stroke="none" />
          <path d="M7 6l4-3 4 3" strokeDasharray="2 2" />
        </svg>
      );
    case "hline":
      return (
        <svg {...common}>
          <path d="M3 10h14" />
          <circle cx="10" cy="10" r="1.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "hray":
      return (
        <svg {...common}>
          <path d="M5 12H16" />
          <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
          <path d="M16 12l-2.2-1" strokeDasharray="1.6 1.6" />
          <path d="M16 12l-2.2 1" strokeDasharray="1.6 1.6" />
        </svg>
      );
    case "ob":
      return (
        <svg {...common}>
          <rect x="5" y="5.5" width="10" height="8.5" rx="0.6" />
          <path d="M3 10h1.6M15.4 10H17" strokeDasharray="1.6 1.6" />
        </svg>
      );
    case "measure":
      return (
        <svg {...common}>
          <path d="M5 13V9.4" strokeDasharray="2 2" />
          <path d="M13 7v3.6" strokeDasharray="2 2" />
          <path d="M5 11h8" />
          <circle cx="5" cy="11" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="13" cy="11" r="1.2" fill="currentColor" stroke="none" />
          <rect x="3.2" y="3.6" width="11.6" height="12.6" rx="1.4"
                strokeDasharray="2.6 2.2" strokeWidth="1" />
        </svg>
      );
    case "save":
      return (
        <svg {...common}>
          <path d="M4.5 4.5h9l2 2v9h-11v-11Z" />
          <path d="M7 4.5V8h6V4.5" />
          <rect x="7.2" y="10.6" width="5.6" height="5" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2.8 10s2.7-4.4 7.2-4.4 7.2 4.4 7.2 4.4-2.7 4.4-7.2 4.4S2.8 10 2.8 10Z" />
          <circle cx="10" cy="10" r="1.9" fill="currentColor" stroke="none" />
          <path d="M16.4 3.6 3.6 16.4" strokeWidth="1.2" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4.5 6h11" />
          <path d="M7.5 6V4.6h5V6" />
          <path d="M6 6v9.2h8V6" />
          <path d="M9 8.5v4.4M11 8.5v4.4" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="10" cy="10" r="3" />
        </svg>
      );
  }
}

const TOOLS: readonly {
  readonly tool: DrawTool;
  readonly label: string;
}[] = [
  { tool: "cursor", label: "Cross (the chart's own pointer)" },
  { tool: "trend", label: "Trend line (drag between two bars)" },
  { tool: "ob", label: "Order block (drag a box over the zone)" },
  { tool: "flatTop", label: "Flat top (drag along a ceiling)" },
  { tool: "flatBottom", label: "Flat bottom (drag along a floor)" },
  { tool: "hline", label: "Horizontal line (click a level)" },
  { tool: "hray", label: "Horizontal ray (click, extends right)" },
];

export function DrawToolRail(props: DrawToolRailProps) {
  const {
    tool, onTool, hidden, onHideToggle, count, onClear, onSave, disabled,
  } = props;
  // The save feedback: a short green flash on the icon, then it fades and
  // the icon is a plain diskette again.
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) {
      return undefined;
    }
    const timer = window.setTimeout(() => setSaved(false), 1600);
    return () => window.clearTimeout(timer);
  }, [saved]);
  const pick = (next: DrawTool) => {
    onTool(next === tool ? "cursor" : next);
  };
  const button = (
    active: boolean,
    name: string,
    label: string,
    onClick: () => void,
    keyPrefix = "t",
    extraClass = "",
  ) => (
    <button
      type="button"
      key={`${keyPrefix}-${name}`}
      className={
        (active ? "tv-rail__tool tv-rail__tool--on" : "tv-rail__tool")
        + (extraClass.length > 0 ? ` ${extraClass}` : "")
      }
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={name} />
    </button>
  );

  return (
    <nav className="tv-rail" aria-label="drawing tools">
      {button(tool === "cursor", "cursor", TOOLS[0]!.label, () => pick("cursor"))}
      <div className="tv-rail__sep" aria-hidden="true" />
      {TOOLS.slice(1).map((entry) => button(
        tool === entry.tool,
        entry.tool,
        entry.label,
        () => pick(entry.tool),
      ))}
      <div className="tv-rail__sep" aria-hidden="true" />
      {button(
        false,
        "measure",
        "Measure (drag, read, release - never kept)",
        () => pick("measure"),
      )}
      {button(
        false,
        "save",
        saved ? "Saved - the drawings on this chart are kept"
          : "Save drawings on this chart",
        () => {
          onSave?.();
          setSaved(true);
        },
        "m",
        saved ? "tv-rail__tool--saved" : "",
      )}
      <div className="tv-rail__gap" aria-hidden="true" />
      {button(
        hidden,
        "eye",
        hidden ? "Show all drawings" : "Hide all drawings",
        onHideToggle,
        "m",
      )}
      {button(
        false,
        "trash",
        count === 0
          ? "No drawings to clear"
          : `Clear all drawings (${count})`,
        onClear,
        "m",
      )}
    </nav>
  );
}
