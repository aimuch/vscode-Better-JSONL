// Reading and writing files that VS Code does not give to extensions: files above 50 MB, and
// compressed files (.jsonl.gz). The webview always gets UTF-8.
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import * as vscode from 'vscode';

/** A large file goes to the webview in pieces of about this size. */
export const CHUNK = 4 * 1024 * 1024;

/** Compressed files Better JSONL opens: the name without ".gz" says JSON or JSON Lines. */
const GZIP = /\.(jsonl|ndjson|jsonlines|json)\.gz$/i;

export function isGzipPath(p: string): boolean {
  return GZIP.test(p);
}

/** The name without ".gz". */
export function innerName(p: string): string {
  return p.replace(/\.gz$/i, '');
}

/**
 * The encoding to read a file with, as a WHATWG label: the "files.encoding" setting for the
 * file. A byte order mark in the file wins over it (see readUtf8).
 */
export function encodingFor(uri: vscode.Uri): string {
  const id = vscode.workspace.getConfiguration('files', uri).get<string>('encoding', 'utf8');
  return LABELS[id] ?? id.replace(/^(iso|windows|cp|koi8)(\d)/, '$1-$2');
}

const LABELS: Record<string, string> = {
  utf8: 'utf-8',
  utf8bom: 'utf-8',
  utf16le: 'utf-16le',
  utf16be: 'utf-16be',
  windows1252: 'windows-1252',
  iso88591: 'iso-8859-1',
  iso88592: 'iso-8859-2',
  iso885915: 'iso-8859-15',
  cp437: 'ibm437',
  cp850: 'ibm850',
  cp866: 'ibm866',
  gbk: 'gbk',
  gb18030: 'gb18030',
  gb2312: 'gbk',
  big5hkscs: 'big5',
  shiftjis: 'shift_jis',
  eucjp: 'euc-jp',
  euckr: 'euc-kr',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
};

export interface SourceOptions {
  gzip: boolean;
  /** WHATWG label; UTF-8 is passed through as it is. */
  encoding: string;
  /** Start here (a byte offset in the file). Not for compressed files. */
  from?: number;
  /** Stop before this byte offset. */
  to?: number;
}

/** The file as raw bytes, from `from` on. */
async function rawStream(uri: vscode.Uri, from: number, to: number | undefined): Promise<Readable> {
  if (uri.scheme === 'file') {
    if (to !== undefined && to <= from) return Readable.from([]);
    return fs.createReadStream(uri.fsPath, { start: from, end: to === undefined ? undefined : to - 1, highWaterMark: 1024 * 1024 });
  }
  const all = await vscode.workspace.fs.readFile(uri);
  const end = Math.min(all.byteLength, to ?? all.byteLength);
  return Readable.from([Buffer.from(all.buffer, all.byteOffset + from, Math.max(0, end - from))]);
}

/**
 * Reads a file as UTF-8 pieces of about CHUNK bytes. `read` is how many bytes of the file
 * (compressed bytes for a .gz file) were read so far, for the progress.
 * The encoding comes from a byte order mark first (UTF-16), then from `options.encoding`.
 */
export async function* readUtf8(uri: vscode.Uri, options: SourceOptions): AsyncGenerator<{ data: Uint8Array; read: number }> {
  const raw = await rawStream(uri, options.from ?? 0, options.to);
  let read = 0;
  raw.on('data', (b: Buffer) => (read += b.length));
  const source: Readable = options.gzip ? raw.pipe(zlib.createGunzip({ chunkSize: 1024 * 1024 })) : raw;
  raw.on('error', (e) => source.destroy(e));
  let decoder: TextDecoder | null | undefined;
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const piece of source as AsyncIterable<Buffer>) {
      let b = piece;
      if (decoder === undefined) {
        // The first bytes decide: a UTF-16 byte order mark, or the configured encoding.
        const bom16 = b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff));
        const label = bom16 ? (b[0] === 0xff ? 'utf-16le' : 'utf-16be') : options.encoding;
        decoder = label === 'utf-8' || label === 'utf8' ? null : makeDecoder(label);
      }
      if (decoder) b = Buffer.from(decoder.decode(b, { stream: true }), 'utf8');
      parts.push(b);
      size += b.length;
      if (size >= CHUNK) {
        yield { data: concat(parts, size), read };
        parts.length = 0;
        size = 0;
      }
    }
    if (decoder) {
      const rest = Buffer.from(decoder.decode(), 'utf8');
      if (rest.length) {
        parts.push(rest);
        size += rest.length;
      }
    }
    yield { data: concat(parts, size), read };
  } finally {
    raw.destroy();
  }
}

