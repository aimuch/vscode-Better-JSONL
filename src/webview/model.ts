import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { errorMessage, errorOffset, stripBom } from '../shared/jsonText';
import type { JsonPath, TextChange } from '../shared/protocol';
import type { ItemStore } from './items';
import { compileQuery, type Program } from './query';
import { childKey, getAt, isContainer, isObj, parseJson, parsePath, plainText, primText, RawNum, stringifyPretty, type JObj, type JVal } from './json';

export type Parsed =
  | { kind: 'value'; value: JVal }
  | { kind: 'blank' }
  | { kind: 'error'; message: string; offset?: number };

const BLANK: Parsed = { kind: 'blank' };

/** What is known about a record without parsing it again. */
export const K_UNKNOWN = 0;
export const K_VALUE = 1;
export const K_ERROR = 2;
export const K_BLANK = 3;

/**
 * Above this size parsed records are not all kept: a bounded cache holds the recent ones.
 * It is the size at which a file becomes a "large file" (config.LARGE_FILE_BYTES in the host).
 */
export const KEEP_ALL_BYTES = 50 * 1024 * 1024;
const CACHE_RECORDS = 4000;
/** Above this size a failed JSON.parse does not try the (slow) JSONC parser or the per-line check. */
const FALLBACK_CHARS = 32 * 1024 * 1024;

// ---------- line stores ----------

/** The raw lines of a document. */
export interface LineStore {
  readonly count: number;
  text(i: number): string;
  /** The first `max` characters of line i, without decoding the rest. */
  head(i: number, max: number): string;
  /** Length of line i: characters (text store) or bytes (byte store). */
  size(i: number): number;
  blank(i: number): boolean;
}

export class StringStore implements LineStore {
  constructor(readonly lines: string[]) {}

  get count(): number {
    return this.lines.length;
  }

  text(i: number): string {
    return this.lines[i];
  }

  head(i: number, max: number): string {
    const s = this.lines[i];
    return s.length > max ? s.slice(0, max) : s;
  }

  size(i: number): number {
    return this.lines[i].length;
  }

  blank(i: number): boolean {
    return !/\S/.test(this.lines[i]);
  }
}

const NO_BYTES = new Uint8Array(0);

/**
 * Lines of a large UTF-8 file, kept as the bytes the host sent.
 * Only the line starts are indexed; a line is decoded when it is needed.
 * It grows while the file loads: `count` holds the lines that are complete.
 */
export class ByteStore implements LineStore {
  private chunks: Uint8Array[] = [];
  private chunkStart: number[] = [];
  private starts = new Float64Array(1 << 14);
  private nStarts = 1;
  private lines = 0;
  private bomChecked = false;
  /** Lines written by the view (record edits of a large file), by line number. */
  private overlay: Map<number, Uint8Array> | undefined;
  /** Bytes the overlay adds to the file (it can be less than 0). */
  edited = 0;
  private readonly decoder = new TextDecoder('utf-8');
  /** Bytes received. */
  total = 0;
  done = false;

  get count(): number {
    return this.lines;
  }

