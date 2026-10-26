/**
 * A tiny, safe expression language for custom indicators.
 *
 * No `eval`, no `Function`, no property access, no loops: only numbers, the
 * seven series fields, arithmetic and a fixed set of vector functions. The
 * evaluator returns a Float64Array so every result can become an indicator
 * line, and an invalid formula is a named error rather than a dead canvas.
 *
 * Example formulas:
 *
 *     ema(close, 20) - ema(close, 50)
 *     rsi(close, 14)
 *     (close - sma(close, 20)) / stddev(close, 20)
 *     highest(high, 20) - lowest(low, 20)
 */

import {
  atr,
  elementwise,
  ema,
  filled,
  highest,
  lowest,
  rateOfChange,
  rsi,
  sma,
  standardDeviation,
} from "./math";
import type { SeriesData } from "./types";

export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

type Value = number | Float64Array;

interface Token {
  readonly kind: "number" | "ident" | "op" | "lparen" | "rparen" |
    "comma" | "assign" | "string" | "end";
  readonly text: string;
  readonly at: number;
}

type Node =
  | { kind: "number"; value: number }
  | { kind: "ref"; name: string }
  | { kind: "unary"; op: string; operand: Node }
  | { kind: "binary"; op: string; left: Node; right: Node }
  | { kind: "ternary"; cond: Node; then: Node; otherwise: Node }
  | { kind: "call"; name: string; args: Node[] };

const SERIES = new Set([
  "open", "high", "low", "close", "volume", "hl2", "ohlc4",
]);

const FUNCTIONS = new Set([
  "sma", "ema", "rsi", "atr", "stddev", "highest", "lowest", "roc",
  "change", "abs", "sqrt", "log", "exp", "min", "max", "nz", "obv",
  "plot", "hline", "round", "floor", "ceil", "pow", "sign", "shift",
  "stdev", "na",
]);

//: `color.yellow` and friends are settings, never values: a plot may name
//: them, and the formula simply has no colour to give them.
const SETTING_PREFIXES = [
  "color.", "shape.", "style.", "size.", "location.", "position.",
  "format.", "plot.", "display.", "scale.", "currency.", "barmerge.",
  "font.", "hline.",
];

/**
 * A whole script, not a one-line formula.
 *
 * The editor used to hold four hundred characters, which is less than a
 * single real indicator: a reader pasting their own study hit the ceiling
 * before the parser ever saw the maths. Eight thousand characters with four
 * thousand tokens is several screens of a Pine-style script and still ends.
 */
const MAX_SOURCE = 8_000;
const MAX_TOKENS = 4_096;
const MAX_DEPTH = 48;

