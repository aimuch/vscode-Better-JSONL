// Unit and property tests for the pure parts: the text-level JSON helpers (the "lossless"
// promise, F3), the byte store of large files, the lazy document model and the fold rules.
// Run: npm run test:unit
import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactText, minifyJson, prettyJson, splitJsonValues } from '../../src/shared/jsonText';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { EncodeError, encodeText } from '../../src/encoding';
import { compare, fileState, LineConflict, replaceLine } from '../../src/fileEdit';
import { locatePath, valueSpan } from '../../src/locate';
import { indexItems, ItemStore } from '../../src/webview/items';
import { ByteJsonError, parseJsonBytes } from '../../src/webview/byteJson';
import { diffValues } from '../../src/webview/diff';
import { csvField, csvRow } from '../../src/webview/exporter';
import { compactJson, compileJq, compileJsonPath, compileQuery, pathOf } from '../../src/webview/query';
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

const DOC = parseJson(`{"store":{"book":[
  {"category":"reference","author":"Nigel Rees","title":"Sayings of the Century","price":8.95},
  {"category":"fiction","author":"Evelyn Waugh","title":"Sword of Honour","price":12.99},
  {"category":"fiction","author":"Herman Melville","title":"Moby Dick","isbn":"0-553-21311-3","price":8.99},
  {"category":"fiction","author":"J. R. R. Tolkien","title":"The Lord of the Rings","isbn":"0-395-19395-8","price":22.99}],
  "bicycle":{"color":"red","price":399}},"big":12345678901234567890,"a.b":{"c d":[1,2,3]}}`);

const values = (src: string, doc: JVal = DOC) => compileJsonPath(src).run(doc).outs.map((o) => compactJson(o.v));
const paths = (src: string, doc: JVal = DOC) => compileJsonPath(src).run(doc).outs.map((o) => JSON.stringify(pathOf(o.p ?? null)));
const jq = (src: string, doc: JVal = DOC) => compileJq(src).run(doc).outs.map((o) => compactJson(o.v));

test('JSONPath (RFC 9535): names, wildcards, descendants, indexes, slices, unions', () => {
  assert.deepEqual(values('$.store.book[*].author'), ['"Nigel Rees"', '"Evelyn Waugh"', '"Herman Melville"', '"J. R. R. Tolkien"']);
  assert.deepEqual(values('$..author').length, 4);
  assert.deepEqual(values('$.store.*').length, 2);
  assert.deepEqual(values('$..price'), ['8.95', '12.99', '8.99', '22.99', '399']);
  assert.deepEqual(values('$..book[2].title'), ['"Moby Dick"']);
  assert.deepEqual(values('$..book[-1].title'), ['"The Lord of the Rings"']);
  assert.deepEqual(values('$..book[0,1].price'), ['8.95', '12.99']);
  assert.deepEqual(values('$..book[:2].price'), ['8.95', '12.99']);
  assert.deepEqual(values('$..book[::-2].price'), ['22.99', '12.99']);
  assert.deepEqual(values("$['a.b']['c d'][1:]"), ['2', '3']);
  assert.deepEqual(values('$.big'), ['12345678901234567890'], 'a big integer keeps its text');
  assert.deepEqual(paths('$..book[?@.isbn].title'), ['["store","book",2,"title"]', '["store","book",3,"title"]']);
});

