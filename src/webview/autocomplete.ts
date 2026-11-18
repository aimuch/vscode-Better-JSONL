// Schema-aware autocomplete for path queries, jq filters, JSONPath, and enum values.
import { t } from '../shared/i18n';
import type { JsonPath } from '../shared/protocol';
import { isContainer, isObj, pathToJq, pathToString, plainText, RawNum, type JObj, type JVal } from './json';
import { formatPathLabel } from './pivot';

export interface FieldInfo {
  path: JsonPath;
  label: string;
  jqPath: string;
  jsonPath: string;
  kind: 'string' | 'number' | 'boolean' | 'container' | 'mixed';
  enumValues: string[];
}

export interface CompletionItem {
  label: string;
  detail: string;
  insertText: string;
  replaceFrom: number;
  replaceTo: number;
}

const JQ_BUILTINS: readonly [string, string][] = [
  ['select(', 'Filter records matching condition'],
  ['map(', 'Transform each array element'],
  ['group_by(', 'Group array items by expression'],
  ['sort_by(', 'Sort array items by expression'],
  ['unique_by(', 'Deduplicate by expression'],
  ['min_by(', 'Minimum item by expression'],
  ['max_by(', 'Maximum item by expression'],
  ['with_entries(', 'Transform {key, value} entries'],
  ['to_entries', 'Object to [{key, value}]'],
  ['from_entries', '[{key, value}] to object'],
  ['del(', 'Delete path from object/array'],
  ['has(', 'Check if object has key'],
  ['contains(', 'Check value containment'],
  ['startswith(', 'String prefix match'],
  ['endswith(', 'String suffix match'],
  ['test(', 'Regex match on string'],
  ['split(', 'Split string by separator'],
  ['join(', 'Join array of strings'],
  ['tonumber', 'Parse string to number'],
  ['tostring', 'Format value as string'],
  ['fromjson', 'Parse JSON string'],
  ['tojson', 'Serialize value as JSON'],
  ['ascii_downcase', 'Lowercase ASCII characters'],
  ['ascii_upcase', 'Uppercase ASCII characters'],
  ['keys', 'Sorted object keys'],
  ['length', 'Length of string/array/object'],
  ['type', 'JSON value type name'],
  ['inputs', 'Stream all JSONL records'],
  ['add', 'Sum/concatenate array'],
];

/** Scans up to `maxSample` records to build field paths and observed scalar enum values. */
export function collectFieldCandidates(records: Iterable<JVal>, maxSample = 250): FieldInfo[] {
  const map = new Map<
    string,
    { path: JsonPath; kinds: Set<string>; enums: Set<string>; enumOverflow: boolean }
  >();
  let n = 0;
  const walk = (v: JVal, path: JsonPath, depth: number) => {
    if (depth > 4 || map.size > 300) return;
    if (path.length > 0) {
      const key = JSON.stringify(path);
      let entry = map.get(key);
      if (!entry) {
        entry = { path, kinds: new Set(), enums: new Set(), enumOverflow: false };
        map.set(key, entry);
      }
      const k = isContainer(v)
        ? 'container'
        : v === null
          ? 'null'
          : typeof v === 'boolean'
            ? 'boolean'
            : typeof v === 'number' || v instanceof RawNum
              ? 'number'
              : 'string';
      if (k !== 'null') entry.kinds.add(k);
      if (!entry.enumOverflow && (typeof v === 'string' || typeof v === 'boolean') && String(v).length <= 48 && !String(v).includes('\n')) {
        entry.enums.add(plainText(v));
        if (entry.enums.size > 16) entry.enumOverflow = true;
      }
    }
    if (Array.isArray(v)) {
      if (v.length > 0 && isObj(v[0])) walk(v[0], [...path, 0], depth + 1);
    } else if (isObj(v)) {
      for (const k of Object.keys(v as JObj)) walk((v as JObj)[k], [...path, k], depth + 1);
    }
  };
  for (const r of records) {
    walk(r, [], 0);
    if (++n >= maxSample) break;
  }
  return [...map.values()].map((e) => {
    const nonNull = [...e.kinds];
    const kind: FieldInfo['kind'] =
      nonNull.length === 1 ? (nonNull[0] as FieldInfo['kind']) : 'mixed';
    return {
      path: e.path,
      label: formatPathLabel(e.path),
      jqPath: pathToJq(e.path),
      jsonPath: pathToString(e.path),
      kind,
      enumValues: e.enumOverflow ? [] : [...e.enums],
    };
  });
}

