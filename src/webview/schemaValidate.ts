// Zero-dependency JSON Schema (Draft 2020-12 / Draft-07 subset) validator for JSON / JSONL datasets.
import { isArr, isObj, plainText, RawNum, type JObj, type JVal } from './json';
import { compactJson } from './query';

export interface SchemaViolation {
  line: number;
  path: string;
  rule: string;
  message: string;
}

export interface SchemaValidationReport {
  checked: number;
  validLines: number;
  invalidLines: number[];
  violations: SchemaViolation[];
  ruleCounts: { rule: string; count: number }[];
}

type JsonSchemaObj = Record<string, unknown>;

const patternCache = new Map<string, RegExp | null>();
function cachedRegex(pat: string): RegExp | null {
  if (pat.length > 512) return null;
  let re = patternCache.get(pat);
  if (re === undefined) {
    if (patternCache.size > 256) patternCache.clear();
    try {
      re = new RegExp(pat);
    } catch {
      re = null;
    }
    patternCache.set(pat, re);
  }
  return re;
}

const FORMAT_CHECKS: Record<string, RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/i,
  uri: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i,
};

function numOf(v: JVal): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof RawNum) {
    const n = Number(v.src);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isIntVal(v: JVal): boolean {
  if (typeof v === 'number') return Number.isInteger(v);
  if (v instanceof RawNum) return /^-?\d+$/.test(v.src);
  return false;
}

function matchesType(v: JVal, expected: string): boolean {
  switch (expected) {
    case 'null':
      return v === null;
    case 'boolean':
      return typeof v === 'boolean';
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' || v instanceof RawNum;
    case 'integer':
      return isIntVal(v);
    case 'array':
      return isArr(v);
    case 'object':
      return isObj(v);
    default:
      return true;
  }
}

function validateNode(
  val: JVal,
  schema: unknown,
  path: string,
  line: number,
  out: SchemaViolation[],
  maxPerLine: number,
  depth = 0,
): void {
  if (out.length >= maxPerLine || depth > 32) return;
  if (schema === true) return;
  if (schema === false) {
    out.push({ line, path, rule: 'false', message: 'Value disallowed by schema' });
    return;
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const s = schema as JsonSchemaObj;

  // type
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [String(s.type)];
    if (!types.some((t) => matchesType(val, t))) {
      out.push({ line, path, rule: 'type', message: `Expected ${types.join(' | ')}, got ${val === null ? 'null' : isArr(val) ? 'array' : typeof val}` });
      return;
    }
  }

  // const
  if ('const' in s) {
    if (compactJson(val) !== JSON.stringify(s.const)) {
      out.push({ line, path, rule: 'const', message: `Expected constant ${JSON.stringify(s.const)}` });
    }
  }

  // enum
  if (Array.isArray(s.enum)) {
    const valCanon = compactJson(val);
    if (!s.enum.some((e) => JSON.stringify(e) === valCanon)) {
      out.push({ line, path, rule: 'enum', message: `Value ${plainText(val)} not in enum [${s.enum.slice(0, 6).map((x) => JSON.stringify(x)).join(', ')}]` });
    }
  }

  // numeric constraints
  const n = numOf(val);
  if (n !== null) {
    if (typeof s.minimum === 'number' && n < s.minimum) {
      out.push({ line, path, rule: 'minimum', message: `${n} < minimum ${s.minimum}` });
    }
    if (typeof s.maximum === 'number' && n > s.maximum) {
      out.push({ line, path, rule: 'maximum', message: `${n} > maximum ${s.maximum}` });
    }
    if (typeof s.exclusiveMinimum === 'number' && n <= s.exclusiveMinimum) {
      out.push({ line, path, rule: 'exclusiveMinimum', message: `${n} <= exclusiveMinimum ${s.exclusiveMinimum}` });
    }
    if (typeof s.exclusiveMaximum === 'number' && n >= s.exclusiveMaximum) {
      out.push({ line, path, rule: 'exclusiveMaximum', message: `${n} >= exclusiveMaximum ${s.exclusiveMaximum}` });
    }
  }

  // string constraints
  if (typeof val === 'string') {
    if (typeof s.minLength === 'number' && val.length < s.minLength) {
      out.push({ line, path, rule: 'minLength', message: `Length ${val.length} < minLength ${s.minLength}` });
    }
    if (typeof s.maxLength === 'number' && val.length > s.maxLength) {
      out.push({ line, path, rule: 'maxLength', message: `Length ${val.length} > maxLength ${s.maxLength}` });
    }
    if (typeof s.pattern === 'string') {
      const re = cachedRegex(s.pattern);
      if (re && !re.test(val)) {
        out.push({ line, path, rule: 'pattern', message: `Does not match /${s.pattern}/` });
      }
    }
    if (typeof s.format === 'string' && s.format in FORMAT_CHECKS) {
      if (!FORMAT_CHECKS[s.format].test(val)) {
        out.push({ line, path, rule: 'format', message: `Invalid ${s.format} format` });
      }
    }
  }

  // array constraints
  if (isArr(val)) {
    if (typeof s.minItems === 'number' && val.length < s.minItems) {
      out.push({ line, path, rule: 'minItems', message: `Items ${val.length} < minItems ${s.minItems}` });
    }
    if (typeof s.maxItems === 'number' && val.length > s.maxItems) {
      out.push({ line, path, rule: 'maxItems', message: `Items ${val.length} > maxItems ${s.maxItems}` });
    }
    if (s.items !== undefined) {
      for (let i = 0; i < val.length && out.length < maxPerLine; i++) {
        validateNode(val[i], s.items, `${path}[${i}]`, line, out, maxPerLine, depth + 1);
      }
    }
  }

  // object constraints
  if (isObj(val)) {
    const obj = val as JObj;
    if (Array.isArray(s.required)) {
      for (const req of s.required) {
        const key = String(req);
        if (!(key in obj)) {
          out.push({ line, path: `${path}.${key}`, rule: 'required', message: `Missing required property "${key}"` });
        }
      }
    }
    const props = s.properties && typeof s.properties === 'object' ? (s.properties as Record<string, unknown>) : undefined;
    if (props) {
      for (const key of Object.keys(props)) {
        if (key in obj && out.length < maxPerLine) {
          validateNode(obj[key], props[key], `${path}.${key}`, line, out, maxPerLine, depth + 1);
        }
      }
    }
    if (s.additionalProperties === false && props) {
      for (const key of Object.keys(obj)) {
        if (!(key in props) && out.length < maxPerLine) {
          out.push({ line, path: `${path}.${key}`, rule: 'additionalProperties', message: `Unexpected property "${key}"` });
        }
      }
    }
  }

  // combinators: allOf / anyOf / oneOf
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      if (out.length < maxPerLine) validateNode(val, sub, path, line, out, maxPerLine, depth + 1);
    }
  }
  if (Array.isArray(s.anyOf) && s.anyOf.length > 0) {
    const passed = s.anyOf.some((sub) => {
      const tmp: SchemaViolation[] = [];
      validateNode(val, sub, path, line, tmp, 1, depth + 1);
      return tmp.length === 0;
    });
    if (!passed) out.push({ line, path, rule: 'anyOf', message: 'Did not satisfy any branch of anyOf' });
  }
  if (Array.isArray(s.oneOf) && s.oneOf.length > 0) {
    let matches = 0;
    for (const sub of s.oneOf) {
      const tmp: SchemaViolation[] = [];
      validateNode(val, sub, path, line, tmp, 1, depth + 1);
      if (tmp.length === 0) matches++;
    }
    if (matches !== 1) out.push({ line, path, rule: 'oneOf', message: `Matched ${matches} branches of oneOf (expected 1)` });
  }
}

export function validateSingleRecord(line: number, value: JVal, schema: unknown, maxPerLine = 8): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  validateNode(value, schema, '$', line, out, maxPerLine);
  return out;
}

export function validateRecordsAgainstSchema(
  records: Iterable<{ line: number; value: JVal }>,
  schema: unknown,
  maxViolations = 500,
): SchemaValidationReport {
  let checked = 0;
  let validLines = 0;
  const invalidLines: number[] = [];
  const violations: SchemaViolation[] = [];
  const ruleMap = new Map<string, number>();

  for (const { line, value } of records) {
    checked++;
    const lineViolations: SchemaViolation[] = [];
    validateNode(value, schema, '$', line, lineViolations, 8);
    if (lineViolations.length === 0) {
      validLines++;
    } else {
      invalidLines.push(line);
      for (const v of lineViolations) {
        ruleMap.set(v.rule, (ruleMap.get(v.rule) ?? 0) + 1);
        if (violations.length < maxViolations) violations.push(v);
      }
    }
  }

  const ruleCounts = [...ruleMap.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count);

  return { checked, validLines, invalidLines, violations, ruleCounts };
}
