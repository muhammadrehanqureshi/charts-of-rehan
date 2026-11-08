import { describe, expect, it } from "vitest";

import {
  MAX_SCRIPT_LINES,
  ScriptFileError,
  scriptFromText,
} from "./scriptFile";

describe("reading an indicator script file", () => {
  it("normalises a BOM, CRLF and trailing whitespace", () => {
    const loaded = scriptFromText("\uFEFFema(close, 20)  \r\nplot last\r\n", "My Study.pine");
    expect(loaded.source).toBe("ema(close, 20)\nplot last");
    expect(loaded.name).toBe("My Study");
  });

  it("takes the display name from a path, without its extension", () => {
    expect(scriptFromText("close", "C:\\studies\\vwap bands.pine").name)
      .toBe("vwap bands");
  });

  it("refuses an empty file with a sentence, not a parse error later", () => {
    expect(() => scriptFromText(" \r\n\t\r\n", "empty.pine"))
      .toThrow(ScriptFileError);
  });

  it("refuses a file over the parser's line limit", () => {
    const tooMany = Array.from({ length: MAX_SCRIPT_LINES + 1 }, () => "close").join("\n");
    expect(() => scriptFromText(tooMany, "long.pine"))
      .toThrow(new RegExp(`${MAX_SCRIPT_LINES}`));
  });

  it("keeps a file at the line limit", () => {
    const exact = Array.from({ length: MAX_SCRIPT_LINES }, () => "close").join("\n");
    expect(scriptFromText(exact, "exact.pine").source.split("\n"))
      .toHaveLength(MAX_SCRIPT_LINES);
  });
});