  append(data: Uint8Array, done: boolean): void {
    if (data.length) {
      const base = this.total;
      this.chunks.push(data);
      this.chunkStart.push(base);
      let p = data.indexOf(10);
      while (p >= 0) {
        if (this.nStarts === this.starts.length) {
          const grown = new Float64Array(this.starts.length * 2);
          grown.set(this.starts);
          this.starts = grown;
        }
        this.starts[this.nStarts++] = base + p + 1;
        p = data.indexOf(10, p + 1);
      }
      this.total += data.length;
      // A UTF-8 byte order mark is not part of the first line. It can arrive split over two chunks.
      if (!this.bomChecked && this.total >= 3) {
        this.bomChecked = true;
        const b = this.bytes(0, 3);
        if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) this.starts[0] = 3;
      }
    }
    this.done = done;
    // The text after the last line feed is a line only when the file is complete.
    this.lines = this.nStarts - 1 + (done && this.starts[this.nStarts - 1] < this.total ? 1 : 0);
  }

  private bytes(a: number, b: number): Uint8Array {
    if (b <= a) return NO_BYTES;
    let lo = 0;
    let hi = this.chunks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.chunkStart[mid] <= a) lo = mid;
      else hi = mid - 1;
    }
    const first = this.chunks[lo];
    const off = a - this.chunkStart[lo];
    if (off + (b - a) <= first.length) return first.subarray(off, off + (b - a));
    // The range crosses a chunk border.
    const out = new Uint8Array(b - a);
    let w = 0;
    let o = off;
    for (let c = lo; w < out.length; c++, o = 0) {
      const src = this.chunks[c];
      const take = Math.min(src.length - o, out.length - w);
      out.set(src.subarray(o, o + take), w);
      w += take;
    }
    return out;
  }

  /** True when the file is complete and its last line has no line end (more bytes would extend that line). */
  get openEnd(): boolean {
    return this.done && this.starts[this.nStarts - 1] < this.total;
  }

  /** Bytes [a, b) of what was received. */
  slice(a: number, b: number): Uint8Array {
    return this.bytes(a, b);
  }

  byteAt(pos: number): number {
    return pos < this.total ? this.bytes(pos, pos + 1)[0] : -1;
  }

  /** The pieces received, in order (for a parser that reads bytes). */
  chunkList(): readonly Uint8Array[] {
    return this.chunks;
  }

  /** Line i now has this text (the file was changed on disk to match). */
  replaceLine(i: number, text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.overlay ??= new Map();
    this.edited += bytes.length - this.size(i);
    this.overlay.set(i, bytes);
  }

  /** Bytes of line i without the line feed and without a carriage return before it. */
  private line(i: number, max = Infinity): Uint8Array {
    const o = this.overlay?.get(i);
    if (o) return o.length > max ? o.subarray(0, max) : o;
    const a = this.starts[i];
    const end = i + 1 < this.nStarts ? this.starts[i + 1] - 1 : this.total;
    if (end - a > max) return this.bytes(a, a + max);
    const v = this.bytes(a, end);
    return v.length && v[v.length - 1] === 13 ? v.subarray(0, v.length - 1) : v;
  }

  text(i: number): string {
    return this.decoder.decode(this.line(i));
  }

  head(i: number, max: number): string {
    // A UTF-16 unit needs at most three UTF-8 bytes.
    if (this.size(i) <= max * 3) {
      const s = this.text(i);
      return s.length > max ? s.slice(0, max) : s;
    }
    let s = this.decoder.decode(this.line(i, max * 3));
    if (s.endsWith('�')) s = s.slice(0, -1);
    return s.slice(0, max);
  }

  size(i: number): number {
    const o = this.overlay?.get(i);
    if (o) return o.length;
    const end = i + 1 < this.nStarts ? this.starts[i + 1] - 1 : this.total;
    return end - this.starts[i];
  }

  blank(i: number): boolean {
    const n = this.size(i);
    if (n === 0) return true;
    // Look at the start first: a record line does not begin with 64 blanks.
    const v = this.line(i, 64);
    for (let k = 0; k < v.length; k++) if (v[k] !== 32 && v[k] !== 9 && v[k] !== 13) return false;
    if (n <= 64) return true;
    const all = this.line(i);
    for (let k = 64; k < all.length; k++) if (all[k] !== 32 && all[k] !== 9 && all[k] !== 13) return false;
    return true;
  }

  /** The first complete line, or undefined while the first line feed has not arrived. */
  firstLine(max: number): string | undefined {
    return this.nStarts > 1 && this.size(0) <= max ? this.text(0) : undefined;
  }

  /** True when something that is not white space follows the first line. */
  hasMoreThanOneLine(): boolean {
    for (let i = 1; i < Math.min(this.nStarts, 50); i++) {
      const end = i + 1 < this.nStarts ? this.starts[i + 1] - 1 : this.total;
      if (end > this.starts[i] && !this.blank(i)) return true;
    }
    return false;
  }

  /** The whole file as one string. The bytes are released. Throws when the text is too long for one string. */
  takeText(): string {
    const dec = new TextDecoder('utf-8');
    const parts: string[] = [];
    const chunks = this.chunks;
    this.chunks = [];
    this.chunkStart = [];
    for (let c = 0; c < chunks.length; c++) {
      parts.push(dec.decode(chunks[c], { stream: true }));
      chunks[c] = NO_BYTES;
    }
    parts.push(dec.decode());
    return parts.join('');
  }
}

