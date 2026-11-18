// Text-level JSON helpers. They never go through JSON.parse -> stringify,
// so numbers, string escapes, key order and duplicate keys stay unchanged.

const QUOTE = 34;

/** Index just after the closing quote of the string that starts at `start`. */
export function scanString(src: string, start: number): number {
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 92) {
      i += 2;
      continue;
    }
    if (c === QUOTE) return i + 1;
    i++;
  }
  return n;
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** Removes all whitespace outside strings. Input must already be valid JSON. */
export function minifyJson(src: string): string {
  src = stripBom(src);
  const parts: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === QUOTE) {
      const j = scanString(src, i);
      parts.push(src.slice(i, j));
      i = j;
    } else if (isWs(c)) {
      i++;
    } else {
      let j = i + 1;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (d === QUOTE || isWs(d)) break;
        j++;
      }
      parts.push(src.slice(i, j));
      i = j;
    }
  }
  return parts.join('');
}

/** Pretty-prints valid JSON text without parsing it into values. `indent` is a space count or the indent text itself (for example "\t"). */
export function prettyJson(src: string, indent: number | string = 2): string {
  const min = minifyJson(src);
  const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const out: string[] = [];
  let depth = 0;
  const nl = () => '\n' + unit.repeat(depth);
  for (let i = 0; i < min.length; i++) {
    const c = min[i];
    if (c === '"') {
      const j = scanString(min, i);
      out.push(min.slice(i, j));
      i = j - 1;
    } else if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      if (min[i + 1] === close) {
        out.push(c + close);
        i++;
      } else {
        depth++;
        out.push(c + nl());
      }
    } else if (c === '}' || c === ']') {
      depth--;
      out.push(nl() + c);
    } else if (c === ',') {
      out.push(',' + nl());
    } else if (c === ':') {
      out.push(': ');
    } else {
      out.push(c);
    }
  }
  return out.join('');
}

export interface ValueSpan {
  start: number;
  end: number;
}

/** Splits text that holds several JSON values in a row (pretty or compact). */
export function splitJsonValues(src: string): ValueSpan[] {
  const spans: ValueSpan[] = [];
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    while (i < n && isWs(src.charCodeAt(i))) i++;
    if (i >= n) break;
    const start = i;
    const c = src[i];
    if (c === '{' || c === '[') {
      let depth = 0;
      while (i < n) {
        const d = src[i];
        if (d === '"') {
          i = scanString(src, i);
          continue;
        }
        if (d === '{' || d === '[') depth++;
        else if (d === '}' || d === ']') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        i++;
      }
    } else if (c === '"') {
      i = scanString(src, i);
    } else {
      while (i < n) {
        const d = src[i];
        if (isWs(d.charCodeAt(0)) || d === '{' || d === '[' || d === '"') break;
        i++;
      }
      if (i === start) i++;
    }
    spans.push({ start, end: i });
  }
  return spans;
}

/** 1-based line number of `offset` in `src`. */
export function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) if (src.charCodeAt(i) === 10) line++;
  return line;
}

export type CompactResult = { ok: true; text: string; count: number } | { ok: false; message: string; line: number };

/**
 * Turns text that holds JSON values (one per line, or pretty-printed over
 * several lines) into one compact value per line. Blank lines between values
 * stay. Nothing changes when any value is invalid.
 */
export function compactText(src: string, eol = '\n'): CompactResult {
  const spans = splitJsonValues(src);
  const out: string[] = [];
  let prev = 0;
  let count = 0;
  for (const s of spans) {
    const piece = src.slice(s.start, s.end);
    try {
      JSON.parse(piece);
    } catch (e) {
      return { ok: false, message: errorMessage(e), line: lineOf(src, s.start) };
    }
    // Blank lines between values stay: one line feed ends the value before, each further one is a blank line.
    let feeds = 0;
    for (let i = prev; i < s.start; i++) if (src.charCodeAt(i) === 10) feeds++;
    for (let i = count ? 1 : 0; i < feeds; i++) out.push('');
    out.push(minifyJson(piece));
    prev = s.end;
    count++;
  }
  return { ok: true, text: out.join(eol), count };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Character offset of a JSON.parse error, when the engine reports one. */
export function errorOffset(message: string): number | undefined {
  const m = /position (\d+)/.exec(message);
  return m ? Number(m[1]) : undefined;
}

export type ConvertResult =
  | { ok: true; to: 'jsonl' | 'json'; text: string; count: number }
  | { ok: false; message: string };

/** Splits the top-level element slices of a valid JSON array text `[ ... ]`, preserving exact tokens. */
function splitArrayItems(src: string): string[] {
  let i = src.indexOf('[') + 1;
  const end = src.lastIndexOf(']');
  const items: string[] = [];
  let depth = 0;
  let itemStart = -1;
  while (i < end) {
    const c = src.charCodeAt(i);
    if (isWs(c) && depth === 0 && itemStart < 0) {
      i++;
      continue;
    }
    if (itemStart < 0) itemStart = i;
    if (c === QUOTE) {
      i = scanString(src, i);
      continue;
    }
    if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) depth--;
    else if (c === 44 && depth === 0) {
      items.push(src.slice(itemStart, i).trim());
      itemStart = -1;
    }
    i++;
  }
  if (itemStart >= 0) {
    const tail = src.slice(itemStart, end).trim();
    if (tail) items.push(tail);
  }
  return items;
}

/**
 * Converts a JSON root array (`[...]`) to JSON Lines (one compact value per line), or JSON Lines
 * to a pretty-printed JSON array (`[\n  ...\n]`), without passing values through JSON.stringify
 * so >53-bit integers and exact token formatting stay intact.
 */
export function convertJsonAndJsonl(src: string, indent: number | string = 2, eol = '\n', preferJsonlInput?: boolean): ConvertResult {
  const clean = stripBom(src);
  const trimmed = clean.trim();
  if (!trimmed) return { ok: true, to: preferJsonlInput ? 'json' : 'jsonl', text: preferJsonlInput ? '[]' + eol : '', count: 0 };
  const spans = splitJsonValues(clean);
  if (spans.length === 1 && trimmed.startsWith('[') && !preferJsonlInput) {
    try {
      JSON.parse(trimmed);
      const items = splitArrayItems(trimmed).map((it) => minifyJson(it));
      return { ok: true, to: 'jsonl', text: items.length ? items.join(eol) + eol : '', count: items.length };
    } catch {
      // Fall through to JSONL handling or report parse error below.
    }
  }
  const unit = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const formatted: string[] = [];
  for (const s of spans) {
    const piece = clean.slice(s.start, s.end);
    try {
      JSON.parse(piece);
    } catch (e) {
      return { ok: false, message: errorMessage(e) };
    }
    const pretty = prettyJson(piece, unit)
      .split('\n')
      .map((l) => unit + l)
      .join(eol);
    formatted.push(pretty);
  }
  if (formatted.length === 1 && trimmed.startsWith('[') && preferJsonlInput) {
    // Even if preferJsonlInput was set, a single multi-line array in a .json file unpacks to JSONL when asked;
    // in a .jsonl file with 1 array record `[1,2]`, wrapping `[ [1, 2] ]` turns 1 JSONL record into a 1-item JSON array.
  }
  const body = formatted.length ? `[${eol}${formatted.join(',' + eol)}${eol}]${eol}` : `[]${eol}`;
  return { ok: true, to: 'json', text: body, count: formatted.length };
}
