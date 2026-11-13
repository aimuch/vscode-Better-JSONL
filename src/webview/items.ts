// One JSON value too large to keep in memory as a whole (over about 512 MB): when it is an
// array (or an object with one array that holds most of it), the items of that array become
// the records of the view, as in JSON Lines. Only the byte ranges of the items are kept; an
// item is decoded and parsed when it is needed.
import { minifyJson } from '../shared/jsonText';
import type { ByteStore, LineStore } from './model';

export interface ItemIndex {
  /** Path of the array in the document: [] for a root array, ["data"] for {"data": [...]}. */
  path: (string | number)[];
  count: number;
  starts: Float64Array;
  ends: Float64Array;
  /** Line number in the file (0-based) where each item starts. */
  lines: Float64Array;
}

const grow = (a: Float64Array, n: number): Float64Array => {
  if (n < a.length) return a;
  const b = new Float64Array(a.length * 2);
  b.set(a);
  return b;
};

/**
 * The children of the container that opens at byte `open`: where each one starts and ends
 * (ends exclusive), and for an object the byte range of each key. One pass over the bytes;
 * strings are skipped with their escapes.
 */
function children(chunks: readonly Uint8Array[], open: number, keys: boolean) {
  let starts: Float64Array = new Float64Array(1024);
  let ends: Float64Array = new Float64Array(1024);
  let lines: Float64Array = new Float64Array(1024);
  let keyStarts: Float64Array | null = keys ? new Float64Array(1024) : null;
  let keyEnds: Float64Array | null = keys ? new Float64Array(1024) : null;
  let n = 0;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let line = 0;
  let start = -1;
  let last = -1;
  /** Objects: the key comes first, then the value after ':'. */
  let inKey = keys;
  let keyStart = -1;
  let keyEnd = -1;
  let base = 0;
  let closed = -1;
  outer: for (const chunk of chunks) {
    const from = Math.max(0, open + 1 - base);
    if (open >= base && open < base + chunk.length) depth = 1;
    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i];
      if (b === 10) line++;
      if (i < from || depth === 0) continue;
      const pos = base + i;
      if (inStr) {
        if (esc) esc = false;
        else if (b === 92) esc = true;
        else if (b === 34) {
          inStr = false;
          if (depth === 1 && inKey) keyEnd = pos + 1;
        }
        last = pos;
        continue;
      }
      if (b === 32 || b === 10 || b === 13 || b === 9) continue;
      if (depth === 1) {
        if (b === 44 || b === 93 || b === 125) {
          // ',' or the end of the container: the child before it ends at its last byte.
          if (start >= 0) {
            starts = grow(starts, n);
            ends = grow(ends, n);
            starts[n] = start;
            ends[n] = last + 1;
            if (keyStarts && keyEnds) {
              keyStarts = grow(keyStarts, n);
              keyEnds = grow(keyEnds, n);
              keyStarts[n] = keyStart;
              keyEnds[n] = keyEnd;
            }
            n++;
          }
          start = -1;
          inKey = keys;
          if (b !== 44) {
            closed = pos;
            break outer;
          }
          continue;
        }
        if (inKey) {
          if (b === 34) {
            inStr = true;
            keyStart = pos;
          } else if (b === 58) inKey = false;
          continue;
        }
        if (start < 0) {
          start = pos;
          lines = grow(lines, n);
          lines[n] = line;
        }
      }
      last = pos;
      if (b === 34) inStr = true;
      else if (b === 123 || b === 91) depth++;
      else if (b === 125 || b === 93) depth--;
    }
    base += chunk.length;
  }
  return { n, starts, ends, lines, keyStarts, keyEnds, closed };
}

/** The first byte that is not white space (after a byte order mark), and its offset. */
function firstByte(store: ByteStore): { b: number; at: number } {
  let at = 0;
  for (const chunk of store.chunkList()) {
    for (let i = 0; i < chunk.length; i++, at++) {
      const b = chunk[i];
      if (at < 3 && (b === 0xef || b === 0xbb || b === 0xbf)) continue;
      if (b !== 32 && b !== 10 && b !== 13 && b !== 9) return { b, at };
    }
  }
  return { b: -1, at };
}

/**
 * The items of the root array, or of the array member of a root object that holds at least
 * half of the bytes. Undefined for other shapes (they are parsed as one value).
 */
export function indexItems(store: ByteStore): ItemIndex | undefined {
  const chunks = store.chunkList();
  const first = firstByte(store);
  let open = first.at;
  const path: (string | number)[] = [];
  if (first.b === 123) {
    const members = children(chunks, open, true);
    let best = -1;
    for (let i = 0; i < members.n; i++) {
      const vs = members.starts[i];
      if (store.byteAt(vs) !== 91) continue;
      if (best < 0 || members.ends[i] - vs > members.ends[best] - members.starts[best]) best = i;
    }
    if (best < 0 || (members.ends[best] - members.starts[best]) * 2 < store.total) return undefined;
    const keyBytes = store.slice((members.keyStarts as Float64Array)[best], (members.keyEnds as Float64Array)[best]);
    path.push(JSON.parse(new TextDecoder().decode(keyBytes)) as string);
    open = members.starts[best];
  } else if (first.b !== 91) return undefined;
  const items = children(chunks, open, false);
  if (items.closed < 0) return undefined;
  return { path, count: items.n, starts: items.starts, ends: items.ends, lines: items.lines };
}

/** The items as records: each one decoded, and made compact (one line), when it is read. */
export class ItemStore implements LineStore {
  readonly edited = 0;
  readonly done = true;
  readonly openEnd = false;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(
    private readonly bytes: ByteStore,
    readonly index: ItemIndex,
  ) {}

  get count(): number {
    return this.index.count;
  }

  get total(): number {
    return this.bytes.total;
  }

  text(i: number): string {
    return minifyJson(this.decoder.decode(this.bytes.slice(this.index.starts[i], this.index.ends[i])));
  }

  head(i: number, max: number): string {
    const size = this.size(i);
    if (size <= max * 4) {
      const s = this.text(i);
      return s.length > max ? s.slice(0, max) : s;
    }
    // A long item: the start of its bytes, made compact.
    let s = this.decoder.decode(this.bytes.slice(this.index.starts[i], this.index.starts[i] + max * 4));
    if (s.endsWith('�')) s = s.slice(0, -1);
    return minifyJson(s).slice(0, max);
  }

  size(i: number): number {
    return this.index.ends[i] - this.index.starts[i];
  }

  blank(): boolean {
    return false;
  }

  /** The line in the file where item i starts. */
  fileLine(i: number): number {
    return this.index.lines[i];
  }
}
