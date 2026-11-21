// Modular Interactive Charts Explorer modal (Time-Series, Grouped Bar, 2D Scatter).
import { t } from '../../shared/i18n';
import type { JsonPath } from '../../shared/protocol';
import { buildChartSvg, type ChartKind } from '../charts';
import { icon } from '../icons';
import { esc, type JVal } from '../json';
import { discoverFieldPaths, type DiscoveredPath } from '../pivot';
import { trapModalTabKey } from '../stateMachines';

export interface ChartsModalHost {
  records(): Iterable<{ line: number; value: JVal }>;
  fileName: string;
  jumpToLine(line: number): void;
  exportSvg(svg: string, name: string): void;
  onClose(): void;
}

export class ChartsModal {
  readonly el: HTMLElement;
  private paths: DiscoveredPath[] = [];
  private kind: ChartKind = 'bar';
  private xIdx = 0;
  private yIdx = -1;
  private metric: 'avg' | 'p50' | 'p95' | 'count' | 'sum' = 'avg';
  private lastSvg = '';

  constructor(private readonly host: ChartsModalHost) {
    this.el = document.createElement('div');
    this.el.className = 'modal-panel charts-panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-modal', 'true');
    this.el.setAttribute('aria-label', t('Charts explorer'));
    this.el.hidden = true;
    this.el.addEventListener('keydown', (e) => {
      trapModalTabKey(this.el, e);
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.host.onClose();
      }
    });
  }

  open(): void {
    const sample: JVal[] = [];
    for (const r of this.host.records()) {
      sample.push(r.value);
      if (sample.length >= 400) break;
    }
    this.paths = discoverFieldPaths(sample, 400);
    const tsIdx = this.paths.findIndex((p) => /time|ts|date|created|timestamp/i.test(p.label));
    const numIdx = this.paths.findIndex((p) => p.isNumeric);
    const catIdx = this.paths.findIndex((p) => !p.isNumeric);
    if (tsIdx >= 0) {
      this.kind = 'timeseries';
      this.xIdx = tsIdx;
      this.yIdx = numIdx;
    } else if (catIdx >= 0) {
      this.kind = 'bar';
      this.xIdx = catIdx;
      this.yIdx = numIdx;
    } else {
      this.kind = 'scatter';
      this.xIdx = Math.max(0, numIdx);
      this.yIdx = this.paths.findIndex((p, i) => p.isNumeric && i !== this.xIdx);
    }

    const opts = this.paths.map((p, i) => `<option value="${i}">${esc(p.label)}${p.isNumeric ? ' (#)' : ''}</option>`).join('');
    this.el.innerHTML = `
      <div class="ep-head">
        <span class="ep-title">${icon('charts', 14)} ${esc(t('Charts explorer'))}</span>
        <span class="dim charts-meta"></span>
      </div>
      <div class="batch-bar piv-controls">
        <label class="piv-ctl"><span>${esc(t('Chart'))}</span>
          <select data-ch-kind>
            <option value="timeseries"${this.kind === 'timeseries' ? ' selected' : ''}>${esc(t('Time series'))}</option>
            <option value="bar"${this.kind === 'bar' ? ' selected' : ''}>${esc(t('Bar chart'))}</option>
            <option value="scatter"${this.kind === 'scatter' ? ' selected' : ''}>${esc(t('Scatter plot'))}</option>
          </select>
        </label>
        <label class="piv-ctl"><span>X</span>
          <select data-ch-x>${opts}</select>
        </label>
        <label class="piv-ctl"><span>Y</span>
          <select data-ch-y><option value="-1">${esc(t('Count (rows)'))}</option>${opts}</select>
        </label>
        <label class="piv-ctl" data-ch-metric-wrap><span>${esc(t('Metric'))}</span>
          <select data-ch-metric>
            <option value="avg">${esc(t('Avg'))}</option>
            <option value="p50">p50</option>
            <option value="p95">p95</option>
            <option value="sum">${esc(t('Sum'))}</option>
            <option value="count">${esc(t('Count'))}</option>
          </select>
        </label>
      </div>
      <div class="charts-body"></div>
      <div class="ep-actions">
        <button class="btn primary" data-ch-svg>${icon('download', 12)}${esc(t('Export SVG'))}</button>
        <button class="btn" data-ch-close>${esc(t('Close'))} <kbd>Esc</kbd></button>
      </div>`;

    const kindSel = this.el.querySelector('[data-ch-kind]') as HTMLSelectElement;
    const xSel = this.el.querySelector('[data-ch-x]') as HTMLSelectElement;
    const ySel = this.el.querySelector('[data-ch-y]') as HTMLSelectElement;
    const mSel = this.el.querySelector('[data-ch-metric]') as HTMLSelectElement;
    const mWrap = this.el.querySelector('[data-ch-metric-wrap]') as HTMLElement;
    if (this.paths.length) xSel.value = String(Math.max(0, this.xIdx));
    ySel.value = String(this.yIdx);

    const syncMetricVis = () => {
      mWrap.hidden = this.kind === 'scatter';
    };
    syncMetricVis();

    const rerun = (kindChanged = false) => {
      this.kind = kindSel.value as ChartKind;
      if (kindChanged && this.kind === 'scatter') {
        const curX = this.paths[Number(xSel.value)];
        const curY = this.paths[Number(ySel.value)];
        if (!curX?.isNumeric) {
          const n1 = this.paths.findIndex((p) => p.isNumeric);
          if (n1 >= 0) xSel.value = String(n1);
        }
        if (!curY?.isNumeric || ySel.value === xSel.value) {
          const n2 = this.paths.findIndex((p, i) => p.isNumeric && String(i) !== xSel.value);
          if (n2 >= 0) ySel.value = String(n2);
        }
      } else if (kindChanged && this.kind === 'timeseries' && tsIdx >= 0) {
        xSel.value = String(tsIdx);
      }
      syncMetricVis();
      this.xIdx = Number(xSel.value);
      this.yIdx = Number(ySel.value);
      this.metric = mSel.value as ChartsModal['metric'];
      this.renderChart();
    };
    kindSel.addEventListener('change', () => rerun(true));
    xSel.addEventListener('change', () => rerun(false));
    ySel.addEventListener('change', () => rerun(false));
    mSel.addEventListener('change', () => rerun(false));
    this.el.querySelector('[data-ch-close]')?.addEventListener('click', () => this.host.onClose());
    this.el.querySelector('[data-ch-svg]')?.addEventListener('click', () => {
      if (this.lastSvg) this.host.exportSvg(this.lastSvg, this.host.fileName.replace(/\.[^.]+$/, '') + '-chart');
    });

    this.el.hidden = false;
    this.renderChart();
    kindSel.focus();
  }

  private renderChart(): void {
    const body = this.el.querySelector('.charts-body') as HTMLElement | null;
    const meta = this.el.querySelector('.charts-meta') as HTMLElement | null;
    if (!body) return;
    if (!this.paths.length) {
      body.innerHTML = `<div class="empty-note">${esc(t('No fields available to chart.'))}</div>`;
      return;
    }
    const xPath: JsonPath = this.paths[this.xIdx]?.path ?? [];
    const yPath: JsonPath | null = this.yIdx >= 0 ? (this.paths[this.yIdx]?.path ?? null) : null;
    const res = buildChartSvg(this.host.records(), { kind: this.kind, xPath, yPath, metric: this.metric });
    this.lastSvg = res.svg;
    if (meta) meta.textContent = res.summary;
    body.innerHTML = res.svg;
    body.querySelectorAll<SVGElement>('[data-chart-line]').forEach((dot) => {
      dot.addEventListener('click', () => {
        const line = Number(dot.getAttribute('data-chart-line'));
        if (Number.isFinite(line)) {
          this.host.onClose();
          this.host.jumpToLine(line);
        }
      });
    });
  }

  close(): void {
    this.el.hidden = true;
    this.el.innerHTML = '';
  }
}
