// Queries in the search box: JSONPath (RFC 9535) and a subset of jq.
// Both read parsed values. Results keep their place in the document when they have one,
// so the Formatted view can go to them.
import { isContainer, parseJson, RawNum, type JObj, type JVal } from './json';

/** The place of a value: a chain from the value up to the root (null). */
export type PathLink = { readonly up: PathLink; readonly k: string | number } | null;

/** One result. `p` is undefined for a value that is computed (it has no place in the document). */
export interface Out {
  v: JVal;
  p: PathLink | undefined;
}

export interface Program {
  readonly kind: 'jq' | 'jsonpath';
  /** JSON Lines: true when the record matches. Errors count as "no match". */
  matches(record: JVal): boolean;
  /** One document: every result. Throws a QueryError for an error at run time. */
  run(root: JVal): { outs: Out[]; capped: boolean };
}

export class QueryError extends Error {}
class LimitError extends Error {}

/** Results (and steps) one query may make. More than this stops it: "too many results". */
const MAX_OUT = 200_000;
const MAX_RECORD = 20_000;
let budget = MAX_OUT;

function spend(n = 1): void {
  budget -= n;
  if (budget < 0) throw new LimitError();
}

export function pathOf(p: PathLink): (string | number)[] {
  const out: (string | number)[] = [];
  for (let x = p; x; x = x.up) out.push(x.k);
  return out.reverse();
}

const val = (v: JVal): Out => {
  spend();
  return { v, p: undefined };
};

const child = (o: Out, k: string | number, v: JVal): Out => {
  spend();
  return { v, p: o.p === undefined ? undefined : { up: o.p, k } };
};

export const truthy = (v: JVal): boolean => v !== null && v !== false;

export function typeName(v: JVal): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' || v instanceof RawNum) return 'number';
  if (typeof v === 'string') return 'string';
  return Array.isArray(v) ? 'array' : 'object';
}

const num = (v: JVal): number => (typeof v === 'number' ? v : v instanceof RawNum ? Number(v.src) : Number.NaN);
const ORDER = { null: 0, boolean: 1, number: 2, string: 3, array: 4, object: 5 };

