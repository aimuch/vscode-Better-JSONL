// Data quality & schema anomaly / duplicate detector for JSON Lines datasets.
import { t } from '../shared/i18n';
import { isContainer, isObj, plainText, RawNum, type JObj, type JVal } from './json';
import type { DocModel } from './model';
import { compactJson } from './query';

export interface QualityIssue {
  id: string;
  kind: 'syntax' | 'dup-line' | 'dup-key' | 'type-drift' | 'missing-field';
  title: string;
  detail: string;
  recordIds: number[];
  /** Extra duplicate record IDs (excluding the first occurrence of each group) that can be safely deleted. */
  deletableIds?: number[];
}

export interface QualityReport {
  scannedRecords: number;
  keyField: string | null;
  keyCandidates: string[];
  issues: QualityIssue[];
}

const KEY_CANDIDATES = ['id', '_id', 'uuid', 'event_id', 'eventId', 'trace_id', 'traceId', 'record_id', 'sample_id', 'key'];

function valKind(v: JVal): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' || v instanceof RawNum) return 'number';
  if (typeof v === 'string') return 'string';
  return Array.isArray(v) ? 'array' : 'object';
}

/** Dual 32-bit FNV-1a + length fingerprint so 200k unique lines do not retain 200k full JSON strings in RAM. */
function fingerprintLine(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x050c5d1f;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  return `${s.length}:${h1.toString(36)}:${h2.toString(36)}`;
}

