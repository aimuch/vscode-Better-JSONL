// Nested field discovery and Group-By / Pivot aggregation engine.
import { t } from '../shared/i18n';
import type { JsonPath } from '../shared/protocol';
import { esc, getAt, isContainer, isObj, pathToJq, pathToString, plainText, RawNum, type JObj, type JVal } from './json';
import { compactJson } from './query';

export interface DiscoveredPath {
  path: JsonPath;
  /** Display label such as `user.name` or `items[0].price`. */
  label: string;
  isNumeric: boolean;
  count: number;
}

export function formatPathLabel(path: JsonPath): string {
  const s = pathToString(path);
  return s.startsWith('$.') ? s.slice(2) : s.startsWith('$') ? s.slice(1) : s;
}

/** Discovers scalar and container paths up to depth 4 from a sample of records. */
export function discoverFieldPaths(records: Iterable<JVal>, maxSample = 400): DiscoveredPath[] {
  const map = new Map<string, { path: JsonPath; numCount: number; count: number }>();
  let seen = 0;
  const walk = (v: JVal, path: JsonPath, depth: number) => {
    if (depth > 4 || map.size > 400) return;
    if (!isContainer(v)) {
      if (!path.length) return;
      const key = JSON.stringify(path);
      let e = map.get(key);
      if (!e) {
        e = { path, numCount: 0, count: 0 };
        map.set(key, e);
      }
      e.count++;
      if (typeof v === 'number' || v instanceof RawNum) e.numCount++;
      return;
    }
    if (Array.isArray(v)) {
      if (path.length) {
        const key = JSON.stringify(path);
        let e = map.get(key);
        if (!e) {
          e = { path, numCount: 0, count: 0 };
          map.set(key, e);
        }
        e.count++;
      }
      if (v.length > 0 && isObj(v[0])) walk(v[0], [...path, 0], depth + 1);
      return;
    }
    for (const k of Object.keys(v as JObj)) {
      walk((v as JObj)[k], [...path, k], depth + 1);
    }
  };
  for (const r of records) {
    walk(r, [], 0);
    if (++seen >= maxSample) break;
  }
  return [...map.values()].map((e) => ({
    path: e.path,
    label: formatPathLabel(e.path),
    isNumeric: e.numCount > 0 && e.numCount >= e.count * 0.5,
    count: e.count,
  }));
}

