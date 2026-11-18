// Dataset timeline distribution sparkline & interactive time-window brush filter.
import { t } from '../shared/i18n';
import { esc, isObj, type JObj } from './json';
import { parseTimestampMs } from './inspect';
import type { DocModel } from './model';

const TIME_CANDIDATES = ['ts', 'timestamp', 'time', '@timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt', 'date', 'datetime', 'eventTime'];

export interface TimelineData {
  col: string;
  minMs: number;
  maxMs: number;
  buckets: number;
  counts: Int32Array;
  errors: Int32Array;
  /** Epoch ms per record (`NaN` when missing or unparseable). */
  rowTimes: Float64Array;
}

/** Detects the primary timestamp column in a JSONL model by checking common names and sampling values. */
export function detectTimeColumn(model: DocModel): string | undefined {
  if (!model.isJsonl || model.count < 2) return undefined;
  const cols = model.columns;
  const ordered = [
    ...TIME_CANDIDATES.filter((c) => cols.includes(c)),
    ...cols.filter((c) => !TIME_CANDIDATES.includes(c) && /(?:time|date|_at|^ts$)/i.test(c)),
  ];
  const limit = Math.min(model.count, 40);
  for (const col of ordered) {
    let hits = 0;
    for (let i = 0; i < limit; i++) {
      const v = model.scanValue(i);
      if (v && isObj(v) && Object.prototype.hasOwnProperty.call(v, col) && parseTimestampMs((v as JObj)[col])) {
        if (++hits >= 2 || (model.valid === 1 && hits === 1)) return col;
      }
    }
  }
  return undefined;
}

export function buildTimeline(model: DocModel, col: string, buckets = 48): TimelineData | undefined {
  const n = model.count;
  const rowTimes = new Float64Array(n);
  rowTimes.fill(Number.NaN);
  let minMs = Infinity;
  let maxMs = -Infinity;
  let validTimes = 0;
  const maxScan = Math.min(n, 250_000);
  for (let i = 0; i < maxScan; i++) {
    if (model.isBlank(i)) continue;
    const p = model.scanParsed(i);
    if (p.kind !== 'value' || !isObj(p.value)) continue;
    const ts = parseTimestampMs((p.value as JObj)[col]);
    if (!ts) continue;
    rowTimes[i] = ts.epochMs;
    if (ts.epochMs < minMs) minMs = ts.epochMs;
    if (ts.epochMs > maxMs) maxMs = ts.epochMs;
    validTimes++;
  }
  if (validTimes === 0 || !Number.isFinite(minMs)) return undefined;
  const counts = new Int32Array(buckets);
  const errors = new Int32Array(buckets);
  const span = Math.max(1, maxMs - minMs);
  let lastBucket = 0;
  for (let i = 0; i < maxScan; i++) {
    const ms = rowTimes[i];
    if (!Number.isNaN(ms)) {
      const b = Math.min(buckets - 1, Math.max(0, Math.floor(((ms - minMs) / span) * buckets)));
      counts[b]++;
      lastBucket = b;
    } else if (!model.isBlank(i) && model.scanParsed(i).kind === 'error') {
      errors[lastBucket]++;
    }
  }
  return { col, minMs, maxMs, buckets, counts, errors, rowTimes };
}

export function formatShortTime(epochMs: number, spanMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  if (spanMs < 86_400_000) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderTimelineHtml(data: TimelineData, selRange: [number, number] | null): string {
  let maxCount = 1;
  for (let i = 0; i < data.buckets; i++) if (data.counts[i] > maxCount) maxCount = data.counts[i];
  const span = Math.max(1, data.maxMs - data.minMs);
  const bars: string[] = [];
  for (let i = 0; i < data.buckets; i++) {
    const bStart = data.minMs + (i / data.buckets) * span;
    const bEnd = data.minMs + ((i + 1) / data.buckets) * span;
    const inSel = !selRange || (bEnd >= selRange[0] && bStart <= selRange[1]);
    const h = data.counts[i] > 0 ? Math.max(14, Math.round((data.counts[i] / maxCount) * 100)) : 0;
    const errDot = data.errors[i] > 0 ? `<span class="tl-err" title="${data.errors[i]} errors"></span>` : '';
    bars.push(
      `<div class="tl-slot${inSel ? ' in' : ' out'}" data-b="${i}" title="${esc(formatShortTime(bStart, span))} (${data.counts[i]})">${errDot}<span class="tl-bar" style="height:${h}%"></span></div>`,
    );
  }
  const rangeLabel = selRange
    ? t('Time window: {0} – {1}', formatShortTime(selRange[0], span), formatShortTime(selRange[1], span))
    : `${esc(data.col)} · ${esc(formatShortTime(data.minMs, span))} – ${esc(formatShortTime(data.maxMs, span))}`;
  const clearBtn = selRange ? `<button class="chip tl-clear">${esc(t('Clear time window'))}</button>` : '';
  return `<span class="tl-label dim" title="${esc(t('Drag across the bars to filter by time window'))}">${rangeLabel}</span><div class="tl-track">${bars.join('')}</div>${clearBtn}`;
}
