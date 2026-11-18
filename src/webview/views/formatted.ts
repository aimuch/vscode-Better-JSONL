import { t } from '../../shared/i18n';
import type { RenderReport } from '../../shared/protocol';
import { defer, type App, type View } from '../app';
import { resolveAtPathKey } from '../inspect';
import { childKey, decodeKey, esc, highlightRaw, parseJson, type JVal } from '../json';
import { icon } from '../icons';
import { isTextQuery, K_ERROR, K_VALUE, stepIn, type Query } from '../model';
import { buildLines, countLines, isFolded, lineHtml, lineText, type PLine } from './lines';

/** Browsers cap element height near 33.5M px. Above this the scroll space is scaled. */
const MAX_SCROLL_PX = 30_000_000;
const RAW_PREVIEW_CHARS = 2000;
/** With word wrap on, more of a long line is shown (it wraps instead of being cut). */
const WRAP_PREVIEW_CHARS = 20000;
const LINE_CACHE = 300;
const MEASURED_CACHE = 20000;
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/g;

/** Columns a string takes in a monospace font: CJK and full-width characters take two. */
function visualColumns(s: string): number {
  const wide = s.match(WIDE);
  return s.length + (wide ? wide.length : 0);
}

/**
 * Formatted view. Every record becomes N rows:
 * collapsed = 1 row, expanded = its pretty lines, error = 2 rows.
 * Only the rows on screen are in the DOM.
 * Without word wrap every row is one line high. With word wrap a row's height is
 * estimated from its length, then updated in O(log n) in a Fenwick tree once on screen.
 */
export class FormattedView implements View {
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly rows: HTMLElement;
  /** Record numbers in display order, or null for "all records". */
  private recs: number[] | null = null;
  private recCount = 0;
  private offsets = new Float64Array(1);
  private total = 0;
  private ratio = 1;
  private readonly heights = new Map<number, number>();
  /** Compact height cache for Expand all (0 = unknown). */
  private allHeights: Int32Array | null = null;
  private readonly lineCache = new Map<number, PLine[]>();
  private modelRef: unknown;
  private modelRev = -1;
  private rendered = 0;
  private firstRecord = 0;
  /** JSON mode: pretty line numbers that match the search. */
  private focusPath: string | null = null;
  private matchesSeen = -1;
  /** Word wrap: 1-based Fenwick tree of row heights in px, and each row's current height. */
  private rowBit: Float64Array | null = null;
  private rowCur: Float32Array | null = null;
  private rowTotalPx = 0;
  private highBit = 0;
  /** Word wrap: measured row heights. Key: the record number for a collapsed record, "record:state:line" otherwise. */
  private readonly measured = new Map<number | string, number>();
  private readonly measuredExpanded = new Set<number>();
  /** The model's errorsVersion this layout was made for. */
  private errorsSeen = -1;
  private relayout = 0;
  private wrapCols = 0;
  private lastWidth = 0;
  private remeasuring = false;
  private readonly resizes: ResizeObserver;

  constructor(private readonly app: App) {
    this.el = document.createElement('div');
    this.el.className = 'view formatted';
    this.el.innerHTML = `<div class="scroller" tabindex="0" aria-label="${t('Formatted records')}"><div class="spacer"><div class="rows code"></div></div></div>`;
    this.scroller = this.el.querySelector('.scroller') as HTMLElement;
    this.spacer = this.el.querySelector('.spacer') as HTMLElement;
    this.rows = this.el.querySelector('.rows') as HTMLElement;
    this.scroller.addEventListener('scroll', () => this.paint(), { passive: true });
    this.resizes = new ResizeObserver(() => {
      const w = this.scroller.clientWidth;
      if (this.app.state?.wrap && w !== this.lastWidth) {
        this.lastWidth = w;
        this.onWrapChanged();
        this.layout();
      } else if (this.ratio < 1) {
        this.applyScrollHeight();
      }
      this.paint();
    });
    this.resizes.observe(this.scroller);
    this.rows.addEventListener('click', (e) => this.onClick(e));
    this.rows.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.rows.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.rows.addEventListener('mouseover', (e) => this.onHover(e));
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.resizes.disconnect();
    cancelAnimationFrame(this.relayout);
  }

  render(anchor?: number): void {
    const virtBefore = anchor !== undefined ? this.recordVirtTop(anchor) : -1;
    const screenOffset = virtBefore >= 0 ? virtBefore - this.virtTop() : undefined;
    this.layout();
    if (anchor !== undefined && screenOffset !== undefined) {
      const virtAfter = this.recordVirtTop(anchor);
      if (virtAfter >= 0) this.scroller.scrollTop = this.toScrollTop(virtAfter - screenOffset);
    }
    this.paint();
  }