test('JSONPath filters: comparisons, logic, functions, the legacy ?( ) form', () => {
  assert.deepEqual(values('$..book[?@.price < 10].title'), ['"Sayings of the Century"', '"Moby Dick"']);
  assert.deepEqual(values('$..book[?(@.price < 10 && @.category == "fiction")].title'), ['"Moby Dick"']);
  assert.deepEqual(values("$..book[?@.category != 'fiction' || @.price > 20].title"), ['"Sayings of the Century"', '"The Lord of the Rings"']);
  assert.deepEqual(values('$..book[?!@.isbn].price'), ['8.95', '12.99']);
  assert.deepEqual(values('$..book[?length(@.title) > 15].price'), ['8.95', '22.99']);
  assert.deepEqual(values("$..book[?match(@.author, 'J.*')].price"), ['22.99']);
  assert.deepEqual(values("$..book[?search(@.title, 'of')].price"), ['8.95', '12.99', '22.99']);
  assert.deepEqual(paths('$.store[?count(@.*) > 2]'), ['["store","book"]'], 'book has 4 members, bicycle 2');
  assert.deepEqual(values('$..book[?@.price == $.store.book[0].price].title'), ['"Sayings of the Century"']);
  // A JSON Lines record is the root; "$[?…]" tests the record itself.
  const p = compileJsonPath('$[?@.level == "warn"]');
  assert.equal(p.matches({ level: 'warn' }), true);
  assert.equal(p.matches({ level: 'info' }), false);
  assert.equal(compileJsonPath('$.user.name').matches({ user: { name: null } }), true, 'existence, even of null');
  assert.throws(() => compileJsonPath('$..book[?@.price <]'), /column/);
  assert.throws(() => compileJsonPath('$.a b'), /unexpected/);
});

test('jq: paths, pipes, select, comparisons, arithmetic, builtins', () => {
  assert.deepEqual(jq('.store.book[] | select(.price > 10) | .title'), ['"Sword of Honour"', '"The Lord of the Rings"']);
  assert.deepEqual(jq('.store.book | map(.price) | add'), ['53.92']);
  assert.deepEqual(jq('[.store.book[].category] | unique'), ['["fiction","reference"]']);
  assert.deepEqual(jq('.store.book | length'), ['4']);
  assert.deepEqual(jq('.store.bicycle | keys'), ['["color","price"]']);
  assert.deepEqual(jq('.store.book[0] | has("isbn"), has("title")'), ['false', 'true']);
  assert.deepEqual(jq('.store.book[] | select(.author | test("^j"; "i")) | .price'), ['22.99']);
  assert.deepEqual(jq('.store.book[1:3] | map(.title)'), ['["Sword of Honour","Moby Dick"]']);
  assert.deepEqual(jq('.store.book[-1].title | ascii_downcase'), ['"the lord of the rings"']);
  assert.deepEqual(jq('.missing.deeper'), ['null'], '.a on null is null');
  assert.deepEqual(jq('.missing // "default"'), ['"default"']);
  assert.deepEqual(jq('if .big then "yes" else "no" end'), ['"yes"']);
  assert.deepEqual(jq('.big'), ['12345678901234567890']);
  assert.deepEqual(jq('[..|numbers] | length'), ['9']);
  assert.deepEqual(jq('{t: .store.bicycle.color, p: .store.bicycle.price}'), ['{"t":"red","p":399}']);
  assert.deepEqual(jq('.store.book | sort_by(.price) | first.title'), ['"Sayings of the Century"']);
  assert.deepEqual(jq('[.store.book[] | .price] | min, max'), ['8.95', '22.99']);
  assert.deepEqual(jq('"a,b" / ","'), ['["a","b"]']);
  assert.deepEqual(jq('[paths] | length'), [String(jq('[..] | length').map(Number)[0] - 1)]);
  assert.deepEqual(jq('path(.store.book[0].title)'), ['["store","book",0,"title"]']);
  assert.deepEqual(jq('.store.book[0] | to_entries[0]'), ['{"key":"category","value":"reference"}']);
  assert.deepEqual(jq('.store.book[] | .title | select(contains("of"))'), ['"Sayings of the Century"', '"Sword of Honour"', '"The Lord of the Rings"']);
  assert.deepEqual(jq('[limit(2; .store.book[])] | length'), ['2']);
  assert.deepEqual(jq('[range(3)]'), ['[0,1,2]']);
  // Results keep their place in the document.
  const outs = compileJq('.store.book[] | select(.price > 20)').run(DOC).outs;
  assert.deepEqual(outs.map((o) => pathOf(o.p ?? null)), [['store', 'book', 3]]);
  assert.equal(compileJq('.price > 10').run({ price: 12 }).outs[0].p, undefined, 'a computed value has no place');
});

