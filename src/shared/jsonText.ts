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
 * several lines) into one compact value per line. Nothing changes when any
 * value is invalid.
 */
export function compactText(src: string, eol = '\n'): CompactResult {
  const spans = splitJsonValues(src);
  const out: string[] = [];
  for (const s of spans) {
    const piece = src.slice(s.start, s.end);
    try {
      JSON.parse(piece);
    } catch (e) {
      return { ok: false, message: errorMessage(e), line: lineOf(src, s.start) };
    }
    out.push(minifyJson(piece));
  }
  return { ok: true, text: out.join(eol), count: out.length };
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Character offset of a JSON.parse error, when the engine reports one. */
export function errorOffset(message: string): number | undefined {
  const m = /position (\d+)/.exec(message);
  return m ? Number(m[1]) : undefined;
}
