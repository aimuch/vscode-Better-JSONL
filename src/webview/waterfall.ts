// Trace / Request / Session call-flow correlation and Gantt waterfall view.
import { t } from '../shared/i18n';
import type { JsonPath } from '../shared/protocol';
import { extractRecordEpochMs, formatDelta } from './inspect';
import { esc, getAt, isContainer, isObj, pathToJq, plainText, RawNum, type JObj, type JVal } from './json';
import type { DocModel } from './model';

const TRACE_KEY_RE =
  /(?:^|[_.\-])(?:trace_?id|request_?id|req_?id|correlation_?id|session_?id|conversation_?id|span_?id|parent_?id|job_?id|run_?id|task_?id|tx_?id)(?:$|[_.\-])/i;

const DURATION_KEYS = ['duration_ms', 'durationMs', 'duration', 'ms', 'latency_ms', 'latency', 'elapsed_ms', 'elapsed', 'took_ms', 'took'];
const LABEL_KEYS = ['span', 'operation', 'op', 'event', 'action', 'name', 'msg', 'message', 'route', 'path', 'url', 'type', 'step'];

export function isTraceCandidate(path: JsonPath, val: JVal | undefined): boolean {
  if (!path.length || val === undefined || val === null || isContainer(val)) return false;
  const last = String(path[path.length - 1]);
  if (TRACE_KEY_RE.test(last)) return true;
  if (typeof val === 'string' && val.length >= 4 && val.length <= 128 && !/\s/.test(val)) return true;
  if (typeof val === 'number' || val instanceof RawNum) return true;
  return false;
}

export interface TraceSpan {
  recordId: number;
  epochMs?: number;
  offsetMs: number;
  durationMs: number;
  hasExplicitDuration: boolean;
  label: string;
  level?: string;
  isError: boolean;
  leftPct: number;
  widthPct: number;
}

export interface TraceWaterfall {
  path: JsonPath;
  jqFilter: string;
  traceValue: string;
  totalDurationMs: number;
  spans: TraceSpan[];
}

