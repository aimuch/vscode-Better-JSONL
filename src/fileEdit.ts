// Changing a file on disk without VS Code: the state of a file (to see whether it only grew),
// and replacing one line (plain or gzip, in its encoding). No VS Code API here, so the unit
// tests can run it.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import { encodeText } from './encoding';

export interface FileState {
  size: number;
  mtimeMs: number;
  /** The last bytes up to `size` (at most TAIL): a file that only grew still ends with them there. */
  tail: Buffer;
}

const TAIL = 4096;

export async function fileState(fsPath: string): Promise<FileState> {
  const fh = await fs.promises.open(fsPath, 'r');
  try {
    const st = await fh.stat();
    const n = Math.min(TAIL, st.size);
    const tail = Buffer.alloc(n);
    if (n) await fh.read(tail, 0, n, st.size - n);
    return { size: st.size, mtimeMs: st.mtimeMs, tail };
  } finally {
    await fh.close();
  }
}

/** How the file on disk relates to the state read before. */
export async function compare(fsPath: string, known: FileState): Promise<'same' | 'grew' | 'changed'> {
  const st = await fs.promises.stat(fsPath);
  if (st.size === known.size && st.mtimeMs === known.mtimeMs) return 'same';
  if (st.size <= known.size) return 'changed';
  const fh = await fs.promises.open(fsPath, 'r');
  try {
    const n = known.tail.length;
    const now = Buffer.alloc(n);
    if (n) await fh.read(now, 0, n, known.size - n);
    return now.equals(known.tail) ? 'grew' : 'changed';
  } finally {
    await fh.close();
  }
}

export class LineConflict extends Error {}

/** Line ends in the decoded stream: one byte (UTF-8 and other ASCII-based encodings) or one UTF-16 unit. */
interface Layout {
  label: string;
  unit: 1 | 2;
  bom: number;
  lf: Buffer;
  cr: Buffer;
}

function layoutOf(head: Buffer, configured: string): Layout {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return { label: 'utf-16le', unit: 2, bom: 2, lf: Buffer.from([10, 0]), cr: Buffer.from([13, 0]) };
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return { label: 'utf-16be', unit: 2, bom: 2, lf: Buffer.from([0, 10]), cr: Buffer.from([0, 13]) };
  if (configured === 'utf-16le' || configured === 'utf-16be') {
    const le = configured === 'utf-16le';
    return { label: configured, unit: 2, bom: 0, lf: Buffer.from(le ? [10, 0] : [0, 10]), cr: Buffer.from(le ? [13, 0] : [0, 13]) };
  }
  const bom = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  return { label: bom ? 'utf-8' : configured, unit: 1, bom, lf: Buffer.from([10]), cr: Buffer.from([13]) };
}

/** The offset of the next line end in `buf` from `from` (aligned to the unit), or -1. */
function nextLineEnd(buf: Buffer, from: number, l: Layout): number {
  if (l.unit === 1) return buf.indexOf(10, from);
  for (let i = from; i + 1 < buf.length; i += 2) if (buf[i] === l.lf[0] && buf[i + 1] === l.lf[1]) return i;
  return -1;
}

async function write(stream: NodeJS.WritableStream, data: Uint8Array, seen?: (d: Uint8Array) => void): Promise<void> {
  if (!data.length) return;
  seen?.(data);
  if (!stream.write(data)) await new Promise<void>((resolve) => stream.once('drain', resolve));
}

/**
 * Replaces line `line` (0-based) of a file: plain or gzip-compressed, in its encoding
 * (`encoding`, or the one a UTF-16 byte order mark says). The line must still read
 * `original`; its line end (LF or CR LF) stays. The file is written to a new file next to it
 * (compressed again for a .gz file), which then takes its place: a failure leaves the file
 * as it was.
 */
/** What replaceLine wrote (before compression): its size, its last bytes, and how its text is encoded. */
export interface Written {
  total: number;
  tail: Buffer;
  label: string;
  lf: Buffer;
}

const WRITTEN_TAIL = 16 * 1024;