// ---------- the document ----------

/** The document as records. JSONL: one record per line. JSON: one record. */
export class DocModel {
  isJsonl: boolean;
  readonly store: LineStore;
  /** Size of the document in bytes. For a byte store that is still loading: the bytes so far. */
  private readonly knownBytes: number;
  /** The .json file needed the JSONC parser (comments or trailing commas). */
  jsonc = false;
  /** The .json file holds one JSON value per line. */
  detectedJsonl = false;
  /** Bytes-backed: a file too large for VS Code to give to an extension. It is read-only. */
  readonly large: boolean;
  /** JSON Lines from text: the text ended with a line end (the empty last line is not a record). */
  private readonly endsWithEol: boolean = false;
  private kinds: Uint8Array;
  private readonly cache = new Map<number, Parsed>();
  private readonly limited: boolean;
  /** Records the background scan has seen. */
  private scanned = 0;
  valid = 0;
  errors = 0;
  blank = 0;
  /** Columns in the order they were found. After the scan: in file order. */
  columns: string[] = [];
  hasNonObject = false;
  private readonly colSet = new Set<string>();
  private scanCols: string[] = [];
  private readonly scanSet = new Set<string>();
  private colsFinal = false;
  /** Grows when a record turns out to be invalid. The Formatted view gives those records two rows. */
  errorsVersion = 0;

  /** `src`: the text, the byte store of a large file, or the records of a JSON Lines document (with `endsWithEol`). */
  constructor(src: string | ByteStore | ItemStore | string[], isJsonl: boolean, bytes?: number, endsWithEol = false) {
    this.isJsonl = isJsonl;
    if (Array.isArray(src)) {
      this.large = false;
      this.knownBytes = bytes ?? 0;
      this.limited = this.knownBytes > KEEP_ALL_BYTES;
      this.store = new StringStore(src);
      this.kinds = new Uint8Array(src.length);
      this.endsWithEol = endsWithEol;
      return;
    }
    if (typeof src !== 'string') {
      this.large = true;
      this.store = src;
      this.knownBytes = -1;
      this.limited = true;
      this.kinds = new Uint8Array(Math.max(1024, src.count));
      return;
    }
    this.large = false;
    this.knownBytes = bytes ?? new TextEncoder().encode(src).length;
    this.limited = this.knownBytes > KEEP_ALL_BYTES;
    const text = stripBom(src);
    if (isJsonl) {
      const lines = text.split(EOL);
      this.endsWithEol = dropLastEmpty(lines);
      this.store = new StringStore(lines);
      this.kinds = new Uint8Array(lines.length);
      return;
    }
    const one = this.parseWhole(text);
    if (one.kind === 'error' && text.length <= FALLBACK_CHARS) {
      const lines = text.split(EOL);
      const endsWithEol = dropLastEmpty(lines);
      const nonBlank = lines.filter((l) => /\S/.test(l));
      if (nonBlank.length > 1 && nonBlank.every((l) => tryParse(l).kind === 'value')) {
        this.isJsonl = true;
        this.detectedJsonl = true;
        this.endsWithEol = endsWithEol;
        this.store = new StringStore(lines);
        this.kinds = new Uint8Array(lines.length);
        return;
      }
    }
    // A large value that parsed: the views read the value, so the text (as large again) is not kept.
    this.store = new StringStore([one.kind === 'value' && this.limited ? '' : text]);
    this.kinds = new Uint8Array(1);
    this.note(0, one);
    this.cache.set(0, one);
    this.scanned = 1;
    this.colsFinal = true;
  }

  get count(): number {
    return this.store.count;
  }

