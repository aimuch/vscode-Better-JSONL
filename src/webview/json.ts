// JSON values, parsing and display helpers for the webview.
import type { JsonPath } from '../shared/protocol';

/** A number whose source text JavaScript cannot hold exactly (for example 9007199254740993). */
export class RawNum {
  constructor(readonly src: string) {}
}

export type JVal = null | boolean | number | string | RawNum | JVal[] | { [k: string]: JVal };
export type JObj = { [k: string]: JVal };

const sourceTextSupported = (() => {
  try {
    let ok = false;
    JSON.parse('[1]', function (_k: string, v: unknown, ctx?: { source?: string }) {
      if (ctx && ctx.source === '1') ok = true;
      return v;
    } as never);
    return ok;
  } catch {
    return false;
  }
})();

const LONG_DIGITS = /\d{16,}/;

function keepSource(_k: string, v: unknown, ctx?: { source?: string }): unknown {
  if (typeof v === 'number' && ctx && ctx.source !== undefined && !Number.isSafeInteger(v) && String(v) !== ctx.source) {
    return new RawNum(ctx.source);
  }
  return v;
}

/** JSON.parse that keeps the exact text of numbers that would lose precision. */
export function parseJson(text: string): JVal {
  if (sourceTextSupported && LONG_DIGITS.test(text)) return JSON.parse(text, keepSource as never) as JVal;
  return JSON.parse(text) as JVal;
}

export function isArr(v: JVal): v is JVal[] {
  return Array.isArray(v);
}

export function isObj(v: JVal): v is JObj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof RawNum);
}

export function isContainer(v: JVal): v is JVal[] | JObj {
  return v !== null && typeof v === 'object' && !(v instanceof RawNum);
}

export type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export function kindOf(v: JVal): Kind {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof RawNum) return 'number';
  return typeof v === 'object' ? 'object' : (typeof v as Kind);
}

export function entriesOf(v: JVal[] | JObj): [string | number, JVal][] {
  if (Array.isArray(v)) return v.map((x, i) => [i, x]);
  return Object.keys(v).map((k) => [k, v[k]]);
}

export function sizeOf(v: JVal[] | JObj): number {
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

/** Short display text for a primitive value. */
export function primText(v: JVal): string {
  if (v instanceof RawNum) return v.src;
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

/** Display text without quotes (grid cells). */
export function plainText(v: JVal): string {
  if (v instanceof RawNum) return v.src;
  if (typeof v === 'string') return v;
  return String(v);
}

export function primClass(v: JVal): string {
  if (v === null) return 'tz';
  if (v instanceof RawNum || typeof v === 'number') return 'tn';
  if (typeof v === 'boolean') return 'tb';
  return 'ts';
}

export function summary(v: JVal[] | JObj): string {
  return Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`;
}

/** Pretty JSON text from a parsed value. Stops at `maxLen` characters. */
export function stringifyPretty(v: JVal, indent = 2, maxLen = 200_000): string {
  const out: string[] = [];
  let len = 0;
  const pad = (d: number) => ' '.repeat(d * indent);
  const push = (s: string) => {
    out.push(s);
    len += s.length;
  };
  const walk = (x: JVal, d: number) => {
    if (len > maxLen) return;
    if (!isContainer(x)) return push(primText(x));
    const ents = entriesOf(x);
    const [open, close] = Array.isArray(x) ? ['[', ']'] : ['{', '}'];
    if (!ents.length) return push(open + close);
    if (d > 500) return push(open + ' … ' + close);
    push(open + '\n');
    ents.forEach(([k, c], i) => {
      push(pad(d + 1));
      if (typeof k === 'string') push(JSON.stringify(k) + ': ');
      walk(c, d + 1);
      push(i < ents.length - 1 ? ',\n' : '\n');
    });
    push(pad(d) + close);
  };
  walk(v, 0);
  const s = out.join('');
  return len > maxLen ? s.slice(0, maxLen) + '\n…' : s;
}

export function getAt(v: JVal, path: JsonPath): JVal | undefined {
  let cur: JVal | undefined = v;
  for (const seg of path) {
    if (cur === undefined || !isContainer(cur)) return undefined;
    cur = Array.isArray(cur) ? cur[seg as number] : (cur as JObj)[seg as string];
  }
  return cur;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/** JSONPath text such as $.user.roles[0] or $["a.b"]. */
export function pathToString(path: JsonPath): string {
  let s = '$';
  for (const seg of path) {
    if (typeof seg === 'number') s += `[${seg}]`;
    else if (IDENT.test(seg)) s += `.${seg}`;
    else s += `[${JSON.stringify(seg)}]`;
  }
  return s;
}

/** Parses "user.name", "$.tags[0]" or '$["a.b"].c'. */
export function parsePath(text: string): JsonPath | undefined {
  let s = text.trim();
  if (s.startsWith('$')) s = s.slice(1);
  const out: JsonPath = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') {
      i++;
      continue;
    }
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return undefined;
      const inner = s.slice(i + 1, end).trim();
      if (/^\d+$/.test(inner)) out.push(Number(inner));
      else {
        try {
          out.push(JSON.parse(inner.replace(/^'(.*)'$/, '"$1"')));
        } catch {
          return undefined;
        }
      }
      i = end + 1;
      continue;
    }
    const m = /^[^.[\]]+/.exec(s.slice(i));
    if (!m) return undefined;
    out.push(m[0]);
    i += m[0].length;
  }
  return out;
}

// Path keys: a compact, typed encoding of a JSON path for maps, sets and
// data-* attributes. The HTML parser keeps U+001F and U+001E (it replaces U+0000).
const SEP = '\u001f';
const NUM = '\u001e';

export function childKey(parent: string, k: string | number): string {
  return parent + SEP + (typeof k === 'number' ? NUM + k : k);
}

export function decodeKey(key: string): JsonPath {
  if (!key) return [];
  return key
    .split(SEP)
    .slice(1)
    .map((s) => (s[0] === NUM ? Number(s.slice(1)) : s));
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const TOKEN = /("(?:[^"\\]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)\b|([{}[\],:])|(\s+)|([^\s"{}[\],:]+)/g;

/** Syntax-highlighted HTML for raw JSON text (one line). */
export function highlightRaw(text: string): string {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(text))) {
    if (m[1] !== undefined) {
      out.push(`<span class="${m[2] ? 'tk' : 'ts'}">${esc(m[1])}</span>`);
      if (m[2]) out.push(`<span class="tp">${esc(m[2])}</span>`);
    } else if (m[3] !== undefined) out.push(`<span class="tn">${m[3]}</span>`);
    else if (m[4] !== undefined) out.push(`<span class="${m[4] === 'null' ? 'tz' : 'tb'}">${m[4]}</span>`);
    else if (m[5] !== undefined) out.push(`<span class="tp">${m[5]}</span>`);
    else if (m[6] !== undefined) out.push(m[6]);
    else out.push(`<span class="tx">${esc(m[7])}</span>`);
  }
  return out.join('');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