/** jq order: null < false < true < numbers < strings < arrays < objects. */
export function compareValues(a: JVal, b: JVal): number {
  const ta = typeName(a);
  const tb = typeName(b);
  if (ta !== tb) return ORDER[ta] - ORDER[tb];
  switch (ta) {
    case 'null':
      return 0;
    case 'boolean':
      return (a ? 1 : 0) - (b ? 1 : 0);
    case 'number': {
      if (a instanceof RawNum && b instanceof RawNum && a.src === b.src) return 0;
      const x = num(a);
      const y = num(b);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    case 'string':
      return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
    case 'array': {
      const x = a as JVal[];
      const y = b as JVal[];
      for (let i = 0; i < x.length && i < y.length; i++) {
        const c = compareValues(x[i], y[i]);
        if (c) return c;
      }
      return x.length - y.length;
    }
    default: {
      const x = a as JObj;
      const y = b as JObj;
      const ka = Object.keys(x).sort();
      const kb = Object.keys(y).sort();
      const c = compareValues(ka, kb);
      if (c) return c;
      for (const k of ka) {
        const d = compareValues(x[k], y[k]);
        if (d) return d;
      }
      return 0;
    }
  }
}

/** Compact JSON text. Numbers that JavaScript cannot hold keep their source text. */
export function compactJson(v: JVal, depth = 0): string {
  if (v instanceof RawNum) return v.src;
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (depth > 200) return '…';
  if (Array.isArray(v)) return `[${v.map((x) => compactJson(x, depth + 1)).join(',')}]`;
  return `{${Object.keys(v)
    .map((k) => `${JSON.stringify(k)}:${compactJson(v[k], depth + 1)}`)
    .join(',')}}`;
}

/** The value and every value inside it, in document order. */
function descend(o: Out): Out[] {
  const out: Out[] = [];
  const stack: Out[] = [o];
  while (stack.length) {
    const x = stack.pop() as Out;
    out.push(x);
    spend();
    const v = x.v;
    if (!isContainer(v)) continue;
    const kids: Out[] = [];
    if (Array.isArray(v)) v.forEach((c, i) => kids.push(child(x, i, c)));
    else for (const k of Object.keys(v)) kids.push(child(x, k, v[k]));
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return out;
}

function children(o: Out): Out[] {
  const v = o.v;
  if (Array.isArray(v)) return v.map((c, i) => child(o, i, c));
  if (isContainer(v)) return Object.keys(v).map((k) => child(o, k, (v as JObj)[k]));
  return [];
}

// ---------- JSONPath ----------

const NOTHING = Symbol('nothing');
type Maybe = JVal | typeof NOTHING;
type Sel = (node: Out, root: Out) => Out[];
type Seg = (nodes: Out[], root: Out) => Out[];
type Test = (node: Out, root: Out) => boolean;
interface Operand {
  value(node: Out, root: Out): Maybe;
  test(node: Out, root: Out): boolean;
  /** A query: its nodes (count() and value() need them). */
  nodes?: (node: Out, root: Out) => Out[];
}

function jpCompare(a: Maybe, op: string, b: Maybe): boolean {
  const eq = () => (a === NOTHING || b === NOTHING ? a === b : typeName(a) === typeName(b) && compareValues(a, b) === 0);
  const lt = (x: Maybe, y: Maybe) => {
    if (x === NOTHING || y === NOTHING) return false;
    const t = typeName(x);
    return t === typeName(y) && (t === 'number' || t === 'string') && compareValues(x, y) < 0;
  };
  switch (op) {
    case '==':
      return eq();
    case '!=':
      return !eq();
    case '<':
      return lt(a, b);
    case '<=':
      return lt(a, b) || eq();
    case '>':
      return lt(b, a);
    default:
      return lt(b, a) || eq();
  }
}

function slice(len: number, start: number | null, end: number | null, step: number): number[] {
  const out: number[] = [];
  if (step === 0) return out;
  const norm = (i: number) => (i >= 0 ? i : len + i);
  if (step > 0) {
    const lo = Math.min(Math.max(norm(start ?? 0), 0), len);
    const hi = Math.min(Math.max(norm(end ?? len), 0), len);
    for (let i = lo; i < hi; i += step) out.push(i);
  } else {
    const hi = Math.min(Math.max(norm(start ?? len - 1), -1), len - 1);
    const lo = Math.min(Math.max(end === null ? -1 : norm(end), -1), len - 1);
    for (let i = hi; lo < i; i += step) out.push(i);
  }
  return out;
}

class JsonPathParser {
  i = 0;
  constructor(private readonly s: string) {}

  fail(msg: string): never {
    throw new QueryError(`${msg} (column ${this.i + 1})`);
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }

  eat(t: string): boolean {
    this.ws();
    if (!this.s.startsWith(t, this.i)) return false;
    this.i += t.length;
    return true;
  }

  get done(): boolean {
    this.ws();
    return this.i >= this.s.length;
  }

  segments(): Seg[] {
    const segs: Seg[] = [];
    for (;;) {
      const save = this.i;
      this.ws();
      if (this.s.startsWith('..', this.i)) {
        this.i += 2;
        const sels = this.s[this.i] === '[' ? (this.i++, this.selectors()) : [this.nameOrWild()];
        segs.push((nodes, root) => nodes.flatMap((n) => descend(n).flatMap((d) => sels.flatMap((s) => s(d, root)))));
      } else if (this.s[this.i] === '.') {
        this.i++;
        const sel = this.nameOrWild();
        segs.push((nodes, root) => nodes.flatMap((n) => sel(n, root)));
      } else if (this.s[this.i] === '[') {
        this.i++;
        const sels = this.selectors();
        segs.push((nodes, root) => nodes.flatMap((n) => sels.flatMap((s) => s(n, root))));
      } else {
        this.i = save;
        return segs;
      }
    }
  }

  private nameOrWild(): Sel {
    if (this.s[this.i] === '*') {
      this.i++;
      return (n) => children(n);
    }
    const m = /^[^\s.[\]()=!<>&|,'"*?@$]+/.exec(this.s.slice(this.i));
    if (!m) this.fail('a member name or * is expected');
    this.i += m[0].length;
    return nameSel(m[0]);
  }

  private selectors(): Sel[] {
    const out: Sel[] = [];
    do out.push(this.selector());
    while (this.eat(','));
    if (!this.eat(']')) this.fail("']' is expected");
    return out;
  }

  private selector(): Sel {
    this.ws();
    const c = this.s[this.i];
    if (c === "'" || c === '"') return nameSel(this.str());
    if (c === '*') {
      this.i++;
      return (n) => children(n);
    }
    if (c === '?') {
      this.i++;
      const test = this.or();
      return (n, root) => children(n).filter((x) => test(x, root));
    }
    const m = /^(-?\d+)?\s*(:)?\s*(-?\d+)?\s*(:)?\s*(-?\d+)?/.exec(this.s.slice(this.i));
    if (!m || !m[0].trim()) this.fail('a selector is expected');
    this.i += m[0].length;
    if (!m[2]) {
      if (m[1] === undefined || m[3] !== undefined) this.fail('an index is expected');
      const k = Number(m[1]);
      return (n) => {
        const v = n.v;
        if (!Array.isArray(v)) return [];
        const i = k < 0 ? v.length + k : k;
        return i >= 0 && i < v.length ? [child(n, i, v[i])] : [];
      };
    }
    const start = m[1] === undefined ? null : Number(m[1]);
    const end = m[3] === undefined ? null : Number(m[3]);
    const step = m[5] === undefined ? 1 : Number(m[5]);
    return (n) => (Array.isArray(n.v) ? slice(n.v.length, start, end, step).map((i) => child(n, i, (n.v as JVal[])[i])) : []);
  }

  private str(): string {
    const q = this.s[this.i++];
    let out = '';
    while (this.i < this.s.length && this.s[this.i] !== q) {
      let c = this.s[this.i++];
      if (c === '\\') {
        const e = this.s[this.i++];
        if (e === 'u') {
          c = String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else c = ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[e] ?? e;
      }
      out += c;
    }
    if (this.s[this.i] !== q) this.fail('the string has no end');
    this.i++;
    return out;
  }

  or(): Test {
    let t = this.and();
    while (this.eat('||')) {
      const a = t;
      const b = this.and();
      t = (n, r) => a(n, r) || b(n, r);
    }
    return t;
  }

  private and(): Test {
    let t = this.unary();
    while (this.eat('&&')) {
      const a = t;
      const b = this.unary();
      t = (n, r) => a(n, r) && b(n, r);
    }
    return t;
  }

  private unary(): Test {
    if (this.eat('!')) {
      const t = this.unary();
      return (n, r) => !t(n, r);
    }
    if (this.eat('(')) {
      const t = this.or();
      if (!this.eat(')')) this.fail("')' is expected");
      return t;
    }
    const left = this.operand();
    this.ws();
    const op = ['==', '!=', '<=', '>=', '<', '>'].find((o) => this.s.startsWith(o, this.i));
    if (!op) return (n, r) => left.test(n, r);
    this.i += op.length;
    const right = this.operand();
    return (n, r) => jpCompare(left.value(n, r), op, right.value(n, r));
  }

  private operand(): Operand {
    this.ws();
    const rest = this.s.slice(this.i);
    const constant = (v: JVal): Operand => ({ value: () => v, test: () => truthy(v) });
    const n = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (n) {
      this.i += n[0].length;
      return constant(Number(n[0]));
    }
    if (rest[0] === "'" || rest[0] === '"') return constant(this.str());
    const lit = /^(true|false|null)\b/.exec(rest);
    if (lit) {
      this.i += lit[0].length;
      return constant(lit[1] === 'true' ? true : lit[1] === 'false' ? false : null);
    }
    if (rest[0] === '@' || rest[0] === '$') {
      const fromRoot = rest[0] === '$';
      this.i++;
      const segs = this.segments();
      const nodes = (node: Out, root: Out) => segs.reduce((acc, s) => s(acc, root), [fromRoot ? root : node]);
      return {
        nodes,
        value: (node, root) => {
          const got = nodes(node, root);
          return got.length === 1 ? got[0].v : NOTHING;
        },
        test: (node, root) => nodes(node, root).length > 0,
      };
    }
    const f = /^([a-z][a-z0-9_]*)\s*\(/.exec(rest);
    if (f) {
      this.i += f[0].length;
      const args: Operand[] = [];
      if (!this.eat(')')) {
        do args.push(this.operand());
        while (this.eat(','));
        if (!this.eat(')')) this.fail("')' is expected");
      }
      return this.func(f[1], args);
    }
    this.fail('a value, @, $ or a function is expected');
  }

  private func(name: string, args: Operand[]): Operand {
    const arity = (n: number) => {
      if (args.length !== n) this.fail(`${name}() takes ${n} argument(s)`);
    };
    const regex = (whole: boolean): Operand => {
      arity(2);
      const cache = new Map<string, RegExp | null>();
      const run = (node: Out, root: Out) => {
        const s = args[0].value(node, root);
        const re = args[1].value(node, root);
        if (typeof s !== 'string' || typeof re !== 'string') return false;
        let r = cache.get(re);
        if (r === undefined) {
          try {
            r = new RegExp(whole ? `^(?:${re})$` : re, 'u');
          } catch {
            r = null;
          }
          cache.set(re, r);
        }
        return !!r && r.test(s);
      };
      return { value: (n, r) => run(n, r), test: run };
    };
    switch (name) {
      case 'length': {
        arity(1);
        const value = (n: Out, r: Out): Maybe => {
          const v = args[0].value(n, r);
          if (typeof v === 'string') return [...v].length;
          if (Array.isArray(v)) return v.length;
          if (v !== NOTHING && isContainer(v)) return Object.keys(v).length;
          return NOTHING;
        };
        return { value, test: (n, r) => value(n, r) !== NOTHING };
      }
      case 'count': {
        arity(1);
        const q = args[0].nodes;
        if (!q) this.fail('count() takes a query');
        return { value: (n, r) => q(n, r).length, test: () => true };
      }
      case 'value': {
        arity(1);
        return { value: (n, r) => args[0].value(n, r), test: (n, r) => args[0].value(n, r) !== NOTHING };
      }
      case 'match':
        return regex(true);
      case 'search':
        return regex(false);
    }
    this.fail(`unknown function ${name}()`);
  }
}

function nameSel(name: string): Sel {
  return (n) => {
    const v = n.v;
    return isContainer(v) && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, name) ? [child(n, name, (v as JObj)[name])] : [];
  };
}

export function compileJsonPath(src: string): Program {
  const p = new JsonPathParser(src);
  if (!p.eat('$')) p.fail('a JSONPath starts with $');
  const segs = p.segments();
  if (!p.done) p.fail('unexpected text');
  const run = (root: JVal) => {
    const r: Out = { v: root, p: null };
    return segs.reduce((acc, s) => s(acc, r), [r]);
  };
  // "$[?…]" on JSON Lines: the records are the root array, so the filter tests the record itself.
  const filterFirst = /^\$\s*\[\s*\?/.test(src);
  return {
    kind: 'jsonpath',
    matches(record) {
      budget = MAX_RECORD;
      try {
        return run(record).length > 0 || (filterFirst && run([record]).length > 0);
      } catch {
        return false;
      }
    },
    run(root) {
      budget = MAX_OUT;
      try {
        return { outs: run(root), capped: false };
      } catch (e) {
        if (e instanceof LimitError) return { outs: [], capped: true };
        throw e;
      }
    },
  };
}

// ---------- jq ----------

type Tok = { t: 'num' | 'str' | 'id' | 'field' | 'op' | 'var' | 'eof'; v: string | number; pos: number };

/** Variables and functions a filter can see (lexical scope: a linked list from the innermost). */
interface Env {
  vars: VarScope;
  funcs: FuncScope;
}
type VarScope = { readonly name: string; readonly v: JVal; readonly up: VarScope } | null;
type FuncScope = { readonly key: string; fn: FuncDef; readonly up: FuncScope } | null;
/** A function from `def`, or a filter argument (a closure over the caller's scope). */
type FuncDef = { params: string[]; body: F; env: Env } | { closure: F; env: Env };
type F = (inp: Out, env: Env) => Out[];

const EMPTY_ENV: Env = { vars: { name: 'ENV', v: {}, up: null }, funcs: null };

const KEYWORDS = new Set(['and', 'or', 'if', 'then', 'elif', 'else', 'end', 'as', 'reduce', 'foreach', 'def', 'try', 'catch', 'label', 'break']);
const UNSUPPORTED = new Set(['import', 'include']);
const ASSIGN = ['=', '|=', '+=', '-=', '*=', '/=', '%=', '//='];

/** error(value): `try … catch` gets the value. */
class JqError extends QueryError {
  constructor(readonly value: JVal) {
    super(typeof value === 'string' ? value : compactJson(value));
  }
}

/** break $label: carries the outputs made before it, so `label` can still emit them. */
class BreakSignal extends Error {
  constructor(
    readonly label: symbol,
    public partial: Out[],
  ) {
    super('break');
  }
}

function lex(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new QueryError(`${msg} (column ${i + 1})`);
  };
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    const pos = i;
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') {
          if (s[j + 1] === '(') {
            i = j;
            fail('string interpolation is not supported');
          }
          j += 2;
        } else j++;
      }
      if (j >= s.length) fail('the string has no end');
      try {
        out.push({ t: 'str', v: JSON.parse(s.slice(i, j + 1)) as string, pos });
      } catch {
        fail('the string is not valid');
      }
      i = j + 1;
      continue;
    }
    if (c === '.') {
      if (s[i + 1] === '.') {
        out.push({ t: 'op', v: '..', pos });
        i += 2;
        continue;
      }
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i + 1));
      if (m) {
        out.push({ t: 'field', v: m[0], pos });
        i += 1 + m[0].length;
      } else {
        out.push({ t: 'op', v: '.', pos });
        i++;
      }
      continue;
    }
    const n = /^\d+(\.\d+)?([eE][+-]?\d+)?/.exec(s.slice(i));
    if (n) {
      out.push({ t: 'num', v: Number(n[0]), pos });
      i += n[0].length;
      continue;
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0], pos });
      i += id[0].length;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(i));
      if (!m) return fail('a variable name is expected');
      if (m[1] === '__loc__') return fail('$__loc__ is not supported');
      out.push({ t: 'var', v: m[1], pos });
      i += m[0].length;
      continue;
    }
    if (c === '@') fail('format strings (@base64, @csv, …) are not supported');
    const three = s.slice(i, i + 3);
    if (three === '?//') fail('?// is not supported');
    if (three === '//=') {
      out.push({ t: 'op', v: three, pos });
      i += 3;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['//', '==', '!=', '<=', '>=', '|=', '+=', '-=', '*=', '/=', '%='].includes(two)) {
      out.push({ t: 'op', v: two, pos });
      i += 2;
      continue;
    }
    if ('|,()[]{}:;?<>+-*/%='.includes(c)) {
      out.push({ t: 'op', v: c, pos });
      i++;
      continue;
    }
    fail(`unexpected character ${c}`);
  }
  out.push({ t: 'eof', v: '', pos: s.length });
  return out;
}

