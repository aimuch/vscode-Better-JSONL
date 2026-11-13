// Unit and property tests for the pure parts: the text-level JSON helpers (the "lossless"
// promise, F3), the byte store of large files, the lazy document model and the fold rules.
// Run: npm run test:unit
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactText, minifyJson, prettyJson, splitJsonValues } from '../../src/shared/jsonText';
import { locatePath } from '../../src/locate';
import { ByteStore, DocModel, K_ERROR, K_UNKNOWN, K_VALUE, lowerBound, patchLines, stepIn, TreeSearch } from '../../src/webview/model';
import { buildLines, countLines, lineText } from '../../src/webview/views/lines';
import { childKey, decodeKey, parseJson, RawNum, type JVal } from '../../src/webview/json';

/** A small seeded generator, so a failure can be repeated. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const STRINGS = ['""', '"a"', '"x  y"', '"tab\\tnew\\nline"', '"quote \\" and \\\\ slash"', '"\\u00e9\\ud83d\\ude00"', '"名字 ünï 😀"', '"{[,:]}"', '" lead and trail "'];
const NUMBERS = ['0', '-0', '1', '-12', '1.50', '1e5', '1E-7', '12345678901234567890', '9007199254740993', '0.1000000000000000055', '-1.0e+10'];
const WS = ['', '', ' ', '  ', '\t', '\n', '\r\n', ' \n  '];

/** Random JSON text: odd white space, numbers and escapes that JSON.parse → stringify would change, duplicate keys. */
function randomJson(r: () => number, depth = 0): string {
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  const ws = () => pick(WS);
  const kind = depth > 4 ? Math.floor(r() * 4) : Math.floor(r() * 6);
  if (kind === 0) return pick(STRINGS);
  if (kind === 1) return pick(NUMBERS);
  if (kind === 2) return pick(['true', 'false', 'null']);
  if (kind === 3) return r() < 0.5 ? `[${ws()}]` : `{${ws()}}`;
  const n = Math.floor(r() * 4);
  if (kind === 4) {
    const items = Array.from({ length: n }, () => ws() + randomJson(r, depth + 1) + ws());
    return `[${items.join(',')}${n ? '' : ws()}]`;
  }
  const keys = ['"a"', '"b"', '"a"', '"k k"', '"\\u0041"', '""'];
  const members = Array.from({ length: n }, () => `${ws()}${pick(keys)}${ws()}:${ws()}${randomJson(r, depth + 1)}${ws()}`);
  return `{${members.join(',')}${n ? '' : ws()}}`;
}