  refresh(): void {
    this.render(this.total ? this.firstRecord : undefined);
  }

  notes(): string[] {
    return [];
  }

  onWrapChanged(): void {
    this.measured.clear();
    this.measuredExpanded.clear();
    this.wrapCols = 0;
  }

  onActiveChanged(scroll: boolean): void {
    if (!scroll) return;
    const r = this.app.state.active;
    const i = this.indexOf(r);
    if (i < 0 || i >= this.offsets.length - 1) return;
    const top = this.topOf(this.offsets[i]);
    const h = this.topOf(this.offsets[i + 1]) - top;
    const vt = this.virtTop();
    const vh = this.scroller.clientHeight || 600;
    if (top < vt || top + Math.min(h, vh) > vt + vh) {
      this.scroller.scrollTop = this.toScrollTop(top - vh / 3);
    }
    this.paint();
  }

  /** Precomputes record heights in slices before turning on Expand all on a large file. */
  prepareExpandAll(onProgress: (pct: number) => void, onDone: () => void): () => void {
    const m = this.app.model;
    if (this.modelRef !== m || this.modelRev !== m.revision) {
      this.modelRef = m;
      this.modelRev = m.revision;
      this.heights.clear();
      this.allHeights = null;
      this.lineCache.clear();
      this.measured.clear();
      this.measuredExpanded.clear();
    }
    const n = m.count;
    if (!this.allHeights || this.allHeights.length < n) {
      const next = new Int32Array(Math.max(n, 1024));
      if (this.allHeights) next.set(this.allHeights.subarray(0, Math.min(this.allHeights.length, next.length)));
      this.allHeights = next;
    }
    const arr = this.allHeights;
    if (n <= 20_000) {
      for (let r = 0; r < n; r++) if (!arr[r]) arr[r] = this.computeRecordHeight(r, true);
      return defer(onDone, 30);
    }
    let r = 0;
    let cancelled = false;
    let stop = () => undefined as void;
    let lastPaint = 0;
    const step = () => {
      if (cancelled || this.app.model !== m) return;
      const end = performance.now() + 12;
      while (r < n) {
        if (!arr[r]) arr[r] = this.computeRecordHeight(r, true);
        r++;
        if ((r & 127) === 0 && performance.now() > end) break;
      }
      if (r >= n) {
        onDone();
        return;
      }
      const now = performance.now();
      if (now - lastPaint > 200) {
        lastPaint = now;
        onProgress(Math.floor((r / n) * 100));
      }
      stop = defer(step);
    };
    stop = defer(step, 30);
    return () => {
      cancelled = true;
      stop();
    };
  }

  stepMatch(dir: 1 | -1): void {
    const app = this.app;
    if (!app.query.text) return;
    if (!app.model.isJsonl) {
      const ms = app.treeMatches;
      if (!ms.length) return;
      app.treeIndex = app.treeIndex < 0 ? (dir > 0 ? 0 : ms.length - 1) : (app.treeIndex + dir + ms.length) % ms.length;
      this.reveal(ms[app.treeIndex]);
      app.paintCount();
      app.stateChanged();
      return;
    }
    const ms = app.matches;
    if (!ms.length) return;
    app.selectRecord(stepIn(ms, app.state.active, dir));
    this.onActiveChanged(true);
  }

  /**
   * Goes to a member of the JSON document (a path key). Folded nodes above it are opened;
   * nothing else changes, so a large document stays mostly folded.
   */
  private reveal(key: string): void {
    const app = this.app;
    const folds = app.folds(0);
    const foldDepth = app.foldDepthOf();
    let path = '';
    let opened = false;
    decodeKey(key).forEach((seg, depth) => {
      if (isFolded(folds, path, depth, foldDepth)) {
        if (!folds.delete(path)) folds.add(path);
        opened = true;
      }
      path = childKey(path, seg);
    });
    if (opened) {
      this.invalidateHeight(0);
      this.lineCache.delete(0);
      this.forgetMeasured(0);
    }
    this.matchesSeen = app.matchesVersion;
    this.focusPath = key;
    this.layout();
    const j = this.linesOf(0).findIndex((l) => l.path === key && l.kind !== 'close');
    if (j >= 0) {
      const top = this.topOf(j);
      const vt = this.virtTop();
      const vh = this.scroller.clientHeight || 600;
      if (top < vt || top + this.app.rh > vt + vh) this.scroller.scrollTop = this.toScrollTop(top - vh / 3);
    }
    this.paint();
  }

