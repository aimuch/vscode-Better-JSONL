// Schema and type inference from JSON / JSON Lines records:
// emits TypeScript interfaces, JSON Schema (2020-12), Python Pydantic models, and Zod schemas.
import { isObj, RawNum, type JObj, type JVal } from './json';

export type PrimKind = 'null' | 'boolean' | 'integer' | 'bigint' | 'number' | 'string';

export interface SchemaNode {
  prims: Set<PrimKind>;
  arrayItem?: SchemaNode;
  objectFields?: Map<string, { node: SchemaNode; count: number }>;
  objectCount: number;
}

function emptySchema(): SchemaNode {
  return { prims: new Set(), objectCount: 0 };
}

function addValue(s: SchemaNode, v: JVal, depth = 0): void {
  if (depth > 40) return;
  if (v === null) {
    s.prims.add('null');
    return;
  }
  if (typeof v === 'boolean') {
    s.prims.add('boolean');
    return;
  }
  if (v instanceof RawNum) {
    s.prims.add(/^-?\d+$/.test(v.src) ? 'bigint' : 'number');
    return;
  }
  if (typeof v === 'number') {
    s.prims.add(Number.isInteger(v) ? 'integer' : 'number');
    return;
  }
  if (typeof v === 'string') {
    s.prims.add('string');
    return;
  }
  if (Array.isArray(v)) {
    s.arrayItem ??= emptySchema();
    for (let i = 0; i < Math.min(v.length, 200); i++) addValue(s.arrayItem, v[i], depth + 1);
    return;
  }
  if (isObj(v)) {
    s.objectCount++;
    s.objectFields ??= new Map();
    for (const k of Object.keys(v as JObj)) {
      let entry = s.objectFields.get(k);
      if (!entry) {
        entry = { node: emptySchema(), count: 0 };
        s.objectFields.set(k, entry);
      }
      entry.count++;
      addValue(entry.node, (v as JObj)[k], depth + 1);
    }
  }
}

function normalizePrims(prims: Set<PrimKind>): PrimKind[] {
  const out = new Set(prims);
  if (out.has('number') && out.has('integer')) out.delete('integer');
  return [...out];
}

export function inferSchema(records: Iterable<JVal>, maxRecords = 25_000): { schema: SchemaNode; sampled: number } {
  const root = emptySchema();
  let sampled = 0;
  for (const r of records) {
    if (sampled >= maxRecords) break;
    addValue(root, r, 0);
    sampled++;
  }
  return { schema: root, sampled };
}

function pascalCase(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  if (!cleaned) return 'Item';
  const s = cleaned
    .split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');
  return /^[0-9]/.test(s) ? `T${s}` : s;
}

// ---------- 1. TypeScript ----------