test('jq: errors, the ? operator, and record matching', () => {
  assert.throws(() => compileJq('.store.book[0].title.x').run(DOC), /cannot index string/);
  assert.deepEqual(jq('[.store.book[].title.x?]'), ['[]']);
  assert.throws(() => compileJq('.a |'), /ends too soon/);
  assert.throws(() => compileJq('$x'), /\$x is not defined/);
  assert.throws(() => compileJq('import "a" as a; .'), /not supported/);
  assert.throws(() => compileJq('nosuch(1)'), /unknown function nosuch\/1/);
  const p = compileJq('.level == "warn" and .ms > 100');
  assert.deepEqual([p.matches({ level: 'warn', ms: 200 }), p.matches({ level: 'warn', ms: 50 }), p.matches('text')], [true, false, false]);
  assert.equal(compileJq('select(.user.name | startswith("A"))').matches({ user: { name: 'Ada' } }), true);
  assert.throws(() => compileJq('.tags | index("x")'), /unknown function index\/1/, 'an unknown function is an error before the search runs');
});

test('compileQuery: what is a query, and what is text', () => {
  assert.equal(compileQuery('timeout').program, undefined);
  assert.equal(compileQuery('length of stay').program, undefined, 'a word that is also a function is text');
  assert.equal(compileQuery('.level == "warn"').program?.kind, 'jq');
  assert.equal(compileQuery('select(.a)').program?.kind, 'jq');
  assert.equal(compileQuery('$..name').program?.kind, 'jsonpath');
  assert.match(compileQuery('.a ==').error ?? '', /^jq: /);
  assert.match(compileQuery('$[?').error ?? '', /^JSONPath: /);
});

/** The bytes of `text`, cut at random places (also inside multi-byte characters and escapes). */
function pieces(text: string, r: () => number, max: number): Uint8Array[] {
  const bytes = encode(text);
  const out: Uint8Array[] = [];
  for (let p = 0; p < bytes.length; ) {
    const n = 1 + Math.floor(r() * max);
    out.push(bytes.slice(p, p + n));
    p += n;
  }
  return out;
}

test('parseJsonBytes gives what JSON.parse gives, for any cuts between pieces', () => {
  const r = rng(2024);
  for (let i = 0; i < 2000; i++) {
    const text = randomJson(r);
    const want = parseJson(text);
    for (const max of [1, 3, 64, 100000]) assert.deepEqual(parseJsonBytes(pieces(text, r, max)), want, `${JSON.stringify(text)} in pieces of up to ${max}`);
  }
  // Long strings, escapes and non-ASCII across pieces; a byte order mark; a key named __proto__.
  const long = JSON.stringify({ s: 'é😀名'.repeat(500) + '\\n"x"', ['__proto__']: { a: 1 } });
  const got = parseJsonBytes([new Uint8Array([0xef, 0xbb, 0xbf]), ...pieces(long, r, 7)]) as { s: string; __proto__: unknown };
  assert.equal(got.s, JSON.parse(long).s);
  assert.deepEqual(Object.getOwnPropertyDescriptor(got, '__proto__')?.value, { a: 1 });
  assert.equal(Object.getPrototypeOf(got), Object.prototype);
  // Deep nesting does not overflow the call stack.
  const deep = '['.repeat(100000) + ']'.repeat(100000);
  let v = parseJsonBytes([encode(deep)]) as unknown[];
  for (let d = 1; d < 100000; d++) v = v[0] as unknown[];
  assert.deepEqual(v, []);
  for (const bad of ['{"a":}', '[1,]', '{"a" 1}', 'tru', '"open', '01', '[1] x', '']) {
    assert.throws(() => parseJsonBytes([encode(bad)]), ByteJsonError, bad);
  }
});