export interface PivotGroup {
  keyId: string;
  label: string;
  rawVal: JVal | undefined;
  count: number;
  share: number;
  filterQuery: string;
  numCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

export interface PivotResult {
  totalRecords: number;
  groups: PivotGroup[];
  hasMetric: boolean;
}

function numOf(v: JVal | undefined): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (v instanceof RawNum) {
    const n = Number(v.src);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function computePivot(
  records: Iterable<JVal>,
  groupBy: JsonPath,
  metricPath: JsonPath | null,
  sortBy: 'count' | 'sum' | 'avg' | 'group' = 'count',
  maxRecords = 200_000,
): PivotResult {
  const buckets = new Map<string, { label: string; rawVal: JVal | undefined; count: number; nums: number[] }>();
  let totalRecords = 0;
  for (const rec of records) {
    if (totalRecords >= maxRecords) break;
    totalRecords++;
    const gv = groupBy.length ? getAt(rec, groupBy) : rec;
    let keyId: string;
    let label: string;
    if (gv === undefined) {
      keyId = 'u:';
      label = t('(missing)');
    } else if (gv === null) {
      keyId = 'z:';
      label = 'null';
    } else if (isContainer(gv)) {
      const cj = compactJson(gv);
      keyId = 'j:' + cj;
      label = cj.length > 100 ? cj.slice(0, 100) + '…' : cj;
    } else if (typeof gv === 'string') {
      keyId = 's:' + gv;
      label = gv === '' ? '""' : gv;
    } else if (typeof gv === 'boolean') {
      keyId = 'b:' + String(gv);
      label = String(gv);
    } else {
      const s = plainText(gv);
      keyId = 'n:' + s;
      label = s;
    }
    let b = buckets.get(keyId);
    if (!b) {
      b = { label, rawVal: gv, count: 0, nums: [] };
      buckets.set(keyId, b);
    }
    b.count++;
    if (metricPath) {
      const mv = numOf(getAt(rec, metricPath));
      if (mv !== undefined) b.nums.push(mv);
    }
  }

  const jqPath = pathToJq(groupBy);
  const groups: PivotGroup[] = [...buckets.entries()].map(([keyId, b]) => {
    let filterQuery = '';
    if (b.rawVal === undefined) {
      const parent = groupBy.slice(0, -1);
      const last = groupBy[groupBy.length - 1];
      filterQuery =
        typeof last === 'string'
          ? `${parent.length ? pathToJq(parent) + ' | ' : ''}(has(${JSON.stringify(last)}) | not)`
          : `${jqPath} == null`;
    } else if (!isContainer(b.rawVal)) {
      const rhs = b.rawVal instanceof RawNum ? b.rawVal.src : JSON.stringify(b.rawVal);
      filterQuery = `${jqPath} == ${rhs}`;
    } else {
      filterQuery = `${jqPath} == ${compactJson(b.rawVal)}`;
    }
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let p50 = 0;
    let p95 = 0;
    if (b.nums.length > 0) {
      b.nums.sort((x, y) => x - y);
      for (const x of b.nums) sum += x;
      min = b.nums[0];
      max = b.nums[b.nums.length - 1];
      const q = (p: number) => b.nums[Math.min(b.nums.length - 1, Math.floor((b.nums.length - 1) * p))];
      p50 = q(0.5);
      p95 = q(0.95);
    }
    return {
      keyId,
      label: b.label,
      rawVal: b.rawVal,
      count: b.count,
      share: totalRecords > 0 ? b.count / totalRecords : 0,
      filterQuery,
      numCount: b.nums.length,
      sum,
      avg: b.nums.length > 0 ? sum / b.nums.length : 0,
      min: b.nums.length > 0 ? min : 0,
      max: b.nums.length > 0 ? max : 0,
      p50,
      p95,
    };
  });

  groups.sort((a, b) => {
    if (sortBy === 'sum') return b.sum - a.sum || b.count - a.count;
    if (sortBy === 'avg') return b.avg - a.avg || b.count - a.count;
    if (sortBy === 'group') return a.label.localeCompare(b.label);
    return b.count - a.count || a.label.localeCompare(b.label);
  });

  return { totalRecords, groups, hasMetric: metricPath !== null };
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString() : Number(n.toPrecision(6)).toLocaleString();
}

export function renderPivotTableHtml(res: PivotResult): string {
  if (!res.groups.length) return `<div class="empty-note">${esc(t('No rows.'))}</div>`;
  const maxCount = Math.max(1, ...res.groups.map((g) => g.count));
  const metricHead = res.hasMetric
    ? `<th class="num">${esc(t('Sum'))}</th><th class="num">${esc(t('Avg'))}</th><th class="num">Min</th><th class="num">p50</th><th class="num">p95</th><th class="num">Max</th>`
    : '';
  const rows = res.groups.slice(0, 500).map((g, idx) => {
    const pct = (g.share * 100).toFixed(1) + '%';
    const barW = Math.max(2, Math.round((g.count / maxCount) * 100));
    const metricCells = res.hasMetric
      ? g.numCount > 0
        ? `<td class="num mono">${fmtNum(g.sum)}</td><td class="num mono">${fmtNum(g.avg)}</td><td class="num mono">${fmtNum(g.min)}</td><td class="num mono">${fmtNum(g.p50)}</td><td class="num mono">${fmtNum(g.p95)}</td><td class="num mono">${fmtNum(g.max)}</td>`
        : '<td class="num dim">–</td><td class="num dim">–</td><td class="num dim">–</td><td class="num dim">–</td><td class="num dim">–</td><td class="num dim">–</td>'
      : '';
    return `<tr class="piv-row" data-pidx="${idx}" title="${esc(t('Click a row to filter by that group'))}">
      <td class="mono piv-key">${esc(g.label)}</td>
      <td class="num mono">${g.count.toLocaleString()}</td>
      <td class="piv-share"><span class="piv-bar-wrap"><span class="piv-bar" style="width:${barW}%"></span></span><span class="mono dim">${pct}</span></td>
      ${metricCells}
    </tr>`;
  });
  return `<table class="cmp piv-tbl"><thead><tr><th>${esc(t('Group'))}</th><th class="num">${esc(t('Count'))}</th><th>${esc(t('Share'))}</th>${metricHead}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