  foldAll(collapse: boolean): void {
    const app = this.app;
    // "Collapse all" folds everything below the root; the toggles of single nodes start again.
    app.folds(0).clear();
    app.state.foldDepth = collapse ? 1 : Infinity;
    this.invalidateHeight(0);
    this.lineCache.delete(0);
    this.forgetMeasured(0);
    this.scroller.scrollTop = 0;
    this.render();
    app.stateChanged();
  }

  fillReport(r: RenderReport): void {
    const app = this.app;
    const m = app.model;
    let expanded = 0;
    if (!m.isJsonl) expanded = m.kind(0) === K_VALUE ? 1 : 0;
    else if (app.expandAll) {
      if (!this.recs) expanded = m.valid;
      else for (const r of this.recs) if (m.kind(r) === K_VALUE) expanded++;
    } else {
      for (const r of app.state.selected) if (r < m.count && this.indexOf(r) >= 0 && m.get(r).kind === 'value') expanded++;
    }
    r.formatted = { totalRows: this.total, expandedRecords: expanded, renderedRows: this.rendered, firstRecord: this.firstRecord };
  }

  // ---------- layout ----------

  private recAt(i: number): number {
    return this.recs ? this.recs[i] : i;
  }

  private indexOf(r: number): number {
    if (!this.recs) return r < this.recCount ? r : -1;
    let lo = 0;
    let hi = this.recs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.recs[mid];
      if (v === r) return mid;
      if (v < r) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  private isExpanded(r: number): boolean {
    const app = this.app;
    return !app.model.isJsonl || app.expandAll || app.state.selected.has(r);
  }

  invalidateRecord(r: number): void {
    this.invalidateHeight(r);
    this.lineCache.delete(r);
    this.forgetMeasured(r);
  }

  private invalidateHeight(r: number): void {
    this.heights.delete(r);
    if (this.allHeights && r < this.allHeights.length) this.allHeights[r] = 0;
  }

  private computeRecordHeight(r: number, scan = false): number {
    const m = this.app.model;
    const p = scan || this.app.expandAll ? m.scanParsed(r) : m.get(r);
    if (p.kind === 'blank') return 1;
    if (p.kind === 'error') return 2;
    return countLines(p.value, this.app.foldsOf(r), this.app.foldDepthOf(), this.app.unpackedOf(r), this.app.multilineOf(r));
  }

  /**
   * Rows of record r. A collapsed record is not parsed for this: it has one row, or two when
   * it is already known to be invalid. The view lays out again when more errors are found.
   */
  private recordHeight(r: number): number {
    const m = this.app.model;
    if (!this.isExpanded(r)) return m.kind(r) === K_ERROR ? 2 : 1;
    if (this.app.expandAll) {
      if (!this.allHeights || this.allHeights.length < m.count) {
        const next = new Int32Array(Math.max(m.count, (this.allHeights?.length ?? 512) * 2));
        if (this.allHeights) next.set(this.allHeights);
        this.allHeights = next;
      }
      let h = this.allHeights[r];
      if (!h) {
        h = this.computeRecordHeight(r);
        this.allHeights[r] = h;
      }
      return h;
    }
    let h = this.heights.get(r);
    if (h === undefined) {
      h = this.computeRecordHeight(r);
      this.heights.set(r, h);
    }
    return h;
  }

  private layout(): void {
    const app = this.app;
    const m = app.model;
    if (this.modelRef !== m || this.modelRev !== m.revision) {
      this.modelRef = m;
      this.modelRev = m.revision;
      this.heights.clear();
      this.allHeights = null;
      this.lineCache.clear();
      this.measured.clear();
      this.measuredExpanded.clear();
    }
    if (!m.isJsonl) this.recs = [0];
    else this.recs = app.formattedRecords();
    this.recCount = this.recs ? this.recs.length : m.count;
    const n = this.recCount;
    const off = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + this.recordHeight(this.recAt(i));
    this.offsets = off;
    this.total = off[n];
    this.errorsSeen = m.errorsVersion;
    if (app.state.wrap) this.buildRowPx();
    else {
      this.rowBit = null;
      this.rowCur = null;
      this.rowTotalPx = 0;
      this.highBit = 0;
    }
    this.applyScrollHeight();
    // A new search result: the match that was in focus belongs to the old one.
    if (app.matchesVersion !== this.matchesSeen) {
      this.matchesSeen = app.matchesVersion;
      this.focusPath = null;
    }
  }

  private applyScrollHeight(): void {
    const full = this.topOf(this.total);
    const vh = this.scroller.clientHeight || 600;
    if (full > MAX_SCROLL_PX && full > vh) {
      this.ratio = (MAX_SCROLL_PX - vh) / (full - vh);
      this.spacer.style.height = `${MAX_SCROLL_PX}px`;
    } else {
      this.ratio = 1;
      this.spacer.style.height = `${full}px`;
    }
  }

  private virtTop(): number {
    return this.scroller.scrollTop / this.ratio;
  }

  private toScrollTop(virtY: number): number {
    const full = this.topOf(this.total);
    const vh = this.scroller.clientHeight || 600;
    return Math.max(0, Math.min(Math.max(0, full - vh), virtY)) * this.ratio;
  }

  /** Top of row k in unscaled px. */
  private topOf(k: number): number {
    const clamped = Math.max(0, Math.min(k, this.total));
    if (!this.rowBit) return clamped * this.app.rh;
    if (clamped === 0) return 0;
    if (clamped >= this.total) return this.rowTotalPx;
    let sum = 0;
    for (let i = clamped; i > 0; i -= i & -i) sum += this.rowBit[i];
    return sum;
  }

  /** The row at unscaled px y. */
  private rowAt(y: number): number {
    if (this.total <= 1 || y <= 0) return 0;
    if (!this.rowBit) return Math.min(this.total - 1, Math.floor(y / this.app.rh));
    const bit = this.rowBit;
    const n = this.total;
    let idx = 0;
    let sum = 0;
    for (let step = this.highBit; step > 0; step = Math.floor(step / 2)) {
      const next = idx + step;
      if (next <= n && sum + bit[next] <= y) {
        idx = next;
        sum += bit[next];
      }
    }
    return Math.min(idx, n - 1);
  }

  /** Top of record r in unscaled virtual px, or -1 when it is not shown. */
  private recordVirtTop(r: number): number {
    const i = this.indexOf(r);
    if (i < 0 || i >= this.offsets.length - 1) return -1;
    return this.topOf(this.offsets[i]);
  }

  // ---------- word wrap ----------

  private rowKey(r: number, j: number): number | string {
    const expanded = this.isExpanded(r);
    return j === 0 && !expanded ? r : `${r}:${expanded ? 'e' : 'c'}:${j}`;
  }

  private setMeasured(r: number, key: number | string, h: number): void {
    if (this.measured.has(key)) this.measured.delete(key);
    else if (this.measured.size >= MEASURED_CACHE) {
      const oldest = this.measured.keys().next().value;
      if (oldest !== undefined) this.measured.delete(oldest);
    }
    this.measured.set(key, h);
    if (typeof key === 'string') this.measuredExpanded.add(r);
  }

  private forgetMeasured(r: number): void {
    this.measured.delete(r);
    if (this.measuredExpanded.delete(r)) {
      const prefix = `${r}:`;
      for (const k of [...this.measured.keys()]) if (typeof k === 'string' && k.startsWith(prefix)) this.measured.delete(k);
    }
  }

  /** Characters per visual line, from the width of the text column and the font. */
  private columns(): number {
    if (this.wrapCols) return this.wrapCols;
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(100);
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
    this.rows.appendChild(probe);
    const charW = probe.getBoundingClientRect().width / 100 || 7.2;
    probe.remove();
    const width = (this.scroller.clientWidth || 800) - 56 - 18 - 12;
    this.wrapCols = Math.max(10, Math.floor(width / charW));
    return this.wrapCols;
  }

  private wrapLines(text: string, indentCols = 0): number {
    const cols = this.columns() - indentCols;
    return Math.max(1, Math.ceil(visualColumns(text) / Math.max(10, cols)));
  }

  private estimate(r: number, j: number): number {
    const rh = this.app.rh;
    const m = this.app.model;
    if (j === 1 && m.kind(r) === K_ERROR) return rh;
    if (m.kind(r) === K_ERROR || !this.isExpanded(r)) {
      // O(1) length estimate: no line is decoded or regex-scanned off screen; on-screen rows are measured.
      return Math.max(1, Math.ceil(Math.min(m.lineSize(r), WRAP_PREVIEW_CHARS) / Math.max(10, this.columns()))) * rh;
    }
    const l = this.lineCache.get(r)?.[j];
    if (!l) return rh;
    const indent = l.d * this.app.config.indent;
    return this.wrapLines(lineText(l), indent) * rh;
  }

  private buildRowPx(): void {
    const n = this.total;
    if (n <= 0) {
      this.rowBit = null;
      this.rowCur = null;
      this.rowTotalPx = 0;
      this.highBit = 0;
      return;
    }
    const bit = new Float64Array(n + 1);
    const cur = new Float32Array(n);
    const hasMeasured = this.measured.size > 0;
    let k = 0;
    let totalPx = 0;
    for (let i = 0; i < this.recCount; i++) {
      const r = this.recAt(i);
      const h = this.offsets[i + 1] - this.offsets[i];
      const expanded = this.isExpanded(r);
      const recMeasured = hasMeasured && (expanded ? this.measuredExpanded.has(r) : this.measured.has(r));
      for (let j = 0; j < h; j++, k++) {
        const px = (recMeasured ? this.measured.get(this.rowKey(r, j)) : undefined) ?? this.estimate(r, j);
        cur[k] = px;
        totalPx += px;
        const idx = k + 1;
        bit[idx] += px;
        const parent = idx + (idx & -idx);
        if (parent <= n) bit[parent] += bit[idx];
      }
    }
    let hb = 1;
    while (hb * 2 <= n) hb *= 2;
    this.rowBit = bit;
    this.rowCur = cur;
    this.rowTotalPx = totalPx;
    this.highBit = hb;
  }

  /** Updates the Fenwick tree in O(log n) with the real height of the rows on screen. */
  private measureRows(): boolean {
    if (!this.rowBit || !this.rowCur) return false;
    let changed = false;
    const bit = this.rowBit;
    const cur = this.rowCur;
    const n = this.total;
    for (const el of Array.from(this.rows.children) as HTMLElement[]) {
      if (!el.classList.contains('row')) continue;
      const r = Number(el.dataset.r);
      const j = Number(el.dataset.j);
      const k = Number(el.dataset.row);
      const key = this.rowKey(r, j);
      const h = el.offsetHeight;
      this.setMeasured(r, key, h);
      if (k >= 0 && k < n && Math.abs(h - cur[k]) > 0.5) {
        const delta = h - cur[k];
        cur[k] = h;
        this.rowTotalPx += delta;
        for (let idx = k + 1; idx <= n; idx += idx & -idx) bit[idx] += delta;
        changed = true;
      }
    }
    return changed;
  }

  private linesOf(r: number): PLine[] {
    let lines = this.lineCache.get(r);
    if (!lines) {
      const v = this.app.model.value(r);
      lines = v === undefined ? [] : buildLines(v, this.app.foldsOf(r), this.app.foldDepthOf(), this.app.unpackedOf(r), this.app.multilineOf(r));
      if (this.lineCache.size >= LINE_CACHE) this.lineCache.delete(this.lineCache.keys().next().value as number);
      this.lineCache.set(r, lines);
    }
    return lines;
  }

  // ---------- painting ----------

  private paint(): void {
    if (this.el.hidden || !this.app.model) return;
    const app = this.app;
    const vh = this.scroller.clientHeight || 600;
    const st = this.scroller.scrollTop;
    const virtTop = st / this.ratio;
    const first = Math.max(0, this.rowAt(virtTop) - 4);
    const last = Math.min(this.total, this.rowAt(virtTop + vh) + 5);
    this.rows.style.transform = `translateY(${st + this.topOf(first) - virtTop}px)`;
    if (this.total === 0) {
      const note = app.model.loading
        ? t('Loading…')
        : app.searching
          ? t('Searching…')
          : app.recsFiltered()
            ? t('No line matches the search.')
            : t('The file is empty.');
      this.rows.innerHTML = `<div class="empty-note">${note}</div>`;
      this.rendered = 0;
      return;
    }
    // Find the record that holds row `first`.
    let lo = 0;
    let hi = this.recCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= first) lo = mid;
      else hi = mid - 1;
    }
    const html: string[] = [];
    let row = first;
    let i = lo;
    this.firstRecord = this.recAt(lo);
    while (row < last && i < this.recCount) {
      const r = this.recAt(i);
      const start = this.offsets[i];
      const h = this.offsets[i + 1] - start;
      for (let j = row - start; j < h && row < last; j++, row++) html.push(this.rowHtml(r, j, h, row));
      i++;
    }
    const focus = this.focusedControl();
    this.rows.innerHTML = html.join('');
    this.rendered = html.length;
    if (focus) this.refocus(focus);
    if (isTextQuery(app.query)) this.markMatches(app.query);
    if (this.rowBit && !this.remeasuring) {
      const anchor = this.rowAt(virtTop);
      const into = virtTop - this.topOf(anchor);
      if (this.measureRows()) {
        // Keep the row at the top of the screen still while the heights above it change.
        this.applyScrollHeight();
        this.remeasuring = true;
        this.scroller.scrollTop = this.toScrollTop(this.topOf(anchor) + into);
        this.paint();
        this.remeasuring = false;
      }
    }
    // Painting parsed the rows on screen. A record that turned out to be invalid needs a second row.
    if (app.model.errorsVersion !== this.errorsSeen && !this.relayout) {
      this.relayout = requestAnimationFrame(() => {
        this.relayout = 0;
        if (!this.el.hidden && this.app.model.errorsVersion !== this.errorsSeen) this.refresh();
      });
    }
  }

  /**
   * The button in a row that has the keyboard focus. Painting replaces the rows, so the focus
   * is put back on the same button of the same row (a fold arrow stays under the fingers).
   */
  private focusedControl(): { r: string; j: string; kind: string } | null {
    const a = document.activeElement;
    if (!(a instanceof HTMLElement) || !this.rows.contains(a)) return null;
    const row = a.closest('.row') as HTMLElement | null;
    if (!row) return null;
    const kind = a.classList.contains('rbtn')
      ? `.rbtn.${a.classList[1]}`
      : a.hasAttribute('data-unpack')
        ? '[data-unpack]'
        : a.hasAttribute('data-ml')
          ? '[data-ml]'
          : '.fold';
    return { r: row.dataset.r as string, j: row.dataset.j as string, kind };
  }

  private refocus(f: { r: string; j: string; kind: string }): void {
    const row = this.rows.querySelector(`.row[data-r="${f.r}"][data-j="${f.j}"]`);
    // A placeholder ("… 3 keys") that was opened is gone: the fold arrow of its line takes the focus.
    const el = (row?.querySelector(f.kind) ?? row?.querySelector('.fold')) as HTMLElement | null;
    el?.focus({ preventScroll: true });
  }

  private rowHtml(r: number, j: number, h: number, rowIdx: number): string {
    const app = this.app;
    const m = app.model;
    const s = app.state;
    const p = m.get(r);
    const cls = ['row'];
    if (m.isJsonl) {
      if (s.selected.has(r)) cls.push('sel');
      if (s.active === r) cls.push('act');
      if (s.bookmarks.has(r)) cls.push('bookmarked');
    }
    if (j === 0) cls.push('first');
    if (j === h - 1) cls.push('last');
    const jsonl = m.isJsonl;
    const wrap = s.wrap;
    const preview = wrap ? WRAP_PREVIEW_CHARS : RAW_PREVIEW_CHARS;
    let indentStyle = '';
    const gutter = jsonl ? (j === 0 ? String(r + 1) : '') : String(j + 1);
    let fold = '';
    let code = '';
    let actions = '';
    let path = '';
    if (p.kind === 'blank') {
      cls.push('blank');
    } else if (p.kind === 'error') {
      cls.push('err');
      if (j === 0) {
        fold = `<span class="mark-err" title="${t('Invalid JSON')}">${icon('warning', 12)}</span>`;
        code = this.rawHtml(r, preview);
        actions = this.actionsHtml(r);
      } else {
        const col = p.offset !== undefined ? t(', col {0}', p.offset + 1) : '';
        code = `<span class="err-msg">${esc(t('{0} · line {1}', p.message, r + 1) + col)}</span>`;
      }
    } else if (!this.isExpanded(r)) {
      cls.push('collapsed');
      fold = `<button class="fold closed" data-expand="1" aria-expanded="false" aria-label="${t('Expand')}" title="${t('Expand')}">${icon('chev-right', 12)}</button>`;
      code = this.rawHtml(r, preview);
    } else {
      const l = this.linesOf(r)[j];
      if (l) {
        path = l.path;
        if (l.kind === 'open') fold = `<button class="fold" data-k="${esc(l.path)}" aria-expanded="true" aria-label="${t('Fold')}" title="${t('Fold')}">${icon('chev-down', 12)}</button>`;
        else if (l.kind === 'folded') fold = `<button class="fold closed" data-k="${esc(l.path)}" aria-expanded="false" aria-label="${t('Unfold')}" title="${t('Unfold')}">${icon('chev-right', 12)}</button>`;
        code = lineHtml(l, app.config.indent, !wrap);
        // Hanging indent: wrapped parts of a line start under its first character.
        if (wrap && l.d) indentStyle = ` style="padding-left:${l.d * app.config.indent}ch"`;
        if (!jsonl && l.path === this.focusPath && l.kind !== 'close') cls.push('hit');
      }
      if (j === 0 && jsonl) actions = this.actionsHtml(r);
    }
    return `<div class="${cls.join(' ')}" data-r="${r}" data-j="${j}" data-row="${rowIdx}"${path ? ` data-p="${esc(path)}"` : ''}><span class="gut">${gutter}</span><span class="fg">${fold}</span><span class="code-text"${indentStyle}>${code}</span>${actions}</div>`;
  }

  /** The start of the raw line, highlighted. Only that part is read from the store. */
  private rawHtml(r: number, preview: number): string {
    const m = this.app.model;
    const raw = m.head(r, preview + 1);
    const trunc = raw.length > preview;
    const shown = trunc ? raw.slice(0, preview) : raw;
    let more = 0;
    if (trunc) {
      const size = m.lineSize(r);
      more = m.large ? Math.max(1, size - new TextEncoder().encode(shown).length) : Math.max(1, size - shown.length);
    }
    return highlightRaw(shown) + (more > 0 ? this.truncNote(more, m.large) : '');
  }

  private actionsHtml(r: number): string {
    const edit = this.app.readOnly ? '' : `<button class="rbtn a-edit" data-r="${r}" title="${t('Edit this record (Enter)')}">${icon('edit', 12)}${t('Edit')}</button>`;
    const goto = this.app.canRevealSource ? `<button class="rbtn a-goto" data-r="${r}" title="${t('Reveal in the text editor')}">${icon('goto', 12)}${t('Source')}</button>` : '';
    return `<span class="acts">${edit}<button class="rbtn a-copy" data-r="${r}" title="${t('Copy the raw line')}">${icon('copy', 12)}${t('Copy')}</button>${goto}</span>`;
  }

  private truncNote(more: number, bytes: boolean): string {
    return `<span class="trunc">${t(bytes ? ' … about {0} more bytes' : ' … {0} more chars', more.toLocaleString())}</span>`;
  }

  /** Marks plain-text or regex matches in `.code-text`, including matches spanning several token spans. */
  private markMatches(query: Query): void {
    if (!query.text || (query.regex && !query.re)) return;
    for (const codeEl of Array.from(this.rows.querySelectorAll<HTMLElement>('.code-text'))) {
      const full = codeEl.textContent ?? '';
      if (!query.re) {
        const hay = query.caseSensitive ? full : full.toLowerCase();
        if (!hay.includes(query.text)) continue;
      }
      const nodes: { node: Text; start: number; end: number }[] = [];
      const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT);
      let clean = '';
      let cur: Node | null;
      while ((cur = walker.nextNode())) {
        const textNode = cur as Text;
        if (textNode.parentElement?.closest('.trunc, .ph, .pill')) continue;
        const start = clean.length;
        clean += textNode.data;
        nodes.push({ node: textNode, start, end: clean.length });
      }
      const spans = findSpans(clean, query);
      if (!spans.length) continue;
      for (const { node, start, end } of nodes) {
        const text = node.data;
        let localPos = 0;
        let hit = false;
        const frag = document.createDocumentFragment();
        for (const [ms, me] of spans) {
          if (me <= start) continue;
          if (ms >= end) break;
          const a = Math.max(localPos, Math.min(text.length, ms - start));
          const b = Math.max(a, Math.min(text.length, me - start));
          if (b <= a) continue;
          hit = true;
          if (a > localPos) frag.appendChild(document.createTextNode(text.slice(localPos, a)));
          const mark = document.createElement('mark');
          mark.textContent = text.slice(a, b);
          frag.appendChild(mark);
          localPos = b;
        }
        if (hit) {
          if (localPos < text.length) frag.appendChild(document.createTextNode(text.slice(localPos)));
          node.replaceWith(frag);
        }
      }
    }
  }

  // ---------- events ----------

  private onClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const rowEl = target.closest('.row') as HTMLElement | null;
    if (!rowEl) return;
    const r = Number(rowEl.dataset.r);
    const app = this.app;
    const act = target.closest('.rbtn') as HTMLElement | null;
    if (act) {
      if (act.classList.contains('a-edit')) app.openEditor(r);
      else if (act.classList.contains('a-copy')) app.post({ type: 'copy', text: app.model.line(r) });
      else if (act.classList.contains('a-goto')) app.reveal(r, []);
      return;
    }
    const unpackEl = target.closest('[data-unpack]') as HTMLElement | null;
    if (unpackEl) {
      app.toggleUnpack(r, unpackEl.dataset.unpack as string);
      return;
    }
    const mlEl = target.closest('[data-ml]') as HTMLElement | null;
    if (mlEl) {
      app.toggleMultiline(r, mlEl.dataset.ml as string);
      return;
    }
    const foldEl = target.closest('[data-k]') as HTMLElement | null;
    if (foldEl) {
      const key = foldEl.dataset.k as string;
      const f = app.folds(r);
      if (f.has(key)) f.delete(key);
      else f.add(key);
      this.invalidateRecord(r);
      this.render(r);
      app.stateChanged();
      return;
    }
    if (e.altKey && target.closest('.gut') && app.model.isJsonl) {
      app.toggleBookmark(r);
      return;
    }
    if (!app.model.isJsonl) return;
    const how = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'set';
    if (how === 'set' && app.state.selected.size === 1 && app.state.selected.has(r) && !target.closest('[data-expand]')) {
      app.post({ type: 'select', line: r });
      return;
    }
    app.selectRecord(r, how);
  }

  private onDblClick(e: MouseEvent): void {
    const rowEl = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (!rowEl || (e.target as HTMLElement).closest('.rbtn,[data-k],[data-unpack],[data-ml]')) return;
    const r = Number(rowEl.dataset.r);
    const pathKey = rowEl.dataset.p ?? '';
    const path = pathKey ? decodeKey(pathKey) : [];
    window.getSelection()?.removeAllRanges();
    if (!this.app.canRevealSource) {
      const val = resolveAtPathKey(this.app.model.value(r), pathKey, this.app.unpackedOf(r));
      this.app.openValueInspector(r, path, val);
      return;
    }
    this.app.reveal(r, path);
  }

  private onContextMenu(e: MouseEvent): void {
    const rowEl = (e.target as HTMLElement).closest('.row') as HTMLElement | null;
    if (!rowEl) return;
    e.preventDefault();
    const r = Number(rowEl.dataset.r);
    if (this.app.model.isJsonl && !this.app.state.selected.has(r)) this.app.selectRecord(r, 'set');
    const pathKey = rowEl.dataset.p ?? '';
    const path = pathKey ? decodeKey(pathKey) : [];
    const root = this.app.model.value(r);
    const val = resolveAtPathKey(root, pathKey, this.app.unpackedOf(r));
    this.app.openContextMenu(e, { record: r, path, value: val, hasValue: root !== undefined && (pathKey === '' || val !== undefined) });
  }

  private onHover(e: MouseEvent): void {
    const tok = (e.target as HTMLElement).closest('.ts, .tn') as HTMLElement | null;
    if (!tok || tok.dataset.tip === '1') return;
    tok.dataset.tip = '1';
    const rowEl = tok.closest('.row') as HTMLElement | null;
    if (!rowEl) return;
    const r = Number(rowEl.dataset.r);
    let val: JVal | undefined;
    if (rowEl.dataset.p !== undefined) {
      val = resolveAtPathKey(this.app.model.value(r), rowEl.dataset.p, this.app.unpackedOf(r));
    } else {
      try {
        val = parseJson(tok.textContent ?? '');
      } catch {
        val = undefined;
      }
    }
    if (val === undefined) return;
    const tip = this.app.smartTooltip(r, val);
    if (tip) tok.title = tip;
  }
}

