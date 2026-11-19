// Reading and writing files that VS Code does not give to extensions: files above 50 MB, and
// compressed files (.jsonl.gz). The webview always gets UTF-8.
import * as fs from 'fs';
import { Readable } from 'stream';
import * as zlib from 'zlib';
import * as vscode from 'vscode';
import { t } from './shared/i18n';
import type { Compression } from './fileEdit';

/** A large file goes to the webview in pieces of about this size. */
export const CHUNK = 4 * 1024 * 1024;

/** Compressed files Better JSONL opens (.gz, .br, .zst): the inner name says JSON or JSON Lines. */
const GZIP = /\.(jsonl|ndjson|jsonlines|json)\.gz$/i;
const BROTLI = /\.(jsonl|ndjson|jsonlines|json)\.br$/i;
const ZSTD = /\.(jsonl|ndjson|jsonlines|json)\.zst$/i;

export function compressionOfPath(p: string): Compression {
  if (GZIP.test(p)) return 'gzip';
  if (BROTLI.test(p)) return 'brotli';
  if (ZSTD.test(p)) return 'zstd';
  return null;
}

export function isGzipPath(p: string): boolean {
  return compressionOfPath(p) !== null;
}

/** The name without ".gz", ".br", or ".zst". */
export function innerName(p: string): string {
  return p.replace(/\.(gz|br|zst)$/i, '');
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
  compression?: Compression;
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
  const comp: Compression = options.compression !== undefined ? options.compression : options.gzip ? 'gzip' : null;
  // A file that is still being written (a compressed log) ends in the middle: the output so far is used.
  const zstdDecompress = (zlib as unknown as { createZstdDecompress?: (opts?: { chunkSize?: number }) => NodeJS.ReadWriteStream }).createZstdDecompress;
  const source: Readable =
    comp === 'zstd'
      ? (() => {
          if (typeof zstdDecompress !== 'function') {
            throw new Error('Zstandard (.zst) requires Node.js 22.15+.');
          }
          return raw.pipe(zstdDecompress({ chunkSize: 1024 * 1024 })) as unknown as Readable;
        })()
      : comp === 'brotli'
        ? raw.pipe(zlib.createBrotliDecompress({ chunkSize: 1024 * 1024, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH }))
        : comp === 'gzip'
          ? raw.pipe(zlib.createGunzip({ chunkSize: 1024 * 1024, finishFlush: zlib.constants.Z_SYNC_FLUSH }))
          : raw;
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
    throw new Error(t('the encoding "{0}" is not supported', label));
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

/** Reads a plain or compressed (.gz / .br / .zst) file into a UTF-8 string up to `maxDecodedBytes`. */
export async function readAllUtf8(uri: vscode.Uri, maxDecodedBytes = 50 * 1024 * 1024): Promise<string> {
  const comp = compressionOfPath(uri.path);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const piece of readUtf8(uri, { gzip: comp !== null, compression: comp, encoding: encodingFor(uri) })) {
    total += piece.data.byteLength;
    if (total > maxDecodedBytes) throw new Error(t('File exceeds 50 MB comparison limit.'));
    parts.push(Buffer.from(piece.data.buffer, piece.data.byteOffset, piece.data.byteLength));
  }
  return Buffer.concat(parts).toString('utf8');
}

