// Text to bytes in the encoding of a file. Node only encodes UTF-8, UTF-16LE and Latin-1, so
// for other encodings (gbk, gb18030, shift_jis, windows-1252, …) the table is built from the
// decoder: byte sequences are decoded once, and the result read backwards.

import { t } from './shared/i18n';

export class EncodeError extends Error {}

const tables = new Map<string, Map<string, number[]>>();
let gb18030BmpTable: Map<string, number[]> | undefined;

function ptrToGb18030(p: number): number[] {
  const b4 = 0x30 + (p % 10);
  p = Math.floor(p / 10);
  const b3 = 0x81 + (p % 126);
  p = Math.floor(p / 126);
  const b2 = 0x30 + (p % 10);
  p = Math.floor(p / 10);
  const b1 = 0x81 + p;
  return [b1, b2, b3, b4];
}

function gb18030Bmp(): Map<string, number[]> {
  if (gb18030BmpTable) return gb18030BmpTable;
  const m = new Map<string, number[]>();
  const dec = new TextDecoder('gb18030');
  const buf = new Uint8Array(4);
  for (let p = 0; p < 39420; p++) {
    const seq = ptrToGb18030(p);
    buf[0] = seq[0];
    buf[1] = seq[1];
    buf[2] = seq[2];
    buf[3] = seq[3];
    const c = dec.decode(buf);
    if (c.length === 1 && c !== '\ufffd' && !m.has(c)) m.set(c, seq);
  }
  gb18030BmpTable = m;
  return m;
}

function table(label: string): Map<string, number[]> {
  let t = tables.get(label);
  if (t) return t;
  t = new Map();
  const dec = new TextDecoder(label);
  const one = new Uint8Array(1);
  let singleByte = true;
  for (let b = 0; b < 256; b++) {
    one[0] = b;
    const c = dec.decode(one);
    if (c.length === 1 && c !== '\ufffd') {
      if (!t.has(c)) t.set(c, [b]);
    } else if (b >= 0x80) singleByte = false;
  }
  if (!singleByte) {
    // Two-byte sequences (gbk, gb18030, big5, shift_jis, euc-kr, euc-jp, …).
    const two = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      two[0] = lead;
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        two[1] = trail;
        const c = dec.decode(two);
        if (c && !c.includes('\ufffd') && [...c].length === 1 && !t.has(c)) t.set(c, [lead, trail]);
      }
    }
    if (label === 'euc-jp') {
      // Three-byte JIS X 0212 sequences (0x8f + two trail bytes in 0xa1..0xfe).
      const three = new Uint8Array(3);
      three[0] = 0x8f;
      for (let b2 = 0xa1; b2 <= 0xfe; b2++) {
        three[1] = b2;
        for (let b3 = 0xa1; b3 <= 0xfe; b3++) {
          three[2] = b3;
          const c = dec.decode(three);
          if (c && !c.includes('\ufffd') && [...c].length === 1 && !t.has(c)) t.set(c, [0x8f, b2, b3]);
        }
      }
    }
  }
  tables.set(label, t);
  return t;
}

/** The bytes of `text` in the encoding `label` (a WHATWG label). Throws when a character has no bytes there. */
export function encodeText(text: string, label: string): Buffer {
  const norm = label.toLowerCase();
  let out: Buffer;
  if (norm === 'utf-8' || norm === 'utf8') out = Buffer.from(text, 'utf8');
  else if (norm === 'utf-16le') out = Buffer.from(text, 'utf16le');
  else if (norm === 'utf-16be') out = Buffer.from(text, 'utf16le').swap16();
  else {
    const tbl = table(norm);
    const bytes: number[] = [];
    for (const c of text) {
      const code = c.codePointAt(0) as number;
      let b = code < 0x80 && tbl.get(c)?.[0] === code ? [code] : tbl.get(c);
      if (!b && norm === 'gb18030') {
        b = code >= 0x10000 ? ptrToGb18030(189000 + code - 0x10000) : gb18030Bmp().get(c);
      }
      if (!b) throw new EncodeError(t('"{0}" cannot be written in the encoding {1}', c, label));
      bytes.push(...b);
    }
    out = Buffer.from(bytes);
  }
  // A last check: the bytes must read back as the same text.
  if (new TextDecoder(norm, { ignoreBOM: true }).decode(out) !== text) throw new EncodeError(t('the text cannot be written in the encoding {0}', label));
  return out;
}