  get bytes(): number {
    if (this.knownBytes >= 0) return this.knownBytes;
    const store = this.store as ByteStore;
    return store.total + store.edited;
  }

  /** One JSON value parsed already (a file too large for one string). */
  static fromValue(value: JVal, bytes: number): DocModel {
    const m = new DocModel('', false, bytes);
    m.cache.clear();
    m.kinds[0] = 0;
    m.blank = 0;
    const p: Parsed = { kind: 'value', value };
    m.note(0, p);
    m.cache.set(0, p);
    return m;
  }

  /** Record i changed: what was known about it is gone, and the scan reads it again. */
  forget(i: number): void {
    const k = this.kinds[i];
    if (k === K_BLANK) this.blank--;
    else if (k === K_ERROR) this.errors--;
    else if (k === K_VALUE) this.valid--;
    if (i < this.kinds.length) this.kinds[i] = 0;
    this.cache.delete(i);
    if (this.scanned > i) this.scanned = i;
    this.errorsVersion++;
  }

  /** A large file: line i was written by the view. */
  replaceLine(i: number, text: string): void {
    (this.store as ByteStore).replaceLine(i, text);
    this.forget(i);
  }

  /**
   * A large file grew at the end. When its last line had no line end, more bytes extend
   * that line: it is read again.
   */
  append(data: Uint8Array): void {
    const store = this.store as ByteStore;
    const open = store.openEnd;
    const last = store.count - 1;
    store.append(data, true);
    if (open && last >= 0) this.forget(last);
  }

  /** One JSON value too large for memory, shown as the items of its array (see items.ts). */
  get items(): { path: (string | number)[]; count: number } | undefined {
    const s = this.store as Partial<ItemStore>;
    return s.index ? { path: s.index.path, count: s.index.count } : undefined;
  }

  /** The line in the file where record i starts. */
  fileLine(i: number): number {
    const s = this.store as Partial<ItemStore>;
    return s.fileLine ? s.fileLine(i) : i;
  }

  /** True while a byte store still receives data. */
  get loading(): boolean {
    return this.large && !(this.store as ByteStore).done;
  }

  /** Records the scan has seen. */
  get parsed(): number {
    return Math.min(this.scanned, this.count);
  }

  get complete(): boolean {
    return !this.loading && this.scanned >= this.count;
  }

  /** True when every parsed record stays in memory, so "Expand all", sorting and column filters are cheap. */
  get keepsAll(): boolean {
    return !this.limited;
  }

  /**
   * The lines as the text editor counts them (an empty last line after the last line end
   * included), as a new list. Undefined when the document is not JSON Lines from text.
   */
  editorLines(): string[] | undefined {
    if (!this.isJsonl || !(this.store instanceof StringStore)) return undefined;
    const lines = this.store.lines.slice();
    if (this.endsWithEol) lines.push('');
    return lines;
  }

  line(i: number): string {
    return this.store.text(i);
  }

  head(i: number, max: number): string {
    return this.store.head(i, max);
  }

  lineSize(i: number): number {
    return this.store.size(i);
  }

  /** The kind of record i if it is already known (K_UNKNOWN otherwise). It never parses. */
  kind(i: number): number {
    return this.kinds[i] || K_UNKNOWN;
  }

  isBlank(i: number): boolean {
    const k = this.kind(i);
    if (k) return k === K_BLANK;
    if (!this.store.blank(i)) return false;
    this.note(i, BLANK);
    return true;
  }

  get(i: number): Parsed {
    const hit = this.cache.get(i);
    if (hit) {
      if (this.limited && this.cache.size > CACHE_RECORDS / 2) {
        this.cache.delete(i);
        this.cache.set(i, hit);
      }
      return hit;
    }
    const p = this.parse(i);
    if (p.kind !== 'blank') {
      this.cache.set(i, p);
      if (this.limited && this.cache.size > CACHE_RECORDS) this.cache.delete(this.cache.keys().next().value as number);
    }
    return p;
  }