export function emitTypeScript(root: SchemaNode, rootName = 'RecordItem'): string {
  const defs: string[] = [];
  const usedNames = new Set<string>([rootName]);

  const uniqueName = (hint: string): string => {
    let base = pascalCase(hint);
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let n = 2;
    while (usedNames.has(`${base}${n}`)) n++;
    const name = `${base}${n}`;
    usedNames.add(name);
    return name;
  };

  const tsExpr = (node: SchemaNode, hint: string, isRoot = false): string => {
    const parts: string[] = [];
    const prims = normalizePrims(node.prims);
    const hasNum = prims.includes('number') || prims.includes('integer') || prims.includes('bigint');
    if (prims.includes('string')) parts.push('string');
    if (hasNum) parts.push(prims.includes('bigint') && !prims.includes('number') && !prims.includes('integer') ? 'number /* >53-bit integer */' : 'number');
    if (prims.includes('boolean')) parts.push('boolean');
    if (node.arrayItem) {
      const inner = tsExpr(node.arrayItem, `${hint}Item`);
      parts.push(inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`);
    }
    if (node.objectCount > 0) {
      const fields = node.objectFields;
      if (!fields || fields.size === 0) {
        parts.push('Record<string, unknown>');
      } else {
        const ifaceName = isRoot ? rootName : uniqueName(hint);
        const lines: string[] = [];
        for (const [k, f] of fields) {
          const opt = f.count < node.objectCount ? '?' : '';
          const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
          lines.push(`  ${key}${opt}: ${tsExpr(f.node, k)};`);
        }
        defs.push(`export interface ${ifaceName} {\n${lines.join('\n')}\n}`);
        parts.push(ifaceName);
      }
    }
    if (prims.includes('null')) parts.push('null');
    return parts.length ? parts.join(' | ') : 'unknown';
  };

  const top = tsExpr(root, rootName, true);
  if (top !== rootName) defs.push(`export type ${rootName} = ${top};`);
  return defs.join('\n\n') + '\n';
}

// ---------- 2. JSON Schema (2020-12) ----------

export function emitJsonSchema(root: SchemaNode, title = 'RecordItem'): string {
  const toSchema = (node: SchemaNode): Record<string, unknown> => {
    const variants: Record<string, unknown>[] = [];
    const prims = normalizePrims(node.prims);
    if (prims.includes('string')) variants.push({ type: 'string' });
    if (prims.includes('integer') || (prims.includes('bigint') && !prims.includes('number'))) variants.push({ type: 'integer' });
    else if (prims.includes('number')) variants.push({ type: 'number' });
    if (prims.includes('boolean')) variants.push({ type: 'boolean' });
    if (node.arrayItem) variants.push({ type: 'array', items: toSchema(node.arrayItem) });
    if (node.objectCount > 0) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [k, f] of node.objectFields ?? []) {
        properties[k] = toSchema(f.node);
        if (f.count === node.objectCount) required.push(k);
      }
      const obj: Record<string, unknown> = { type: 'object', properties };
      if (required.length) obj.required = required;
      variants.push(obj);
    }
    if (prims.includes('null')) variants.push({ type: 'null' });
    if (variants.length === 0) return {};
    if (variants.length === 1) return variants[0];
    if (variants.every((v) => Object.keys(v).length === 1 && typeof v.type === 'string')) {
      return { type: variants.map((v) => v.type) };
    }
    return { anyOf: variants };
  };

  return (
    JSON.stringify(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title,
        ...toSchema(root),
      },
      null,
      2,
    ) + '\n'
  );
}

// ---------- 3. Python Pydantic (v2) ----------

const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import',
  'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

export function emitPydantic(root: SchemaNode, rootName = 'RecordItem'): string {
  const models: string[] = [];
  const usedNames = new Set<string>([rootName]);
  let needsField = false;
  let needsAny = false;

  const uniqueName = (hint: string): string => {
    const base = pascalCase(hint);
    if (!usedNames.has(base)) {
      usedNames.add(base);
      return base;
    }
    let n = 2;
    while (usedNames.has(`${base}${n}`)) n++;
    const name = `${base}${n}`;
    usedNames.add(name);
    return name;
  };

  const pyType = (node: SchemaNode, hint: string, isRoot = false): string => {
    const parts: string[] = [];
    const prims = normalizePrims(node.prims);
    if (prims.includes('string')) parts.push('str');
    if (prims.includes('number')) parts.push('float');
    else if (prims.includes('integer') || prims.includes('bigint')) parts.push('int');
    if (prims.includes('boolean')) parts.push('bool');
    if (node.arrayItem) parts.push(`list[${pyType(node.arrayItem, `${hint}Item`)}]`);
    if (node.objectCount > 0) {
      const fields = node.objectFields;
      if (!fields || fields.size === 0) {
        needsAny = true;
        parts.push('dict[str, Any]');
      } else {
        const clsName = isRoot ? rootName : uniqueName(hint);
        const lines: string[] = [];
        const usedAttrs = new Set<string>();
        for (const [k, f] of fields) {
          const optional = f.count < node.objectCount;
          let tExpr = pyType(f.node, k);
          if (optional && !tExpr.endsWith(' | None')) tExpr += ' | None';
          const validIdent = /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !PY_KEYWORDS.has(k) && !k.startsWith('model_');
          let attr = validIdent ? k : k.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, 'f_$1') || 'field';
          if (PY_KEYWORDS.has(attr) || attr.startsWith('model_')) attr = `${attr}_`;
          while (usedAttrs.has(attr)) attr += '_';
          usedAttrs.add(attr);
          if (attr !== k) {
            needsField = true;
            lines.push(`    ${attr}: ${tExpr} = Field(${optional ? 'default=None, ' : ''}alias=${JSON.stringify(k)})`);
          } else {
            lines.push(`    ${attr}: ${tExpr}${optional ? ' = None' : ''}`);
          }
        }
        models.push(`class ${clsName}(BaseModel):\n${lines.length ? lines.join('\n') : '    pass'}`);
        parts.push(clsName);
      }
    }
    if (prims.includes('null') && !parts.includes('None')) parts.push('None');
    if (!parts.length) {
      needsAny = true;
      return 'Any';
    }
    return parts.join(' | ');
  };

  const top = pyType(root, rootName, true);
  const imports: string[] = ['from __future__ import annotations'];
  if (needsAny) imports.push('from typing import Any');
  imports.push(needsField ? 'from pydantic import BaseModel, Field' : 'from pydantic import BaseModel');
  if (top !== rootName) models.push(`${rootName} = ${top}`);
  return imports.join('\n') + '\n\n\n' + models.join('\n\n\n') + '\n';
}

// ---------- 4. Zod ----------

export function emitZod(root: SchemaNode, rootName = 'RecordItemSchema'): string {
  const zodExpr = (node: SchemaNode, indent = 0): string => {
    const pad = '  '.repeat(indent);
    const parts: string[] = [];
    const prims = normalizePrims(node.prims);
    const hasNull = prims.includes('null');
    if (prims.includes('string')) parts.push('z.string()');
    if (prims.includes('integer') && !prims.includes('number') && !prims.includes('bigint')) parts.push('z.number().int()');
    else if (prims.includes('number') || prims.includes('bigint')) parts.push('z.number()');
    if (prims.includes('boolean')) parts.push('z.boolean()');
    if (node.arrayItem) parts.push(`z.array(${zodExpr(node.arrayItem, indent)})`);
    if (node.objectCount > 0) {
      const fields = node.objectFields;
      if (!fields || fields.size === 0) {
        parts.push('z.record(z.string(), z.unknown())');
      } else {
        const innerPad = '  '.repeat(indent + 1);
        const rows: string[] = [];
        for (const [k, f] of fields) {
          const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
          let expr = zodExpr(f.node, indent + 1);
          if (f.count < node.objectCount) expr += '.optional()';
          rows.push(`${innerPad}${key}: ${expr},`);
        }
        parts.push(`z.object({\n${rows.join('\n')}\n${pad}})`);
      }
    }
    if (!parts.length) return hasNull ? 'z.null()' : 'z.unknown()';
    let combined = parts.length === 1 ? parts[0] : `z.union([${parts.join(', ')}])`;
    if (hasNull) combined += '.nullable()';
    return combined;
  };

  const baseName = rootName.endsWith('Schema') ? rootName.slice(0, -6) || 'RecordItem' : rootName;
  const schemaVar = rootName.endsWith('Schema') ? rootName : `${rootName}Schema`;
  return `import { z } from 'zod';\n\nexport const ${schemaVar} = ${zodExpr(root, 0)};\n\nexport type ${baseName} = z.infer<typeof ${schemaVar}>;\n`;
}

// ---------- 5. Go struct ----------

export function emitGoStruct(root: SchemaNode, rootName = 'RecordItem'): string {
  const defs: string[] = [];
  const used = new Set<string>([rootName]);
  const uniq = (hint: string) => {
    const base = pascalCase(hint);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  };

  const goType = (node: SchemaNode, hint: string, isRoot = false): string => {
    const prims = normalizePrims(node.prims);
    const nonNull = prims.filter((p) => p !== 'null');
    const nullable = prims.includes('null');
    if (node.objectCount > 0 && node.objectFields?.size) {
      const name = isRoot ? rootName : uniq(hint);
      const rows: string[] = [];
      for (const [k, f] of node.objectFields) {
        const fieldName = pascalCase(k);
        const optional = f.count < node.objectCount;
        let t = goType(f.node, `${name}${fieldName}`);
        if (optional && !t.startsWith('*') && !t.startsWith('[]') && t !== 'any') t = `*${t}`;
        rows.push(`\t${fieldName} ${t} \`json:"${k}${optional ? ',omitempty' : ''}"\``);
      }
      defs.push(`type ${name} struct {\n${rows.join('\n')}\n}`);
      return nullable ? `*${name}` : name;
    }
    if (node.arrayItem) return `[]${goType(node.arrayItem, `${hint}Item`)}`;
    if (nonNull.length === 1) {
      const p = nonNull[0];
      const base = p === 'string' ? 'string' : p === 'boolean' ? 'bool' : p === 'integer' || p === 'bigint' ? 'int64' : 'float64';
      return nullable ? `*${base}` : base;
    }
    return 'any';
  };

  const top = goType(root, rootName, true);
  if (top !== rootName) defs.push(`type ${rootName} = ${top}`);
  return `package main\n\n${defs.join('\n\n')}\n`;
}