export async function replaceLine(
  fsPath: string,
  line: number,
  original: string,
  text: string,
  opts: { gzip: boolean; encoding: string },
): Promise<FileState & { written: Written }> {
  const mode = (await fs.promises.stat(fsPath)).mode & 0o777;
  const tmp = path.join(path.dirname(fsPath), `.${path.basename(fsPath)}.${randomBytes(4).toString('hex')}.tmp`);
  const raw = fs.createReadStream(fsPath, { highWaterMark: 1024 * 1024 });
  const source: Readable = opts.gzip ? raw.pipe(zlib.createGunzip({ chunkSize: 1024 * 1024 })) : raw;
  raw.on('error', (e) => source.destroy(e));
  const file = fs.createWriteStream(tmp, { mode });
  const sink: NodeJS.WritableStream = opts.gzip ? zlib.createGzip({ chunkSize: 1024 * 1024 }) : file;
  if (opts.gzip) (sink as zlib.Gzip).pipe(file);
  const closed = new Promise<void>((resolve, reject) => {
    file.on('close', resolve);
    file.on('error', reject);
  });
  // Awaited below; a failure before that is handled in catch.
  closed.catch(() => undefined);
  let total = 0;
  let tail: Buffer = Buffer.alloc(0);
  // The end of what is written, for the caller (a compressed file followed by the view).
  const seen = (d: Uint8Array) => {
    total += d.length;
    const b = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    tail = b.length >= WRITTEN_TAIL ? Buffer.from(b.subarray(b.length - WRITTEN_TAIL)) : Buffer.concat([tail, b]).subarray(-WRITTEN_TAIL);
  };
  let l: Layout | undefined;
  try {
    let index = 0;
    let target: Buffer[] | null = line === 0 ? [] : null;
    let done = false;
    let carry: Buffer = Buffer.alloc(0);
    const finish = async (hasLf: boolean) => {
      const lay = l as Layout;
      let old = Buffer.concat(target as Buffer[]);
      let bom = Buffer.alloc(0);
      if (line === 0 && lay.bom) {
        bom = old.subarray(0, lay.bom);
        old = old.subarray(lay.bom);
      }
      const cr = old.length >= lay.unit && old.subarray(old.length - lay.unit).equals(lay.cr);
      if (cr) old = old.subarray(0, old.length - lay.unit);
      if (new TextDecoder(lay.label).decode(old) !== original) throw new LineConflict(`line ${line + 1} changed on disk`);
      await write(sink, Buffer.concat([bom, encodeText(text, lay.label), cr ? lay.cr : Buffer.alloc(0), hasLf ? lay.lf : Buffer.alloc(0)]), seen);
      target = null;
      done = true;
    };
    for await (const piece of source as AsyncIterable<Buffer>) {
      if (done) {
        await write(sink, piece, seen);
        continue;
      }
      let buf = carry.length ? Buffer.concat([carry, piece]) : piece;
      if (!l) {
        if (buf.length < 3) {
          carry = buf;
          continue;
        }
        l = layoutOf(buf, opts.encoding);
      }
      // UTF-16: an odd last byte waits for the next piece.
      const usable = l.unit === 2 ? buf.length - (buf.length % 2) : buf.length;
      carry = Buffer.from(buf.subarray(usable));
      buf = buf.subarray(0, usable);
      let at = 0;
      while (!done) {
        const end = nextLineEnd(buf, at, l);
        const stop = end < 0 ? buf.length : end;
        if (target) target.push(Buffer.from(buf.subarray(at, stop)));
        else await write(sink, buf.subarray(at, stop), seen);
        if (end < 0) break;
        if (target) await finish(true);
        else await write(sink, l.lf, seen);
        at = end + l.unit;
        index++;
        if (index === line) target = [];
      }
      if (done && at < buf.length) await write(sink, buf.subarray(at), seen);
    }
    if (!done && carry.length) {
      if (target) target.push(carry);
      else await write(sink, carry, seen);
    }
    if (!l) l = layoutOf(carry, opts.encoding);
    if (target) await finish(false);
    if (!done) throw new LineConflict(`line ${line + 1} is not in the file`);
    sink.end();
    await closed;
    await fs.promises.rename(tmp, fsPath);
  } catch (e) {
    raw.destroy();
    if (opts.gzip) {
      (sink as zlib.Gzip).unpipe(file);
      (sink as zlib.Gzip).destroy();
    }
    file.destroy();
    await closed.catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  const lay = l ?? layoutOf(Buffer.alloc(0), opts.encoding);
  return { ...(await fileState(fsPath)), written: { total, tail, label: lay.label, lf: lay.lf } };
}