function makeDecoder(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    throw new Error(`the encoding "${label}" is not supported`);
  }
}

function concat(parts: Buffer[], size: number): Uint8Array {
  if (parts.length === 1) return new Uint8Array(parts[0].buffer, parts[0].byteOffset, parts[0].byteLength);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

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

/**
 * Replaces line `line` (0-based) of a UTF-8 file. The line must still read `original`; its
 * line end (LF or CR LF) stays. The file is written to a new file next to it, which then
 * takes its place, so a failure leaves the file as it was.
 */
export async function replaceLine(fsPath: string, line: number, original: string, text: string): Promise<FileState> {
  const fh = await fs.promises.open(fsPath, 'r');
  let start = -1;
  let end = -1;
  let size = 0;
  let mode = 0o644;
  try {
    const st = await fh.stat();
    size = st.size;
    mode = st.mode;
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let lineStart = 0;
    let index = 0;
    // A UTF-8 byte order mark is not part of the first line.
    const head = Buffer.alloc(3);
    await fh.read(head, 0, 3, 0);
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) lineStart = 3;
    if (index === line) start = lineStart;
    for (let pos = 0; pos < size && end < 0; ) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      for (let j = buf.indexOf(10); j >= 0 && j < bytesRead; j = buf.indexOf(10, j + 1)) {
        if (index === line) {
          end = pos + j;
          break;
        }
        index++;
        lineStart = pos + j + 1;
        if (index === line) start = lineStart;
      }
      pos += bytesRead;
    }
    if (start >= 0 && end < 0) end = size;
    if (start < 0 || start > size) throw new LineConflict(`line ${line + 1} is not in the file`);
    const old = Buffer.alloc(end - start);
    if (old.length) await fh.read(old, 0, old.length, start);
    const cr = old.length > 0 && old[old.length - 1] === 13;
    if (!old.subarray(0, cr ? old.length - 1 : old.length).equals(Buffer.from(original, 'utf8'))) throw new LineConflict(`line ${line + 1} changed on disk`);
    if (cr) end--;
  } finally {
    await fh.close();
  }
  const tmp = path.join(path.dirname(fsPath), `.${path.basename(fsPath)}.${randomBytes(4).toString('hex')}.tmp`);
  const out = await fs.promises.open(tmp, 'w', mode & 0o777);
  try {
    const src = await fs.promises.open(fsPath, 'r');
    try {
      await copyRange(src, out, 0, start);
      await out.write(Buffer.from(text, 'utf8'));
      await copyRange(src, out, end, size);
    } finally {
      await src.close();
    }
    await out.close();
    await fs.promises.rename(tmp, fsPath);
  } catch (e) {
    await out.close().catch(() => undefined);
    await fs.promises.rm(tmp, { force: true });
    throw e;
  }
  return fileState(fsPath);
}

async function copyRange(src: fs.promises.FileHandle, out: fs.promises.FileHandle, from: number, to: number): Promise<void> {
  const buf = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, to - from)));
  for (let pos = from; pos < to; ) {
    const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, to - pos), pos);
    if (!bytesRead) break;
    await out.write(buf, 0, bytesRead);
    pos += bytesRead;
  }
}