const jqFail = (msg: string): never => {
  throw new QueryError(msg);
};

function field(name: string): (o: Out) => Out[] {
  return (o) => {
    const v = o.v;
    if (v === null) return [child(o, name, null)];
    if (isContainer(v) && !Array.isArray(v)) return [child(o, name, Object.prototype.hasOwnProperty.call(v, name) ? (v as JObj)[name] : null)];
    return jqFail(`cannot index ${typeName(v)} with "${name}"`);
  };
}

function indexBy(o: Out, k: JVal): Out[] {
  const v = o.v;
  if (typeof k === 'string') return field(k)(o);
  if (typeof k === 'number' || k instanceof RawNum) {
    if (v === null) return [val(null)];
    if (!Array.isArray(v)) return jqFail(`cannot index ${typeName(v)} with a number`);
    const n = Math.floor(num(k));
    const i = n < 0 ? v.length + n : n;
    return [i >= 0 && i < v.length ? child(o, i, v[i]) : child(o, i, null)];
  }
  return jqFail(`cannot index ${typeName(v)} with ${typeName(k)}`);
}

function iterate(o: Out): Out[] {
  if (!isContainer(o.v)) return jqFail(`cannot iterate over ${typeName(o.v)}`);
  return children(o);
}

function length(v: JVal): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return jqFail('boolean has no length');
  if (typeof v === 'number' || v instanceof RawNum) return Math.abs(num(v));
  if (typeof v === 'string') return [...v].length;
  return Array.isArray(v) ? v.length : Object.keys(v).length;
}

function contains(a: JVal, b: JVal): boolean {
  const t = typeName(a);
  if (t !== typeName(b)) return jqFail(`${t} and ${typeName(b)} cannot have their containment checked`);
  if (t === 'string') return (a as string).includes(b as string);
  if (t === 'array') return (b as JVal[]).every((y) => (a as JVal[]).some((x) => typeName(x) === typeName(y) && contains(x, y)));
  if (t === 'object') {
    const x = a as JObj;
    const y = b as JObj;
    return Object.keys(y).every((k) => Object.prototype.hasOwnProperty.call(x, k) && typeName(x[k]) === typeName(y[k]) && contains(x[k], y[k]));
  }
  return compareValues(a, b) === 0;
}

function arith(op: string, a: JVal, b: JVal): JVal {
  const ta = typeName(a);
  const tb = typeName(b);
  if (op === '+') {
    if (ta === 'null') return b;
    if (tb === 'null') return a;
    if (ta === 'number' && tb === 'number') return num(a) + num(b);
    if (ta === 'string' && tb === 'string') return (a as string) + (b as string);
    if (ta === 'array' && tb === 'array') return [...(a as JVal[]), ...(b as JVal[])];
    if (ta === 'object' && tb === 'object') return { ...(a as JObj), ...(b as JObj) };
  } else if (op === '-') {
    if (ta === 'number' && tb === 'number') return num(a) - num(b);
    if (ta === 'array' && tb === 'array') return (a as JVal[]).filter((x) => !(b as JVal[]).some((y) => compareValues(x, y) === 0));
  } else if (op === '*') {
    if (ta === 'number' && tb === 'number') return num(a) * num(b);
    const [s, n] = ta === 'string' && tb === 'number' ? [a as string, num(b)] : tb === 'string' && ta === 'number' ? [b as string, num(a)] : [null, 0];
    if (s !== null) return n > 0 ? s.repeat(Math.ceil(n)) : null;
    if (ta === 'object' && tb === 'object') return { ...(a as JObj), ...(b as JObj) };
  } else if (op === '/') {
    if (ta === 'number' && tb === 'number') return num(b) === 0 ? jqFail('division by zero') : num(a) / num(b);
    if (ta === 'string' && tb === 'string') return (a as string).split(b as string);
  } else if (op === '%') {
    if (ta === 'number' && tb === 'number') {
      const d = Math.trunc(num(b));
      return d === 0 ? jqFail('modulo by zero') : Math.trunc(num(a)) % d;
    }
  }
  return jqFail(`${ta} and ${tb} cannot be used with ${op}`);
}

function cmpOp(op: string, a: JVal, b: JVal): boolean {
  const c = compareValues(a, b);
  return op === '==' ? c === 0 : op === '!=' ? c !== 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0;
}

/** Every pair of a and b outputs; a varies fastest (as in jq). */
function product(a: F, b: F, inp: Out, env: Env, fn: (x: JVal, y: JVal) => JVal): Out[] {
  const L = a(inp, env);
  const R = b(inp, env);
  const out: Out[] = [];
  for (const r of R) for (const l of L) out.push(val(fn(l.v, r.v)));
  return out;
}

function stringArg(v: JVal, name: string): string {
  return typeof v === 'string' ? v : jqFail(`${name} needs a string`);
}

// ---------- paths for assignment ----------