  value(i: number): JVal | undefined {
    const p = this.get(i);
    return p.kind === 'value' ? p.value : undefined;
  }

  /** The value of record i for a pass over all records: a limited cache is left alone. */
  scanValue(i: number): JVal | undefined {
    const p = this.cache.get(i) ?? (this.limited ? this.parse(i) : this.get(i));
    return p.kind === 'value' ? p.value : undefined;
  }

  /** Scans more records in the background. Returns true when the whole document is scanned. */
  parseSome(budgetMs: number): boolean {
    const end = performance.now() + budgetMs;
    const n = this.count;
    while (this.scanned < n) {
      const i = this.scanned++;
      // A limited cache is for the records on screen: the scan does not fill it.
      const v = this.scanValue(i);
      if (v !== undefined && isObj(v)) {
        for (const k in v) {
          if (!this.scanSet.has(k)) {
            this.scanSet.add(k);
            this.scanCols.push(k);
          }
        }
      }
      if ((i & 63) === 63 && performance.now() > end) break;
    }
    if (this.complete && !this.colsFinal) {
      this.colsFinal = true;
      this.columns = this.scanCols;
    }
    return this.complete;
  }

  /** Records with errors that are known so far, in file order. All of them once the scan is complete. */
  errorRecords(): number[] {
    const out: number[] = [];
    const n = Math.min(this.count, this.kinds.length);
    for (let i = 0; i < n; i++) if (this.kinds[i] === K_ERROR) out.push(i);
    return out;
  }

  /**
   * Takes the parse results of `old` for the records that did not change.
   * Returns where each old record is now (-1: the record changed or is gone).
   */
  adopt(old: DocModel): (r: number) => number {
    const a = old.store;
    const b = this.store;
    if (!(a instanceof StringStore) || !(b instanceof StringStore) || !old.isJsonl || !this.isJsonl) {
      const same = !old.isJsonl && !this.isJsonl;
      return (r) => (same ? r : -1);
    }
    const la = a.lines;
    const lb = b.lines;
    const max = Math.min(la.length, lb.length);
    let head = 0;
    while (head < max && la[head] === lb[head]) head++;
    let tail = 0;
    while (tail < max - head && la[la.length - 1 - tail] === lb[lb.length - 1 - tail]) tail++;
    const shift = lb.length - la.length;
    const tailFrom = la.length - tail;
    const map = (r: number) => (r < head ? r : r >= tailFrom && r < la.length ? r + shift : -1);
    for (let r = 0; r < la.length; r++) {
      const k = old.kinds[r];
      if (!k || (r >= head && r < tailFrom)) continue;
      const to = r < head ? r : r + shift;
      this.kinds[to] = k;
      if (k === K_BLANK) this.blank++;
      else if (k === K_ERROR) this.errors++;
      else this.valid++;
    }
    if (!this.limited) {
      for (const [r, p] of old.cache) {
        const to = map(r);
        if (to >= 0) this.cache.set(to, p);
      }
    }
    for (const c of old.columns) {
      this.colSet.add(c);
      this.columns.push(c);
    }
    this.hasNonObject = old.hasNonObject;
    return map;
  }

  private parse(i: number): Parsed {
    const p = this.kinds[i] === K_BLANK ? BLANK : tryParse(this.store.text(i));
    this.note(i, p);
    return p;
  }

  /** Records the kind of record i the first time it is seen. */
  private note(i: number, p: Parsed): void {
    if (i >= this.kinds.length) {
      const grown = new Uint8Array(Math.max(this.count, this.kinds.length * 2, i + 1));
      grown.set(this.kinds);
      this.kinds = grown;
    }
    if (this.kinds[i]) return;
    if (p.kind === 'blank') {
      this.kinds[i] = K_BLANK;
      this.blank++;
    } else if (p.kind === 'error') {
      this.kinds[i] = K_ERROR;
      this.errors++;
      this.errorsVersion++;
    } else {
      this.kinds[i] = K_VALUE;
      this.valid++;
      if (this.colsFinal) return;
      if (!isObj(p.value)) this.hasNonObject = true;
      else {
        for (const k in p.value) {
          if (!this.colSet.has(k)) {
            this.colSet.add(k);
            this.columns.push(k);
          }
        }
      }
    }
  }

