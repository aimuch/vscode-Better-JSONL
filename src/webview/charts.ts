// Zero-dependency interactive SVG chart builder for JSON / JSON Lines datasets.
// Supports: Time-Series Multi-Line (avg/p50/p95/count), Grouped Bar, and 2D Scatter Plot (click point -> jump to line).
import type { JsonPath } from '../shared/protocol';
import { esc, getAt, plainText, RawNum, type JVal } from './json';
import { parseTimestampMs } from './inspect';
import { QuantileSketch } from './sketch';

export type ChartKind = 'timeseries' | 'bar' | 'scatter';

export interface ChartConfig {
  kind: ChartKind;
  xPath: JsonPath;
  yPath: JsonPath | null;
  groupPath?: JsonPath | null;
  metric?: 'avg' | 'p50' | 'p95' | 'count' | 'sum';
  width?: number;
  height?: number;
}

export interface ChartResult {
  svg: string;
  pointCount: number;
  summary: string;
}

const PALETTE = ['#4fc1ff', '#f48771', '#89d185', '#cca700', '#c586c0', '#3dc9b0', '#ce9178', '#569cd6'];

function numOf(v: JVal | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof RawNum) {
    const n = Number(v.src);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function fmtShort(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '');
}

function fmtTimeShort(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function buildChartSvg(
  records: Iterable<{ line: number; value: JVal }>,
  cfg: ChartConfig,
): ChartResult {
  const W = cfg.width ?? 760;
  const H = cfg.height ?? 320;
  const padL = 56;
  const padR = 20;
  const padT = 24;
  const padB = 46;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  if (cfg.kind === 'scatter') {
    const pts: { x: number; y: number; line: number; group: string }[] = [];
    const groups = new Map<string, number>();
    for (const { line, value } of records) {
      if (pts.length >= 2500) break;
      const xv = numOf(getAt(value, cfg.xPath));
      const yv = cfg.yPath ? numOf(getAt(value, cfg.yPath)) : null;
      if (xv === null || yv === null) continue;
      const g = cfg.groupPath?.length ? plainText(getAt(value, cfg.groupPath) ?? '') || '(none)' : 'all';
      if (!groups.has(g)) groups.set(g, groups.size);
      pts.push({ x: xv, y: yv, line, group: g });
    }
    if (!pts.length) {
      return { svg: `<svg viewBox="0 0 ${W} ${H}" class="chart-svg"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" opacity="0.6">No numeric X/Y pairs found.</text></svg>`, pointCount: 0, summary: '0 points' };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const sx = (x: number) => padL + ((x - minX) / spanX) * plotW;
    const sy = (y: number) => padT + plotH - ((y - minY) / spanY) * plotH;

    const grid: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (plotH * i) / 4;
      const val = maxY - (spanY * i) / 4;
      grid.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="ch-grid"/>`);
      grid.push(`<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="ch-axis">${esc(fmtShort(val))}</text>`);
      const gx = padL + (plotW * i) / 4;
      const xval = minX + (spanX * i) / 4;
      grid.push(`<text x="${gx.toFixed(1)}" y="${H - padB + 16}" text-anchor="middle" class="ch-axis">${esc(fmtShort(xval))}</text>`);
    }
    const dots = pts.map((p) => {
      const color = PALETTE[(groups.get(p.group) ?? 0) % PALETTE.length];
      return `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3.5" fill="${color}" fill-opacity="0.78" class="ch-dot" data-chart-line="${p.line}"><title>Line ${p.line + 1} (${esc(p.group)}): X=${fmtShort(p.x)}, Y=${fmtShort(p.y)}</title></circle>`;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="chart-svg">
      ${grid.join('')}
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="ch-axis-line"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" class="ch-axis-line"/>
      ${dots.join('')}
    </svg>`;
    return { svg, pointCount: pts.length, summary: `${pts.length.toLocaleString()} points` };
  }

  if (cfg.kind === 'bar') {
    const metric = cfg.metric ?? (cfg.yPath ? 'avg' : 'count');
    const buckets = new Map<string, { count: number; sketch: QuantileSketch }>();
    let total = 0;
    for (const { value } of records) {
      if (total++ >= 200_000) break;
      const xv = getAt(value, cfg.xPath);
      const label = xv === undefined ? '(missing)' : plainText(xv).slice(0, 32) || '(empty)';
      let b = buckets.get(label);
      if (!b) {
        b = { count: 0, sketch: new QuantileSketch() };
        buckets.set(label, b);
      }
      b.count++;
      if (cfg.yPath) {
        const yv = numOf(getAt(value, cfg.yPath));
        if (yv !== null) b.sketch.add(yv);
      }
    }
    const items = [...buckets.entries()]
      .map(([label, b]) => {
        const val =
          metric === 'count' || !cfg.yPath
            ? b.count
            : metric === 'sum'
              ? b.sketch.sum
              : metric === 'p50'
                ? b.sketch.quantile(0.5)
                : metric === 'p95'
                  ? b.sketch.quantile(0.95)
                  : b.sketch.avg;
        return { label, val: Number.isFinite(val) ? val : 0 };
      })
      .sort((a, b) => b.val - a.val)
      .slice(0, 20);
    if (!items.length) {
      return { svg: `<svg viewBox="0 0 ${W} ${H}" class="chart-svg"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" opacity="0.6">No data to plot.</text></svg>`, pointCount: 0, summary: '0 groups' };
    }
    const maxV = Math.max(...items.map((i) => Math.abs(i.val)), 1);
    const barW = Math.max(8, Math.min(48, plotW / items.length - 6));
    const step = plotW / items.length;
    const grid: string[] = [];
    for (let i = 0; i <= 4; i++) {
      const gy = padT + (plotH * i) / 4;
      const val = maxV * (1 - i / 4);
      grid.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="ch-grid"/>`);
      grid.push(`<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="ch-axis">${esc(fmtShort(val))}</text>`);
    }
    const bars = items.map((it, idx) => {
      const bh = Math.max(1, (Math.max(0, it.val) / maxV) * plotH);
      const bx = padL + idx * step + (step - barW) / 2;
      const by = padT + plotH - bh;
      const color = PALETTE[idx % PALETTE.length];
      const lbl = it.label.length > 10 ? it.label.slice(0, 9) + '…' : it.label;
      return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="2" fill="${color}" class="ch-bar"><title>${esc(it.label)}: ${fmtShort(it.val)}</title></rect>
        <text x="${(bx + barW / 2).toFixed(1)}" y="${H - padB + 15}" text-anchor="middle" class="ch-axis">${esc(lbl)}</text>`;
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="chart-svg">
      ${grid.join('')}
      <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="ch-axis-line"/>
      ${bars.join('')}
    </svg>`;
    return { svg, pointCount: items.length, summary: `Top ${items.length} groups (${metric})` };
  }

  // Time-series multi-line (buckets across [minTs, maxTs])
  const samples: { ts: number; val: number; line: number }[] = [];
  let minTs = Infinity, maxTs = -Infinity;
  for (const { line, value } of records) {
    if (samples.length >= 200_000) break;
    const tv = getAt(value, cfg.xPath);
    const parsedTs = tv !== undefined ? parseTimestampMs(tv) : undefined;
    if (!parsedTs) continue;
    const ms = parsedTs.epochMs;
    const yv = cfg.yPath ? numOf(getAt(value, cfg.yPath)) : 1;
    if (yv === null) continue;
    if (ms < minTs) minTs = ms;
    if (ms > maxTs) maxTs = ms;
    samples.push({ ts: ms, val: yv, line });
  }
  if (samples.length < 2) {
    return { svg: `<svg viewBox="0 0 ${W} ${H}" class="chart-svg"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="currentColor" opacity="0.6">Need at least 2 timestamped records.</text></svg>`, pointCount: samples.length, summary: `${samples.length} points` };
  }
  const B = Math.min(48, Math.max(8, Math.floor(samples.length / 2)));
  const span = maxTs - minTs || 1;
  const buckets = Array.from({ length: B }, () => ({ count: 0, sketch: new QuantileSketch(), firstLine: -1 }));
  for (const s of samples) {
    const idx = Math.min(B - 1, Math.floor(((s.ts - minTs) / span) * B));
    buckets[idx].count++;
    buckets[idx].sketch.add(s.val);
    if (buckets[idx].firstLine < 0) buckets[idx].firstLine = s.line;
  }
  const series = cfg.yPath
    ? [
        { name: 'avg', color: PALETTE[0], vals: buckets.map((b) => (b.count ? b.sketch.avg : null)) },
        { name: 'p95', color: PALETTE[1], vals: buckets.map((b) => (b.count ? b.sketch.quantile(0.95) : null)) },
      ]
    : [{ name: 'count', color: PALETTE[0], vals: buckets.map((b) => b.count) }];

  let maxV = 1;
  for (const sr of series) for (const v of sr.vals) if (v !== null && v > maxV) maxV = v;
  const sx = (i: number) => padL + (i / (B - 1)) * plotW;
  const sy = (v: number) => padT + plotH - (v / maxV) * plotH;

  const grid: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (plotH * i) / 4;
    const val = maxV * (1 - i / 4);
    grid.push(`<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" class="ch-grid"/>`);
    grid.push(`<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="ch-axis">${esc(fmtShort(val))}</text>`);
  }
  for (let i = 0; i <= 3; i++) {
    const gx = padL + (plotW * i) / 3;
    const ts = minTs + (span * i) / 3;
    grid.push(`<text x="${gx.toFixed(1)}" y="${H - padB + 16}" text-anchor="middle" class="ch-axis">${esc(fmtTimeShort(ts))}</text>`);
  }

  const lines: string[] = [];
  const legend: string[] = [];
  series.forEach((sr, sIdx) => {
    const pts: string[] = [];
    sr.vals.forEach((v, i) => {
      if (v === null) return;
      pts.push(`${pts.length ? 'L' : 'M'}${sx(i).toFixed(1)},${sy(v).toFixed(1)}`);
      if (sIdx === 0 && buckets[i].firstLine >= 0) {
        lines.push(`<circle cx="${sx(i).toFixed(1)}" cy="${sy(v).toFixed(1)}" r="3" fill="${sr.color}" class="ch-dot" data-chart-line="${buckets[i].firstLine}"><title>${sr.name}: ${fmtShort(v)} (line ${buckets[i].firstLine + 1})</title></circle>`);
      }
    });
    if (pts.length) lines.push(`<path d="${pts.join(' ')}" fill="none" stroke="${sr.color}" stroke-width="2"/>`);
    legend.push(`<g transform="translate(${padL + sIdx * 70}, 14)"><rect width="10" height="3" y="-4" fill="${sr.color}"/><text x="14" class="ch-axis">${esc(sr.name)}</text></g>`);
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="chart-svg">
    ${grid.join('')}
    <line x1="${padL}" y1="${padT + plotH}" x2="${W - padR}" y2="${padT + plotH}" class="ch-axis-line"/>
    ${lines.join('')}
    ${legend.join('')}
  </svg>`;
  return { svg, pointCount: samples.length, summary: `${samples.length.toLocaleString()} records in ${B} buckets` };
}
