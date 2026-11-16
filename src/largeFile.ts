// Reading and writing files that VS Code does not give to extensions: files above 50 MB, and
// compressed files (.jsonl.gz). The webview always gets UTF-8.
import * as fs from 'fs';
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
  /** Check for a byte order mark at the start of the stream (defaults to true when `from` is 0). */
  detectBom?: boolean;
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

function detectLabel(head: Buffer, configured: string, detectBom: boolean): string {
  if (detectBom) {
    if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
    if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
    if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return 'utf-8';
  }
  return configured;
}

/**
 * Reads a file as UTF-8 pieces of about CHUNK bytes. `read` is how many bytes of the file
 * (compressed bytes for a .gz file) were read so far, for the progress.
 * The encoding comes from a byte order mark first (when reading from byte 0), then from `options.encoding`.
 */
export async function* readUtf8(uri: vscode.Uri, options: SourceOptions): AsyncGenerator<{ data: Uint8Array; read: number; encoding: string }> {
  const from = options.from ?? 0;
  const detectBom = options.detectBom ?? from === 0;
  const raw = await rawStream(uri, from, options.to);
  let read = 0;
  raw.on('data', (b: Buffer) => (read += b.length));
  // A file that is still being written (a compressed log) ends in the middle: the output so far is used.
  const source: Readable = options.gzip ? raw.pipe(zlib.createGunzip({ chunkSize: 1024 * 1024, finishFlush: zlib.constants.Z_SYNC_FLUSH })) : raw;
  raw.on('error', (e) => source.destroy(e));
  let decoder: TextDecoder | null | undefined;
  let resolved = options.encoding;
  let headCarry: Buffer = Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const piece of source as AsyncIterable<Buffer>) {
      let b = piece;
      if (decoder === undefined) {
        b = headCarry.length ? Buffer.concat([headCarry, b]) : b;
        if (detectBom && b.length < 3) {
          headCarry = b;
          continue;
        }
        headCarry = Buffer.alloc(0);
        resolved = detectLabel(b, options.encoding, detectBom);
        decoder = resolved === 'utf-8' || resolved === 'utf8' ? null : makeDecoder(resolved, !detectBom);
      }
      if (decoder) b = Buffer.from(decoder.decode(b, { stream: true }), 'utf8');
      parts.push(b);
      size += b.length;
      if (size >= CHUNK) {
        yield { data: concat(parts, size), read, encoding: resolved };
        parts.length = 0;
        size = 0;
      }
    }
    if (decoder === undefined && headCarry.length) {
      resolved = detectLabel(headCarry, options.encoding, detectBom);
      decoder = resolved === 'utf-8' || resolved === 'utf8' ? null : makeDecoder(resolved, !detectBom);
      const first = decoder ? Buffer.from(decoder.decode(headCarry, { stream: true }), 'utf8') : headCarry;
      if (first.length) {
        parts.push(first);
        size += first.length;
      }
    }
    if (decoder) {
      const rest = Buffer.from(decoder.decode(), 'utf8');
      if (rest.length) {
        parts.push(rest);
        size += rest.length;
      }
    }
    yield { data: concat(parts, size), read, encoding: resolved };
  } finally {
    raw.destroy();
  }
}

function makeDecoder(label: string, ignoreBOM: boolean): TextDecoder {
  try {
    return new TextDecoder(label, { ignoreBOM });
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

export { compare, fileState, LineConflict, replaceLine, type FileState } from './fileEdit';