/** The strings, numbers and literals of JSON text, in order. Lossless formatting never changes them. */
function tokens(src: string): string[] {
  return src.match(/"(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*|true|false|null|[{}[\],:]/g) ?? [];
}

test('minifyJson and prettyJson never change a token (F3)', () => {
  const r = rng(20260101);
  for (let i = 0; i < 3000; i++) {
    const src = randomJson(r);
    const min = minifyJson(src);
    assert.deepEqual(tokens(min), tokens(src), `tokens of ${JSON.stringify(src)}`);
    assert.deepEqual(JSON.parse(min), JSON.parse(src));
    assert.equal(minifyJson(min), min, 'minify is stable');
    assert.equal(min.replace(/"(?:[^"\\]|\\.)*"/g, '').search(/\s/), -1, `no white space outside strings: ${JSON.stringify(min)}`);
    for (const indent of [1, 2, 4, '\t'] as const) {
      const pretty = prettyJson(src, indent);
      assert.equal(minifyJson(pretty), min, `pretty(${JSON.stringify(indent)}) then minify`);
      assert.deepEqual(tokens(pretty), tokens(src));
    }
  }
});

test('compactText: one value per line again, blank lines stay, an invalid value changes nothing', () => {
  const r = rng(7);
  for (let i = 0; i < 300; i++) {
    const values = Array.from({ length: 1 + Math.floor(r() * 6) }, () => randomJson(r));
    // Records, some of them pretty-printed over several lines, with blank lines between some.
    const lines: string[] = [];
    const want: string[] = [];
    for (const v of values) {
      if (r() < 0.3) {
        lines.push('');
        want.push('');
      }
      lines.push(r() < 0.5 ? prettyJson(v, 2) : minifyJson(v));
      want.push(minifyJson(v));
    }
    const res = compactText(lines.join('\n'));
    assert.ok(res.ok, lines.join('\n'));
    assert.equal(res.ok && res.text, want.join('\n'));
    assert.equal(res.ok && res.count, values.length);
  }
  const bad = compactText('{"a":1}\n{\n  "b": \n}\n');
  assert.deepEqual(bad.ok ? null : bad.line, 2);
  assert.equal(compactText('{"a":1}\r\n\r\n[1,\r\n 2]\r\n', '\r\n').ok && (compactText('{"a":1}\r\n\r\n[1,\r\n 2]\r\n', '\r\n') as { text: string }).text, '{"a":1}\r\n\r\n[1,2]');
  assert.deepEqual(splitJsonValues('1 "a" {"x":[1]}[2]').length, 4);
});

const encode = (s: string) => new TextEncoder().encode(s);

function storeOf(text: string, r: () => number, maxChunk: number): ByteStore {
  const bytes = encode(text);
  const store = new ByteStore();
  let p = 0;
  while (p < bytes.length) {
    const n = 1 + Math.floor(r() * maxChunk);
    store.append(bytes.slice(p, p + n), p + n >= bytes.length);
    p += n;
  }
  if (!bytes.length) store.append(new Uint8Array(0), true);
  return store;
}

test('ByteStore: lines match the text for any chunk size (BOM, CRLF, multi-byte characters, no last line feed)', () => {
  const r = rng(99);
  const pieces = ['', ' ', '{"a":1}', '{"名字":"ünï 😀"}', 'x'.repeat(300), '   \t ', '[1,2,3]', '"é"'];
  for (let i = 0; i < 400; i++) {
    const lines = Array.from({ length: Math.floor(r() * 12) }, () => pieces[Math.floor(r() * pieces.length)]);
    const eol = r() < 0.5 ? '\n' : '\r\n';
    const bom = r() < 0.3 ? '﻿' : '';
    const endsWithEol = r() < 0.6;
    const text = bom + lines.join(eol) + (endsWithEol && lines.length ? eol : '');
    const store = storeOf(text, r, 1 + Math.floor(r() * 40));
    // The same rule as the text path: split at line feeds; a last empty piece is not a line.
    const want = lines.slice();
    if (!endsWithEol && want.length && want[want.length - 1] === '') want.pop();
    assert.equal(store.count, want.length, JSON.stringify(text));
    for (let k = 0; k < want.length; k++) {
      assert.equal(store.text(k), want[k], `line ${k} of ${JSON.stringify(text)}`);
      assert.equal(store.blank(k), !/\S/.test(want[k]));
      assert.equal(store.head(k, 5), want[k].slice(0, 5), `head of line ${k} of ${JSON.stringify(text)}`);
    }
  }
});

test('ByteStore: lines are complete only up to the last line feed while the file loads', () => {
  const store = new ByteStore();
  store.append(encode('{"a":1}\n{"b"'), false);
  assert.equal(store.count, 1);
  store.append(encode(':2}'), false);
  assert.equal(store.count, 1);
  store.append(encode('\n{"c":3}'), true);
  assert.equal(store.count, 3);
  assert.deepEqual([store.text(0), store.text(1), store.text(2)], ['{"a":1}', '{"b":2}', '{"c":3}']);
  assert.equal(store.firstLine(100), '{"a":1}');
  assert.equal(store.hasMoreThanOneLine(), true);
  assert.equal(store.takeText(), '{"a":1}\n{"b":2}\n{"c":3}');
});

test('DocModel: nothing is parsed until it is needed; the scan gives counts and columns in file order', () => {
  const m = new DocModel('{"b":1,"a":2}\n\n{"bad": }\n{"c":3,"a":4}\n[1]\n', true);
  assert.equal(m.count, 5);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => m.kind(i)), [K_UNKNOWN, K_UNKNOWN, K_UNKNOWN, K_UNKNOWN, K_UNKNOWN]);
  assert.equal(m.get(3).kind, 'value');
  assert.deepEqual([m.kind(2), m.kind(3), m.valid, m.complete], [K_UNKNOWN, K_VALUE, 1, false]);
  assert.deepEqual(m.columns, ['c', 'a'], 'columns found so far');
  assert.equal(m.parseSome(1000), true);
  assert.deepEqual([m.valid, m.errors, m.blank, m.parsed, m.complete], [3, 1, 1, 5, true]);
  assert.deepEqual(m.columns, ['b', 'a', 'c'], 'file order after the scan');
  assert.deepEqual([m.kind(2), m.hasNonObject, m.errorRecords()], [K_ERROR, true, [2]]);
});