test('diffValues: added, removed and changed members, in document order', () => {
  const a = { id: 1, user: { name: 'Ada', roles: ['a', 'b'] }, gone: true, big: parseJson('12345678901234567890') as JVal };
  const b = { id: 2, user: { name: 'Ada', roles: ['a'], age: 3 }, big: parseJson('12345678901234567890') as JVal, tags: [] };
  const { rows, more } = diffValues(a, b);
  assert.equal(more, false);
  assert.deepEqual(
    rows.map((d) => [d.kind, d.path.join('.')]),
    [
      ['changed', 'id'],
      ['removed', 'user.roles.1'],
      ['added', 'user.age'],
      ['removed', 'gone'],
      ['added', 'tags'],
    ],
  );
  assert.deepEqual(diffValues({ a: [1] }, { a: { 0: 1 } }).rows.map((d) => d.kind), ['changed'], 'array to object is one change');
  assert.deepEqual(diffValues(a, a).rows, []);
  assert.equal(diffValues(Array.from({ length: 50 }, (_, i) => i), [], 10).more, true);
});

test('CSV fields are quoted only when they must be', () => {
  assert.equal(csvRow(['a', 'b c', '', 'x,y', 'say "hi"', 'two\nlines', ' pad', '名字']), 'a,b c,,"x,y","say ""hi""","two\nlines"," pad",名字');
  assert.equal(csvField('plain'), 'plain');
});

test('valueSpan: the value only, without its key; the last of two equal keys', () => {
  const line = '{"a":1,"u":{"n":"Ada","n":"Lin"},"t":[1, 2]}';
  const at = (path: (string | number)[]) => {
    const s = valueSpan(line, path);
    return s && line.slice(s.offset, s.offset + s.length);
  };
  assert.deepEqual([at(['a']), at(['u', 'n']), at(['t', 1]), at(['x'])], ['1', '"Lin"', '2', undefined]);
});

test('a large file: an edited line, and bytes added at the end', () => {
  const r = rng(8);
  const text = '{"a":1}\n{"bad"\n{"c":3';
  const store = new ByteStore();
  for (const p of pieces(text, r, 4)) store.append(p, false);
  store.append(new Uint8Array(0), true);
  const m = new DocModel(store, true);
  m.parseSome(1000);
  assert.deepEqual([m.count, m.valid, m.errors, store.openEnd], [3, 1, 2, true]);
  // The invalid line is fixed (as the host wrote it on disk).
  m.replaceLine(1, '{"b":2,"名":"ü"}');
  m.parseSome(1000);
  assert.deepEqual([m.valid, m.errors, m.line(1), m.bytes], [2, 1, '{"b":2,"名":"ü"}', text.length + encode('{"b":2,"名":"ü"}').length - '{"bad"'.length]);
  // The last line had no line end: new bytes go on with it, then new lines follow.
  m.append(encode(',"d":4}\n{"e":5}\n'));
  m.parseSome(1000);
  assert.deepEqual([m.count, m.valid, m.errors, m.line(2), m.line(3)], [4, 4, 0, '{"c":3,"d":4}', '{"e":5}']);
  assert.deepEqual(m.columns, ['a', 'b', '名', 'c', 'd', 'e']);
});

test('DocModel.fromValue: one JSON value parsed from bytes', () => {
  const m = DocModel.fromValue({ rows: [1, 2] }, 1234);
  assert.deepEqual([m.isJsonl, m.count, m.valid, m.blank, m.bytes, m.complete], [false, 1, 1, 0, 1234, true]);
  assert.deepEqual(m.value(0), { rows: [1, 2] });
});