// ---------- 6. Rust serde ----------

function rustIdent(k: string): string {
  const s = k.replace(/[^A-Za-z0-9_]+/g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/^_+|_+$/g, '') || 'field';
  const reserved = new Set(['type', 'match', 'ref', 'mod', 'fn', 'let', 'mut', 'pub', 'use', 'struct', 'enum', 'impl', 'in', 'as', 'loop', 'move', 'self']);
  return /^[0-9]/.test(s) ? `f_${s}` : reserved.has(s) ? `r#${s}` : s;
}

export function emitRustSerde(root: SchemaNode, rootName = 'RecordItem'): string {
  const defs: string[] = [];
  const used = new Set<string>([rootName]);
  const uniq = (hint: string) => {
    const base = pascalCase(hint);
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}${n}`)) n++;
    used.add(`${base}${n}`);
    return `${base}${n}`;
  };

  const rsType = (node: SchemaNode, hint: string, isRoot = false): string => {
    const prims = normalizePrims(node.prims);
    const nonNull = prims.filter((p) => p !== 'null');
    const nullable = prims.includes('null');
    const wrap = (t: string) => (nullable ? `Option<${t}>` : t);
    if (node.objectCount > 0 && node.objectFields?.size) {
      const name = isRoot ? rootName : uniq(hint);
      const rows: string[] = [];
      for (const [k, f] of node.objectFields) {
        const attr = rustIdent(k);
        const optional = f.count < node.objectCount;
        let t = rsType(f.node, `${name}${pascalCase(k)}`);
        if (optional && !t.startsWith('Option<')) t = `Option<${t}>`;
        if (attr.replace(/^r#/, '') !== k) rows.push(`    #[serde(rename = ${JSON.stringify(k)})]`);
        rows.push(`    pub ${attr}: ${t},`);
      }
      defs.push(`#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct ${name} {\n${rows.join('\n')}\n}`);
      return wrap(name);
    }
    if (node.arrayItem) return wrap(`Vec<${rsType(node.arrayItem, `${hint}Item`)}>`);
    if (nonNull.length === 1) {
      const p = nonNull[0];
      return wrap(p === 'string' ? 'String' : p === 'boolean' ? 'bool' : p === 'integer' || p === 'bigint' ? 'i64' : 'f64');
    }
    return 'serde_json::Value';
  };

  const top = rsType(root, rootName, true);
  if (top !== rootName) defs.push(`pub type ${rootName} = ${top};`);
  return `use serde::{Deserialize, Serialize};\n\n${defs.join('\n\n')}\n`;
}