test('DocModel on bytes gives the same result as on text', () => {
  const r = rng(5);
  const lines = Array.from({ length: 500 }, (_, i) => (i % 50 === 7 ? '{"bad"' : i % 60 === 9 ? '' : `{"id":${i},"名":"v${i}","n":9007199254740993}`));
  const text = lines.join('\n') + '\n';
  const a = new DocModel(text, true);
  const b = new DocModel(storeOf(text, r, 300), true);
  a.parseSome(1000);
  b.parseSome(1000);
  assert.deepEqual([b.count, b.valid, b.errors, b.blank, b.columns], [a.count, a.valid, a.errors, a.blank, a.columns]);
  assert.deepEqual(b.get(123), a.get(123));
  assert.equal(b.large && !b.keepsAll, true);
});

test('DocModel.adopt: records that did not change keep their place in the new document', () => {
  const r = rng(11);
  for (let i = 0; i < 300; i++) {
    const old = Array.from({ length: 5 + Math.floor(r() * 30) }, (_, k) => (r() < 0.1 ? '{"bad"' : r() < 0.1 ? '' : `{"k":${k},"r":${Math.floor(r() * 1e6)}}`));
    // The last two lines are never edited, and the last one is not blank (a last blank line is not a record).
    old.push('{"k":"before-end"}', '{"k":"end"}');
    const next = old.slice();
    const at = Math.floor(r() * (old.length - 3));
    const kind = Math.floor(r() * 3);
    if (kind === 0) next.splice(at, 0, '{"new":true}', '{"new":2}');
    else if (kind === 1) next.splice(at, 1 + Math.floor(r() * 2));
    else next[at] = '{"changed":1}';
    const a = new DocModel(old.join('\n'), true);
    a.parseSome(1000);
    const b = new DocModel(next.join('\n'), true);
    const map = b.adopt(a);
    for (let k = 0; k < old.length; k++) {
      const to = map(k);
      if (to >= 0) assert.equal(next[to], old[k], `record ${k} -> ${to}`);
    }
    // Unique lines: every record outside the edit keeps a place.
    const kept = old.filter((_, k) => map(k) >= 0).length;
    assert.ok(kept >= old.length - (kind === 0 ? 0 : 2), `kept ${kept} of ${old.length}`);
    b.parseSome(1000);
    const fresh = new DocModel(next.join('\n'), true);
    fresh.parseSome(1000);
    assert.deepEqual([b.valid, b.errors, b.blank, b.columns], [fresh.valid, fresh.errors, fresh.blank, fresh.columns]);
  }
});

function randomValue(r: () => number, depth = 0): JVal {
  const k = depth > 3 ? Math.floor(r() * 3) : Math.floor(r() * 5);
  if (k === 0) return Math.floor(r() * 100);
  if (k === 1) return 's' + Math.floor(r() * 100);
  if (k === 2) return r() < 0.5 ? [] : {};
  const n = Math.floor(r() * 4);
  if (k === 3) return Array.from({ length: n }, () => randomValue(r, depth + 1));
  const o: { [k: string]: JVal } = {};
  for (let i = 0; i < n; i++) o['k' + i] = randomValue(r, depth + 1);
  return o;
}

test('folds: countLines equals the number of built lines, for any toggles and fold depth', () => {
  const r = rng(3);
  for (let i = 0; i < 1500; i++) {
    const v = randomValue(r);
    const all = buildLines(v, new Set());
    const paths = all.filter((l) => l.kind === 'open').map((l) => l.path);
    const toggles = new Set(paths.filter(() => r() < 0.3));
    for (const depth of [Infinity, 1, 2]) {
      const lines = buildLines(v, toggles, depth);
      assert.equal(countLines(v, toggles, depth), lines.length);
    }
    // Depth 1 with no toggles: the root is open and every container below it is one folded line.
    const top = buildLines(v, new Set(), 1);
    assert.ok(top.every((l) => l.d <= 1 && (l.d === 0 || l.kind !== 'open')));
  }
  // A toggle below the fold depth opens that container; its own children stay folded.
  const doc: JVal = { rows: [{ a: [1] }, { a: [2] }] };
  const rows = childKey('', 'rows');
  assert.equal(buildLines(doc, new Set(), 1).length, 3);
  assert.equal(buildLines(doc, new Set([rows]), 1).length, 6);
});