const setKey = (o: JObj, k: string, v: JVal) => {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
  else o[k] = v;
};

function getPath(v: JVal, path: (string | number)[]): JVal {
  for (const k of path) {
    if (v === null) return null;
    if (typeof k === 'number') {
      if (!Array.isArray(v)) return jqFail(`cannot index ${typeName(v)} with a number`);
      v = v[k < 0 ? v.length + k : k] ?? null;
    } else {
      if (!isContainer(v) || Array.isArray(v)) return jqFail(`cannot index ${typeName(v)} with "${k}"`);
      v = Object.prototype.hasOwnProperty.call(v, k) ? (v as JObj)[k] : null;
    }
  }
  return v;
}

/** A copy of `v` with `x` at `path` (containers on the way are copied; null becomes one). */
function setPath(v: JVal, path: (string | number)[], x: JVal, i = 0): JVal {
  if (i === path.length) return x;
  const k = path[i];
  if (typeof k === 'number') {
    if (v !== null && !Array.isArray(v)) return jqFail(`cannot index ${typeName(v)} with a number`);
    const arr = v === null ? [] : (v as JVal[]).slice();
    const at = k < 0 ? arr.length + k : k;
    if (at < 0) return jqFail('out of bounds negative array index');
    while (arr.length < at) arr.push(null);
    arr[at] = setPath(at < arr.length ? arr[at] : null, path, x, i + 1);
    return arr;
  }
  if (v !== null && (!isContainer(v) || Array.isArray(v))) return jqFail(`cannot index ${typeName(v)} with "${k}"`);
  const obj: JObj = {};
  if (v !== null) for (const key of Object.keys(v)) setKey(obj, key, (v as JObj)[key]);
  setKey(obj, k, setPath(Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null, path, x, i + 1));
  return obj;
}

/** A copy of `v` without the values at `paths` (deepest and last first, so indexes stay right). */
function delPaths(v: JVal, paths: (string | number)[][]): JVal {
  const sorted = [...paths].sort((a, b) => compareValues(b, a));
  for (const p of sorted) {
    if (!p.length) return null;
    const parent = getPath(v, p.slice(0, -1));
    const k = p[p.length - 1];
    if (parent === null) continue;
    let next: JVal;
    if (Array.isArray(parent)) {
      if (typeof k !== 'number') return jqFail('cannot delete a string key from an array');
      const at = k < 0 ? parent.length + k : k;
      next = parent.filter((_, i) => i !== at);
    } else if (isContainer(parent)) {
      const o: JObj = {};
      for (const key of Object.keys(parent)) if (key !== k) setKey(o, key, (parent as JObj)[key]);
      next = o;
    } else return jqFail(`cannot delete from ${typeName(parent)}`);
    v = setPath(v, p.slice(0, -1), next);
  }
  return v;
}

/** The paths a filter points at, relative to its input. A computed value has none: an error. */
function pathsOf(f: F, inp: Out, env: Env): (string | number)[][] {
  return f({ v: inp.v, p: null }, env).map((o) => (o.p === undefined ? jqFail('invalid path expression') : pathOf(o.p)));
}

function lookupVar(env: Env, name: string): JVal {
  for (let s = env.vars; s; s = s.up) if (s.name === name) return s.v;
  return jqFail(`$${name} is not defined`);
}

function lookupFunc(env: Env, key: string): FuncDef {
  for (let s = env.funcs; s; s = s.up) if (s.key === key) return s.fn;
  return jqFail(`${key} is not defined`);
}

function callUser(def: FuncDef, args: F[], inp: Out, caller: Env): Out[] {
  if ('closure' in def) return def.closure(inp, def.env);
  // Each argument: a filter (a closure over the caller's scope), or $name: one call per value.
  let envs: Env[] = [def.env];
  def.params.forEach((p, i) => {
    const a = args[i];
    if (p.startsWith('$')) {
      const name = p.slice(1);
      const values = a(inp, caller);
      envs = envs.flatMap((e) =>
        values.map((o) => ({
          vars: { name, v: o.v, up: e.vars },
          funcs: { key: `${name}/0`, fn: { closure: () => [val(o.v)], env: e }, up: e.funcs },
        })),
      );
    } else envs = envs.map((e) => ({ vars: e.vars, funcs: { key: `${p}/0`, fn: { closure: a, env: caller }, up: e.funcs } }));
  });
  return envs.flatMap((e) => def.body(inp, e));
}

type Pattern = (v: JVal, vars: VarScope) => VarScope;

class JqParser {
  i = 0;
  /** Names the query defines, innermost last: functions ("name/arity") and variables. */
  private funcs: string[] = [];
  private vars: string[] = ['ENV'];

  constructor(private readonly toks: Tok[]) {}

  peek(o = 0): Tok {
    return this.toks[Math.min(this.i + o, this.toks.length - 1)];
  }

  is(t: Tok['t'], v?: string): boolean {
    const k = this.peek();
    return k.t === t && (v === undefined || k.v === v);
  }

  op(v: string): boolean {
    return this.is('op', v);
  }

  fail(msg: string): never {
    throw new QueryError(`${msg} (column ${this.peek().pos + 1})`);
  }

  expect(v: string): void {
    if (!this.op(v)) this.fail(`'${v}' is expected`);
    this.i++;
  }

  private keyword(v: string): void {
    if (!this.is('id', v)) this.fail(`'${v}' is expected`);
    this.i++;
  }

  /** Runs `parse` with more names in scope. */
  private scoped<T>(vars: string[], funcs: string[], parse: () => T): T {
    const nv = this.vars.length;
    const nf = this.funcs.length;
    this.vars.push(...vars);
    this.funcs.push(...funcs);
    try {
      return parse();
    } finally {
      this.vars.length = nv;
      this.funcs.length = nf;
    }
  }

  pipe(): F {
    if (this.is('id', 'def')) return this.def();
    if (this.is('id', 'label')) {
      this.i++;
      if (!this.is('var')) this.fail('a label name ($name) is expected');
      const name = `*label*${this.peek().v}`;
      this.i++;
      this.expect('|');
      const body = this.scoped([name], [], () => this.pipe());
      return (inp, env) => {
        const id = Symbol(name);
        try {
          return body(inp, { vars: { name, v: id as unknown as JVal, up: env.vars }, funcs: env.funcs });
        } catch (e) {
          if (e instanceof BreakSignal && e.label === id) return e.partial;
          throw e;
        }
      };
    }
    const l = this.comma();
    if (!this.op('|')) return l;
    this.i++;
    const r = this.pipe();
    return (inp, env) => {
      const out: Out[] = [];
      for (const x of l(inp, env)) {
        try {
          for (const y of r(x, env)) out.push(y);
        } catch (e) {
          if (e instanceof BreakSignal) e.partial = [...out, ...e.partial];
          throw e;
        }
      }
      return out;
    };
  }

  /** def name: body;  def name(f; $x): body;  — then the rest of the pipe sees it. */
  private def(): F {
    this.i++;
    if (!this.is('id')) this.fail('a function name is expected');
    const name = this.peek().v as string;
    this.i++;
    const params: string[] = [];
    if (this.op('(')) {
      this.i++;
      for (;;) {
        if (this.is('id')) params.push(this.peek().v as string);
        else if (this.is('var')) params.push(`$${this.peek().v}`);
        else this.fail('a parameter name is expected');
        this.i++;
        if (!this.op(';')) break;
        this.i++;
      }
      this.expect(')');
    }
    this.expect(':');
    const key = `${name}/${params.length}`;
    const paramFuncs = params.map((p) => `${p.replace(/^\$/, '')}/0`);
    const paramVars = params.filter((p) => p.startsWith('$')).map((p) => p.slice(1));
    const body = this.scoped(paramVars, [key, ...paramFuncs], () => this.pipe());
    this.expect(';');
    const rest = this.scoped([], [key], () => this.pipe());
    return (inp, env) => {
      const scope: { key: string; fn: FuncDef; up: FuncScope } = { key, fn: { closure: () => [], env }, up: env.funcs };
      const inner: Env = { vars: env.vars, funcs: scope };
      scope.fn = { params, body, env: inner };
      return rest(inp, inner);
    };
  }

