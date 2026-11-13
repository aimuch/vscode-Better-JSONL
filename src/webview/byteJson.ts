// A JSON parser that reads UTF-8 bytes in pieces. It is for one JSON value too large for one
// JavaScript string (about 512 MB): JSON.parse needs the whole text as a string.
// It is iterative, so deep nesting does not overflow the call stack.
import { RawNum, type JObj, type JVal } from './json';

const decoder = new TextDecoder('utf-8');

export class ByteJsonError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at byte ${offset + 1}`);
  }
}

type Frame = { arr: JVal[]; obj: null; key: null } | { arr: null; obj: JObj; key: string };

/** Parses the bytes of `chunks` (in order) as one JSON value. A UTF-8 byte order mark is skipped. */
export function parseJsonBytes(chunks: readonly Uint8Array[]): JVal {
  let ci = 0;
  let cur = chunks[0] ?? new Uint8Array(0);
  let pos = 0;
  let base = 0;

  /** The byte at the read position, or -1 at the end. */
  const peek = (): number => {
    while (pos >= cur.length) {
      if (ci + 1 >= chunks.length) return -1;
      base += cur.length;
      cur = chunks[++ci];
      pos = 0;
    }
    return cur[pos];
  };
  const offset = () => base + pos;
  const fail = (msg: string): never => {
    throw new ByteJsonError(msg, offset());
  };
  const ws = (): number => {
    for (;;) {
      const c = peek();
      if (c !== 32 && c !== 10 && c !== 13 && c !== 9) return c;
      pos++;
    }
  };
  const expect = (word: string): void => {
    for (let i = 0; i < word.length; i++) {
      if (peek() !== word.charCodeAt(i)) fail(`"${word}" is expected`);
      pos++;
    }
  };

  let scratch = new Uint8Array(1024);
  const string = (): string => {
    pos++; // the opening quote
    let esc = false;
    let wide = false;
    // Fast path: the whole string is in this piece.
    let j = pos;
    const n = cur.length;
    while (j < n) {
      const b = cur[j];
      if (b === 34) break;
      if (b === 92) {
        esc = true;
        j += 2;
        continue;
      }
      if (b >= 0x80) wide = true;
      j++;
    }
    let s: string;
    if (j < n) {
      if (!wide && !esc && j - pos <= 64) {
        s = '';
        for (let k = pos; k < j; k++) s += String.fromCharCode(cur[k]);
      } else s = decoder.decode(cur.subarray(pos, j));
      pos = j + 1;
    } else {
      // The string goes on in the next piece: copy its bytes first.
      let len = 0;
      for (;;) {
        const b = peek();
        if (b < 0) fail('the string has no end');
        if (b === 34) break;
        if (len + 2 > scratch.length) {
          const grown = new Uint8Array(scratch.length * 2);
          grown.set(scratch);
          scratch = grown;
        }
        scratch[len++] = b;
        pos++;
        if (b === 92) {
          esc = true;
          const e = peek();
          if (e < 0) fail('the string has no end');
          scratch[len++] = e;
          pos++;
        }
      }
      pos++;
      s = decoder.decode(scratch.subarray(0, len));
    }
    if (!esc) return s;
    try {
      return JSON.parse(`"${s}"`) as string;
    } catch {
      return fail('the string has a bad escape');
    }
  };

  const number = (): JVal => {
    let s = '';
    let digits = 0;
    let exp = false;
    for (;;) {
      const c = peek();
      if (c >= 48 && c <= 57) {
        if (!exp) digits++;
      } else if (c === 101 || c === 69) exp = true;
      else if (c !== 45 && c !== 43 && c !== 46) break;
      s += String.fromCharCode(c);
      pos++;
    }
    const v = Number(s);
    if (!s || Number.isNaN(v) || !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(s)) fail('the number is not valid');
    // The same rule as json.parseJson: keep the text of a number that JavaScript cannot hold.
    return digits >= 16 && !Number.isSafeInteger(v) && String(v) !== s ? new RawNum(s) : v;
  };

  const set = (obj: JObj, key: string, v: JVal) => {
    if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
    else obj[key] = v;
  };

  // A UTF-8 byte order mark.
  if (peek() === 0xef) {
    pos++;
    if (peek() !== 0xbb) fail('unexpected byte');
    pos++;
    if (peek() !== 0xbf) fail('unexpected byte');
    pos++;
  }

  const stack: Frame[] = [];
  for (;;) {
    // Read one value.
    let v: JVal;
    const c = ws();
    if (c === 123) {
      pos++;
      if (ws() === 125) {
        pos++;
        v = {};
      } else {
        if (peek() !== 34) fail('a key is expected');
        const key = string();
        if (ws() !== 58) fail("':' is expected");
        pos++;
        stack.push({ arr: null, obj: {}, key });
        continue;
      }
    } else if (c === 91) {
      pos++;
      if (ws() === 93) {
        pos++;
        v = [];
      } else {
        stack.push({ arr: [], obj: null, key: null });
        continue;
      }
    } else if (c === 34) v = string();
    else if (c === 45 || (c >= 48 && c <= 57)) v = number();
    else if (c === 116) {
      expect('true');
      v = true;
    } else if (c === 102) {
      expect('false');
      v = false;
    } else if (c === 110) {
      expect('null');
      v = null;
    } else return fail(c < 0 ? 'the text ends too soon' : 'a value is expected');

    // Put it in its container; close containers that end here.
    for (;;) {
      const top = stack[stack.length - 1];
      if (!top) {
        if (ws() >= 0) fail('more text after the value');
        return v;
      }
      if (top.arr) {
        top.arr.push(v);
        const d = ws();
        pos++;
        if (d === 44) break;
        if (d !== 93) {
          pos--;
          fail("',' or ']' is expected");
        }
        v = top.arr;
      } else {
        set(top.obj, top.key, v);
        const d = ws();
        pos++;
        if (d === 44) {
          if (ws() !== 34) fail('a key is expected');
          top.key = string();
          if (ws() !== 58) fail("':' is expected");
          pos++;
          break;
        }
        if (d !== 125) {
          pos--;
          fail("',' or '}' is expected");
        }
        v = top.obj;
      }
      stack.pop();
    }
  }
}