test('path keys: every path has its own key, also for keys with control characters (F17)', () => {
  const odd = ['a', 'a.b', '', '0', '\u001f', '\u001e1', 'a\u001fb', '\u001d', '\u001d_', 'say "hi"'];
  const paths: (string | number)[][] = [[]];
  for (const a of odd) {
    paths.push([a], [0, a], [a, 1]);
    for (const b of odd) paths.push([a, b]);
  }
  const keys = new Set<string>();
  for (const p of paths) {
    const key = p.reduce<string>((k, seg) => childKey(k, seg), '');
    assert.deepEqual(decodeKey(key), p);
    keys.add(key);
  }
  assert.equal(keys.size, paths.length);
});

test('stepIn: the next and the previous match, going round at the ends', () => {
  const ms = [3, 8, 9, 20];
  assert.deepEqual([0, 3, 4, 8, 19, 20, 99].map((from) => stepIn(ms, from, 1)), [3, 8, 8, 9, 20, 3, 3]);
  assert.deepEqual([0, 3, 4, 8, 19, 20, 99].map((from) => stepIn(ms, from, -1)), [20, 20, 3, 3, 9, 9, 20]);
  assert.deepEqual([lowerBound(ms, -1), lowerBound(ms, 8), lowerBound(ms, 21), lowerBound([], 1)], [0, 1, 4, 0]);
  assert.equal(stepIn([5], 5, 1), 5);
});

test('TreeSearch finds what a search over the fully open lines finds, in the same order, also in slices', () => {
  const r = rng(42);
  for (let i = 0; i < 800; i++) {
    const v = randomValue(r);
    const q = ['s1', 'k0', '"k1": ', '7', '{', '[]', '"k2": s'][Math.floor(r() * 7)];
    const want = buildLines(v, new Set())
      .filter((l) => l.kind !== 'close' && lineText(l).toLowerCase().includes(q))
      .map((l) => l.path);
    const all = new TreeSearch(v, q, 1e9);
    assert.equal(all.step(Infinity), true);
    assert.deepEqual(all.matches, want, `query ${q} in ${JSON.stringify(v)}`);
    const sliced = new TreeSearch(v, q, 1e9);
    let turns = 0;
    while (!sliced.step(0) && turns++ < 1e6);
    assert.deepEqual(sliced.matches, want);
    assert.equal(sliced.capped, false);
  }
  const many = new TreeSearch(Array.from({ length: 5000 }, (_, i) => ({ id: i })), 'id', 100);
  many.step(Infinity);
  assert.deepEqual([many.matches.length, many.capped, many.done], [100, true, true]);
  assert.deepEqual(decodeKey(many.matches[99]), [99, 'id']);
});

test('parseJson keeps numbers that a JavaScript number cannot hold (F2)', () => {
  const big = (v: JVal | undefined) => (v instanceof RawNum ? v.src : v);
  assert.equal(big(parseJson('12345678901234567890')), '12345678901234567890');
  assert.deepEqual((parseJson('[1,12345678901234567890, -9007199254740993]') as JVal[]).map(big), [1, '12345678901234567890', '-9007199254740993']);
  assert.equal(big((parseJson('{"a":9007199254740993}') as { a: JVal }).a), '9007199254740993');
  assert.equal(big((parseJson('{"a":\n\t9007199254740993}') as { a: JVal }).a), '9007199254740993');
  assert.equal(big(parseJson('0.1234567890123456789')), '0.1234567890123456789');
  // Digits inside a string are text: nothing to keep, and the fast parse is used.
  assert.deepEqual(parseJson('{"ts":"20260101000000000123","n":5}'), { ts: '20260101000000000123', n: 5 });
});