export function getSearchCompletions(
  input: string,
  cursor: number,
  fields: readonly FieldInfo[],
  opts?: { literal?: boolean; regex?: boolean },
): CompletionItem[] {
  if (opts?.literal || opts?.regex) return [];
  const head = input.slice(0, cursor);
  if (!head.trim()) return [];

  // 1. jq comparison value completion: `.level == "wa` or `.level == wa`
  const jqValMatch = /(\.[A-Za-z0-9_.\[\]"]+)\s*(==|!=)\s*("?)([^"\s|)]*)$/.exec(head);
  if (jqValMatch) {
    const jqExpr = jqValMatch[1];
    const hasQuote = jqValMatch[3] === '"';
    const partial = jqValMatch[4].toLowerCase();
    const field = fields.find((f) => f.jqPath === jqExpr);
    if (field && field.enumValues.length) {
      const replaceFrom = cursor - jqValMatch[3].length - jqValMatch[4].length;
      return field.enumValues
        .filter((v) => v.toLowerCase().includes(partial) && (!hasQuote || v !== jqValMatch[4]))
        .slice(0, 12)
        .map((v) => {
          const lit = field.kind === 'boolean' ? v : JSON.stringify(v);
          return { label: lit, detail: field.label, insertText: lit, replaceFrom, replaceTo: cursor };
        });
    }
  }

  // 2. Simple path query value completion: `level=wa` or `user.name:ad`
  const pathValMatch = /^\s*([A-Za-z_$][^\s:=!<>]*)\s*(!=|==|=|:)\s*([^\s]*)$/.exec(head);
  if (pathValMatch) {
    const fName = pathValMatch[1];
    const partial = pathValMatch[3].toLowerCase();
    const field = fields.find((f) => f.label === fName || f.jsonPath === fName);
    if (field && field.enumValues.length) {
      const replaceFrom = cursor - pathValMatch[3].length;
      return field.enumValues
        .filter((v) => v.toLowerCase().includes(partial) && v !== pathValMatch[3])
        .slice(0, 12)
        .map((v) => ({ label: v, detail: field.label, insertText: v, replaceFrom, replaceTo: cursor }));
    }
  }

  // 3. JSONPath completion (`$...`)
  const jpMatch = /(\$[A-Za-z0-9_.\[\]]*)$/.exec(head);
  if (jpMatch) {
    const token = jpMatch[1];
    const low = token.toLowerCase();
    const replaceFrom = cursor - token.length;
    return fields
      .filter((f) => f.jsonPath.toLowerCase().startsWith(low) && f.jsonPath !== token)
      .slice(0, 14)
      .map((f) => ({
        label: f.jsonPath,
        detail: f.kind,
        insertText: f.jsonPath,
        replaceFrom,
        replaceTo: cursor,
      }));
  }

  // 4. jq path completion (`.foo` anywhere in a jq filter)
  const jqMatch = /(?:^|[\s(|,;\[])(\.[A-Za-z0-9_.\[\]]*)$/.exec(head);
  if (jqMatch) {
    const token = jqMatch[1];
    const low = token.toLowerCase();
    const replaceFrom = cursor - token.length;
    return fields
      .filter((f) => f.jqPath.toLowerCase().startsWith(low) && f.jqPath !== token)
      .slice(0, 14)
      .map((f) => ({
        label: f.jqPath,
        detail: f.kind,
        insertText: f.jqPath,
        replaceFrom,
        replaceTo: cursor,
      }));
  }

  // 5. Bare identifier token: field path queries (at start of input) + jq builtins
  const wordMatch = /(?:^|[\s(|,;])([A-Za-z_][A-Za-z0-9_.]*)$/.exec(head);
  if (wordMatch) {
    const token = wordMatch[1];
    const low = token.toLowerCase();
    const replaceFrom = cursor - token.length;
    const atStart = head.trim() === token;
    const out: CompletionItem[] = [];
    if (atStart) {
      for (const f of fields) {
        if (f.kind === 'container') continue;
        if (f.label.toLowerCase().startsWith(low) || f.label.toLowerCase().includes('.' + low)) {
          const op = f.kind === 'number' ? '>' : '=';
          const ins = f.label + op;
          if (ins !== token) {
            out.push({
              label: ins,
              detail: `${f.kind}${f.enumValues.length ? ` (${f.enumValues.slice(0, 3).join(', ')})` : ''}`,
              insertText: ins,
              replaceFrom,
              replaceTo: cursor,
            });
          }
          if (out.length >= 8) break;
        }
      }
    }
    for (const [fn, desc] of JQ_BUILTINS) {
      if (fn.toLowerCase().startsWith(low) && fn !== token) {
        out.push({ label: fn, detail: t(desc), insertText: fn, replaceFrom, replaceTo: cursor });
        if (out.length >= 14) break;
      }
    }
    return out;
  }

  return [];
}
