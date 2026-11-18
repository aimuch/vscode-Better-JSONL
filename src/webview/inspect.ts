// Smart value inspection: nested JSON-in-string unpacking, safe Markdown rendering,
// and automatic Timestamp / JWT / Base64 / URL semantic decoding.
import { childKey, decodeKey, esc, isContainer, isObj, parseJson, RawNum, stringifyPretty, type JObj, type JVal } from './json';

const MAX_UNPACK_LEN = 2 * 1024 * 1024;
const MAX_MEMO_STR_LEN = 262_144;
const MAX_MEMO_ENTRIES = 512;
const unpackMemo = new Map<string, JVal | null>();

/**
 * If `s` holds serialized JSON (an object `{...}`, an array `[...]`, or multi-line JSONL),
 * returns the parsed value so views can unpack stringified payloads in place.
 * Memoized for strings <= 256 KB so virtual-scroll repaints never re-parse on every frame.
 */
export function tryUnpackJsonString(s: string): JVal | undefined {
  if (s.length < 2 || s.length > MAX_UNPACK_LEN) return undefined;
  const c0 = s.charCodeAt(0);
  // Fast path: 99% of strings do not start with `{`, `[`, or leading whitespace.
  if (c0 !== 123 && c0 !== 91 && c0 > 32) return undefined;
  const useMemo = s.length <= MAX_MEMO_STR_LEN;
  if (useMemo && unpackMemo.has(s)) {
    return unpackMemo.get(s) ?? undefined;
  }
  const store = (res: JVal | undefined): JVal | undefined => {
    if (useMemo) {
      if (unpackMemo.size >= MAX_MEMO_ENTRIES) {
        const oldest = unpackMemo.keys().next().value;
        if (oldest !== undefined) unpackMemo.delete(oldest);
      }
      unpackMemo.set(s, res ?? null);
    }
    return res;
  };
  const trimmed = s.trim();
  if (trimmed.length < 2) return store(undefined);
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '{' && last === '}') || (first === '[' && last === ']')) {
    try {
      const v = parseJson(trimmed);
      if (isContainer(v)) return store(v);
    } catch {
      // Check if it is multi-line JSONL (`{...}\n{...}`).
    }
  }
  if (first === '{' && trimmed.includes('\n')) {
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length >= 2 && lines.length <= 5000 && lines.every((l) => l.trim().startsWith('{'))) {
      try {
        return store(lines.map((l) => parseJson(l)));
      } catch {
        return store(undefined);
      }
    }
  }
  return store(undefined);
}

/** Resolves a value along `pathKey`, stepping into unpacked JSON strings when `unpacked` contains an ancestor path. */
export function resolveAtPathKey(root: JVal | undefined, pathKey: string, unpacked?: ReadonlySet<string>): JVal | undefined {
  if (root === undefined) return undefined;
  if (!pathKey) return root;
  const segs = decodeKey(pathKey);
  let cur: JVal | undefined = root;
  let curPath = '';
  for (const s of segs) {
    if (typeof cur === 'string' && unpacked?.has(curPath)) cur = tryUnpackJsonString(cur);
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = Array.isArray(cur) ? (typeof s === 'number' ? cur[s] : undefined) : Object.prototype.hasOwnProperty.call(cur, String(s)) ? (cur as JObj)[String(s)] : undefined;
    curPath = childKey(curPath, s);
  }
  return cur;
}

export type DecodedInfo =
  | { kind: 'timestamp'; sourceKind: 'unix' | 'iso'; epochMs: number; local: string; utc: string; delta?: string }
  | { kind: 'jwt'; header: JVal; payload: JVal; expired?: boolean; status?: string }
  | { kind: 'base64'; text: string; json?: JVal }
  | { kind: 'url'; decoded: string; params: [string, string][] };

// Reasonable Unix timestamp window: 2000-01-01T00:00:00Z .. 2100-01-01T00:00:00Z
const MIN_EPOCH_MS = 946_684_800_000;
const MAX_EPOCH_MS = 4_102_444_800_000;