test('jq: variables, destructuring, def, reduce, foreach, assignment, try/catch, label/break', () => {
  const one = (src: string, doc: JVal = DOC) => jq(src, doc);
  // Variables and patterns.
  assert.deepEqual(one('.store.bicycle.price as $p | .store.book[] | select(.price * 40 > $p) | .title'), ['"Sword of Honour"', '"The Lord of the Rings"']);
  assert.deepEqual(one('[1, [2, 3]] as [$a, [$b, $c]] | $a + $b + $c'), ['6']);
  assert.deepEqual(one('{"a": 1, "b": {"c": 2}} as {a: $x, $b, b: {c: $y}} | [$x, $b, $y]'), ['[1,{"c":2},2]']);
  assert.deepEqual(one('1 as $x | {$x, y: 2}'), ['{"x":1,"y":2}']);
  assert.deepEqual(one('$ENV | type'), ['"object"']);
  // def: filter and $value parameters, recursion, closures over the caller's scope.
  assert.deepEqual(one('def inc(f): f + 1; [.store.book[].price | inc(.)] | length'), ['4']);
  assert.deepEqual(one('def fac: if . <= 1 then 1 else . * (. - 1 | fac) end; 5 | fac'), ['120']);
  assert.deepEqual(one('def add2($a; $b): $a + $b; add2(1; 2, 3)'), ['3', '4']);
  assert.deepEqual(one('10 as $k | def addk(f): f + $k; 1 | addk(.)'), ['11']);
  assert.deepEqual(one('def f: def g: 3; g * 2; f'), ['6']);
  // reduce and foreach.
  assert.deepEqual(one('reduce .store.book[] as $b (0; . + $b.price)'), ['53.92']);
  assert.deepEqual(one('reduce range(5) as $i ([]; . + [$i * $i])'), ['[0,1,4,9,16]']);
  assert.deepEqual(one('[foreach (1, 2, 3) as $x (0; . + $x)]'), ['[1,3,6]']);
  assert.deepEqual(one('[foreach (1, 2, 3) as $x (0; . + $x; [$x, .])]'), ['[[1,1],[2,3],[3,6]]']);
  // Assignment (the value is changed in a copy; the document stays as it is).
  assert.deepEqual(one('.a.b = 1', {}), ['{"a":{"b":1}}']);
  assert.deepEqual(one('.store.book[].price |= . * 2 | [.store.book[].price]'), ['[17.9,25.98,17.98,45.98]']);
  assert.deepEqual(one('.n += 1 | .n', { n: 1 }), ['2']);
  assert.deepEqual(one('.xs[1] -= 10 | .xs', { xs: [1, 20] }), ['[1,10]']);
  assert.deepEqual(one('.a //= "d" | .b //= "d"', { a: 'x', b: null }), ['{"a":"x","b":"d"}']);
  assert.deepEqual(one('.a = (1, 2) | .a', {}), ['1', '2']);
  assert.deepEqual(one('.xs[] |= empty', { xs: [1, 2, 3] }), ['{"xs":[2]}'], 'jq 1.7: an empty update deletes (indexes move)');
  assert.deepEqual(one('del(.a, .c) | keys', { a: 1, b: 2, c: 3 }), ['["b"]']);
  assert.deepEqual(one('to_entries | map(.value += 1) | from_entries', { a: 1 }), ['{"a":2}']);
  assert.deepEqual(one('with_entries(.key |= ascii_upcase)', { a: 1 }), ['{"A":1}']);
  assert.deepEqual(one('setpath(["a", 0]; 7)', null), ['{"a":[7]}']);
  assert.deepEqual(one('getpath(["store", "bicycle", "color"])'), ['"red"']);
  assert.deepEqual(one('[paths(type == "number")] | length'), ['9']);
  assert.throws(() => compileJq('(1 + 1) = 3').run({}), /invalid path expression/);
  assert.equal(compileJq('.["__proto__"] = 1').run({}).outs[0].v && Object.getPrototypeOf(compileJq('.["__proto__"] = 1').run({}).outs[0].v), Object.prototype);
  // try/catch and error values.
  assert.deepEqual(one('try error("bad") catch .'), ['"bad"']);
  assert.deepEqual(one('try error({"code": 7}) catch .code'), ['7']);
  assert.deepEqual(one('[.[] | try (if . > 1 then error("x") else . end)]', [1, 2, 3]), ['[1]']);
  assert.deepEqual(one('try (1 / 0) catch "div"'), ['"div"']);
  // label and break keep the outputs made before the break.
  assert.deepEqual(one('[label $out | 1, 2, break $out, 3]'), ['[1,2]']);
  assert.deepEqual(one('[label $f | range(10) | ., (select(. == 2) | break $f)]'), ['[0,1,2]']);
  assert.throws(() => compileJq('break $nope'), /label/);
  // Matching records still works with all of it.
  assert.equal(compileJq('def big: .ms > 100; select(big)').matches({ ms: 200 }), true);
  assert.equal(compileJq('reduce .tags[] as $t (false; . or ($t == "db"))').matches({ tags: ['x', 'db'] }), true);
});