  private comma(): F {
    let f = this.alt();
    while (this.op(',')) {
      this.i++;
      const a = f;
      const b = this.alt();
      f = (inp, env) => {
        const first = a(inp, env);
        try {
          return [...first, ...b(inp, env)];
        } catch (e) {
          if (e instanceof BreakSignal) e.partial = [...first, ...e.partial];
          throw e;
        }
      };
    }
    return f;
  }

  alt(): F {
    let f = this.assign();
    while (this.op('//')) {
      this.i++;
      const a = f;
      const b = this.assign();
      f = (inp, env) => {
        let outs: Out[];
        try {
          outs = a(inp, env).filter((o) => truthy(o.v));
        } catch (e) {
          if (e instanceof LimitError || e instanceof BreakSignal) throw e;
          outs = [];
        }
        return outs.length ? outs : b(inp, env);
      };
    }
    return f;
  }

  /** lhs = rhs, lhs |= f, lhs += rhs, …  (not associative). */
  private assign(): F {
    const lhs = this.or();
    const op = ASSIGN.find((o) => this.op(o));
    if (!op) return lhs;
    this.i++;
    const rhs = this.or();
    if (op === '|=') {
      return (inp, env) => {
        let v = inp.v;
        for (const p of pathsOf(lhs, inp, env)) {
          const outs = rhs(val(getPath(v, p)), env);
          v = outs.length ? setPath(v, p, outs[0].v) : delPaths(v, [p]);
        }
        return [val(v)];
      };
    }
    return (inp, env) =>
      rhs(inp, env).map((r) => {
        let v = inp.v;
        for (const p of pathsOf(lhs, inp, env)) {
          const cur = getPath(v, p);
          const next = op === '=' ? r.v : op === '//=' ? (truthy(cur) ? cur : r.v) : arith(op.slice(0, -1), cur, r.v);
          v = setPath(v, p, next);
        }
        return val(v);
      });
  }

  private or(): F {
    let f = this.and();
    while (this.is('id', 'or')) {
      this.i++;
      const a = f;
      const b = this.and();
      f = (inp, env) => a(inp, env).flatMap((x) => (truthy(x.v) ? [val(true)] : b(inp, env).map((y) => val(truthy(y.v)))));
    }
    return f;
  }

  private and(): F {
    let f = this.cmp();
    while (this.is('id', 'and')) {
      this.i++;
      const a = f;
      const b = this.cmp();
      f = (inp, env) => a(inp, env).flatMap((x) => (!truthy(x.v) ? [val(false)] : b(inp, env).map((y) => val(truthy(y.v)))));
    }
    return f;
  }

  private cmp(): F {
    const l = this.add();
    const op = ['==', '!=', '<=', '>=', '<', '>'].find((o) => this.op(o));
    if (!op) return l;
    this.i++;
    const r = this.add();
    return (inp, env) => product(l, r, inp, env, (a, b) => cmpOp(op, a, b));
  }

  private add(): F {
    let f = this.mul();
    while (this.op('+') || this.op('-')) {
      const op = this.peek().v as string;
      this.i++;
      const a = f;
      const b = this.mul();
      f = (inp, env) => product(a, b, inp, env, (x, y) => arith(op, x, y));
    }
    return f;
  }

  private mul(): F {
    let f = this.unary();
    while (this.op('*') || this.op('/') || this.op('%')) {
      const op = this.peek().v as string;
      this.i++;
      const a = f;
      const b = this.unary();
      f = (inp, env) => product(a, b, inp, env, (x, y) => arith(op, x, y));
    }
    return f;
  }

  private unary(): F {
    if (!this.op('-')) return this.postfix();
    this.i++;
    const f = this.postfix();
    return (inp, env) => f(inp, env).map((o) => (typeName(o.v) === 'number' ? val(-num(o.v)) : jqFail(`${typeName(o.v)} cannot be negated`)));
  }

  /** A term with its suffixes. `allowAs`: `Term as $x | body` binds here (not after reduce/foreach sources). */
  private postfix(allowAs = true): F {
    let f = this.term();
    for (;;) {
      if (this.is('field')) {
        const g = field(this.peek().v as string);
        this.i++;
        const base = f;
        f = (inp, env) => base(inp, env).flatMap(g);
      } else if (this.op('.') && this.peek(1).t === 'str') {
        this.i++;
        const g = field(this.peek().v as string);
        this.i++;
        const base = f;
        f = (inp, env) => base(inp, env).flatMap(g);
      } else if (this.op('[')) {
        f = this.bracket(f);
      } else if (this.op('?')) {
        this.i++;
        const g = f;
        f = (inp, env) => {
          try {
            return g(inp, env);
          } catch (e) {
            if (e instanceof LimitError || e instanceof BreakSignal) throw e;
            return [];
          }
        };
      } else if (allowAs && this.is('id', 'as')) {
        this.i++;
        const names: string[] = [];
        const pattern = this.pattern(names);
        this.expect('|');
        const body = this.scoped(names, [], () => this.pipe());
        const source = f;
        return (inp, env) => source(inp, env).flatMap((o) => body(inp, { vars: pattern(o.v, env.vars), funcs: env.funcs }));
      } else return f;
    }
  }

  /** $x, [$a, $b], {a: $x, $b, "c": [$d]} */
  private pattern(names: string[]): Pattern {
    if (this.is('var')) {
      const name = this.peek().v as string;
      this.i++;
      names.push(name);
      return (v, vars) => ({ name, v, up: vars });
    }
    if (this.op('[')) {
      this.i++;
      const items: Pattern[] = [];
      for (;;) {
        items.push(this.pattern(names));
        if (!this.op(',')) break;
        this.i++;
      }
      this.expect(']');
      return (v, vars) => {
        if (v !== null && !Array.isArray(v)) return jqFail(`cannot index ${typeName(v)} with a number`);
        return items.reduce<VarScope>((acc, p, k) => p(v === null ? null : ((v as JVal[])[k] ?? null), acc), vars);
      };
    }
    if (this.op('{')) {
      this.i++;
      const entries: { key: string; p: Pattern }[] = [];
      for (;;) {
        const k = this.peek();
        if (k.t === 'var') {
          // {$name} or {$name: pattern}: $name gets the value of "name" (and the pattern matches it too).
          this.i++;
          const name = k.v as string;
          names.push(name);
          const own: Pattern = (v, vars) => ({ name, v, up: vars });
          if (this.op(':')) {
            this.i++;
            const inner = this.pattern(names);
            entries.push({ key: name, p: (v, vars) => inner(v, own(v, vars)) });
          } else entries.push({ key: name, p: own });
        } else if (k.t === 'id' || k.t === 'str') {
          this.i++;
          this.expect(':');
          entries.push({ key: k.v as string, p: this.pattern(names) });
        } else this.fail('an object key is expected in the pattern');
        if (!this.op(',')) break;
        this.i++;
      }
      this.expect('}');
      return (v, vars) => {
        if (v !== null && (!isContainer(v) || Array.isArray(v))) return jqFail(`cannot index ${typeName(v)} with a key`);
        return entries.reduce<VarScope>((acc, e) => e.p(v === null || !Object.prototype.hasOwnProperty.call(v, e.key) ? null : (v as JObj)[e.key], acc), vars);
      };
    }
    this.fail('a pattern ($name, [...] or {...}) is expected');
  }