function fnv64Pair(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}:${(h2 >>> 0).toString(36)}:${s.length}`;
}

async function* readLinesStream(uri: vscode.Uri): AsyncGenerator<{ line: number; text: string }> {
  const comp = compressionOfPath(uri.path);
  const decoder = new TextDecoder('utf-8');
  let carry = '';
  let line = 0;
  for await (const piece of readUtf8(uri, { gzip: comp !== null, compression: comp, encoding: encodingFor(uri) })) {
    const chunk = carry + decoder.decode(piece.data, { stream: true });
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10) {
        const end = i > start && chunk.charCodeAt(i - 1) === 13 ? i - 1 : i;
        yield { line: line++, text: chunk.slice(start, end) };
        start = i + 1;
      }
    }
    carry = chunk.slice(start);
  }
  carry += decoder.decode();
  if (carry.length) yield { line: line++, text: carry.endsWith('\r') ? carry.slice(0, -1) : carry };
}

const STREAM_KEY_CANDIDATES = ['id', '_id', 'uuid', 'sample_id', 'event_id', 'key'];

function extractStreamKey(text: string, keyField: string): string | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && keyField in obj) {
      const v = obj[keyField];
      if (v !== null && v !== undefined && typeof v !== 'object') return String(v);
    }
  } catch {
    // ignore malformed line
  }
  return null;
}

export interface StreamDiffSummary {
  mode: 'key' | 'line';
  keyField: string | null;
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  entries: { kind: 'added' | 'removed' | 'modified'; keyLabel: string; leftLine?: number; rightLine?: number; leftText?: string; rightText?: string }[];
}

/**
 * Streaming hash-indexed cross-file comparison for large JSONL datasets (>50 MB).
 * Stores only compact key -> (hash, line) maps in memory, keeping full text only for bounded diff samples.
 */
export async function streamDiffFiles(leftUri: vscode.Uri, rightUri: vscode.Uri, maxEntries = 500): Promise<StreamDiffSummary> {
  // Detect a common primary key from the first 50 lines of leftUri.
  let keyField: string | null = null;
  const counts = new Map<string, number>();
  let sampled = 0;
  for await (const { text } of readLinesStream(leftUri)) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        for (const k of STREAM_KEY_CANDIDATES) {
          if (k in obj && obj[k] !== null && obj[k] !== undefined && typeof obj[k] !== 'object') {
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
        }
      }
    } catch {
      // ignore
    }
    if (++sampled >= 50) break;
  }
  for (const k of STREAM_KEY_CANDIDATES) {
    if ((counts.get(k) ?? 0) >= Math.max(1, sampled * 0.8)) {
      keyField = k;
      break;
    }
  }

  const leftIndex = new Map<string, { line: number; hash: string; sample?: string }>();
  for await (const { line, text } of readLinesStream(leftUri)) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const key = keyField ? extractStreamKey(trimmed, keyField) ?? `#${line + 1}` : `#${line + 1}`;
    const sample = leftIndex.size < 20_000 && trimmed.length <= 8192 ? trimmed : undefined;
    leftIndex.set(key, { line, hash: fnv64Pair(trimmed), sample });
  }

  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;
  const entries: StreamDiffSummary['entries'] = [];
  const seenLeft = new Set<string>();

  for await (const { line, text } of readLinesStream(rightUri)) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const key = keyField ? extractStreamKey(trimmed, keyField) ?? `#${line + 1}` : `#${line + 1}`;
    const prev = leftIndex.get(key);
    if (!prev) {
      added++;
      if (entries.length < maxEntries) {
        entries.push({ kind: 'added', keyLabel: key, rightLine: line, rightText: trimmed.slice(0, 16_384) });
      }
    } else {
      seenLeft.add(key);
      if (prev.hash === fnv64Pair(trimmed)) {
        unchanged++;
      } else {
        modified++;
        if (entries.length < maxEntries) {
          entries.push({
            kind: 'modified',
            keyLabel: key,
            leftLine: prev.line,
            rightLine: line,
            leftText: prev.sample,
            rightText: trimmed.slice(0, 16_384),
          });
        }
      }
    }
  }

  for (const [key, prev] of leftIndex) {
    if (!seenLeft.has(key)) {
      removed++;
      if (entries.length < maxEntries) {
        entries.push({ kind: 'removed', keyLabel: key, leftLine: prev.line, leftText: prev.sample });
      }
    }
  }

  return { mode: keyField ? 'key' : 'line', keyField, added, removed, modified, unchanged, entries };
}

/**
 * Merges multiple JSON/JSONL/compressed files into a single JSONL stream with `_file` source metadata injected.
 */
export async function readMergedJsonl(uris: vscode.Uri[], maxBytes = 80 * 1024 * 1024): Promise<string> {
  const out: string[] = [];
  let bytes = 0;
  for (const uri of uris) {
    const base = uri.path.split('/').pop() ?? uri.fsPath;
    const prefix = `{"_file":${JSON.stringify(base)},`;
    for await (const { text } of readLinesStream(uri)) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      let lineOut: string;
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        lineOut = trimmed === '{}' ? `{"_file":${JSON.stringify(base)}}` : prefix + trimmed.slice(1);
      } else {
        lineOut = `{"_file":${JSON.stringify(base)},"value":${trimmed}}`;
      }
      bytes += lineOut.length + 1;
      if (bytes > maxBytes) break;
      out.push(lineOut);
    }
    if (bytes > maxBytes) break;
  }
  return out.join('\n') + (out.length ? '\n' : '');
}

export { compare, fileState, LineConflict, mutateFileLines, replaceLine, supportsZstd, TAIL, type Compression, type FileState } from './fileEdit';
