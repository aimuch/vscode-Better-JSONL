// Cross-file JSON / JSONL dataset comparison aligned by primary key or by line index.
import { splitJsonValues, stripBom } from '../shared/jsonText';
import { diffValues, type Difference } from './diff';
import { isArr, isContainer, isObj, parseJson, plainText, RawNum, type JObj, type JVal } from './json';
import { compactJson } from './query';

export interface DatasetDiffEntry {
  kind: 'added' | 'removed' | 'modified';
  keyLabel: string;
  leftIndex?: number;
  rightIndex?: number;
  left?: JVal;
  right?: JVal;
  changes?: Difference[];
}

export interface MetricDelta {
  field: string;
  leftAvg: number;
  rightAvg: number;
  delta: number;
}

export interface DatasetDiffResult {
  mode: 'key' | 'line';
  keyField: string | null;
  keyCandidates: string[];
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  entries: DatasetDiffEntry[];
  metrics: MetricDelta[];
}

const KEY_CANDIDATES = ['id', '_id', 'uuid', 'sample_id', 'event_id', 'key', 'slug', 'name'];

/** Parses a JSONL file, JSON root array, concatenated JSON stream, or single JSON value into record items. */
export function parseDatasetRecords(rawText: string): JVal[] {
  const clean = stripBom(rawText);
  const trimmed = clean.trim();
  if (!trimmed) return [];

  // 1. Try standard line-by-line JSONL first if >= 2 lines parse or single line object
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length >= 2) {
    const lineVals: JVal[] = [];
    let allOk = true;
    for (const l of lines) {
      try {
        lineVals.push(parseJson(l));
      } catch {
        allOk = false;
        break;
      }
    }
    if (allOk) return lineVals;
  }

  // 2. Try single JSON root (if array, return its elements; otherwise [root])
  try {
    const one = parseJson(trimmed);
    return isArr(one) ? one : [one];
  } catch {
    // Fall through to concatenated stream or best-effort JSONL lines
  }

  // 3. Try concatenated multi-line JSON stream
  const spans = splitJsonValues(clean);
  if (spans.length >= 2) {
    const vals: JVal[] = [];
    let ok = true;
    for (const sp of spans) {
      try {
        vals.push(parseJson(clean.slice(sp.start, sp.end)));
      } catch {
        ok = false;
        break;
      }
    }
    if (ok) return vals;
  }

  // 4. Best-effort JSONL skipping malformed lines
  const out: JVal[] = [];
  for (const l of lines) {
    try {
      out.push(parseJson(l));
    } catch {
      // skip invalid line
    }
  }
  return out;
}