  /** `[]`, `[e]`, `[a:b]` after a term. The index is computed from the same input as the term. */
  private bracket(base: F): F {
    this.expect('[');
    if (this.op(']')) {
      this.i++;
      return (inp, env) => base(inp, env).flatMap(iterate);
    }
    const lo = this.op(':') ? null : this.pipe();
    if (this.op(':')) {
      this.i++;
      const hi = this.op(']') ? null : this.pipe();
      this.expect(']');
      const bound = (g: F | null, inp: Out, env: Env) => (g ? g(inp, env).map((o) => (o.v === null ? null : num(o.v))) : [null]);
      return (inp, env) =>
        base(inp, env).flatMap((b) =>
          bound(lo, inp, env).flatMap((x) =>
            bound(hi, inp, env).map((y) => {
              const v = b.v;
              if (v === null) return val(null);
              if (typeof v !== 'string' && !Array.isArray(v)) return jqFail(`cannot slice ${typeName(v)}`);
              const len = v.length;
              const s = x === null ? 0 : Math.max(0, Math.min(len, Math.floor(x < 0 ? len + x : x)));
              const e = y === null ? len : Math.max(0, Math.min(len, Math.ceil(y < 0 ? len + y : y)));
              return val(v.slice(s, Math.max(s, e)) as JVal);
            }),
          ),
        );
    }
    this.expect(']');
    const key = lo as F;
    return (inp, env) => {
      const bases = base(inp, env);
      return key(inp, env).flatMap((k) => bases.flatMap((b) => indexBy(b, k.v)));
    };
  }

  private term(): F {
    const k = this.peek();
    if (k.t === 'num' || k.t === 'str') {
      this.i++;
      return () => [val(k.v)];
    }
    if (k.t === 'field') {
      this.i++;
      return field(k.v as string);
    }
    if (k.t === 'var') {
      this.i++;
      const name = k.v as string;
      if (!this.vars.includes(name)) this.fail(`$${name} is not defined`);
      return (_inp, env) => [val(lookupVar(env, name))];
    }
    if (k.t === 'op') {
      switch (k.v) {
        case '.':
          this.i++;
          if (this.is('str')) {
            const g = field(this.peek().v as string);
            this.i++;
            return g;
          }
          return (inp) => [inp];
        case '..':
          this.i++;
          return descend;
        case '(': {
          this.i++;
          const f = this.pipe();
          this.expect(')');
          return f;
        }
        case '[': {
          this.i++;
          if (this.op(']')) {
            this.i++;
            return () => [val([])];
          }
          const f = this.pipe();
          this.expect(']');
          return (inp, env) => [val(f(inp, env).map((o) => o.v))];
        }
        case '{':
          return this.object();
      }
    }
    if (k.t === 'id') {
      const name = k.v as string;
      if (name === 'true' || name === 'false' || name === 'null') {
        this.i++;
        const v = name === 'true' ? true : name === 'false' ? false : null;
        return () => [val(v)];
      }
      if (name === 'if') return this.ifThen();
      if (name === 'reduce' || name === 'foreach') return this.fold(name);
      if (name === 'try') return this.tryCatch();
      if (name === 'def') return this.def();
      if (name === 'break') {
        this.i++;
        const label = `*label*${this.peek().v}`;
        if (!this.is('var') || !this.vars.includes(label)) this.fail('break needs a $label in scope');
        this.i++;
        return (_inp, env) => {
          throw new BreakSignal(lookupVar(env, label) as unknown as symbol, []);
        };
      }
      if (UNSUPPORTED.has(name)) this.fail(`${name} is not supported`);
      if (KEYWORDS.has(name)) this.fail(`unexpected '${name}'`);
      this.i++;
      const args: F[] = [];
      if (this.op('(')) {
        this.i++;
        args.push(this.pipe());
        while (this.op(';')) {
          this.i++;
          args.push(this.pipe());
        }
        this.expect(')');
      }
      const key = `${name}/${args.length}`;
      // A function the query defined (or a filter parameter) wins over a builtin.
      if (this.funcs.includes(key)) return (inp, env) => callUser(lookupFunc(env, key), args, inp, env);
      return builtin(name, args, (msg) => this.fail(msg));
    }
    this.fail(k.t === 'eof' ? 'the query ends too soon' : `unexpected '${k.v}'`);
  }

  /** reduce SOURCE as $x (INIT; UPDATE)  ·  foreach SOURCE as $x (INIT; UPDATE; EXTRACT) */
  private fold(kind: 'reduce' | 'foreach'): F {
    this.i++;
    const source = this.postfix(false);
    this.keyword('as');
    const names: string[] = [];
    const pattern = this.pattern(names);
    this.expect('(');
    const init = this.pipe();
    this.expect(';');
    const update = this.scoped(names, [], () => this.pipe());
    let extract: F | null = null;
    if (kind === 'foreach' && this.op(';')) {
      this.i++;
      extract = this.scoped(names, [], () => this.pipe());
    }
    this.expect(')');
    if (kind === 'reduce') {
      return (inp, env) =>
        init(inp, env).map((start) => {
          let acc: JVal = start.v;
          for (const x of source(inp, env)) {
            const outs = update(val(acc), { vars: pattern(x.v, env.vars), funcs: env.funcs });
            acc = outs.length ? outs[outs.length - 1].v : null;
          }
          return val(acc);
        });
    }
    return (inp, env) =>
      init(inp, env).flatMap((start) => {
        const out: Out[] = [];
        let state: JVal = start.v;
        for (const x of source(inp, env)) {
          const e2: Env = { vars: pattern(x.v, env.vars), funcs: env.funcs };
          for (const u of update(val(state), e2)) {
            state = u.v;
            for (const o of extract ? extract(val(state), e2) : [val(state)]) out.push(o);
          }
        }
        return out;
      });
  }

  /** try E  ·  try E catch F  (F gets the error message, or the value given to error) */
  private tryCatch(): F {
    this.i++;
    const body = this.postfix();
    let handler: F | null = null;
    if (this.is('id', 'catch')) {
      this.i++;
      handler = this.postfix();
    }
    return (inp, env) => {
      try {
        return body(inp, env);
      } catch (e) {
        if (e instanceof LimitError || e instanceof BreakSignal || !(e instanceof QueryError)) throw e;
        return handler ? handler(val(e instanceof JqError ? e.value : e.message), env) : [];
      }
    };
  }

  private ifThen(): F {
    this.i++;
    const cond = this.pipe();
    this.keyword('then');
    const yes = this.pipe();
    let no: F = (inp) => [inp];
    if (this.is('id', 'elif')) {
      this.toks[this.i] = { ...this.peek(), v: 'if' };
      no = this.ifThen();
      return (inp, env) => cond(inp, env).flatMap((c) => (truthy(c.v) ? yes(inp, env) : no(inp, env)));
    }
    if (this.is('id', 'else')) {
      this.i++;
      no = this.pipe();
    }
    this.keyword('end');
    return (inp, env) => cond(inp, env).flatMap((c) => (truthy(c.v) ? yes(inp, env) : no(inp, env)));
  }

  private object(): F {
    this.expect('{');
    const entries: { key: F; value: F }[] = [];
    while (!this.op('}')) {
      const k = this.peek();
      let key: F;
      let value: F | null = null;
      if (k.t === 'var') {
        // {$x}: the key "x" with the value of $x
        this.i++;
        const name = k.v as string;
        if (!this.vars.includes(name)) this.fail(`$${name} is not defined`);
        key = () => [val(name)];
        value = (_inp, env) => [val(lookupVar(env, name))];
      } else if (k.t === 'id' || k.t === 'str') {
        this.i++;
        const name = k.v as string;
        key = () => [val(name)];
        value = field(name);
      } else if (this.op('(')) {
        this.i++;
        key = this.pipe();
        this.expect(')');
      } else this.fail('an object key is expected');
      if (this.op(':')) {
        this.i++;
        value = this.alt();
      } else if (!value) this.fail("':' is expected");
      entries.push({ key, value: value as F });
      if (!this.op(',')) break;
      this.i++;
    }
    this.expect('}');
    return (inp, env) => {
      let acc: JObj[] = [{}];
      for (const e of entries) {
        const next: JObj[] = [];
        const keys = e.key(inp, env);
        const values = e.value(inp, env);
        for (const o of acc) {
          for (const kk of keys) {
            const key = typeof kk.v === 'string' ? kk.v : jqFail('an object key must be a string');
            for (const vv of values) {
              const copy: JObj = {};
              for (const ok of Object.keys(o)) setKey(copy, ok, o[ok]);
              setKey(copy, key, vv.v);
              next.push(copy);
            }
          }
        }
        spend(next.length);
        acc = next;
      }
      return acc.map((o) => val(o));
    };
  }
}