  private parseWhole(text: string): Parsed {
    if (!/\S/.test(text)) return BLANK;
    const p = tryParse(text);
    if (p.kind !== 'error' || text.length > FALLBACK_CHARS) return p;
    const errs: ParseError[] = [];
    const v = parseJsonc(text, errs, { allowTrailingComma: true, disallowComments: false });
    if (!errs.length) {
      this.jsonc = true;
      return { kind: 'value', value: v as JVal };
    }
    return p;
  }
}

/** Line ends as the text editor reads them: CR LF, LF, or a CR alone. */
const EOL = /\r\n|\r|\n/;

/** Text that ends with a line end gives an empty last piece: it is not a record. Returns true when it was there. */
export function dropLastEmpty(lines: string[]): boolean {
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
    return true;
  }
  return false;
}

function utf8Length(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) n += c > 0x7ff && (c < 0xd800 || c > 0xdfff) ? 2 : 1;
  }
  return n;
}

/**
 * Applies text changes to the lines of a document (the lines as the text editor counts them).
 * `lines` is changed in place. Returns how much the document grew, in characters and in
 * UTF-8 bytes (`eol` is the length of a line end), or undefined when a change does not fit
 * the lines: then the two sides are out of step and the whole text is needed.
 */
export function patchLines(lines: string[], changes: TextChange[], eol: number): { chars: number; bytes: number } | undefined {
  let chars = 0;
  let bytes = 0;
  for (const c of changes) {
    if (c.sl < 0 || c.el < c.sl || c.el >= lines.length || c.sc < 0 || c.ec < 0) return undefined;
    const first = lines[c.sl];
    const last = lines[c.el];
    if (c.sc > first.length || c.ec > last.length || (c.sl === c.el && c.ec < c.sc)) return undefined;
    // What goes away.
    if (c.sl === c.el) {
      chars -= c.ec - c.sc;
      bytes -= utf8Length(first.slice(c.sc, c.ec));
    } else {
      chars -= first.length - c.sc + c.ec + (c.el - c.sl) * eol;
      bytes -= utf8Length(first.slice(c.sc)) + utf8Length(last.slice(0, c.ec)) + (c.el - c.sl) * eol;
      for (let l = c.sl + 1; l < c.el; l++) {
        chars -= lines[l].length;
        bytes -= utf8Length(lines[l]);
      }
    }
    // What comes in. The editor stores every line end of the new text as the document's own.
    const pieces = c.text.split(EOL);
    chars += (pieces.length - 1) * eol;
    bytes += (pieces.length - 1) * eol;
    for (const p of pieces) {
      chars += p.length;
      bytes += utf8Length(p);
    }
    pieces[0] = first.slice(0, c.sc) + pieces[0];
    pieces[pieces.length - 1] += last.slice(c.ec);
    lines.splice(c.sl, c.el - c.sl + 1, ...pieces);
  }
  return { chars, bytes };
}

export function tryParse(text: string): Parsed {
  if (!/\S/.test(text)) return BLANK;
  try {
    return { kind: 'value', value: parseJson(text) };
  } catch (e) {
    const message = errorMessage(e);
    return { kind: 'error', message: message.replace(/^JSON\.parse: /, ''), offset: errorOffset(message) };
  }
}

// ---------- search and filter ----------

