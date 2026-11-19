// Nested field discovery and Group-By / Pivot aggregation engine.
import { t } from '../shared/i18n';
import type { JsonPath } from '../shared/protocol';
import { esc, getAt, isContainer, isObj, pathToJq, pathToString, plainText, RawNum, type JObj, type JVal } from './json';
import { compactJson } from './query';
import { DistinctCounter, QuantileSketch } from './sketch';

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
  distinctGroups?: number;
}

export interface CrossTabResult {
  totalRecords: number;
  rowLabels: string[];
  colLabels: string[];
  rowFilters: string[];
  colFilters: string[];
  /** Matrix[r][c] = { count, sum, avg, numCount } */
  cells: { count: number; sum: number; avg: number; numCount: number }[][];
  rowTotals: number[];
  colTotals: number[];
  maxCell: number;
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

function keyAndLabel(gv: JVal | undefined): { keyId: string; label: string } {
  if (gv === undefined) return { keyId: 'u:', label: t('(missing)') };
  if (gv === null) return { keyId: 'z:', label: 'null' };
  if (isContainer(gv)) {
    const cj = compactJson(gv);
    return { keyId: 'j:' + cj, label: cj.length > 100 ? cj.slice(0, 100) + '…' : cj };
  }
  if (typeof gv === 'string') return { keyId: 's:' + gv, label: gv === '' ? '""' : gv };
  if (typeof gv === 'boolean') return { keyId: 'b:' + String(gv), label: String(gv) };
  const s = plainText(gv);
  return { keyId: 'n:' + s, label: s };
}

function jqFilterFor(path: JsonPath, rawVal: JVal | undefined): string {
  const jqPath = pathToJq(path);
  if (rawVal === undefined) {
    const parent = path.slice(0, -1);
    const last = path[path.length - 1];
    return typeof last === 'string'
      ? `${parent.length ? pathToJq(parent) + ' | ' : ''}(has(${JSON.stringify(last)}) | not)`
      : `${jqPath} == null`;
  }
  if (!isContainer(rawVal)) {
    const rhs = rawVal instanceof RawNum ? rawVal.src : JSON.stringify(rawVal);
    return `${jqPath} == ${rhs}`;
  }
  return `${jqPath} == ${compactJson(rawVal)}`;
}

const EXACT_QUANTILE_CAP = 8_192;

export function computePivot(
  records: Iterable<JVal>,
  groupBy: JsonPath,
  metricPath: JsonPath | null,
  sortBy: 'count' | 'sum' | 'avg' | 'group' = 'count',
  maxRecords = 2_000_000,
): PivotResult {
  const buckets = new Map<
    string,
    { label: string; rawVal: JVal | undefined; count: number; nums: number[] | null; sketch: QuantileSketch | null }
  >();
  const distinct = new DistinctCounter();
  let totalRecords = 0;
  for (const rec of records) {
    if (totalRecords >= maxRecords) break;
    totalRecords++;
    const gv = groupBy.length ? getAt(rec, groupBy) : rec;
    const { keyId, label } = keyAndLabel(gv);
    distinct.add(keyId);
    let b = buckets.get(keyId);
    if (!b) {
      b = { label, rawVal: gv, count: 0, nums: [], sketch: null };
      buckets.set(keyId, b);
    }
    b.count++;
    if (metricPath) {
      const mv = numOf(getAt(rec, metricPath));
      if (mv !== undefined) {
        if (b.sketch) {
          b.sketch.add(mv);
        } else {
          b.nums!.push(mv);
          if (b.nums!.length > EXACT_QUANTILE_CAP) {
            const sk = new QuantileSketch(0.01);
            for (const x of b.nums!) sk.add(x);
            b.sketch = sk;
            b.nums = null;
          }
        }
      }
    }
  }

  const groups: PivotGroup[] = [...buckets.entries()].map(([keyId, b]) => {
    const filterQuery = jqFilterFor(groupBy, b.rawVal);
    let numCount = 0;
    let sum = 0;
    let min = 0;
    let max = 0;
    let avg = 0;
    let p50 = 0;
    let p95 = 0;
    if (b.sketch) {
      numCount = b.sketch.count;
      sum = b.sketch.sum;
      min = b.sketch.min;
      max = b.sketch.max;
      avg = b.sketch.avg;
      p50 = b.sketch.quantile(0.5);
      p95 = b.sketch.quantile(0.95);
    } else if (b.nums && b.nums.length > 0) {
      numCount = b.nums.length;
      b.nums.sort((x, y) => x - y);
      for (const x of b.nums) sum += x;
      min = b.nums[0];
      max = b.nums[b.nums.length - 1];
      avg = sum / numCount;
      const q = (p: number) => b.nums![Math.min(numCount - 1, Math.floor((numCount - 1) * p))];
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
      numCount,
      sum,
      avg,
      min,
      max,
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

  return { totalRecords, groups, hasMetric: metricPath !== null, distinctGroups: distinct.estimate() };
}

/** Computes a 2D Cross-Tab Pivot matrix (Row dimension x Column dimension). */
export function computeCrossTab(
  records: Iterable<JVal>,
  rowBy: JsonPath,
  colBy: JsonPath,
  metricPath: JsonPath | null,
  maxRows = 30,
  maxCols = 12,
  maxRecords = 500_000,
): CrossTabResult {
  const rowTotalsMap = new Map<string, { label: string; rawVal: JVal | undefined; count: number }>();
  const colTotalsMap = new Map<string, { label: string; rawVal: JVal | undefined; count: number }>();
  const cellMap = new Map<string, { count: number; sum: number; numCount: number }>();
  let totalRecords = 0;

  for (const rec of records) {
    if (totalRecords >= maxRecords) break;
    totalRecords++;
    const rv = rowBy.length ? getAt(rec, rowBy) : rec;
    const cv = colBy.length ? getAt(rec, colBy) : rec;
    const rk = keyAndLabel(rv);
    const ck = keyAndLabel(cv);
    let rEnt = rowTotalsMap.get(rk.keyId);
    if (!rEnt) {
      rEnt = { label: rk.label, rawVal: rv, count: 0 };
      rowTotalsMap.set(rk.keyId, rEnt);
    }
    rEnt.count++;
    let cEnt = colTotalsMap.get(ck.keyId);
    if (!cEnt) {
      cEnt = { label: ck.label, rawVal: cv, count: 0 };
      colTotalsMap.set(ck.keyId, cEnt);
    }
    cEnt.count++;
    const pairKey = `${rk.keyId}\x00${ck.keyId}`;
    let cell = cellMap.get(pairKey);
    if (!cell) {
      cell = { count: 0, sum: 0, numCount: 0 };
      cellMap.set(pairKey, cell);
    }
    cell.count++;
    if (metricPath) {
      const mv = numOf(getAt(rec, metricPath));
      if (mv !== undefined) {
        cell.sum += mv;
        cell.numCount++;
      }
    }
  }

  const topRows = [...rowTotalsMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, maxRows);
  const topCols = [...colTotalsMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, maxCols);
  let maxCell = 1;
  const cells = topRows.map(([rk]) =>
    topCols.map(([ck]) => {
      const c = cellMap.get(`${rk}\x00${ck}`) ?? { count: 0, sum: 0, numCount: 0 };
      const avg = c.numCount ? c.sum / c.numCount : 0;
      const val = metricPath ? (c.numCount ? avg : 0) : c.count;
      if (val > maxCell) maxCell = val;
      return { count: c.count, sum: c.sum, avg, numCount: c.numCount };
    }),
  );

  return {
    totalRecords,
    rowLabels: topRows.map(([, r]) => r.label),
    colLabels: topCols.map(([, c]) => c.label),
    rowFilters: topRows.map(([, r]) => jqFilterFor(rowBy, r.rawVal)),
    colFilters: topCols.map(([, c]) => jqFilterFor(colBy, c.rawVal)),
    cells,
    rowTotals: topRows.map(([, r]) => r.count),
    colTotals: topCols.map(([, c]) => c.count),
    maxCell,
    hasMetric: metricPath !== null,
  };
}

export function renderCrossTabHtml(res: CrossTabResult): string {
  if (!res.rowLabels.length || !res.colLabels.length) return `<div class="empty-note">${esc(t('No rows.'))}</div>`;
  const head = `<tr><th>${esc(t('Row \\ Col'))}</th>${res.colLabels.map((c) => `<th class="num mono">${esc(c.length > 18 ? c.slice(0, 17) + '…' : c)}</th>`).join('')}<th class="num">${esc(t('Total'))}</th></tr>`;
  const body = res.rowLabels.map((rl, ri) => {
    const tds = res.colLabels.map((_, ci) => {
      const c = res.cells[ri][ci];
      if (!c.count) return '<td class="num dim">·</td>';
      const display = res.hasMetric ? (c.numCount ? fmtNum(c.avg) : '–') : c.count.toLocaleString();
      const intensity = Math.min(0.65, Math.max(0.08, ((res.hasMetric ? c.avg : c.count) / res.maxCell) * 0.65));
      return `<td class="num mono piv-cell" data-xrow="${ri}" data-xcol="${ci}" style="background:color-mix(in srgb, var(--accent) ${Math.round(intensity * 100)}%, transparent)" title="${esc(t('Click to filter by row & column'))}">${esc(display)}</td>`;
    });
    return `<tr><td class="mono piv-key">${esc(rl)}</td>${tds.join('')}<td class="num mono dim">${res.rowTotals[ri].toLocaleString()}</td></tr>`;
  });
  return `<table class="cmp piv-tbl piv-xtab"><thead>${head}</thead><tbody>${body.join('')}</tbody></table>`;
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