/** Finds non-overlapping `[start, end)` UTF-16 match spans in `clean`, preserving indices even under case-folding expansion (`İ`). */
function findSpans(clean: string, query: Query): [number, number][] {
  const spans: [number, number][] = [];
  if (query.re) {
    const flags = query.re.flags.includes('g') ? query.re.flags : query.re.flags + 'g';
    const re = new RegExp(query.re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) {
      if (m[0].length > 0) spans.push([m.index, m.index + m[0].length]);
      else re.lastIndex = m.index + (clean.codePointAt(m.index)! > 0xffff ? 2 : 1);
      if (spans.length >= 2000) break;
    }
    return spans;
  }
  const needle = query.text;
  if (!needle) return spans;
  if (query.caseSensitive) {
    let pos = 0;
    let k: number;
    while ((k = clean.indexOf(needle, pos)) >= 0) {
      spans.push([k, k + needle.length]);
      pos = k + needle.length;
    }
    return spans;
  }
  const lower = clean.toLowerCase();
  if (lower.length === clean.length) {
    let pos = 0;
    let k: number;
    while ((k = lower.indexOf(needle, pos)) >= 0) {
      spans.push([k, k + needle.length]);
      pos = k + needle.length;
    }
    return spans;
  }
  const map: number[] = [];
  for (let i = 0; i < clean.length; ) {
    const cp = clean.codePointAt(i)!;
    const step = cp > 0xffff ? 2 : 1;
    const folded = clean.slice(i, i + step).toLowerCase();
    for (let f = 0; f < folded.length; f++) map.push(i);
    i += step;
  }
  map.push(clean.length);
  let pos = 0;
  let k: number;
  while ((k = lower.indexOf(needle, pos)) >= 0) {
    const a = map[k];
    const endIdx = k + needle.length;
    let b = map[endIdx];
    while (b === a && b < clean.length) b++;
    spans.push([a, b]);
    pos = endIdx;
  }
  return spans;
}