/** Index of the first item that is not below `x` in a sorted list (its length when there is none). */
export function lowerBound(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The match after (dir 1) or before (dir -1) record `from`, going round at the ends. `sorted` is not empty. */
export function stepIn(sorted: ArrayLike<number>, from: number, dir: 1 | -1): number {
  if (dir > 0) {
    const i = lowerBound(sorted, from + 1);
    return sorted[i < sorted.length ? i : 0];
  }
  const i = lowerBound(sorted, from) - 1;
  return sorted[i >= 0 ? i : sorted.length - 1];
}

export type Op = ':' | '=' | '!=' | '>' | '<';

export interface Query {
  raw: string;
  /** Lower-case text for plain search. */
  text: string;
  path?: JsonPath;
  op?: Op;
  value?: string;
  /** A JSONPath or jq query (see query.ts). */
  program?: Program;
  /** The text looks like a query but is not a valid one: it is searched as text, and this says why. */
  error?: string;
  /** jq modules to read before the query can run ("jq:path" / "json:path"). */
  needs?: string[];
}

/** Plain text search: no path query, no JSONPath or jq. */
export function isTextQuery(q: Query): boolean {
  return !!q.text && !q.path && !q.program;
}

const PATH_QUERY = /^\s*(\$?[A-Za-z_$\[][^\s:=!<>]*)\s*(!=|=|:|>|<)\s*(.*)$/;

export function parseQuery(raw: string, model: DocModel, modules?: Map<string, string | null>): Query {
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
  if (!q.path && q.text) {
    const c = compileQuery(raw, modules);
    q.program = c.program;
    q.error = c.error;
    q.needs = c.needs;
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
  if (q.program) {
    const rec = model.scanValue(i);
    return rec !== undefined && q.program.matches(rec);
  }
  if (!q.path) return model.line(i).toLowerCase().includes(q.text);
  const rec = model.scanValue(i);
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

// ---------- search in one JSON document ----------

/** Matches of a tree search that are kept. More than this many are counted as "1,000+". */
export const TREE_MATCHES = 1000;

type Frame = { v: JVal[] | JObj; keys: string[] | null; i: number; n: number; path: string };

/**
 * Finds the members of one JSON value whose line contains the text: the key, a primitive
 * value, or both ("id": 5). It reads the parsed value, not the lines on screen, so it also
 * finds what is inside folded nodes. Matches are path keys (json.childKey) in document order.
 * The walk is iterative and can run in slices: call step() until it returns true.
 */
export class TreeSearch {
  readonly matches: string[] = [];
  /** The search stopped at TREE_MATCHES: there may be more. */
  capped = false;
  done = false;
  private readonly stack: Frame[] = [];

  /** `q` is lower-case text. */
  constructor(root: JVal, private readonly q: string, private readonly max = TREE_MATCHES) {
    this.visit(root, undefined, '');
  }

  /** Works for about `budgetMs`. Returns true when the search is complete. */
  step(budgetMs: number): boolean {
    const end = performance.now() + budgetMs;
    const stack = this.stack;
    let seen = 0;
    while (stack.length && !this.done) {
      const f = stack[stack.length - 1];
      if (f.i >= f.n) {
        stack.pop();
        continue;
      }
      const k = f.keys ? f.keys[f.i] : f.i;
      const child = f.keys ? (f.v as JObj)[f.keys[f.i]] : (f.v as JVal[])[f.i];
      f.i++;
      this.visit(child, k, f.path);
      if ((++seen & 255) === 0 && performance.now() > end) return false;
    }
    this.done = true;
    stack.length = 0;
    return true;
  }

  private visit(v: JVal, key: string | number | undefined, parent: string): void {
    const box = isContainer(v);
    const arr = box && Array.isArray(v);
    const keys = box && !arr ? Object.keys(v) : null;
    const n = box ? (keys ? keys.length : (v as JVal[]).length) : 0;
    // The same text as the line of this member in the Formatted view.
    const text = (typeof key === 'string' ? JSON.stringify(key) + ': ' : '') + (box ? (arr ? (n ? '[' : '[]') : n ? '{' : '{}') : primText(v));
    // The path is built only for a match and for a container that is entered.
    let path: string | undefined;
    if (text.toLowerCase().includes(this.q)) {
      if (this.matches.length >= this.max) {
        this.capped = true;
        this.done = true;
        return;
      }
      path = key === undefined ? '' : childKey(parent, key);
      this.matches.push(path);
    }
    if (n) this.stack.push({ v: v as JVal[] | JObj, keys, i: 0, n, path: path ?? (key === undefined ? '' : childKey(parent, key)) });
  }
}