// ---------- 7. DuckDB SQL & Python Polars snippets ----------

export function emitDuckDbSnippet(root: SchemaNode, fileName = 'data.jsonl'): string {
  const cols = root.objectFields ? [...root.objectFields.keys()].slice(0, 8) : [];
  const selectCols = cols.length ? cols.map((c) => `  "${c.replace(/"/g, '""')}"`).join(',\n') : '  *';
  const groupCol = cols.find((c) => {
    const f = root.objectFields?.get(c);
    return f && f.node.prims.has('string');
  });
  const numCol = cols.find((c) => {
    const f = root.objectFields?.get(c);
    return f && (f.node.prims.has('number') || f.node.prims.has('integer'));
  });
  const agg = groupCol
    ? `\n-- Group-by summary\nSELECT\n  "${groupCol}",\n  COUNT(*) AS rows${numCol ? `,\n  ROUND(AVG("${numCol}"), 2) AS avg_${numCol.replace(/[^A-Za-z0-9_]/g, '_')},\n  QUANTILE_CONT("${numCol}", 0.95) AS p95_${numCol.replace(/[^A-Za-z0-9_]/g, '_')}` : ''}\nFROM read_json_auto(${JSON.stringify(fileName)})\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT 25;\n`
    : '';
  return `-- DuckDB query for ${fileName}\nSELECT\n${selectCols}\nFROM read_json_auto(${JSON.stringify(fileName)})\nLIMIT 100;\n${agg}`;
}

export function emitPolarsSnippet(root: SchemaNode, fileName = 'data.jsonl'): string {
  const cols = root.objectFields ? [...root.objectFields.keys()].slice(0, 8) : [];
  const groupCol = cols.find((c) => root.objectFields?.get(c)?.node.prims.has('string'));
  const numCol = cols.find((c) => {
    const p = root.objectFields?.get(c)?.node.prims;
    return p && (p.has('number') || p.has('integer'));
  });
  const summary = groupCol
    ? `\nsummary = (\n    df.group_by(${JSON.stringify(groupCol)})\n    .agg([\n        pl.len().alias("count"),${numCol ? `\n        pl.col(${JSON.stringify(numCol)}).mean().alias("avg"),\n        pl.col(${JSON.stringify(numCol)}).quantile(0.95).alias("p95"),` : ''}\n    ])\n    .sort("count", descending=True)\n)\nprint(summary.collect())\n`
    : `\nprint(df.head(20).collect())\n`;
  return `import polars as pl\n\ndf = pl.scan_ndjson(${JSON.stringify(fileName)})\n${summary}`;
}
