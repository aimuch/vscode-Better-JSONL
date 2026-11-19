// Zero-dependency lightweight SQL query engine for JSON / JSON Lines datasets.
// Supports: SELECT <cols | aggregates> [FROM ...] [WHERE <expr>] [GROUP BY <cols>] [ORDER BY <col|pos> [ASC|DESC]] [LIMIT <n>]
import type { JsonPath } from '../shared/protocol';
import { compareNumbers, getAt, isContainer, isObj, parsePath, plainText, RawNum, type JObj, type JVal } from './json';
import { compactJson } from './query';
import { DistinctCounter } from './sketch';

export type AggFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export interface SelectItem {
  kind: 'star' | 'field' | 'agg';
  path?: JsonPath;
  rawPath?: string;
  agg?: AggFn;
  distinct?: boolean;
  alias: string;
}

export type WhereExpr =
  | { kind: 'and' | 'or'; left: WhereExpr; right: WhereExpr }
  | { kind: 'not'; expr: WhereExpr }
  | { kind: 'cmp'; path: JsonPath; op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE'; value: JVal }
  | { kind: 'in'; path: JsonPath; values: JVal[]; negated?: boolean }
  | { kind: 'null'; path: JsonPath; negated: boolean };

export interface OrderSpec {
  target: string | number; // column alias/path or 1-based positional index
  dir: 1 | -1;
}

export interface SqlQuery {
  select: SelectItem[];
  where: WhereExpr | null;
  groupBy: { path: JsonPath; raw: string }[];
  orderBy: OrderSpec[];
  limit: number | null;
  hasAggregate: boolean;
}

export interface SqlResult {
  rows: JObj[];
  totalMatched: number;
  columns: string[];
}

export function isSqlQueryText(q: string): boolean {
  return /^\s*SELECT\s+/i.test(q);
}

// ---------- Lexer ----------

type TokKind = 'ident' | 'str' | 'num' | 'op' | 'punct' | 'eof';
interface Tok {
  kind: TokKind;
  text: string;
  upper: string;
  pos: number;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      const start = i++;
      let s = '';
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) {
          s += src[i + 1];
          i += 2;
        } else if (src[i] === q) {
          if (q === "'" && src[i + 1] === "'") {
            s += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          s += src[i++];
        }
      }
      out.push({ kind: q === '`' ? 'ident' : 'str', text: s, upper: s.toUpperCase(), pos: start });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && i + 1 < n && /[0-9]/.test(src[i + 1]))) {
      const start = i++;
      while (i < n && /[0-9.eE+-]/.test(src[i])) i++;
      const text = src.slice(start, i);
      out.push({ kind: 'num', text, upper: text, pos: start });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '!=' || two === '<>' || two === '>=' || two === '<=') {
      out.push({ kind: 'op', text: two === '<>' ? '!=' : two, upper: two, pos: i });
      i += 2;
      continue;
    }
    if (ch === '=' || ch === '>' || ch === '<') {
      out.push({ kind: 'op', text: ch, upper: ch, pos: i });
      i++;
      continue;
    }
    if ('(),*;'.includes(ch)) {
      out.push({ kind: 'punct', text: ch, upper: ch, pos: i });
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i++;
      while (i < n && /[A-Za-z0-9_$.[\]-]/.test(src[i])) i++;
      const text = src.slice(start, i);
      out.push({ kind: 'ident', text, upper: text.toUpperCase(), pos: start });
      continue;
    }
    throw new Error(`Unexpected character "${ch}" at position ${i + 1}`);
  }
  out.push({ kind: 'eof', text: '', upper: '', pos: n });
  return out;
}