test('locatePath: with the same key twice, the last one is found (the value JSON.parse keeps)', () => {
  const text = '{"a":1,"b":{"x":1},"a":2,"b":{"x":[10,20]}}';
  const at = (path: (string | number)[]) => {
    const span = locatePath(text, path);
    return span && text.slice(span.offset, span.offset + span.length);
  };
  assert.equal(at(['a']), '"a":2');
  assert.equal(at(['b', 'x', 1]), '20');
  assert.equal(at(['b', 'x']), '"x":[10,20]');
  assert.equal(at([]), text);
  assert.equal(at(['missing']), undefined);
  assert.equal(at(['a', 0]), undefined);
});

test('patchLines: changes applied to the lines give the lines of the changed text, and its size', () => {
  const r = rng(77);
  const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)];
  // No characters outside the BMP here: a random range could cut one in two halves.
  const words = ['', 'a', '{"k":1}', '名字', 'ünï', 'x y', '[1,2]'];
  for (let i = 0; i < 2000; i++) {
    const eol = r() < 0.5 ? '\n' : '\r\n';
    let text = Array.from({ length: Math.floor(r() * 6) }, () => pick(words)).join(eol) + (r() < 0.5 ? eol : '');
    const lines = text.split(/\r\n|\r|\n/);
    const changes = [];
    let chars = text.length;
    let bytes = new TextEncoder().encode(text).length;
    const want = { chars: 0, bytes: 0 };
    for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
      // A range in the text as it is now, by offsets and by line and character.
      const now = text.split(/\r\n|\r|\n/);
      const sl = Math.floor(r() * now.length);
      const el = Math.min(now.length - 1, sl + Math.floor(r() * 3));
      const sc = Math.floor(r() * (now[sl].length + 1));
      const ec = sl === el ? sc + Math.floor(r() * (now[el].length - sc + 1)) : Math.floor(r() * (now[el].length + 1));
      const offset = (line: number, ch: number) => now.slice(0, line).reduce((n, l) => n + l.length + eol.length, 0) + ch;
      // The new text may use another line end: the editor stores it as the document's own.
      const typed = Array.from({ length: Math.floor(r() * 3) }, () => pick(words)).join(pick(['\n', '\r\n', '\r']));
      text = text.slice(0, offset(sl, sc)) + typed.replace(/\r\n|\r|\n/g, eol) + text.slice(offset(el, ec));
      changes.push({ sl, sc, el, ec, text: typed });
    }
    want.chars = text.length - chars;
    want.bytes = new TextEncoder().encode(text).length - bytes;
    const grown = patchLines(lines, changes, eol.length);
    assert.deepEqual(lines, text.split(/\r\n|\r|\n/), `changes ${JSON.stringify(changes)}`);
    assert.deepEqual(grown, want);
  }
  const emoji = ['a😀b'];
  assert.deepEqual(patchLines(emoji, [{ sl: 0, sc: 1, el: 0, ec: 3, text: '😀😀' }], 1), { chars: 2, bytes: 4 });
  assert.deepEqual(emoji, ['a😀😀b']);
  // A change that does not fit: the caller asks for the whole text.
  assert.equal(patchLines(['a', 'b'], [{ sl: 2, sc: 0, el: 2, ec: 0, text: 'x' }], 1), undefined);
  assert.equal(patchLines(['a', 'b'], [{ sl: 0, sc: 5, el: 0, ec: 5, text: 'x' }], 1), undefined);
  assert.equal(patchLines(['abc'], [{ sl: 0, sc: 2, el: 0, ec: 1, text: '' }], 1), undefined);
});

test('DocModel from records gives the same document as from the text', () => {
  const text = '{"a":1}\r\n\r\n{"bad"\r\n{"b":2}\r\n';
  const a = new DocModel(text, true);
  const lines = a.editorLines() as string[];
  assert.deepEqual(lines, ['{"a":1}', '', '{"bad"', '{"b":2}', '']);
  const b = new DocModel(lines.slice(0, -1), true, text.length, true);
  a.parseSome(1000);
  b.parseSome(1000);
  assert.deepEqual([b.count, b.valid, b.errors, b.blank, b.columns, b.bytes], [a.count, a.valid, a.errors, a.blank, a.columns, a.bytes]);
  assert.deepEqual(b.editorLines(), lines);
  // A carriage return alone ends a line, as in the text editor.
  assert.equal(new DocModel('{"a":1}\r{"b":2}', true).count, 2);
});