function builtin(name: string, args: F[], fail: (msg: string) => never): F {
  const n = args.length;
  const want = (k: number) => {
    if (n !== k) fail(`unknown function ${name}/${n}`);
  };
  const map1 = (fn: (v: JVal) => JVal): F => {
    want(0);
    return (inp, env) => [val(fn(inp.v))];
  };
  const withArg = (fn: (v: JVal, a: JVal) => JVal): F => {
    want(1);
    return (inp, env) => args[0](inp, env).map((a) => val(fn(inp.v, a.v)));
  };
  const arr = (v: JVal, what: string): JVal[] => (Array.isArray(v) ? v : jqFail(`${what} needs an array`));
  const byType = (t: string | string[]): F => {
    want(0);
    const ts = Array.isArray(t) ? t : [t];
    return (inp, env) => (ts.includes(typeName(inp.v)) ? [inp] : []);
  };
  switch (name) {
    case 'empty':
      want(0);
      return () => [];
    case 'not':
      return map1((v) => !truthy(v));
    case 'length':
      return map1(length);
    case 'type':
      return map1(typeName);
    case 'keys':
    case 'keys_unsorted':
      return map1((v) => {
        if (Array.isArray(v)) return v.map((_, i) => i);
        if (!isContainer(v)) return jqFail(`${typeName(v)} has no keys`);
        const ks = Object.keys(v);
        return name === 'keys' ? ks.sort() : ks;
      });
    case 'has':
      return withArg((v, k) => {
        if (Array.isArray(v) && typeName(k) === 'number') return num(k) >= 0 && num(k) < v.length;
        if (isContainer(v) && !Array.isArray(v) && typeof k === 'string') return Object.prototype.hasOwnProperty.call(v, k);
        return jqFail(`cannot check whether ${typeName(v)} has a ${typeName(k)} key`);
      });
    case 'select':
      want(1);
      return (inp, env) => args[0](inp, env).filter((o) => truthy(o.v)).map(() => inp);
    case 'values':
      want(0);
      return (inp, env) => (inp.v === null ? [] : [inp]);
    case 'nulls':
      return byType('null');
    case 'booleans':
      return byType('boolean');
    case 'numbers':
      return byType('number');
    case 'strings':
      return byType('string');
    case 'arrays':
      return byType('array');
    case 'objects':
      return byType('object');
    case 'iterables':
      return byType(['array', 'object']);
    case 'scalars':
      return byType(['null', 'boolean', 'number', 'string']);
    case 'map':
      want(1);
      return (inp, env) => [val(iterate(inp).flatMap((c) => args[0](c, env)).map((o) => o.v))];
    case 'map_values':
      want(1);
      return (inp, env) => {
        const v = inp.v;
        if (Array.isArray(v)) return [val(v.flatMap((x) => args[0](val(x), env).slice(0, 1).map((o) => o.v)))];
        if (!isContainer(v)) return jqFail(`cannot iterate over ${typeName(v)}`);
        const out: JObj = {};
        for (const k of Object.keys(v)) {
          const r = args[0](val((v as JObj)[k]), env);
          if (r.length) out[k] = r[0].v;
        }
        return [val(out)];
      };
    case 'add':
      return map1((v) => {
        const xs = isContainer(v) ? (Array.isArray(v) ? v : Object.values(v)) : v === null ? [] : jqFail(`cannot add up ${typeName(v)}`);
        return xs.length ? xs.reduce((a, b) => arith('+', a, b)) : null;
      });
    case 'any':
    case 'all': {
      const every = name === 'all';
      if (n === 0) return map1((v) => (every ? arr(v, name).every(truthy) : arr(v, name).some(truthy)));
      want(1);
      return (inp, env) => {
        const kids = iterate(inp);
        const ok = (c: Out) => args[0](c, env).some((o) => truthy(o.v));
        return [val(every ? kids.every(ok) : kids.some(ok))];
      };
    }
    case 'min':
    case 'max':
      return map1((v) => {
        const xs = arr(v, name);
        if (!xs.length) return null;
        return xs.reduce((a, b) => ((name === 'min' ? compareValues(b, a) < 0 : compareValues(b, a) >= 0) ? b : a));
      });
    case 'sort':
      return map1((v) => [...arr(v, 'sort')].sort(compareValues));
    case 'sort_by':
    case 'group_by':
    case 'unique_by':
    case 'min_by':
    case 'max_by': {
      want(1);
      return (inp, env) => {
        const xs = iterate(inp);
        const keyed = xs.map((x) => ({ x: x.v, k: args[0](x, env).map((o) => o.v) as JVal }));
        keyed.sort((a, b) => compareValues(a.k, b.k));
        if (name === 'sort_by') return [val(keyed.map((e) => e.x))];
        if (name === 'min_by') return [val(keyed.length ? keyed[0].x : null)];
        if (name === 'max_by') return [val(keyed.length ? keyed[keyed.length - 1].x : null)];
        const groups: { k: JVal; xs: JVal[] }[] = [];
        for (const e of keyed) {
          const last = groups[groups.length - 1];
          if (last && compareValues(last.k, e.k) === 0) last.xs.push(e.x);
          else groups.push({ k: e.k, xs: [e.x] });
        }
        return [val(name === 'group_by' ? groups.map((g) => g.xs) : groups.map((g) => g.xs[0]))];
      };
    }
    case 'unique':
      return map1((v) => [...arr(v, 'unique')].sort(compareValues).filter((x, i, all) => i === 0 || compareValues(all[i - 1], x) !== 0));
    case 'reverse':
      return map1((v) => (typeof v === 'string' ? [...v].reverse().join('') : v === null ? [] : [...arr(v, 'reverse')].reverse()));
    case 'first':
    case 'last':
      if (n === 0) {
        return (inp, env) => {
          const v = inp.v;
          if (v === null) return [val(null)];
          const xs = arr(v, name);
          return indexBy(inp, name === 'first' ? 0 : xs.length - 1);
        };
      }
      want(1);
      return (inp, env) => {
        const outs = args[0](inp, env);
        return outs.length ? [name === 'first' ? outs[0] : outs[outs.length - 1]] : [];
      };
    case 'limit':
      want(2);
      return (inp, env) => args[0](inp, env).flatMap((k) => args[1](inp, env).slice(0, Math.max(0, num(k.v))));
    case 'range':
      if (n !== 1 && n !== 2) fail(`unknown function range/${n}`);
      return (inp, env) => {
        const [lo, hi] = n === 1 ? [0, num(args[0](inp, env)[0]?.v ?? 0)] : [num(args[0](inp, env)[0]?.v ?? 0), num(args[1](inp, env)[0]?.v ?? 0)];
        const out: Out[] = [];
        for (let i = lo; i < hi; i++) out.push(val(i));
        return out;
      };
    case 'floor':
    case 'ceil':
    case 'round':
    case 'fabs':
    case 'sqrt':
      return map1((v) => {
        if (typeName(v) !== 'number') return jqFail(`${typeName(v)} is not a number`);
        const x = num(v);
        return name === 'floor' ? Math.floor(x) : name === 'ceil' ? Math.ceil(x) : name === 'round' ? Math.round(x) : name === 'fabs' ? Math.abs(x) : Math.sqrt(x);
      });
    case 'tostring':
      return map1((v) => (typeof v === 'string' ? v : compactJson(v)));
    case 'tojson':
      return map1((v) => compactJson(v));
    case 'fromjson':
      return map1((v) => {
        try {
          return parseJson(stringArg(v, 'fromjson'));
        } catch (e) {
          return jqFail(`${(e as Error).message}`);
        }
      });
    case 'tonumber':
      return map1((v) => {
        if (typeName(v) === 'number') return v;
        const x = Number(stringArg(v, 'tonumber'));
        return Number.isNaN(x) || !(v as string).trim() ? jqFail(`cannot parse "${v}" as a number`) : x;
      });
    case 'ascii_downcase':
    case 'ascii_upcase':
      return map1((v) => {
        const s = stringArg(v, name);
        return name === 'ascii_downcase' ? s.replace(/[A-Z]/g, (c) => c.toLowerCase()) : s.replace(/[a-z]/g, (c) => c.toUpperCase());
      });
    case 'trim':
    case 'ltrim':
    case 'rtrim':
      return map1((v) => {
        const s = stringArg(v, name);
        return name === 'trim' ? s.trim() : name === 'ltrim' ? s.trimStart() : s.trimEnd();
      });
    case 'startswith':
    case 'endswith':
      return withArg((v, a) => {
        const s = stringArg(v, name);
        const p = stringArg(a, name);
        return name === 'startswith' ? s.startsWith(p) : s.endsWith(p);
      });
    case 'ltrimstr':
    case 'rtrimstr':
      return withArg((v, a) => {
        if (typeof v !== 'string' || typeof a !== 'string') return v;
        if (name === 'ltrimstr') return v.startsWith(a) ? v.slice(a.length) : v;
        return a && v.endsWith(a) ? v.slice(0, v.length - a.length) : v;
      });
    case 'split':
      if (n === 1) return withArg((v, a) => stringArg(v, 'split').split(stringArg(a, 'split')));
      want(2);
      return (inp, env) => args[0](inp, env).flatMap((re) => args[1](inp, env).map((fl) => val(stringArg(inp.v, 'split').split(regex(re.v, fl.v)))));
    case 'join':
      return withArg((v, a) => {
        const sep = stringArg(a, 'join');
        return arr(v, 'join')
          .map((x) => (x === null ? '' : typeof x === 'string' ? x : typeName(x) === 'object' || typeName(x) === 'array' ? jqFail('cannot join an object or array') : compactJson(x)))
          .join(sep);
      });
    case 'test':
      if (n !== 1 && n !== 2) fail(`unknown function test/${n}`);
      return (inp, env) => {
        const s = stringArg(inp.v, 'test');
        const flags = n === 2 ? args[1](inp, env) : [val(null)];
        return args[0](inp, env).flatMap((re) => flags.map((fl) => val(regex(re.v, fl.v).test(s))));
      };
    case 'contains':
      return withArg((v, a) => contains(v, a));
    case 'inside':
      return withArg((v, a) => contains(a, v));
    case 'to_entries':
      return map1((v) => {
        if (!isContainer(v) || Array.isArray(v)) return jqFail(`${typeName(v)} has no entries`);
        return Object.keys(v).map((k) => ({ key: k, value: v[k] }));
      });
    case 'from_entries':
      return map1((v) => {
        const out: JObj = {};
        for (const e of arr(v, 'from_entries')) {
          if (!isContainer(e) || Array.isArray(e)) return jqFail('from_entries needs objects');
          const o = e as JObj;
          const k = o.key ?? o.k ?? o.name ?? o.Name ?? o.Key ?? o.K;
          out[typeof k === 'string' ? k : compactJson(k ?? null)] = (o.value ?? o.v ?? o.Value ?? o.V ?? null) as JVal;
        }
        return out;
      });
    case 'del':
      want(1);
      return (inp, env) => [val(delPaths(inp.v, pathsOf(args[0], inp, env)))];
    case 'delpaths':
      want(1);
      return (inp, env) => args[0](inp, env).map((ps) => val(delPaths(inp.v, arr(ps.v, 'delpaths').map((p) => arr(p, 'delpaths') as (string | number)[]))));
    case 'getpath':
      want(1);
      return (inp, env) =>
        args[0](inp, env).map((p) => {
          try {
            return val(getPath(inp.v, arr(p.v, 'getpath') as (string | number)[]));
          } catch {
            return val(null);
          }
        });
    case 'setpath':
      want(2);
      return (inp, env) => args[1](inp, env).flatMap((x) => args[0](inp, env).map((p) => val(setPath(inp.v, arr(p.v, 'setpath') as (string | number)[], x.v))));
    case 'with_entries':
      want(1);
      return (inp, env) => {
        const v = inp.v;
        if (!isContainer(v) || Array.isArray(v)) return jqFail(`${typeName(v)} has no entries`);
        const out: JObj = {};
        for (const k of Object.keys(v)) {
          for (const e of args[0](val({ key: k, value: (v as JObj)[k] }), env)) {
            const o = e.v as JObj;
            if (!isContainer(o) || Array.isArray(o)) return jqFail('with_entries needs objects');
            const key = o.key ?? o.k ?? o.name ?? null;
            setKey(out, typeof key === 'string' ? key : compactJson(key), (o.value ?? o.v ?? null) as JVal);
          }
        }
        return [val(out)];
      };
    case 'leaf_paths':
      want(0);
      return (inp) => descend({ v: inp.v, p: null }).filter((o) => o.p !== null && !isContainer(o.v)).map((o) => val(pathOf(o.p as PathLink)));
    case 'paths':
      if (n === 1)
        return (inp, env) =>
          descend({ v: inp.v, p: null })
            .slice(1)
            .filter((o) => args[0](val(o.v), env).some((x) => truthy(x.v)))
            .map((o) => val(pathOf(o.p as PathLink)));
      want(0);
      return (inp, env) => descend({ v: inp.v, p: null }).slice(1).map((o) => val(pathOf(o.p as PathLink)));
    case 'path':
      want(1);
      return (inp, env) => args[0]({ v: inp.v, p: null }, env).map((o) => (o.p === undefined ? jqFail('invalid path expression') : val(pathOf(o.p))));
    case 'recurse':
      if (n === 0) return descend;
      want(1);
      return (inp, env) => {
        const out: Out[] = [];
        const stack: Out[] = [inp];
        while (stack.length) {
          const x = stack.pop() as Out;
          out.push(x);
          const next = args[0](x, env);
          for (let i = next.length - 1; i >= 0; i--) stack.push(next[i]);
        }
        return out;
      };
    case 'error':
      want(n === 0 ? 0 : 1);
      return (inp, env) => {
        throw new JqError(n === 0 ? inp.v : (args[0](inp, env)[0]?.v ?? null));
      };
  }
  return fail(`unknown function ${name}/${n}`);
}