function detectKeyCandidates(left: JVal[], right: JVal[]): string[] {
  const sample = [...left.slice(0, 200), ...right.slice(0, 200)].filter(isObj) as JObj[];
  if (!sample.length) return [];
  const counts = new Map<string, number>();
  for (const r of sample) {
    for (const k of Object.keys(r)) {
      const v = r[k];
      if (v !== null && v !== undefined && !isContainer(v)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const viable = [...counts.entries()]
    .filter(([, c]) => c >= sample.length * 0.6)
    .map(([k]) => k);
  return [
    ...KEY_CANDIDATES.filter((k) => viable.includes(k)),
    ...viable.filter((k) => !KEY_CANDIDATES.includes(k)),
  ];
}

function autoPickUniqueKey(left: JVal[], right: JVal[], candidates: string[]): string | null {
  if (!left.length || !right.length) return candidates[0] ?? null;
  for (const k of candidates) {
    if (!KEY_CANDIDATES.includes(k)) continue;
    const checkSide = (arr: JVal[]) => {
      const seen = new Set<string>();
      let has = 0;
      const limit = Math.min(arr.length, 500);
      for (let i = 0; i < limit; i++) {
        const r = arr[i];
        if (!isObj(r)) return false;
        const v = (r as JObj)[k];
        if (v === undefined || v === null || isContainer(v)) continue;
        const s = `${typeof v}:${plainText(v)}`;
        if (seen.has(s)) return false;
        seen.add(s);
        has++;
      }
      return has >= limit * 0.8;
    };
    if (checkSide(left) && checkSide(right)) return k;
  }
  return null;
}

function computeMetrics(left: JVal[], right: JVal[]): MetricDelta[] {
  const sumSide = (arr: JVal[]) => {
    const map = new Map<string, { sum: number; n: number }>();
    const lim = Math.min(arr.length, 20_000);
    for (let i = 0; i < lim; i++) {
      const r = arr[i];
      if (!isObj(r)) continue;
      for (const k of Object.keys(r as JObj)) {
        const v = (r as JObj)[k];
        const num = typeof v === 'number' ? v : v instanceof RawNum ? Number(v.src) : NaN;
        if (!Number.isFinite(num)) continue;
        let e = map.get(k);
        if (!e && map.size < 40) {
          e = { sum: 0, n: 0 };
          map.set(k, e);
        }
        if (e) {
          e.sum += num;
          e.n++;
        }
      }
    }
    return map;
  };
  const lm = sumSide(left);
  const rm = sumSide(right);
  const out: MetricDelta[] = [];
  for (const [k, le] of lm) {
    if (KEY_CANDIDATES.includes(k)) continue;
    const re = rm.get(k);
    if (!re || le.n < 2 || re.n < 2) continue;
    const la = le.sum / le.n;
    const ra = re.sum / re.n;
    if (Math.abs(ra - la) > 1e-9) out.push({ field: k, leftAvg: la, rightAvg: ra, delta: ra - la });
  }
  return out.slice(0, 6);
}

/**
 * Compares two record lists (`left` vs `right`).
 * - `keyField === undefined`: auto-detects primary key (`id`, `uuid`, ...), falling back to line alignment.
 * - `keyField === null`: forces line-by-line alignment.
 * - `typeof keyField === 'string'`: aligns by `record[keyField]`.
 */
export function diffDatasets(left: JVal[], right: JVal[], keyField?: string | null, maxEntries = 2000): DatasetDiffResult {
  const keyCandidates = detectKeyCandidates(left, right);
  const resolvedKey = keyField === undefined ? autoPickUniqueKey(left, right, keyCandidates) : keyField;
  const entries: DatasetDiffEntry[] = [];
  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  if (resolvedKey) {
    const keyOfRec = (r: JVal, idx: number): string => {
      if (isObj(r) && Object.prototype.hasOwnProperty.call(r, resolvedKey)) {
        const v = (r as JObj)[resolvedKey];
        if (v !== undefined && v !== null && !isContainer(v)) return `${typeof v}:${plainText(v)}`;
      }
      return `#idx:${idx}`;
    };
    const labelOfRec = (r: JVal, idx: number): string => {
      if (isObj(r) && Object.prototype.hasOwnProperty.call(r, resolvedKey)) {
        const v = (r as JObj)[resolvedKey];
        if (v !== undefined && v !== null && !isContainer(v)) return `${resolvedKey}=${plainText(v)}`;
      }
      return `#${idx + 1}`;
    };
    const rightMap = new Map<string, { idx: number; val: JVal }>();
    right.forEach((r, idx) => {
      const k = keyOfRec(r, idx);
      if (!rightMap.has(k)) rightMap.set(k, { idx, val: r });
    });
    const matchedRight = new Set<string>();

    left.forEach((lVal, lIdx) => {
      const k = keyOfRec(lVal, lIdx);
      const rHit = rightMap.get(k);
      if (!rHit) {
        removed++;
        if (entries.length < maxEntries) {
          entries.push({ kind: 'removed', keyLabel: labelOfRec(lVal, lIdx), leftIndex: lIdx, left: lVal });
        }
      } else {
        matchedRight.add(k);
        if (compactJson(lVal) === compactJson(rHit.val)) {
          unchanged++;
        } else {
          modified++;
          if (entries.length < maxEntries) {
            entries.push({
              kind: 'modified',
              keyLabel: labelOfRec(lVal, lIdx),
              leftIndex: lIdx,
              rightIndex: rHit.idx,
              left: lVal,
              right: rHit.val,
              changes: diffValues(lVal, rHit.val, 50).rows,
            });
          }
        }
      }
    });

    right.forEach((rVal, rIdx) => {
      const k = keyOfRec(rVal, rIdx);
      if (!matchedRight.has(k)) {
        added++;
        if (entries.length < maxEntries) {
          entries.push({ kind: 'added', keyLabel: labelOfRec(rVal, rIdx), rightIndex: rIdx, right: rVal });
        }
      }
    });
  } else {
    const maxLen = Math.max(left.length, right.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= left.length) {
        added++;
        if (entries.length < maxEntries) entries.push({ kind: 'added', keyLabel: `#${i + 1}`, rightIndex: i, right: right[i] });
      } else if (i >= right.length) {
        removed++;
        if (entries.length < maxEntries) entries.push({ kind: 'removed', keyLabel: `#${i + 1}`, leftIndex: i, left: left[i] });
      } else if (compactJson(left[i]) === compactJson(right[i])) {
        unchanged++;
      } else {
        modified++;
        if (entries.length < maxEntries) {
          entries.push({
            kind: 'modified',
            keyLabel: `#${i + 1}`,
            leftIndex: i,
            rightIndex: i,
            left: left[i],
            right: right[i],
            changes: diffValues(left[i], right[i], 50).rows,
          });
        }
      }
    }
  }

  return {
    mode: resolvedKey ? 'key' : 'line',
    keyField: resolvedKey,
    keyCandidates,
    added,
    removed,
    modified,
    unchanged,
    entries,
    metrics: computeMetrics(left, right),
  };
}
