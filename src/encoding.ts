// Text to bytes in the encoding of a file. Node only encodes UTF-8, UTF-16LE and Latin-1, so
// for other encodings (gbk, shift_jis, windows-1252, …) the table is built from the decoder:
// every byte and every two-byte sequence is decoded once, and the result read backwards.

export class EncodeError extends Error {}

const tables = new Map<string, Map<string, number[]>>();

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
    if (c.length === 1 && c !== '�') {
      if (!t.has(c)) t.set(c, [b]);
    } else if (b >= 0x80) singleByte = false;
  }
  if (!singleByte) {
    // Two-byte sequences (gbk, big5, shift_jis, euc-kr, euc-jp, …).
    const two = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfe; lead++) {
      two[0] = lead;
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        two[1] = trail;
        const c = dec.decode(two);
        if (c && !c.includes('�') && [...c].length === 1 && !t.has(c)) t.set(c, [lead, trail]);
      }
    }
  }
  tables.set(label, t);
  return t;
}

/** The bytes of `text` in the encoding `label` (a WHATWG label). Throws when a character has no bytes there. */
export function encodeText(text: string, label: string): Buffer {
  let out: Buffer;
  if (label === 'utf-8' || label === 'utf8') out = Buffer.from(text, 'utf8');
  else if (label === 'utf-16le') out = Buffer.from(text, 'utf16le');
  else if (label === 'utf-16be') out = Buffer.from(text, 'utf16le').swap16();
  else {
    const t = table(label);
    const bytes: number[] = [];
    for (const c of text) {
      const code = c.codePointAt(0) as number;
      const b = code < 0x80 && t.get(c)?.[0] === code ? [code] : t.get(c);
      if (!b) throw new EncodeError(`"${c}" cannot be written in the encoding ${label}`);
      bytes.push(...b);
    }
    out = Buffer.from(bytes);
  }
  // A last check: the bytes must read back as the same text.
  if (new TextDecoder(label).decode(out) !== text) throw new EncodeError(`the text cannot be written in the encoding ${label}`);
  return out;
}