/** Parses a numeric or string value as an epoch millisecond timestamp when plausible. */
export function parseTimestampMs(v: JVal): { epochMs: number; sourceKind: 'unix' | 'iso' } | undefined {
  if (typeof v === 'number' || v instanceof RawNum) {
    const n = v instanceof RawNum ? Number(v.src) : v;
    if (!Number.isFinite(n) || n <= 0) return undefined;
    if (n >= MIN_EPOCH_MS / 1000 && n <= MAX_EPOCH_MS / 1000) return { epochMs: Math.round(n * 1000), sourceKind: 'unix' };
    if (n >= MIN_EPOCH_MS && n <= MAX_EPOCH_MS) return { epochMs: Math.round(n), sourceKind: 'unix' };
    if (n >= MIN_EPOCH_MS * 1000 && n <= MAX_EPOCH_MS * 1000) return { epochMs: Math.round(n / 1000), sourceKind: 'unix' };
    if (n >= MIN_EPOCH_MS * 1e6 && n <= MAX_EPOCH_MS * 1e6) return { epochMs: Math.round(n / 1e6), sourceKind: 'unix' };
    return undefined;
  }
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (/^\d{10,19}(?:\.\d+)?$/.test(s)) return parseTimestampMs(Number(s));
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(s)) {
    const ms = Date.parse(s.includes('T') ? s : s.replace(' ', 'T'));
    if (!Number.isNaN(ms)) return { epochMs: ms, sourceKind: 'iso' };
  }
  return undefined;
}

const TIME_KEYS = ['ts', 'timestamp', 'time', '@timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'date', 'datetime', 'eventTime'];

/** Finds the primary timestamp (in epoch ms) of a record object, if present. */
export function extractRecordEpochMs(rec: JVal | undefined): number | undefined {
  if (!rec || !isObj(rec)) return undefined;
  for (const k of TIME_KEYS) {
    if (Object.prototype.hasOwnProperty.call(rec, k)) {
      const p = parseTimestampMs(rec[k]);
      if (p) return p.epochMs;
    }
  }
  return undefined;
}

export function formatDelta(deltaMs: number): string {
  const sign = deltaMs >= 0 ? '+' : '-';
  const abs = Math.abs(deltaMs);
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  if (abs < 60_000) return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 2 : 1)} s`;
  if (abs < 3_600_000) return `${sign}${(abs / 60_000).toFixed(1)} min`;
  if (abs < 86_400_000) return `${sign}${(abs / 3_600_000).toFixed(1)} h`;
  return `${sign}${(abs / 86_400_000).toFixed(1)} d`;
}

function decodeBase64Utf8(b64: string, urlSafe = false): string | undefined {
  let clean = b64.trim();
  if (urlSafe) clean = clean.replace(/-/g, '+').replace(/_/g, '/');
  while (clean.length % 4 !== 0) clean += '=';
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean)) return undefined;
  try {
    let bin: string;
    if (typeof atob === 'function') bin = atob(clean);
    else bin = Buffer.from(clean, 'base64').toString('latin1');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text;
  } catch {
    return undefined;
  }
}

function isMostlyPrintable(s: string): boolean {
  if (!s.length) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)) printable++;
  }
  return printable / s.length >= 0.92;
}

/** Detects and decodes Timestamps, JWT tokens, Base64 payloads, and URL-encoded strings. */
export function decodeSmartValue(v: JVal, prevEpochMs?: number): DecodedInfo[] {
  const out: DecodedInfo[] = [];
  const ts = parseTimestampMs(v);
  if (ts) {
    const d = new Date(ts.epochMs);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    const offMin = -d.getTimezoneOffset();
    const offSign = offMin >= 0 ? '+' : '-';
    const offAbs = Math.abs(offMin);
    const tz = `${offSign}${pad(Math.floor(offAbs / 60))}:${pad(offAbs % 60)}`;
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} (${tz})`;
    const delta = prevEpochMs !== undefined && prevEpochMs !== ts.epochMs ? formatDelta(ts.epochMs - prevEpochMs) : undefined;
    out.push({ kind: 'timestamp', sourceKind: ts.sourceKind, epochMs: ts.epochMs, local, utc: d.toISOString(), delta });
  }
  if (typeof v !== 'string') return out;
  const s = v.trim();

  // JWT: header.payload.signature
  if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*$/.test(s)) {
    const parts = s.split('.');
    if (parts.length === 3) {
      const hStr = decodeBase64Utf8(parts[0], true);
      const pStr = decodeBase64Utf8(parts[1], true);
      if (hStr && pStr) {
        try {
          const header = parseJson(hStr);
          const payload = parseJson(pStr);
          if (isObj(header) && isObj(payload) && ('alg' in header || 'typ' in header)) {
            let expired: boolean | undefined;
            let status: string | undefined;
            const exp = typeof (payload as JObj).exp === 'number' ? ((payload as JObj).exp as number) * 1000 : undefined;
            if (exp !== undefined) {
              expired = exp < Date.now();
              status = new Date(exp).toISOString();
            }
            out.push({ kind: 'jwt', header, payload, expired, status });
            return out;
          }
        } catch {
          // Not a valid JSON JWT.
        }
      }
    }
  }

  // URL / Query string
  if ((/^https?:\/\//i.test(s) && (s.includes('?') || /%[0-9A-Fa-f]{2}/.test(s))) || (!/\s/.test(s) && /%[0-9A-Fa-f]{2}/.test(s))) {
    try {
      const decoded = decodeURIComponent(s.replace(/\+/g, '%20'));
      const params: [string, string][] = [];
      const qIdx = s.indexOf('?');
      if (qIdx >= 0) {
        const sp = new URLSearchParams(s.slice(qIdx + 1).split('#')[0]);
        sp.forEach((val, key) => params.push([key, val]));
      }
      if (decoded !== s || params.length > 0) out.push({ kind: 'url', decoded, params });
    } catch {
      // Malformed percent encoding.
    }
  }

  // Base64 (minimum 16 chars, multiple of 4 or padded, printable UTF-8 result)
  if (s.length >= 16 && s.length <= 262_144 && /^[A-Za-z0-9+/]{16,}={0,2}$/.test(s) && s.length % 4 === 0 && /[+/=]|\d/.test(s)) {
    const dec = decodeBase64Utf8(s, false);
    if (dec && dec.length >= 4 && isMostlyPrintable(dec)) {
      const json = tryUnpackJsonString(dec);
      out.push({ kind: 'base64', text: dec, json });
    }
  }

  return out;
}