function readDurationMs(rec: JObj): number | undefined {
  for (const k of DURATION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
    const v = rec[k];
    const n = typeof v === 'number' ? v : v instanceof RawNum ? Number(v.src) : NaN;
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

function readSpanLabel(rec: JObj, fallbackIdx: number): string {
  const method = typeof rec.method === 'string' ? rec.method + ' ' : '';
  for (const k of LABEL_KEYS) {
    const v = rec[k];
    if (typeof v === 'string' && v.trim()) {
      const s = (method && (k === 'path' || k === 'route' || k === 'url') ? method : '') + v.trim();
      return s.length > 90 ? s.slice(0, 90) + '…' : s;
    }
  }
  return `Record #${fallbackIdx + 1}`;
}

export function buildTraceWaterfall(model: DocModel, path: JsonPath, targetVal: JVal): TraceWaterfall {
  const targetStr = plainText(targetVal);
  const rawSpans: {
    recordId: number;
    epochMs?: number;
    durMs?: number;
    label: string;
    level?: string;
    isError: boolean;
  }[] = [];

  const limit = Math.min(model.count, 500_000);
  const fastNeedle =
    !model.keepsAll && targetStr.length >= 2 && /^[\x20-\x7e]+$/.test(targetStr) && !/["\\]/.test(targetStr)
      ? targetStr
      : undefined;
  for (let i = 0; i < limit; i++) {
    if (model.isBlank(i)) continue;
    if (fastNeedle !== undefined && !model.line(i).includes(fastNeedle)) continue;
    const rec = model.scanValue(i);
    if (!rec) continue;
    const v = getAt(rec, path);
    if (v === undefined || v === null || isContainer(v)) continue;
    if (plainText(v) !== targetStr || typeof v !== typeof targetVal && !(v instanceof RawNum && targetVal instanceof RawNum)) {
      if (plainText(v) !== targetStr) continue;
    }
    const obj = isObj(rec) ? (rec as JObj) : {};
    const lvl = typeof obj.level === 'string' ? obj.level : typeof obj.severity === 'string' ? obj.severity : typeof obj.status === 'string' ? obj.status : undefined;
    const statusNum = typeof obj.status === 'number' ? obj.status : typeof obj.statusCode === 'number' ? obj.statusCode : undefined;
    const isError =
      (lvl !== undefined && /err|fatal|crit|fail/i.test(lvl)) ||
      (statusNum !== undefined && statusNum >= 400) ||
      obj.error !== undefined;
    rawSpans.push({
      recordId: i,
      epochMs: extractRecordEpochMs(rec),
      durMs: isObj(rec) ? readDurationMs(obj) : undefined,
      label: isObj(rec) ? readSpanLabel(obj, i) : plainText(rec).slice(0, 80),
      level: lvl ?? (statusNum !== undefined ? String(statusNum) : undefined),
      isError,
    });
    if (rawSpans.length >= 2000) break;
  }

  // Sort chronologically when timestamps are available, preserving file order on ties
  const hasTimestamps = rawSpans.some((s) => s.epochMs !== undefined);
  if (hasTimestamps) {
    rawSpans.sort((a, b) => (a.epochMs ?? Infinity) - (b.epochMs ?? Infinity) || a.recordId - b.recordId);
  }

  const firstMs = rawSpans.find((s) => s.epochMs !== undefined)?.epochMs ?? 0;
  let endMs = firstMs;
  const computed = rawSpans.map((s, idx) => {
    const startMs = s.epochMs ?? (idx > 0 ? (rawSpans[idx - 1].epochMs ?? firstMs) : firstMs);
    const offsetMs = Math.max(0, startMs - firstMs);
    const nextEpoch = rawSpans[idx + 1]?.epochMs;
    const inferredDur =
      s.durMs !== undefined
        ? s.durMs
        : nextEpoch !== undefined && nextEpoch > startMs
          ? nextEpoch - startMs
          : 0;
    if (startMs + inferredDur > endMs) endMs = startMs + inferredDur;
    return { ...s, offsetMs, durationMs: inferredDur, hasExplicitDuration: s.durMs !== undefined };
  });

  const totalDurationMs = Math.max(1, endMs - firstMs, ...computed.map((c) => c.offsetMs + c.durationMs));
  const spans: TraceSpan[] = computed.map((c) => {
    const leftPct = Math.min(98, (c.offsetMs / totalDurationMs) * 100);
    const rawW = (c.durationMs / totalDurationMs) * 100;
    const widthPct = Math.max(1.5, Math.min(100 - leftPct, rawW));
    return {
      recordId: c.recordId,
      epochMs: c.epochMs,
      offsetMs: c.offsetMs,
      durationMs: c.durationMs,
      hasExplicitDuration: c.hasExplicitDuration,
      label: c.label,
      level: c.level,
      isError: c.isError,
      leftPct,
      widthPct,
    };
  });

  const rhs = targetVal instanceof RawNum ? targetVal.src : JSON.stringify(targetVal);
  return {
    path,
    jqFilter: `${pathToJq(path)} == ${rhs}`,
    traceValue: targetStr,
    totalDurationMs: endMs > firstMs ? endMs - firstMs : Math.max(0, ...computed.map((c) => c.durationMs)),
    spans,
  };
}

export function renderWaterfallHtml(wf: TraceWaterfall): string {
  if (!wf.spans.length) return `<div class="empty-note">${esc(t('No rows.'))}</div>`;
  const rows = wf.spans
    .map((sp) => {
      const offStr = sp.offsetMs === 0 ? '0 ms' : formatDelta(sp.offsetMs);
      const durStr = sp.durationMs > 0 ? formatDelta(sp.durationMs).replace(/^\+/, '') : '–';
      const badge = sp.level ? `<span class="badge${sp.isError ? ' bad' : ''}">${esc(sp.level)}</span> ` : '';
      return `<tr class="wf-row${sp.isError ? ' wf-err' : ''}" data-wf-rec="${sp.recordId}">
        <td class="num dim mono">#${sp.recordId + 1}</td>
        <td class="wf-lbl">${badge}<span>${esc(sp.label)}</span></td>
        <td class="num mono dim">${esc(offStr)}</td>
        <td class="wf-bar-cell"><div class="wf-track"><span class="wf-bar${sp.isError ? ' err' : ''}" style="left:${sp.leftPct.toFixed(2)}%;width:${sp.widthPct.toFixed(2)}%"></span></div></td>
        <td class="num mono">${esc(durStr)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="cmp wf-tbl"><thead><tr><th class="num">#</th><th>${esc(t('Span'))}</th><th class="num">${esc(t('Offset'))}</th><th>${esc(t('Timeline'))}</th><th class="num">${esc(t('Duration'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}