const regexCache = new Map<string, RegExp>();

function regex(re: JVal, flags: JVal): RegExp {
  const src = stringArg(re, 'test');
  const fl = flags === null ? '' : stringArg(flags, 'test');
  const key = `${fl}/${src}`;
  let r = regexCache.get(key);
  if (!r) {
    try {
      r = new RegExp(fl.includes('x') ? src.replace(/\s+|#.*$/gm, '') : src, `u${fl.includes('i') ? 'i' : ''}${fl.includes('s') ? 's' : ''}`);
    } catch (e) {
      return jqFail(`the regular expression is not valid: ${(e as Error).message}`);
    }
    if (regexCache.size > 100) regexCache.clear();
    regexCache.set(key, r);
  }
  return r;
}

export function compileJq(src: string): Program {
  const p = new JqParser(lex(src));
  const f = p.pipe();
  if (!p.is('eof')) p.fail(`unexpected '${p.peek().v}'`);
  return {
    kind: 'jq',
    matches(record) {
      budget = MAX_RECORD;
      try {
        return f({ v: record, p: null }, EMPTY_ENV).some((o) => truthy(o.v));
      } catch {
        return false;
      }
    },
    run(root) {
      budget = MAX_OUT;
      try {
        return { outs: f({ v: root, p: null }, EMPTY_ENV), capped: false };
      } catch (e) {
        if (e instanceof LimitError) return { outs: [], capped: true };
        throw e;
      }
    },
  };
}

/** A search that starts with `.` (or one of these functions) is a jq filter. */
const JQ_START = /^(?:\.|(?:select|map|has|any|all|test|to_entries|paths|recurse|keys|length|type)\s*\(|if\s)/;

/**
 * Reads the search text as a query when it looks like one: `$…` is JSONPath, `.…` is jq.
 * Returns an error message when it looks like a query but is not a valid one.
 */
export function compileQuery(raw: string): { program?: Program; error?: string } {
  const s = raw.trim();
  const jsonPath = s.startsWith('$');
  if (!jsonPath && !JQ_START.test(s)) return {};
  try {
    return { program: jsonPath ? compileJsonPath(s) : compileJq(s) };
  } catch (e) {
    return { error: `${jsonPath ? 'JSONPath' : 'jq'}: ${(e as Error).message}` };
  }
}
