// Changing a file on disk without VS Code: the state of a file (to see whether it only grew),
// and replacing one line (plain or gzip, in its encoding). No VS Code API here, so the unit
// tests can run it.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import { encodeText } from './encoding';
import type { LineMutation } from './shared/protocol';

export interface FileState {
  size: number;
  mtimeMs: number;
  /** The last bytes up to `size` (at most TAIL): a file that only grew still ends with them there. */
  tail: Buffer;
}

export const TAIL = 4096;

export async function fileState(fsPath: string, atSize?: number): Promise<FileState> {
  const fh = await fs.promises.open(fsPath, 'r');
  try {
    const st = await fh.stat();
    const size = atSize !== undefined && atSize < st.size ? atSize : st.size;
    const n = Math.min(TAIL, size);
    const tail = Buffer.alloc(n);
    if (n) await fh.read(tail, 0, n, size - n);
    return { size, mtimeMs: size < st.size ? 0 : st.mtimeMs, tail };
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

/** The next line break (LF, CR LF, or a standalone CR) in `buf` from `from` (aligned to `l.unit`), or null. */
function nextLineBreak(buf: Buffer, from: number, l: Layout): { at: number; len: number } | null {
  if (l.unit === 1) {
    for (let i = from; i < buf.length; i++) {
      const b = buf[i];
      if (b === 10) return { at: i, len: 1 };
      if (b === 13) return { at: i, len: i + 1 < buf.length && buf[i + 1] === 10 ? 2 : 1 };
    }
    return null;
  }
  for (let i = from; i + 1 < buf.length; i += 2) {
    if (buf[i] === l.lf[0] && buf[i + 1] === l.lf[1]) return { at: i, len: 2 };
    if (buf[i] === l.cr[0] && buf[i + 1] === l.cr[1]) {
      const crlf = i + 3 < buf.length && buf[i + 2] === l.lf[0] && buf[i + 3] === l.lf[1];
      return { at: i, len: crlf ? 4 : 2 };
    }
  }
  return null;
}

async function write(stream: NodeJS.WritableStream, data: Uint8Array, seen?: (d: Uint8Array) => void): Promise<void> {
  if (!data.length) return;
  seen?.(data);
  if (!stream.write(data)) await new Promise<void>((resolve) => stream.once('drain', resolve));
}

export type Compression = 'gzip' | 'brotli' | null;

function resolveCompression(opts: { gzip?: boolean; compression?: Compression }): Compression {
  if (opts.compression !== undefined) return opts.compression;
  return opts.gzip ? 'gzip' : null;
}

function wrapReadStream(raw: Readable, comp: Compression): Readable {
  if (comp === 'gzip') return raw.pipe(zlib.createGunzip({ chunkSize: 1024 * 1024 }));
  if (comp === 'brotli') return raw.pipe(zlib.createBrotliDecompress({ chunkSize: 1024 * 1024 }));
  return raw;
}

function wrapWriteStream(file: fs.WriteStream, comp: Compression): { sink: NodeJS.WritableStream; destroy: () => void } {
  if (comp === 'gzip') {
    const gz = zlib.createGzip({ chunkSize: 1024 * 1024 });
    gz.pipe(file);
    return {
      sink: gz,
      destroy: () => {
        gz.unpipe(file);
        gz.destroy();
      },
    };
  }
  if (comp === 'brotli') {
    const br = zlib.createBrotliCompress({
      chunkSize: 1024 * 1024,
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
    });
    br.pipe(file);
    return {
      sink: br,
      destroy: () => {
        br.unpipe(file);
        br.destroy();
      },
    };
  }
  return { sink: file, destroy: () => undefined };
}

/** What replaceLine wrote (before compression): its size, its last bytes, and how its text is encoded. */
export interface Written {
  total: number;
  tail: Buffer;
  label: string;
  lf: Buffer;
}

const WRITTEN_TAIL = 16 * 1024;

/**
 * Replaces line `line` (0-based) of a file: plain or compressed (`.gz` / `.br`), in its encoding
 * (`encoding`, or the one a UTF-16/UTF-8 byte order mark says). The line must still read
 * `original`; its line end (LF, CR LF, or CR) stays. Symbolic links are resolved first so the
 * target file is updated rather than replacing the link. The file is written to a temporary
 * file next to the target and renamed into place: a failure leaves the file as it was.
 */
export async function replaceLine(
  fsPath: string,
  line: number,
  original: string,
  text: string,
  opts: { gzip?: boolean; compression?: Compression; encoding: string },
): Promise<FileState & { written: Written }> {
  const comp = resolveCompression(opts);
  const realPath = await fs.promises.realpath(fsPath);
  const mode = (await fs.promises.stat(realPath)).mode & 0o777;
  const tmp = path.join(path.dirname(realPath), `.${path.basename(realPath)}.${randomBytes(4).toString('hex')}.tmp`);
  const raw = fs.createReadStream(realPath, { highWaterMark: 1024 * 1024 });
  const source: Readable = wrapReadStream(raw, comp);
  raw.on('error', (e) => source.destroy(e));
  const file = fs.createWriteStream(tmp, { mode });
  const { sink, destroy: destroyComp } = wrapWriteStream(file, comp);
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
    const finish = async (eolBytes: Buffer) => {
      const lay = l as Layout;
      let old = Buffer.concat(target as Buffer[]);
      let bom = Buffer.alloc(0);
      if (line === 0 && lay.bom) {
        bom = old.subarray(0, lay.bom);
        old = old.subarray(lay.bom);
      }
      if (new TextDecoder(lay.label, { ignoreBOM: true }).decode(old) !== original) throw new LineConflict(`line ${line + 1} changed on disk`);
      await write(sink, Buffer.concat([bom, encodeText(text, lay.label), eolBytes]), seen);
      target = null;
      done = true;
    };
    const scanChunk = async (buf: Buffer) => {
      const lay = l as Layout;
      let at = 0;
      while (!done) {
        const brk = nextLineBreak(buf, at, lay);
        const stop = brk ? brk.at : buf.length;
        if (target) target.push(Buffer.from(buf.subarray(at, stop)));
        else await write(sink, buf.subarray(at, stop), seen);
        if (!brk) break;
        const eolBytes = buf.subarray(brk.at, brk.at + brk.len);
        if (target) await finish(eolBytes);
        else await write(sink, eolBytes, seen);
        at = brk.at + brk.len;
        index++;
        if (index === line) target = [];
      }
      if (done && at < buf.length) await write(sink, buf.subarray(at), seen);
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
      // UTF-16: an odd last byte waits for the next piece. A trailing CR also waits so CR LF is not split.
      let usable = l.unit === 2 ? buf.length - (buf.length % 2) : buf.length;
      if (usable >= l.unit && buf.subarray(usable - l.unit, usable).equals(l.cr)) usable -= l.unit;
      carry = Buffer.from(buf.subarray(usable));
      buf = buf.subarray(0, usable);
      if (buf.length) await scanChunk(buf);
    }
    if (!l) l = layoutOf(carry, opts.encoding);
    if (carry.length) {
      if (done) await write(sink, carry, seen);
      else await scanChunk(carry);
    }
    if (target) await finish(Buffer.alloc(0));
    if (!done) throw new LineConflict(`line ${line + 1} is not in the file`);
    sink.end();
    await closed;
    await fs.promises.chmod(tmp, mode);
    await fs.promises.rename(tmp, realPath);
  } catch (e) {
    raw.destroy();
    destroyComp();
    file.destroy();
    await closed.catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  const lay = l ?? layoutOf(Buffer.alloc(0), opts.encoding);
  return { ...(await fileState(fsPath)), written: { total, tail, label: lay.label, lf: lay.lf } };
}

/**
 * Inserts a line, deletes lines, or batch-rewrites lines atomically in a plain or compressed
 * file while preserving BOM, encoding, line breaks, symlinks, and file permissions.
 */
export async function mutateFileLines(
  fsPath: string,
  mutation: LineMutation,
  opts: { gzip?: boolean; compression?: Compression; encoding: string },
): Promise<FileState> {
  const comp = resolveCompression(opts);
  const realPath = await fs.promises.realpath(fsPath);
  const mode = (await fs.promises.stat(realPath)).mode & 0o777;
  const tmp = path.join(path.dirname(realPath), `.${path.basename(realPath)}.${randomBytes(4).toString('hex')}.tmp`);
  const raw = fs.createReadStream(realPath, { highWaterMark: 1024 * 1024 });
  const source: Readable = wrapReadStream(raw, comp);
  raw.on('error', (e) => source.destroy(e));
  const file = fs.createWriteStream(tmp, { mode });
  const { sink, destroy: destroyComp } = wrapWriteStream(file, comp);
  const closed = new Promise<void>((resolve, reject) => {
    file.on('close', resolve);
    file.on('error', reject);
  });
  closed.catch(() => undefined);
  const delSet = mutation.op === 'delete' ? new Set(mutation.lines) : null;
  const rewriteMap = mutation.op === 'rewrite' ? new Map(mutation.edits.map((e) => [e.line, e])) : null;
  let l: Layout | undefined;
  let carry: Buffer = Buffer.alloc(0);
  let index = 0;
  let cur: Buffer[] = [];
  let inserted = false;
  try {
    const emitLine = async (eolBytes: Buffer) => {
      const lay = l as Layout;
      let lineBuf = Buffer.concat(cur);
      cur = [];
      let bom = Buffer.alloc(0);
      if (index === 0 && lay.bom && lineBuf.length >= lay.bom) {
        bom = lineBuf.subarray(0, lay.bom);
        lineBuf = lineBuf.subarray(lay.bom);
      }
      if (bom.length) await write(sink, bom);
      if (mutation.op === 'insert' && mutation.after < 0 && index === 0 && !inserted) {
        await write(sink, Buffer.concat([encodeText(mutation.text, lay.label), eolBytes.length ? eolBytes : lay.lf]));
        inserted = true;
      }
      if (delSet?.has(index)) {
        // Drop this line (its BOM if index 0 was already preserved above).
      } else if (rewriteMap?.has(index)) {
        const ed = rewriteMap.get(index)!;
        if (new TextDecoder(lay.label, { ignoreBOM: true }).decode(lineBuf) !== ed.original) {
          throw new LineConflict(`line ${index + 1} changed on disk`);
        }
        await write(sink, Buffer.concat([encodeText(ed.text, lay.label), eolBytes]));
      } else {
        await write(sink, Buffer.concat([lineBuf, eolBytes]));
      }
      if (mutation.op === 'insert' && mutation.after === index && !inserted) {
        if (!eolBytes.length && !delSet?.has(index)) await write(sink, lay.lf);
        await write(sink, Buffer.concat([encodeText(mutation.text, lay.label), eolBytes.length ? eolBytes : lay.lf]));
        inserted = true;
      }
      index++;
    };
    const scanChunk = async (buf: Buffer) => {
      const lay = l as Layout;
      let at = 0;
      while (at < buf.length) {
        const brk = nextLineBreak(buf, at, lay);
        if (!brk) {
          cur.push(Buffer.from(buf.subarray(at)));
          break;
        }
        cur.push(Buffer.from(buf.subarray(at, brk.at)));
        await emitLine(buf.subarray(brk.at, brk.at + brk.len));
        at = brk.at + brk.len;
      }
    };
    for await (const piece of source as AsyncIterable<Buffer>) {
      let buf = carry.length ? Buffer.concat([carry, piece]) : piece;
      if (!l) {
        if (buf.length < 3) {
          carry = buf;
          continue;
        }
        l = layoutOf(buf, opts.encoding);
      }
      let usable = l.unit === 2 ? buf.length - (buf.length % 2) : buf.length;
      if (usable >= l.unit && buf.subarray(usable - l.unit, usable).equals(l.cr)) usable -= l.unit;
      carry = Buffer.from(buf.subarray(usable));
      buf = buf.subarray(0, usable);
      if (buf.length) await scanChunk(buf);
    }
    if (!l) l = layoutOf(carry, opts.encoding);
    if (carry.length) await scanChunk(carry);
    if (cur.some((b) => b.length > 0) || index === 0) {
      if (index === 0 && cur.every((b) => b.length === 0)) {
        if (mutation.op === 'insert' && !inserted) {
          await write(sink, Buffer.concat([encodeText(mutation.text, l.label), l.lf]));
          inserted = true;
        }
      } else {
        await emitLine(Buffer.alloc(0));
      }
    }
    if (mutation.op === 'insert' && !inserted) {
      await write(sink, Buffer.concat([encodeText(mutation.text, l.label), l.lf]));
    }
    sink.end();
    await closed;
    await fs.promises.chmod(tmp, mode);
    await fs.promises.rename(tmp, realPath);
  } catch (e) {
    raw.destroy();
    destroyComp();
    file.destroy();
    await closed.catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  return fileState(fsPath);
}