function inlineMd(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
}

/**
 * Renders Markdown to strictly sanitized HTML (all raw text is escaped via `esc()` first,
 * so zero untrusted HTML tags or attributes can ever be injected).
 */
export function renderMarkdownSafe(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];
  let inCode = false;
  let codeLang = '';
  let codeLines: string[] = [];
  let listKind: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listKind) {
      html.push(`</${listKind}>`);
      listKind = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trimStart().startsWith('```')) {
      closeList();
      if (!inCode) {
        inCode = true;
        codeLang = raw.trimStart().slice(3).trim();
        codeLines = [];
      } else {
        html.push(`<pre class="md-code"${codeLang ? ` data-lang="${esc(codeLang)}"` : ''}><code>${esc(codeLines.join('\n'))}</code></pre>`);
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }
    const trim = raw.trim();
    if (!trim) {
      closeList();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trim)) {
      closeList();
      html.push('<hr>');
      continue;
    }
    const hm = /^(#{1,6})\s+(.*)$/.exec(trim);
    if (hm) {
      closeList();
      const lvl = hm[1].length;
      html.push(`<h${lvl}>${inlineMd(esc(hm[2]))}</h${lvl}>`);
      continue;
    }
    if (trim.startsWith('>')) {
      closeList();
      html.push(`<blockquote>${inlineMd(esc(trim.replace(/^>\s?/, '')))}</blockquote>`);
      continue;
    }
    // Pipe table
    if (trim.startsWith('|') && trim.endsWith('|') && i + 1 < lines.length && /^\s*\|(?:\s*:?-{2,}:?\s*\|)+\s*$/.test(lines[i + 1])) {
      closeList();
      const splitCells = (row: string) =>
        row
          .trim()
          .slice(1, -1)
          .split('|')
          .map((c) => inlineMd(esc(c.trim())));
      const headers = splitCells(trim);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        bodyRows.push(splitCells(lines[i]));
        i++;
      }
      i--;
      html.push(
        `<table class="md-tbl"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`,
      );
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(trim);
    if (ul) {
      if (listKind !== 'ul') {
        closeList();
        html.push('<ul>');
        listKind = 'ul';
      }
      html.push(`<li>${inlineMd(esc(ul[1]))}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(trim);
    if (ol) {
      if (listKind !== 'ol') {
        closeList();
        html.push('<ol>');
        listKind = 'ol';
      }
      html.push(`<li>${inlineMd(esc(ol[1]))}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inlineMd(esc(raw))}</p>`);
  }
  if (inCode) html.push(`<pre class="md-code"><code>${esc(codeLines.join('\n'))}</code></pre>`);
  closeList();
  return html.join('\n');
}

export function formatDecodedSummary(d: DecodedInfo): string {
  if (d.kind === 'timestamp') return `${d.local}${d.delta ? ` (${d.delta})` : ''}`;
  if (d.kind === 'jwt') return `JWT ${stringifyPretty(d.payload, 2, 200)}`;
  if (d.kind === 'base64') return d.text.slice(0, 200);
  return d.decoded.slice(0, 200);
}