export function analyzeDataQuality(model: DocModel, explicitKey?: string, maxRecords = 200_000): QualityReport {
  const issues: QualityIssue[] = [];
  const n = Math.min(model.count, maxRecords);

  // 1. Syntax errors
  const errIds = model.errorRecords();
  if (errIds.length > 0) {
    const sampleRefs = errIds.slice(0, 5).map((i) => `#${i + 1}`).join(', ') + (errIds.length > 5 ? '…' : '');
    issues.push({
      id: 'syntax',
      kind: 'syntax',
      title: t('Syntax errors'),
      detail: t('{0} lines ({1})', errIds.length.toLocaleString(), sampleRefs),
      recordIds: errIds,
    });
  }

  // Gather candidate primary keys
  const cols = model.columns;
  const keyCandidates = [
    ...KEY_CANDIDATES.filter((k) => cols.includes(k)),
    ...cols.filter((k) => !KEY_CANDIDATES.includes(k)).slice(0, 20),
  ];
  const chosenKey =
    explicitKey !== undefined
      ? explicitKey || null
      : KEY_CANDIDATES.find((k) => cols.includes(k)) ?? null;

  const lineHashes = new Map<string, { firstIdx: number; ids: number[] }[]>();
  const keyBuckets = chosenKey ? new Map<string, { display: string; ids: number[] }>() : null;
  const allObjIds = new Int32Array(n);
  const maxAllowedMissing = Math.ceil(n * 0.25) + 4;

  interface FieldStat {
    present: number;
    nonNull: number;
    lastNonNullSeq: number;
    missingIds: number[];
    missingDropped: boolean;
    types: Map<string, { count: number; ids: number[] }>;
  }
  const fieldStats = new Map<string, FieldStat>();

  let objRecords = 0;
  let validScanned = 0;

  for (let i = 0; i < n; i++) {
    if (model.isBlank(i)) continue;
    const v = model.scanValue(i);
    if (v === undefined) continue;
    validScanned++;

    const canon = compactJson(v);
    const fp = fingerprintLine(canon);
    let bucket = lineHashes.get(fp);
    if (!bucket) {
      lineHashes.set(fp, [{ firstIdx: i, ids: [i] }]);
    } else {
      let matched = false;
      for (const entry of bucket) {
        const firstVal = model.scanValue(entry.firstIdx);
        if (firstVal !== undefined && compactJson(firstVal) === canon) {
          entry.ids.push(i);
          matched = true;
          break;
        }
      }
      if (!matched) bucket.push({ firstIdx: i, ids: [i] });
    }

    if (!isObj(v)) continue;
    const curSeq = objRecords++;
    allObjIds[curSeq] = i;
    const obj = v as JObj;

    if (keyBuckets && chosenKey && Object.prototype.hasOwnProperty.call(obj, chosenKey)) {
      const kv = obj[chosenKey];
      if (kv !== null && kv !== undefined && !isContainer(kv)) {
        const ks = `${valKind(kv)}:${plainText(kv)}`;
        let b = keyBuckets.get(ks);
        if (!b) {
          b = { display: plainText(kv), ids: [] };
          keyBuckets.set(ks, b);
        }
        b.ids.push(i);
      }
    }

    for (const k of Object.keys(obj)) {
      let st = fieldStats.get(k);
      if (!st && fieldStats.size < 250) {
        st = {
          present: 0,
          nonNull: 0,
          lastNonNullSeq: -1,
          missingIds: [],
          missingDropped: curSeq > maxAllowedMissing,
          types: new Map(),
        };
        fieldStats.set(k, st);
      }
      if (!st) continue;
      const fv = obj[k];
      st.present++;
      const tk = valKind(fv);
      if (tk !== 'null') {
        if (!st.missingDropped) {
          const missedSoFar = curSeq - st.nonNull;
          if (missedSoFar > maxAllowedMissing) {
            st.missingDropped = true;
            st.missingIds.length = 0;
          } else {
            for (let s = st.lastNonNullSeq + 1; s < curSeq && st.missingIds.length < 5000; s++) {
              st.missingIds.push(allObjIds[s]);
            }
            st.lastNonNullSeq = curSeq;
          }
        }
        st.nonNull++;
        let tb = st.types.get(tk);
        if (!tb) {
          tb = { count: 0, ids: [] };
          st.types.set(tk, tb);
        }
        tb.count++;
        if (tb.ids.length < 5000) tb.ids.push(i);
      }
    }
  }

  // 2. Exact duplicate lines
  const dupAllIds: number[] = [];
  const dupExtraIds: number[] = [];
  let dupGroups = 0;
  for (const bucket of lineHashes.values()) {
    for (const entry of bucket) {
      if (entry.ids.length >= 2) {
        dupGroups++;
        dupAllIds.push(...entry.ids);
        dupExtraIds.push(...entry.ids.slice(1));
      }
    }
  }
  if (dupAllIds.length > 0) {
    dupAllIds.sort((a, b) => a - b);
    dupExtraIds.sort((a, b) => a - b);
    issues.push({
      id: 'dup-line',
      kind: 'dup-line',
      title: t('Exact duplicate lines'),
      detail: t('{0} groups · {1} extra copies', dupGroups.toLocaleString(), dupExtraIds.length.toLocaleString()),
      recordIds: dupAllIds,
      deletableIds: dupExtraIds,
    });
  }

  // 3. Duplicate primary keys
  if (keyBuckets && chosenKey) {
    const keyDupIds: number[] = [];
    const keyExtraIds: number[] = [];
    const sampleKeys: string[] = [];
    for (const b of keyBuckets.values()) {
      if (b.ids.length >= 2) {
        keyDupIds.push(...b.ids);
        keyExtraIds.push(...b.ids.slice(1));
        if (sampleKeys.length < 4) sampleKeys.push(b.display);
      }
    }
    if (keyDupIds.length > 0) {
      keyDupIds.sort((a, b) => a - b);
      keyExtraIds.sort((a, b) => a - b);
      const sampleStr = sampleKeys.join(', ') + (keyExtraIds.length > sampleKeys.length ? '…' : '');
      issues.push({
        id: `dup-key:${chosenKey}`,
        kind: 'dup-key',
        title: t('Duplicate key "{0}"', chosenKey),
        detail: t('{0} lines ({1})', keyDupIds.length.toLocaleString(), sampleStr),
        recordIds: keyDupIds,
        deletableIds: keyExtraIds,
      });
    }
  }

  // 4. Type drift & 5. Missing core fields (zero second scan!)
  if (objRecords >= 3) {
    for (const [k, st] of fieldStats) {
      if (st.types.size >= 2 && st.nonNull >= 3) {
        const sortedTypes = [...st.types.entries()].sort((a, b) => b[1].count - a[1].count);
        const [domType, domInfo] = sortedTypes[0];
        if (domInfo.count / st.nonNull >= 0.65) {
          const outlierIds: number[] = [];
          const otherSummary: string[] = [];
          for (let ti = 1; ti < sortedTypes.length; ti++) {
            const [tName, tInfo] = sortedTypes[ti];
            otherSummary.push(`${t(tName)} (${tInfo.count})`);
            outlierIds.push(...tInfo.ids);
          }
          outlierIds.sort((a, b) => a - b);
          issues.push({
            id: `drift:${k}`,
            kind: 'type-drift',
            title: t('Type drift in "{0}"', k),
            detail: `${t(domType)} (${domInfo.count}) / ${otherSummary.join(', ')}`,
            recordIds: outlierIds,
          });
        }
      }

      if (objRecords >= 4 && !st.missingDropped && st.nonNull < objRecords && st.nonNull / objRecords >= 0.75) {
        for (let s = st.lastNonNullSeq + 1; s < objRecords && st.missingIds.length < 5000; s++) {
          st.missingIds.push(allObjIds[s]);
        }
        const totalMissing = objRecords - st.nonNull;
        if (st.missingIds.length > 0) {
          const refs = st.missingIds.slice(0, 4).map((x) => `#${x + 1}`).join(', ') + (totalMissing > 4 ? '…' : '');
          issues.push({
            id: `missing:${k}`,
            kind: 'missing-field',
            title: t('Missing core field "{0}"', k),
            detail: t('{0} of {1} records ({2})', totalMissing.toLocaleString(), objRecords.toLocaleString(), refs),
            recordIds: st.missingIds,
          });
        }
      }
    }
  }

  return { scannedRecords: validScanned, keyField: chosenKey, keyCandidates, issues };
}