test('encodeText: UTF-8, UTF-16, single-byte and two-byte encodings; a character with no bytes is refused', () => {
  const back = (b: Buffer, label: string) => new TextDecoder(label).decode(b);
  for (const [label, text] of [
    ['utf-8', '{"名":"ünï 😀"}'],
    ['utf-16le', '{"n":"ünï 😀"}'],
    ['utf-16be', '{"n":"ünï"}'],
    ['windows-1252', '{"city":"Montréal €"}'],
    ['gbk', '{"名字":"测试"}'],
    ['shift_jis', '{"名前":"テスト"}'],
    ['big5', '{"名字":"測試"}'],
    ['euc-kr', '{"이름":"테스트"}'],
  ] as const) {
    assert.equal(back(encodeText(text, label), label), text, label);
  }
  assert.deepEqual([...encodeText('é', 'windows-1252')], [0xe9]);
  assert.throws(() => encodeText('名', 'windows-1252'), EncodeError);
  assert.throws(() => encodeText('😀', 'gbk'), EncodeError);
});

test('replaceLine: plain and gzip files, UTF-8 / UTF-16 / GBK, byte order marks, CR LF, the last line', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bj-unit-'));
  try {
    const cases: { name: string; bytes: Buffer; gzip: boolean; encoding: string; read: (b: Buffer) => string }[] = [
      { name: 'a.jsonl', bytes: Buffer.from('﻿{"a":1}\r\n{"b":"名"}\r\n{"c":3}', 'utf8'), gzip: false, encoding: 'utf-8', read: (b) => b.toString('utf8') },
      { name: 'b.jsonl', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}\n{"b":"名"}\n{"c":3}\n', 'utf16le')]), gzip: false, encoding: 'utf-8', read: (b) => new TextDecoder('utf-16le').decode(b) },
      { name: 'c.jsonl', bytes: encodeText('{"a":1}\n{"b":"名"}\n{"c":3}\n', 'gbk'), gzip: false, encoding: 'gbk', read: (b) => new TextDecoder('gbk').decode(b) },
      { name: 'd.jsonl.gz', bytes: zlib.gzipSync(Buffer.from('{"a":1}\n{"b":"名"}\n{"c":3}\n')), gzip: true, encoding: 'utf-8', read: (b) => zlib.gunzipSync(b).toString('utf8') },
      { name: 'e.jsonl.gz', bytes: zlib.gzipSync(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('{"a":1}\r\n{"b":"名"}\r\n{"c":3}', 'utf16le').swap16()])), gzip: true, encoding: 'utf-8', read: (b) => new TextDecoder('utf-16be').decode(zlib.gunzipSync(b)) },
    ];
    for (const c of cases) {
      const file = path.join(dir, c.name);
      fs.writeFileSync(file, c.bytes);
      const before = c.read(fs.readFileSync(file));
      await replaceLine(file, 1, '{"b":"名"}', '{"b":"新的"}', { gzip: c.gzip, encoding: c.encoding });
      assert.equal(c.read(fs.readFileSync(file)), before.replace('{"b":"名"}', '{"b":"新的"}'), c.name);
      await replaceLine(file, 2, '{"c":3}', '{"c":4}', { gzip: c.gzip, encoding: c.encoding });
      await replaceLine(file, 0, '{"a":1}', '{"a":0}', { gzip: c.gzip, encoding: c.encoding });
      assert.equal(c.read(fs.readFileSync(file)), before.replace('{"b":"名"}', '{"b":"新的"}').replace('{"c":3}', '{"c":4}').replace('{"a":1}', '{"a":0}'), `${c.name}: first and last lines, line ends and byte order mark kept`);
      const now = fs.readFileSync(file);
      await assert.rejects(replaceLine(file, 1, '{"b":"old"}', '{}', { gzip: c.gzip, encoding: c.encoding }), LineConflict);
      await assert.rejects(replaceLine(file, 9, '', '{}', { gzip: c.gzip, encoding: c.encoding }), LineConflict);
      assert.ok(fs.readFileSync(file).equals(now), `${c.name}: a refused edit changes nothing`);
    }
    await assert.rejects(replaceLine(path.join(dir, 'c.jsonl'), 0, '{"a":0}', '{"a":"😀"}', { gzip: false, encoding: 'gbk' }), EncodeError);
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temporary files are left');
    // A file that only grew, and one that changed.
    const log = path.join(dir, 'log.jsonl');
    fs.writeFileSync(log, '{"a":1}\n');
    const st = await fileState(log);
    fs.appendFileSync(log, '{"a":2}\n');
    assert.equal(await compare(log, st), 'grew');
    fs.writeFileSync(log, '{"x":1}\n{"a":2}\n');
    assert.equal(await compare(log, st), 'changed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('indexItems: the items of a huge array are records, for any cuts between pieces', () => {
  const r = rng(31);
  for (let i = 0; i < 300; i++) {
    const items = Array.from({ length: Math.floor(r() * 12) }, () => randomJson(r));
    const pretty = r() < 0.5;
    const text = `${r() < 0.3 ? '﻿' : ''}${pretty ? '[\n  ' : '['}${items.join(pretty ? ',\n  ' : ',')}${pretty ? '\n]\n' : ']'}`;
    const store = storeOf(text, r, 1 + Math.floor(r() * 50));
    const idx = indexItems(store);
    assert.ok(idx, text);
    const s = new ItemStore(store, idx);
    assert.equal(s.count, items.length);
    for (let k = 0; k < items.length; k++) {
      assert.deepEqual(parseJson(s.text(k)), parseJson(items[k]), `item ${k} of ${JSON.stringify(text)}`);
      assert.equal(s.text(k).includes('\n'), false, 'one line per record');
    }
    if (pretty) for (let k = 0; k < items.length; k++) assert.ok(s.fileLine(k) >= k + 1, 'items start on their own lines');
  }
  // An object that is mostly one array: that array's items.
  const big = JSON.stringify({ meta: { n: 3 }, data: [{ a: 1 }, { a: 2 }, { a: '3,]}' }, { long: 'x'.repeat(100) }], tail: 1 });
  const idx = indexItems(storeOf(big, r, 5)) as NonNullable<ReturnType<typeof indexItems>>;
  assert.deepEqual([idx.path, idx.count], [['data'], 4]);
  assert.equal(new ItemStore(storeOf(big, r, 5), idx).text(2), '{"a":"3,]}"}');
  // Other shapes are parsed as one value.
  assert.equal(indexItems(storeOf('{"a": 1, "b": [1]}', r, 3)), undefined, 'the array is not most of the bytes');
  assert.equal(indexItems(storeOf('"just a string"', r, 3)), undefined);
  assert.equal(indexItems(storeOf('[1, 2', r, 3)), undefined, 'an array without its end');
  // The model on top: records read when needed.
  const m = new DocModel(new ItemStore(storeOf('[{"x":1},\n{"x":2,"y":[1]},\n"z"]', r, 4), indexItems(storeOf('[{"x":1},\n{"x":2,"y":[1]},\n"z"]', r, 4)) as NonNullable<ReturnType<typeof indexItems>>), true);
  m.parseSome(1000);
  assert.deepEqual([m.count, m.valid, m.columns, m.hasNonObject, m.items?.count, m.fileLine(2)], [3, 3, ['x', 'y'], true, 3, 2]);
});
