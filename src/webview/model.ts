import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { errorMessage, errorOffset, stripBom } from '../shared/jsonText';
import type { JsonPath } from '../shared/protocol';
import { getAt, isContainer, isObj, parseJson, parsePath, plainText, RawNum, stringifyPretty, type JVal } from './json';

export type Parsed =
  | { kind: 'value'; value: JVal }
  | { kind: 'blank' }
  | { kind: 'error'; message: string; offset?: number };

const BLANK: Parsed = { kind: 'blank' };

/** The document as records. JSONL: one record per line. JSON: one record. */
export class DocModel {
  isJsonl: boolean;
  readonly lines: string[];
  readonly bytes: number;
  /** The .json file needed the JSONC parser (comments or trailing commas). */
  jsonc = false;
  /** The .json file holds one JSON value per line. */
  detectedJsonl = false;
  private readonly cache: (Parsed | undefined)[];
  private nextBackground = 0;
  parsed = 0;
  valid = 0;
  errors = 0;
  blank = 0;
  columns: string[] = [];
  hasNonObject = false;
  private readonly colSet = new Set<string>();

  constructor(text: string, isJsonl: boolean) {
    this.bytes = new TextEncoder().encode(text).length;
    text = stripBom(text);
    this.isJsonl = isJsonl;
    if (isJsonl) {
      this.lines = splitLines(text);
      this.cache = new Array(this.lines.length);
      return;
    }
    this.lines = [text];
    this.cache = [undefined];
    const one = this.parseWhole(text);
    if (one.kind === 'error') {
      const lines = splitLines(text);
      const nonBlank = lines.filter((l) => l.trim());
      if (nonBlank.length > 1 && nonBlank.every((l) => tryParse(l).kind === 'value')) {
        this.isJsonl = true;
        this.detectedJsonl = true;
        this.lines = lines;
        this.cache = new Array(lines.length);
        return;
      }
    }
    this.store(0, one);
  }

  get count(): number {
    return this.lines.length;
  }

  get complete(): boolean {
    return this.parsed >= this.lines.length;
  }

  get(i: number): Parsed {
    const hit = this.cache[i];
    if (hit) return hit;
    const p = tryParse(this.lines[i]);
    this.store(i, p);
    return p;
  }

  value(i: number): JVal | undefined {
    const p = this.get(i);
    return p.kind === 'value' ? p.value : undefined;
  }

  /** Parses more records in the background. Returns true when all are parsed. */
  parseSome(budgetMs: number): boolean {
    const end = performance.now() + budgetMs;
    while (this.nextBackground < this.lines.length) {
      this.get(this.nextBackground++);
      if ((this.nextBackground & 63) === 0 && performance.now() > end) break;
    }
    if (this.complete) this.rebuildColumns();
    return this.complete;
  }

  /** All records with errors, in file order. Parses every record. */
  errorRecords(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.lines.length; i++) if (this.get(i).kind === 'error') out.push(i);
    return out;
  }

  private store(i: number, p: Parsed): void {
    this.cache[i] = p;
    this.parsed++;
    if (p.kind === 'blank') this.blank++;
    else if (p.kind === 'error') this.errors++;
    else {
      this.valid++;
      this.addColumns(p.value);
    }
  }

  private addColumns(v: JVal): void {
    if (!isObj(v)) {
      this.hasNonObject = true;
      return;
    }
    for (const k in v) {
      if (!this.colSet.has(k)) {
        this.colSet.add(k);
        this.columns.push(k);
      }
    }
  }

  /** Puts columns in file order once every record is parsed. */
  private rebuildColumns(): void {
    const seen = new Set<string>();
    const cols: string[] = [];
    for (const p of this.cache) {
      if (p && p.kind === 'value' && isObj(p.value)) {
        for (const k in p.value) {
          if (!seen.has(k)) {
            seen.add(k);
            cols.push(k);
          }
        }
      }
    }
    this.columns = cols;
  }

  private parseWhole(text: string): Parsed {
    if (!text.trim()) return BLANK;
    const p = tryParse(text);
    if (p.kind !== 'error') return p;
    const errs: ParseError[] = [];
    const v = parseJsonc(text, errs, { allowTrailingComma: true, disallowComments: false });
    if (!errs.length) {
      this.jsonc = true;
      return { kind: 'value', value: v as JVal };
    }
    return p;
  }
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function tryParse(text: string): Parsed {
  if (!text.trim()) return BLANK;
  try {
    return { kind: 'value', value: parseJson(text) };
  } catch (e) {
    const message = errorMessage(e);
    return { kind: 'error', message: message.replace(/^JSON\.parse: /, ''), offset: errorOffset(message) };
  }
}

// ---------- search and filter ----------

export type Op = ':' | '=' | '!=' | '>' | '<';

export interface Query {
  raw: string;
  /** Lower-case text for plain search. */
  text: string;
  path?: JsonPath;
  op?: Op;
  value?: string;
}

const PATH_QUERY = /^\s*(\$?[A-Za-z_$\[][^\s:=!<>]*)\s*(!=|=|:|>|<)\s*(.*)$/;

export function parseQuery(raw: string, model: DocModel): Query {
  const q: Query = { raw, text: raw.trim().toLowerCase() };
  const m = PATH_QUERY.exec(raw);
  if (m) {
    const path = parsePath(m[1]);
    const head = path?.[0];
    if (path && path.length && (m[1].startsWith('$') || (typeof head === 'string' && model.columns.includes(head)))) {
      q.path = path;
      q.op = m[2] as Op;
      q.value = m[3].trim();
    }
  }
  return q;
}

function valueText(v: JVal): string {
  return isContainer(v) ? stringifyPretty(v, 0, 10_000).replace(/\n/g, '') : plainText(v);
}

function stripQuotes(s: string): string {
  return s.length >= 2 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function matchesRecord(model: DocModel, i: number, q: Query): boolean {
  if (!q.text) return true;
  if (!q.path) return model.lines[i].toLowerCase().includes(q.text);
  const rec = model.value(i);
  if (rec === undefined) return false;
  const v = getAt(rec, q.path);
  const want = stripQuotes(q.value ?? '');
  switch (q.op) {
    case ':':
      return v !== undefined && valueText(v).toLowerCase().includes(want.toLowerCase());
    case '=':
      return v !== undefined && valueText(v) === want;
    case '!=':
      return v === undefined || valueText(v) !== want;
    case '>':
    case '<': {
      if (v === undefined) return false;
      const a = typeof v === 'number' ? v : v instanceof RawNum ? Number(v.src) : Number.NaN;
      const b = Number(want);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return q.op === '>' ? a > b : a < b;
    }
  }
  return false;
}

export function findMatches(model: DocModel, q: Query): number[] {
  const out: number[] = [];
  if (!q.text) return out;
  for (let i = 0; i < model.count; i++) if (matchesRecord(model, i, q)) out.push(i);
  return out;
}