/** Every statement of a script, so `x = ...` lines can be read back. */
type Statement =
  | { kind: "assign"; name: string; value: Node }
  | { kind: "expr"; value: Node };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  // A newline inside brackets continues the same statement, so a wrapped
  // call is not read as two broken ones.
  let brackets = 0;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (/\s/.test(character)) {
      // A newline or a semicolon ends one statement; plain spaces do not.
      const breaks = character === "\n" || character === "\r" ||
        (character === ";" && brackets === 0);
      if (breaks && brackets === 0) {
        const last = tokens[tokens.length - 1];
        if (last !== undefined && last.kind !== "end") {
          tokens.push({ kind: "end", text: character, at: index });
        }
      }
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(character)) {
      const start = index;
      while (index < source.length && /[0-9.]/.test(source[index] ?? "")) {
        index += 1;
      }
      if (/[eE]/.test(source[index] ?? "")) {
        index += 1;
        if (/[+-]/.test(source[index] ?? "")) {
          index += 1;
        }
        while (index < source.length && /[0-9]/.test(source[index] ?? "")) {
          index += 1;
        }
      }
      const text = source.slice(start, index);
      if (!Number.isFinite(Number(text))) {
        throw new FormulaError(`"${text}" is not a number (at ${start})`);
      }
      tokens.push({ kind: "number", text, at: start });
      continue;
    }
    if (character === "\"" || character === "'") {
      // A title, a tooltip, a colour name: a string is never a number, so it
      // is read as one token and dropped where a call cannot use it.
      const quote = character;
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === "\\" ? 2 : 1;
      }
      index += 1;
      tokens.push({ kind: "string", text: source.slice(start, index), at: start });
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? "")) {
        index += 1;
      }
      // A namespace (`ta.ema`, `math.max`, `color.yellow`) is one name, not
      // a member access this language does not have.
      while (source[index] === "." && /[A-Za-z_]/.test(source[index + 1] ?? "")) {
        index += 1;
        while (index < source.length && /[A-Za-z0-9_]/.test(source[index] ?? "")) {
          index += 1;
        }
      }
      tokens.push({ kind: "ident", text: source.slice(start, index), at: start });
      continue;
    }
    if (character === "(") {
      brackets += 1;
      tokens.push({ kind: "lparen", text: character, at: index });
      index += 1;
      continue;
    }
    if (character === ")") {
      brackets = Math.max(0, brackets - 1);
      tokens.push({ kind: "rparen", text: character, at: index });
      index += 1;
      continue;
    }
    if (character === ",") {
      tokens.push({ kind: "comma", text: character, at: index });
      index += 1;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === ">=" || pair === "<=" || pair === "==" || pair === "!=") {
      tokens.push({ kind: "op", text: pair, at: index });
      index += 2;
      continue;
    }
    if ("+-*/%^?:<>[ ]".includes(character) && character !== " ") {
      tokens.push({ kind: "op", text: character, at: index });
      index += 1;
      continue;
    }
    if (character === "=") {
      tokens.push({ kind: "assign", text: character, at: index });
      index += 1;
      continue;
    }
    throw new FormulaError(`unexpected character "${character}" at ${index}`);
  }
  while (tokens.length > 0 && tokens[tokens.length - 1]?.kind === "end") {
    tokens.pop();
  }
  if (tokens.length > MAX_TOKENS) {
    throw new FormulaError("the formula is too long to be safe");
  }
  return tokens;
}

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  parseProgram(): Statement[] {
    const statements: Statement[] = [];
    while (this.index < this.tokens.length) {
      if (this.peek()?.kind === "end") {
        this.take();
        continue;
      }
      const first = this.peek();
      const second = this.tokens[this.index + 1];
      if (first?.kind === "ident" && second?.kind === "assign") {
        this.take();
        this.take();
        const value = this.ternary();
        statements.push({
          kind: "assign", name: first.text.toLowerCase(), value,
        });
      } else {
        statements.push({ kind: "expr", value: this.ternary() });
      }
      const next = this.peek();
      if (next !== undefined && next.kind !== "end") {
        throw new FormulaError(
          `unexpected "${next.text}" at ${next.at} (each statement is one line)`);
      }
    }
    if (statements.length === 0) {
      throw new FormulaError("the formula is empty");
    }
    return statements;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private take(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) {
      throw new FormulaError("the formula ends too early");
    }
    this.index += 1;
    return token;
  }

  /** `cond ? a : b`, right associative, the way Pine writes a conditional plot. */
  private ternary(): Node {
    const cond = this.logic();
    if (this.peek()?.kind === "op" && this.peek()?.text === "?") {
      this.take();
      const then = this.ternary();
      const colon = this.take();
      if (colon.kind !== "op" || colon.text !== ":") {
        throw new FormulaError(`"?" needs a matching ":" (at ${colon.at})`);
      }
      const otherwise = this.ternary();
      return { kind: "ternary", cond, then, otherwise };
    }
    return cond;
  }

  /** Pine's `and`/`or`, which bind looser than a comparison and tighter
   * than the ternary. */
  private logic(): Node {
    let left = this.comparison();
    while (this.peek()?.kind === "ident" &&
           ["and", "or"].includes(this.peek()?.text.toLowerCase() ?? "")) {
      const op = this.take().text.toLowerCase();
      const right = this.comparison();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  /** `<`, `<=`, `>`, `>=`, `==`, `!=`: 1 is true, 0 is false. */
  private comparison(): Node {
    let left = this.additive();
    while (this.peek()?.kind === "op" &&
           [">", "<", ">=", "<=", "==", "!="]
             .includes(this.peek()?.text ?? "")) {
      const op = this.take().text;
      const right = this.additive();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private additive(): Node {
    let left = this.multiplicative();
    while (this.peek()?.kind === "op" &&
           ((this.peek()?.text ?? "") === "+" ||
            (this.peek()?.text ?? "") === "-")) {
      const op = this.take().text;
      const right = this.multiplicative();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private multiplicative(): Node {
    let left = this.power();
    while (this.peek()?.kind === "op" &&
           ["*", "/", "%"].includes(this.peek()?.text ?? "")) {
      const op = this.take().text;
      const right = this.power();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private power(): Node {
    const left = this.unary();
    if (this.peek()?.kind === "op" && this.peek()?.text === "^") {
      this.take();
      return { kind: "binary", op: "^", left, right: this.power() };
    }
    return left;
  }

  private unary(): Node {
    if (this.peek()?.kind === "ident"
        && this.peek()?.text.toLowerCase() === "not") {
      this.take();
      return { kind: "unary", op: "not", operand: this.unary() };
    }
    if (this.peek()?.kind === "op" &&
        ((this.peek()?.text ?? "") === "-" ||
         (this.peek()?.text ?? "") === "+")) {
      const op = this.take().text;
      return { kind: "unary", op, operand: this.unary() };
    }
    return this.postfix(this.primary());
  }

  /** `close[1]`: the value `n` bars back, read as a shift of the series. */
  private postfix(node: Node): Node {
    let value = node;
    while (this.peek()?.kind === "op" && this.peek()?.text === "[") {
      this.take();
      const back = this.ternary();
      const close = this.take();
      if (close.kind !== "op" || close.text !== "]") {
        throw new FormulaError(`"[" needs a matching "]" (at ${close.at})`);
      }
      value = { kind: "call", name: "shift", args: [value, back] };
    }
    return value;
  }

  /**
   * One call argument.
   *
   * A string is a title, and a `name=value` pair is a setting (`color`,
   * `linewidth`) or an input the study names. Titles and settings are
   * dropped, but a numeric input keeps its value so a Pine call written with
   * named arguments still reads positionally.
   */
  private argument(args: Node[]): void {
    if (this.peek()?.kind === "string") {
      this.take();
      return;
    }
    const first = this.peek();
    const second = this.tokens[this.index + 1];
    if (first?.kind === "ident" && second?.kind === "assign") {
      const name = first.text.toLowerCase();
      this.take();
      this.take();
      const value = this.ternary();
      if (["length", "period", "source", "src", "value", "series"]
        .includes(name)) {
        args.push(value);
      }
      return;
    }
    args.push(this.ternary());
  }

  private primary(): Node {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaError("the formula is nested too deeply");
    }
    const token = this.take();
    if (token.kind === "number") {
      this.depth -= 1;
      return { kind: "number", value: Number(token.text) };
    }
    if (token.kind === "ident") {
      const name = token.text.toLowerCase();
      if (this.peek()?.kind === "lparen") {
        if (!FUNCTIONS.has(name)) {
          throw new FormulaError(`unknown function "${token.text}"`);
        }
        this.take();
        const args: Node[] = [];
        if (this.peek()?.kind !== "rparen") {
          this.argument(args);
          while (this.peek()?.kind === "comma") {
            this.take();
            this.argument(args);
          }
        }
        if (this.take().kind !== "rparen") {
          throw new FormulaError(`"${token.text}" is missing a closing ")"`);
        }
        this.depth -= 1;
        return { kind: "call", name, args };
      }
      // A bare name may be a variable an earlier line assigned; the parser
      // cannot know that, so the check happens when the script runs.
      this.depth -= 1;
      return { kind: "ref", name };
    }
    if (token.kind === "lparen") {
      const node = this.ternary();
      if (this.take().kind !== "rparen") {
        throw new FormulaError("missing a closing \")\"");
      }
      this.depth -= 1;
      return node;
    }
    if (token.kind === "end") {
      throw new FormulaError(`the statement ends too early (at ${token.at})`);
    }
    throw new FormulaError(`unexpected "${token.text}" at ${token.at}`);
  }
}

function asArray(value: Value, length: number): Float64Array {
  if (typeof value === "number") {
    return filled(length, value);
  }
  return value;
}

function map(value: Value, length: number, fn: (x: number) => number): Value {
  if (typeof value === "number") {
    return fn(value);
  }
  const out = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    out[index] = fn(value[index] ?? Number.NaN);
  }
  return out;
}

function binary(
  left: Value,
  right: Value,
  length: number,
  fn: (a: number, b: number) => number,
): Value {
  if (typeof left === "number" && typeof right === "number") {
    return fn(left, right);
  }
  return elementwise(left, right, length, (a, b) => fn(a, b));
}

function scalar(value: Value, name: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new FormulaError(`${name} needs a single number`);
}

function seriesValue(value: Value, _name: string, length: number): Float64Array {
  if (typeof value === "number") {
    return filled(length, value);
  }
  return value;
}

function safe(value: number): number {
  return Number.isFinite(value) ? value : Number.NaN;
}

/** How many brackets a line opens minus how many it closes. */
function bracketDelta(line: string): number {
  let delta = 0;
  for (const character of line) {
    if (character === "(") {
      delta += 1;
    } else if (character === ")") {
      delta -= 1;
    }
  }
  return delta;
}

/** `//` to the end of the line, the way the editor's own scripts comment. */
function stripComment(line: string): string {
  const at = line.indexOf("//");
  return at === -1 ? line : line.slice(0, at);
}

/**
 * Replace `input.int(5, "len")` and friends with their first number.
 *
 * A pasted Pine study usually opens with its inputs. This language has no
 * settings dialog to hang them on, so the sensible reading is the literal
 * value the script was written with - the alternative is refusing the whole
 * script over a line that only describes a default.
 */
function replaceInputs(text: string): string {
  let out = text;
  let guard = 0;
  while (guard < 32) {
    guard += 1;
    const match = /\binput(?:\.\w+)?\s*\(/.exec(out);
    if (match === null) {
      break;
    }
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let index = open; index < out.length; index += 1) {
      const character = out[index];
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close < 0) {
      break;
    }
    const args = out.slice(open + 1, close);
    const number = /-?\d+(?:\.\d+)?/.exec(args)?.[0] ?? "0";
    out = out.slice(0, match.index) + number + out.slice(close + 1);
  }
  return out;
}

/**
 * Read a pasted Pine study as the formula it describes.
 *
 * This is a translator for the shapes a study actually uses - the version
 * banner, `//` comments, the `indicator(...)`/`study(...)` declaration, the
 * `ta.` namespace, `var` and `input.*` defaults - not a Pine interpreter.
 * Anything outside the formula language is still refused with a named error,
 * which is the honest answer: a script quietly drawing something else would
 * be worse than a refusal.
 */
/** A declaration, a shape or an alert: a line that draws, never a value. */
const DROPPED_CALL = new RegExp(
  "^\\s*(indicator|study|strategy|plotshape|plotchar|plotarrow|" +
  "plotcandle|plotbar|bgcolor|barcolor|alertcondition|alert|fill|" +
  "fill_between|table|log)\\s*\\(",
);

/** A drawing object or a collection: `box.delete(bx)`, `array.push(xs, i)`. */
const DROPPED_NAMESPACE = new RegExp(
  "^\\s*(?:[A-Za-z_]\\w*\\s*(?::?=)\\s*)?(box|line|label|table|array|" +
  "strategy|request|ticker|polyline|map|matrix)\\.",
);

/** Pine's statement blocks are always drawings or guards; neither can plot. */
const DROPPED_BLOCK = /^\s*(if|else|for|while|switch)\b/;

/** A statement that names a Pine type before the value, e.g. `float x = ...`. */
const TYPE_PREFIX = /^\s*(?:(?:simple|series)\s+)*(bool|int|float|string|color)\s+(?=[A-Za-z_][A-Za-z0-9_]*\s*[:=])/;

export function normaliseScript(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  let skipping = 0;
  // The indentation whose indented body is being dropped with its `if`.
  let blockIndent = -1;
  // A kept statement that opened a bracket and is still waiting for its own
  // closing one: Pine wraps a long call across lines, and the wrap is one
  // statement, not a second one.
  let pending: string[] | null = null;
  let pendingDelta = 0;
  for (const raw of lines) {
    const line = stripComment(raw);
    const indent = /^\s*/.exec(raw)?.[0].length ?? 0;
    if (blockIndent >= 0) {
      if (line.trim().length === 0) {
        continue;
      }
      if (indent > blockIndent) {
        continue;
      }
      blockIndent = -1;
    }
    if (skipping > 0) {
      skipping += bracketDelta(line);
      continue;
    }
    if (pending !== null) {
      // Consumed inside the wrap that nothing may interrupt except the
      // statement's own closing bracket.
      pending.push(line);
      pendingDelta += bracketDelta(line);
      if (pendingDelta > 0) {
        continue;
      }
      const wrapped = pending.join(" ").trim().replace(TYPE_PREFIX, "");
      pending = null;
      kept.push(wrapped);
      continue;
    }
    // A declaration and a drawing this language cannot express (a shape, a
    // colour, an alert, a box, an array) are dropped - with every line they
    // wrap - rather than allowed to fail the whole study.
    if (DROPPED_CALL.test(line) || DROPPED_NAMESPACE.test(line)) {
      const delta = bracketDelta(line);
      skipping = delta > 0 ? delta : 0;
      continue;
    }
    if (DROPPED_BLOCK.test(line)) {
      blockIndent = indent;
      continue;
    }
    if (line.trim().length === 0) {
      continue;
    }
    const opened = bracketDelta(line);
    if (opened > 0) {
      pending = [line];
      pendingDelta = opened;
      continue;
    }
    // `var float G_TREND = na` is a statement about one value: the storage
    // word and the type word are Pine's, and this language stores what the
    // statement stores.
    kept.push(
      line.replace(/^\s*var(?:ip)?\s+/, "").replace(TYPE_PREFIX, ""));
  }
  let text = kept.join("\n");
  text = replaceInputs(text);
  text = text.replace(/\b(?:ta|math)\.(\w+)/g, "$1");
  text = text.replace(/\bvarip\s+/g, "");
  text = text.replace(/\bvar\s+/g, "");
  // Pine's reassignment is an assignment here: the language has no "this bar
  // replaces that one", it evaluates the script once over the whole series.
  text = text.replace(/:=/g, "=");
  return text.trim();
}

/**
 * The home a pasted Pine study declares for itself.
 *
 * `indicator("Trend EMA", overlay=true)` says the study belongs over the
 * candles; a script that says nothing is an oscillator and keeps its own pane.
 * Reading the declaration is the difference between a formula landing where its
 * author meant it and it being exiled to a pane nobody asked for.
 */
export function placementFromScript(
  source: string,
): "overlay" | "pane" | null {
  const match = /overlay\s*=\s*(true|false)/i.exec(source);
  if (match === null) {
    return null;
  }
  return match[1]?.toLowerCase() === "true" ? "overlay" : "pane";
}

/**
 * Name the line a formula error happened on.
 *
 * "unexpected \"G_TREND\" at 7" is only as useful as the line it points at,
 * so a parse error in a statement stream is re-raised with the statement's
 * own text attached: the reader can see which line spoke wrong, not just
 * where in a joined stream of them.
 */
function withLine(error: FormulaError, clean: string): FormulaError {
  const match = / at (\d+)(?:$|\s|\))/.exec(error.message);
  const at = match === null ? -1 : Number.parseInt(match[1] ?? "-1", 10);
  if (!Number.isFinite(at) || at < 0) {
    return error;
  }
  let start = 0;
  let number = 1;
  for (const line of clean.split("\n")) {
    const end = start + line.length;
    if (at <= end) {
      const text = line.trim();
      if (text.length > 0) {
        return new FormulaError(
          `${error.message} — statement ${number}: "${text}"`);
      }
      return error;
    }
    start = end + 1;
    number += 1;
  }
  return error;
}

export function compileFormula(source: string): (data: SeriesData) => Float64Array {
  const clean = normaliseScript(source).trim();
  if (clean.length === 0) {
    throw new FormulaError("the formula is empty");
  }
  if (clean.length > MAX_SOURCE) {
    throw new FormulaError(`the formula is longer than ${MAX_SOURCE} characters`);
  }
  let program: Statement[];
  try {
    program = new Parser(tokenize(clean)).parseProgram();
  } catch (error) {
    throw error instanceof FormulaError
      ? withLine(error, clean)
      : error;
  }
  const env = new Map<string, Value>();

  const evaluate = (node: Node, data: SeriesData): Value => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "ref": {
        const held = env.get(node.name);
        if (held !== undefined) {
          return held;
        }
        switch (node.name) {
          case "na": return Number.NaN;
          case "true": return 1;
          case "false": return 0;
          case "bar_index": {
            const bars = new Float64Array(data.length);
            for (let index = 0; index < data.length; index += 1) {
              bars[index] = index;
            }
            return bars;
          }
          default: break;
        }
        if (SETTING_PREFIXES.some((prefix) => node.name.startsWith(prefix))) {
          // A colour or a shape is a setting, never a number: it can sit in a
          // call without being drawn, and it must not fail the study.
          return Number.NaN;
        }
        if (!SERIES.has(node.name)) {
          throw new FormulaError(`unknown series or variable "${node.name}"`);
        }
        switch (node.name) {
          case "open": return data.open;
          case "high": return data.high;
          case "low": return data.low;
          case "close": return data.close;
          case "volume": return data.volume;
          case "hl2": return binary(data.high, data.low, data.length,
            (a, b) => (a + b) / 2);
          case "ohlc4": return binary(
            binary(data.open, data.high, data.length, (a, b) => a + b),
            binary(data.low, data.close, data.length, (a, b) => a + b),
            data.length,
            (a, b) => a / 4 + b / 4,
          );
          default:
            throw new FormulaError(`unknown series "${node.name}"`);
        }
      }
      case "unary": {
        const operand = evaluate(node.operand, data);
        return map(operand, data.length,
          (x) => node.op === "-" ? -x
            : node.op === "not" ? (x === 0 ? 1 : 0) : x);
      }
      case "ternary": {
        const cond = evaluate(node.cond, data);
        const yes = evaluate(node.then, data);
        const no = evaluate(node.otherwise, data);
        const length = data.length;
        if (typeof cond === "number" && typeof yes === "number"
          && typeof no === "number") {
          return cond > 0 ? yes : no;
        }
        const out = new Float64Array(length);
        for (let index = 0; index < length; index += 1) {
          const pick = typeof cond === "number" ? cond : (cond[index] ?? Number.NaN);
          out[index] = pick > 0
            ? (typeof yes === "number" ? yes : (yes[index] ?? Number.NaN))
            : (typeof no === "number" ? no : (no[index] ?? Number.NaN));
        }
        return out;
      }
      case "binary": {
        const left = evaluate(node.left, data);
        const right = evaluate(node.right, data);
        return binary(left, right, data.length, (a, b) => {
          switch (node.op) {
            case "+": return safe(a + b);
            case "-": return safe(a - b);
            case "*": return safe(a * b);
            case "/": return b === 0 ? Number.NaN : safe(a / b);
            case "%": return b === 0 ? Number.NaN : safe(a % b);
            case "^": return safe(Math.pow(a, b));
            case ">": return a > b ? 1 : 0;
            case "<": return a < b ? 1 : 0;
            case ">=": return a >= b ? 1 : 0;
            case "<=": return a <= b ? 1 : 0;
            case "==": return a === b ? 1 : 0;
            case "!=": return a !== b ? 1 : 0;
            case "and": return a !== 0 && b !== 0 ? 1 : 0;
            case "or": return a !== 0 || b !== 0 ? 1 : 0;
            default: throw new FormulaError(`unknown operator "${node.op}"`);
          }
        });
      }
      case "call": {
        const args = node.args.map((arg) => evaluate(arg, data));
        const length = data.length;
        switch (node.name) {
          case "sma":
            return sma(seriesValue(args[0] ?? Number.NaN, "sma", length),
              scalar(args[1] ?? Number.NaN, "sma period"));
          case "ema":
            return ema(seriesValue(args[0] ?? Number.NaN, "ema", length),
              scalar(args[1] ?? Number.NaN, "ema period"));
          case "rsi":
            return rsi(seriesValue(args[0] ?? Number.NaN, "rsi", length),
              args.length > 1 ? scalar(args[1] ?? 14, "rsi period") : 14);
          case "atr":
            if (args.length === 1) {
              return atr(data.high, data.low, data.close,
                scalar(args[0] ?? 14, "atr period"));
            }
            return atr(
              seriesValue(args[0] ?? Number.NaN, "atr high", length),
              seriesValue(args[1] ?? Number.NaN, "atr low", length),
              seriesValue(args[2] ?? Number.NaN, "atr close", length),
              scalar(args[3] ?? 14, "atr period"));
          case "stddev":
            return standardDeviation(
              seriesValue(args[0] ?? Number.NaN, "stddev", length),
              scalar(args[1] ?? 20, "stddev period"));
          case "highest":
            return highest(
              seriesValue(args[0] ?? Number.NaN, "highest", length),
              scalar(args[1] ?? 20, "highest period"));
          case "lowest":
            return lowest(
              seriesValue(args[0] ?? Number.NaN, "lowest", length),
              scalar(args[1] ?? 20, "lowest period"));
          case "roc":
            return rateOfChange(
              seriesValue(args[0] ?? Number.NaN, "roc", length),
              scalar(args[1] ?? 10, "roc period"));
          case "change": {
            const values = seriesValue(args[0] ?? Number.NaN, "change", length);
            const period = args.length > 1
              ? Math.max(1, Math.floor(scalar(args[1] ?? 1, "change period")))
              : 1;
            const out = filled(length);
            for (let index = period; index < length; index += 1) {
              out[index] = (values[index] ?? 0) - (values[index - period] ?? 0);
            }
            return out;
          }
          case "abs": return map(args[0] ?? Number.NaN, length, Math.abs);
          case "sqrt": return map(args[0] ?? Number.NaN, length,
            (x) => x < 0 ? Number.NaN : Math.sqrt(x));
          case "log": return map(args[0] ?? Number.NaN, length,
            (x) => x <= 0 ? Number.NaN : Math.log(x));
          case "exp": return map(args[0] ?? Number.NaN, length, Math.exp);
          case "min": return binary(args[0] ?? Number.NaN, args[1] ?? Number.NaN,
            length, Math.min);
          case "max": return binary(args[0] ?? Number.NaN, args[1] ?? Number.NaN,
            length, Math.max);
          case "shift": {
            // `close[1]` is the value one bar back: the series moved forward,
            // with na before the first bar it could reach.
            const values = seriesValue(args[0] ?? Number.NaN, "shift", length);
            const back = Math.max(0,
              Math.round(scalar(args[1] ?? 1, "shift offset")));
            const out = filled(length);
            for (let index = back; index < length; index += 1) {
              out[index] = values[index - back] ?? Number.NaN;
            }
            return out;
          }
          case "round": {
            const digits = args.length > 1
              ? Math.max(0, Math.round(scalar(args[1] ?? 0, "round digits")))
              : 0;
            const factor = Math.pow(10, digits);
            return map(args[0] ?? Number.NaN, length,
              (x) => Math.round(x * factor) / factor);
          }
          case "floor": return map(args[0] ?? Number.NaN, length, Math.floor);
          case "ceil": return map(args[0] ?? Number.NaN, length, Math.ceil);
          case "sign": return map(args[0] ?? Number.NaN, length, Math.sign);
          case "pow": return binary(args[0] ?? Number.NaN, args[1] ?? Number.NaN,
            length, Math.pow);
          case "stdev":
            return standardDeviation(
              seriesValue(args[0] ?? Number.NaN, "stdev", length),
              scalar(args[1] ?? 20, "stdev period"));
          case "na":
            // `na(x)` is the test, `na` alone is the value: both are Pine.
            return map(args[0] ?? Number.NaN, length,
              (x) => Number.isNaN(x) ? 1 : 0);
          case "nz": {
            const fallback = args.length > 1
              ? scalar(args[1] ?? 0, "nz fallback")
              : 0;
            return map(args[0] ?? Number.NaN, length,
              (x) => Number.isNaN(x) ? fallback : x);
          }
          case "obv": {
            const close = seriesValue(args[0] ?? data.close, "obv close", length);
            const volume = seriesValue(args[1] ?? data.volume, "obv volume", length);
            const out = filled(length);
            let running = 0;
            for (let index = 0; index < length; index += 1) {
              if (index > 0) {
                const move = (close[index] ?? 0) - (close[index - 1] ?? 0);
                running += move > 0 ? (volume[index] ?? 0)
                  : move < 0 ? -(volume[index] ?? 0) : 0;
              }
              out[index] = running;
            }
            return out;
          }
          case "plot":
          case "hline":
            return args[0] ?? Number.NaN;
          default:
            throw new FormulaError(`unknown function "${node.name}"`);
        }
      }
    }
  };

  return (data: SeriesData): Float64Array => {
    env.clear();
    let result: Value = Number.NaN;
    for (const statement of program) {
      result = evaluate(statement.value, data);
      if (statement.kind === "assign") {
        // A script's last line is the line it draws, assignment or not: a
        // reader who names their study still expects to see it.
        env.set(statement.name, result);
      }
    }
    return asArray(result, data.length);
  };
}

/**
 * Compile a formula and run it once against a synthetic, well-formed series.
 *
 * The editor uses this instead of only compiling: syntax can be perfect while
 * a call is still impossible (`sma(close, close)`), and the reader deserves
 * that sentence in the panel rather than a silently missing line. The sample
 * is never drawn and never touches the live bars.
 */
export function validateFormula(source: string): void {
  const run = compileFormula(source);
  const length = 16;
  const time = new Float64Array(length);
  const open = new Float64Array(length);
  const high = new Float64Array(length);
  const low = new Float64Array(length);
  const close = new Float64Array(length);
  const volume = new Float64Array(length);
  for (let index = 0; index < length; index += 1) {
    const price = 100 + index;
    time[index] = index * 60_000;
    open[index] = price;
    high[index] = price + 1;
    low[index] = price - 1;
    close[index] = price + 0.5;
    volume[index] = 1_000 + index;
  }
  run({ length, time, open, high, low, close, volume });
}