const AGG_FNS = new Set<AggFn>(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const KEYWORDS = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'AS', 'ASC', 'DESC', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL', 'LIKE', 'DISTINCT', 'TRUE', 'FALSE']);

// ---------- Parser ----------

export function parseSql(src: string): SqlQuery {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const matchKw = (kw: string): boolean => {
    if (peek().kind === 'ident' && peek().upper === kw) {
      p++;
      return true;
    }
    return false;
  };
  const expectKw = (kw: string) => {
    if (!matchKw(kw)) throw new Error(`Expected ${kw} near "${peek().text || 'end'}"`);
  };

  const toPath = (raw: string): JsonPath => {
    const clean = raw.startsWith('$.') ? raw.slice(2) : raw.startsWith('.') ? raw.slice(1) : raw;
    return parsePath(clean) ?? [clean];
  };

  expectKw('SELECT');
  const select: SelectItem[] = [];
  let hasAggregate = false;

  while (true) {
    if (peek().kind === 'punct' && peek().text === '*') {
      next();
      select.push({ kind: 'star', alias: '*' });
    } else if (peek().kind === 'ident' && AGG_FNS.has(peek().upper as AggFn) && toks[p + 1]?.text === '(') {
      const agg = next().upper as AggFn;
      next(); // '('
      let distinct = false;
      if (matchKw('DISTINCT')) distinct = true;
      let rawPath = '*';
      let path: JsonPath | undefined;
      if (peek().text === '*') {
        next();
      } else if (peek().kind === 'ident') {
        rawPath = next().text;
        path = toPath(rawPath);
      } else {
        throw new Error(`Expected column or * inside ${agg}(...)`);
      }
      if (next().text !== ')') throw new Error(`Expected ")" after ${agg}(...)`);
      let alias = `${agg.toLowerCase()}_${rawPath === '*' ? 'all' : rawPath.replace(/[^A-Za-z0-9_]+/g, '_')}`;
      if (matchKw('AS')) {
        alias = next().text;
      } else if (peek().kind === 'ident' && !KEYWORDS.has(peek().upper)) {
        alias = next().text;
      }
      hasAggregate = true;
      select.push({ kind: 'agg', agg, distinct, path, rawPath, alias });
    } else if (peek().kind === 'ident') {
      const rawPath = next().text;
      let alias = rawPath;
      if (matchKw('AS')) {
        alias = next().text;
      } else if (peek().kind === 'ident' && !KEYWORDS.has(peek().upper)) {
        alias = next().text;
      }
      select.push({ kind: 'field', path: toPath(rawPath), rawPath, alias });
    } else {
      throw new Error(`Expected column expression near "${peek().text || 'end'}"`);
    }
    if (peek().text === ',') {
      next();
      continue;
    }
    break;
  }

  // Optional FROM <table_name>
  if (matchKw('FROM')) {
    if (peek().kind === 'ident' || peek().kind === 'str') next();
  }

  // Optional WHERE
  const parseLiteral = (): JVal => {
    const t = next();
    if (t.kind === 'str') return t.text;
    if (t.kind === 'num') {
      const n = Number(t.text);
      return Number.isFinite(n) ? n : t.text;
    }
    if (t.kind === 'ident') {
      if (t.upper === 'TRUE') return true;
      if (t.upper === 'FALSE') return false;
      if (t.upper === 'NULL') return null;
      return t.text;
    }
    throw new Error(`Expected literal value near "${t.text || 'end'}"`);
  };

  const parsePrimary = (): WhereExpr => {
    if (matchKw('NOT')) return { kind: 'not', expr: parsePrimary() };
    if (peek().text === '(') {
      next();
      const inner = parseOr();
      if (next().text !== ')') throw new Error('Expected closing ")"');
      return inner;
    }
    if (peek().kind !== 'ident') throw new Error(`Expected field name near "${peek().text || 'end'}"`);
    const field = next().text;
    const path = toPath(field);
    if (matchKw('IS')) {
      const negated = matchKw('NOT');
      expectKw('NULL');
      return { kind: 'null', path, negated };
    }
    const negatedIn = matchKw('NOT');
    if (matchKw('IN')) {
      if (next().text !== '(') throw new Error('Expected "(" after IN');
      const values: JVal[] = [];
      while (peek().text !== ')' && peek().kind !== 'eof') {
        values.push(parseLiteral());
        if (peek().text === ',') next();
      }
      if (next().text !== ')') throw new Error('Expected ")" after IN list');
      return { kind: 'in', path, values, negated: negatedIn };
    }
    if (negatedIn) throw new Error('Expected IN after NOT');
    if (matchKw('LIKE')) {
      return { kind: 'cmp', path, op: 'LIKE', value: parseLiteral() };
    }
    if (peek().kind === 'op') {
      const op = next().text as '=' | '!=' | '>' | '>=' | '<' | '<=';
      return { kind: 'cmp', path, op, value: parseLiteral() };
    }
    throw new Error(`Expected comparison operator after "${field}"`);
  };

  const parseAnd = (): WhereExpr => {
    let left = parsePrimary();
    while (matchKw('AND')) left = { kind: 'and', left, right: parsePrimary() };
    return left;
  };

  const parseOr = (): WhereExpr => {
    let left = parseAnd();
    while (matchKw('OR')) left = { kind: 'or', left, right: parseAnd() };
    return left;
  };

  let where: WhereExpr | null = null;
  if (matchKw('WHERE')) where = parseOr();

  // Optional GROUP BY
  const groupBy: { path: JsonPath; raw: string }[] = [];
  if (matchKw('GROUP')) {
    expectKw('BY');
    while (true) {
      if (peek().kind !== 'ident') throw new Error('Expected column name in GROUP BY');
      const raw = next().text;
      groupBy.push({ path: toPath(raw), raw });
      if (peek().text === ',') {
        next();
        continue;
      }
      break;
    }
  }

  // Optional ORDER BY
  const orderBy: OrderSpec[] = [];
  if (matchKw('ORDER')) {
    expectKw('BY');
    while (true) {
      const t = next();
      let target: string | number;
      if (t.kind === 'num') target = Math.max(1, Math.floor(Number(t.text)));
      else if (t.kind === 'ident') target = t.text;
      else throw new Error('Expected column name or position in ORDER BY');
      let dir: 1 | -1 = 1;
      if (matchKw('DESC')) dir = -1;
      else matchKw('ASC');
      orderBy.push({ target, dir });
      if (peek().text === ',') {
        next();
        continue;
      }
      break;
    }
  }

  // Optional LIMIT
  let limit: number | null = null;
  if (matchKw('LIMIT')) {
    const t = next();
    const n = Number(t.text);
    if (t.kind !== 'num' || !Number.isFinite(n) || n < 0) throw new Error('Expected non-negative integer after LIMIT');
    limit = Math.floor(n);
  }

  if (peek().text === ';') next();
  if (peek().kind !== 'eof') throw new Error(`Unexpected token "${peek().text}"`);

  return { select, where, groupBy, orderBy, limit, hasAggregate };
}

// ---------- Evaluator ----------

function asNum(v: JVal | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof RawNum) {
    const n = Number(v.src);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sqlEqual(a: JVal | undefined, b: JVal): boolean {
  if (a === undefined) return b === null;
  if (a === null || b === null) return a === b;
  if ((typeof a === 'number' || a instanceof RawNum) && (typeof b === 'number' || b instanceof RawNum)) {
    return compareNumbers(a, b) === 0;
  }
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b;
  return plainText(a) === plainText(b);
}

function sqlLike(val: JVal | undefined, pattern: JVal): boolean {
  if (val === undefined || val === null) return false;
  const s = plainText(val);
  const p = String(pattern ?? '');
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(s);
}

function evalWhere(expr: WhereExpr, rec: JVal): boolean {
  switch (expr.kind) {
    case 'and':
      return evalWhere(expr.left, rec) && evalWhere(expr.right, rec);
    case 'or':
      return evalWhere(expr.left, rec) || evalWhere(expr.right, rec);
    case 'not':
      return !evalWhere(expr.expr, rec);
    case 'null': {
      const v = getAt(rec, expr.path);
      const isNull = v === undefined || v === null;
      return expr.negated ? !isNull : isNull;
    }
    case 'in': {
      const v = getAt(rec, expr.path);
      const hit = expr.values.some((x) => sqlEqual(v, x));
      return expr.negated ? !hit : hit;
    }
    case 'cmp': {
      const v = getAt(rec, expr.path);
      if (expr.op === '=') return sqlEqual(v, expr.value);
      if (expr.op === '!=') return !sqlEqual(v, expr.value);
      if (expr.op === 'LIKE') return sqlLike(v, expr.value);
      if (v === undefined || v === null) return false;
      const na = asNum(v);
      const nb = asNum(expr.value);
      if (na !== null && nb !== null) {
        const cmp = compareNumbers(v as number | RawNum, expr.value as number | RawNum);
        return expr.op === '>' ? cmp > 0 : expr.op === '>=' ? cmp >= 0 : expr.op === '<' ? cmp < 0 : cmp <= 0;
      }
      const sa = plainText(v);
      const sb = plainText(expr.value);
      return expr.op === '>' ? sa > sb : expr.op === '>=' ? sa >= sb : expr.op === '<' ? sa < sb : sa <= sb;
    }
  }
}

function keyOfVal(v: JVal | undefined): string {
  if (v === undefined) return 'u:';
  if (v === null) return 'z:';
  if (isContainer(v)) return 'j:' + compactJson(v);
  return `${typeof v}:${plainText(v)}`;
}

interface AggBucket {
  groupVals: JVal[];
  countAll: number;
  aggs: {
    count: number;
    sum: number;
    min: number;
    max: number;
    distinct?: DistinctCounter;
  }[];
}

function compareCells(a: JVal | undefined, b: JVal | undefined): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if ((typeof a === 'number' || a instanceof RawNum) && (typeof b === 'number' || b instanceof RawNum)) {
    return compareNumbers(a, b);
  }
  return plainText(a).localeCompare(plainText(b));
}

export function executeSql(query: SqlQuery, records: Iterable<JVal>, maxRows = 250_000): SqlResult {
  const isGrouped = query.groupBy.length > 0 || query.hasAggregate;
  let totalMatched = 0;
  let rows: JObj[] = [];

  if (!isGrouped) {
    let seen = 0;
    for (const rec of records) {
      if (seen++ >= maxRows) break;
      if (query.where && !evalWhere(query.where, rec)) continue;
      totalMatched++;
      if (query.select.length === 1 && query.select[0].kind === 'star') {
        rows.push(isObj(rec) ? (rec as JObj) : { value: rec });
      } else {
        const out: JObj = {};
        for (const item of query.select) {
          if (item.kind === 'star') {
            if (isObj(rec)) Object.assign(out, rec);
            else out.value = rec;
          } else if (item.path) {
            const v = getAt(rec, item.path);
            out[item.alias] = v === undefined ? null : v;
          }
        }
        rows.push(out);
      }
      if (query.limit !== null && query.orderBy.length === 0 && rows.length >= query.limit) break;
    }
  } else {
    const aggItems = query.select.filter((s) => s.kind === 'agg');
    const buckets = new Map<string, AggBucket>();
    let seen = 0;
    for (const rec of records) {
      if (seen++ >= maxRows) break;
      if (query.where && !evalWhere(query.where, rec)) continue;
      totalMatched++;
      const gVals = query.groupBy.map((g) => {
        const v = getAt(rec, g.path);
        return v === undefined ? null : v;
      });
      const gKey = gVals.map(keyOfVal).join('\x00');
      let b = buckets.get(gKey);
      if (!b) {
        b = {
          groupVals: gVals,
          countAll: 0,
          aggs: aggItems.map((it) => ({
            count: 0,
            sum: 0,
            min: Infinity,
            max: -Infinity,
            distinct: it.distinct ? new DistinctCounter() : undefined,
          })),
        };
        buckets.set(gKey, b);
      }
      b.countAll++;
      for (let i = 0; i < aggItems.length; i++) {
        const it = aggItems[i];
        const st = b.aggs[i];
        const v = it.path ? getAt(rec, it.path) : rec;
        if (it.agg === 'COUNT') {
          if (it.rawPath === '*') {
            st.count++;
          } else if (v !== undefined && v !== null) {
            if (st.distinct) st.distinct.add(keyOfVal(v));
            else st.count++;
          }
        } else {
          const n = asNum(v);
          if (n !== null) {
            st.count++;
            st.sum += n;
            if (n < st.min) st.min = n;
            if (n > st.max) st.max = n;
          }
        }
      }
    }

    for (const b of buckets.values()) {
      const out: JObj = {};
      let ai = 0;
      for (const item of query.select) {
        if (item.kind === 'field') {
          const gi = query.groupBy.findIndex((g) => g.raw === item.rawPath);
          out[item.alias] = gi >= 0 ? b.groupVals[gi] : null;
        } else if (item.kind === 'agg') {
          const st = b.aggs[ai++];
          if (item.agg === 'COUNT') out[item.alias] = st.distinct ? st.distinct.estimate() : st.count;
          else if (item.agg === 'SUM') out[item.alias] = st.count ? Number(st.sum.toFixed(6)) : 0;
          else if (item.agg === 'AVG') out[item.alias] = st.count ? Number((st.sum / st.count).toFixed(4)) : null;
          else if (item.agg === 'MIN') out[item.alias] = st.count ? st.min : null;
          else if (item.agg === 'MAX') out[item.alias] = st.count ? st.max : null;
        }
      }
      rows.push(out);
    }
  }

  const columns =
    query.select.length === 1 && query.select[0].kind === 'star'
      ? rows.length
        ? Object.keys(rows[0])
        : []
      : query.select.map((s) => s.alias);

  if (query.orderBy.length > 0 && rows.length > 1) {
    rows.sort((a, b) => {
      for (const spec of query.orderBy) {
        const key = typeof spec.target === 'number' ? columns[spec.target - 1] ?? '' : spec.target;
        const av = a[key];
        const bv = b[key];
        const cmp = compareCells(av, bv);
        if (cmp !== 0) return cmp * spec.dir;
      }
      return 0;
    });
  }

  if (query.limit !== null && rows.length > query.limit) {
    rows = rows.slice(0, query.limit);
  }

  return { rows, totalMatched, columns };
}
