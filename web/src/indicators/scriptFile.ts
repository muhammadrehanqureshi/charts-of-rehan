/**
 * Reading a custom indicator from a file.
 *
 * The chart already accepts a pasted Pine-style study; this is the same door
 * for a reader who keeps studies in files. The browser hands over text, and
 * the only work here is to make it the text the parser expects: no byte-order
 * mark, Unix newlines, no trailing spaces, and a bounded size so one enormous
 * file cannot freeze the dialog.
 *
 * The parser itself stays the authority on the language. A file that is too
 * big or empty is refused with a sentence; a file that does not parse is
 * refused later by the formula validation, with the parser's own error.
 */

export const MAX_SCRIPT_LINES = 1_000;
export const MAX_SCRIPT_BYTES = 512_000;

export class ScriptFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptFileError";
  }
}

export interface LoadedScript {
  /** The normalised source, ready for the formula parameter. */
  readonly source: string;
  /** A display name taken from the file's own name. */
  readonly name: string;
}

/** Drop the directory, extension and any leading dots from a file name. */
function nameFromFile(fileName: string): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "").trim();
  return (base.length > 0 ? base : "Custom script").slice(0, 60);
}

/**
 * Normalise one script's text, or explain why it cannot be used.
 *
 * Line count is checked after normalisation, because CRLF and a trailing
 * blank line are not study lines. The parser's own limit is 1,000 lines; the
 * byte ceiling is deliberately generous enough for that many long lines.
 */
export function scriptFromText(text: string, fileName = "indicator"): LoadedScript {
  const source = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+$/, "");
  if (source.trim().length === 0) {
    throw new ScriptFileError("that file is empty; choose a saved study.");
  }
  if (source.length > MAX_SCRIPT_BYTES) {
    throw new ScriptFileError(
      `that file is ${Math.ceil(source.length / 1024)} KB; the limit is ` +
      `${MAX_SCRIPT_BYTES / 1024} KB.`);
  }
  const lines = source.split("\n").length;
  if (lines > MAX_SCRIPT_LINES) {
    throw new ScriptFileError(
      `that file has ${lines} lines; the limit is ${MAX_SCRIPT_LINES}.`);
  }
  return { source, name: nameFromFile(fileName) };
}
