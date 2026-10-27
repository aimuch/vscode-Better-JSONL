import type { RenderReport } from '../../shared/protocol';
import type { App, View } from '../app';
import { decodeKey, esc, highlightRaw } from '../json';
import { icon } from '../icons';
import { buildLines, containerKeys, countLines, lineHtml, lineText, type PLine } from './lines';

/** Browsers cap element height near 33.5M px. Above this the scroll space is scaled. */
const MAX_SCROLL_PX = 30_000_000;
const RAW_PREVIEW_CHARS = 2000;
/** With word wrap on, more of a long line is shown (it wraps instead of being cut). */
const WRAP_PREVIEW_CHARS = 20000;
const LINE_CACHE = 300;
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
 * estimated from its text, then measured once it is on screen.
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
  private readonly lineCache = new Map<number, PLine[]>();
  private modelRef: unknown;
  private rendered = 0;
  private firstRecord = 0;
  /** JSON mode: pretty line numbers that match the search. */
  private lineMatches: number[] = [];
  private focusLine = -1;
  /** Word wrap: top of every row in px (length total + 1), or null when not wrapping. */
  private rowPx: Float64Array | null = null;
  /** Word wrap: measured row heights, by "record:state:line". */
  private readonly measured = new Map<string, number>();
  /** Word wrap: estimated height of collapsed and error rows, by record. */
  private readonly estimates = new Map<number, number>();
  private wrapCols = 0;
  private lastWidth = 0;
  private remeasuring = false;

  constructor(private readonly app: App) {
    this.el = document.createElement('div');
    this.el.className = 'view formatted';
    this.el.innerHTML = `<div class="scroller" tabindex="0" aria-label="Formatted records"><div class="spacer"><div class="rows code"></div></div></div>`;
    this.scroller = this.el.querySelector('.scroller') as HTMLElement;
    this.spacer = this.el.querySelector('.spacer') as HTMLElement;
    this.rows = this.el.querySelector('.rows') as HTMLElement;
    this.scroller.addEventListener('scroll', () => this.paint(), { passive: true });
    new ResizeObserver(() => {
      const w = this.scroller.clientWidth;
      if (this.app.state?.wrap && w !== this.lastWidth) {
        this.lastWidth = w;
        this.onWrapChanged();
        this.layout();
      }
      this.paint();
    }).observe(this.scroller);
    this.rows.addEventListener('click', (e) => this.onClick(e));
    this.rows.addEventListener('dblclick', (e) => this.onDblClick(e));
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  render(anchor?: number): void {
    const before = anchor !== undefined ? this.rowTopPx(anchor) - this.scroller.scrollTop : undefined;
    this.layout();
    if (anchor !== undefined && before !== undefined) {
      const after = this.rowTopPx(anchor);
      if (after >= 0) this.scroller.scrollTop = after - before;
    }
    this.paint();
  }

  onWrapChanged(): void {
    this.measured.clear();
    this.estimates.clear();
    this.wrapCols = 0;
  }

  onActiveChanged(scroll: boolean): void {
    if (!scroll) return;
    const r = this.app.state.active;
    const top = this.rowTopPx(r);
    if (top < 0) return;
    const i = this.indexOf(r);
    const h = (this.topOf(this.offsets[i + 1]) - this.topOf(this.offsets[i])) * this.ratio;
    const st = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight;
    if (top < st || top + Math.min(h, vh) > st + vh) this.scroller.scrollTop = Math.max(0, top - vh / 3);
    this.paint();
  }

  stepMatch(dir: 1 | -1): void {
    const app = this.app;
    if (!app.query.text) return;
    if (!app.model.isJsonl) {
      if (!this.lineMatches.length) return;
      const cur = this.focusLine;
      const next =
        dir > 0
          ? (this.lineMatches.find((l) => l > cur) ?? this.lineMatches[0])
          : ([...this.lineMatches].reverse().find((l) => l < cur) ?? this.lineMatches[this.lineMatches.length - 1]);
      this.focusLine = next;
      const top = this.topOf(next) * this.ratio;
      this.scroller.scrollTop = Math.max(0, top - this.scroller.clientHeight / 3);
      this.paint();
      return;
    }
    const ms = app.matches;
    if (!ms.length) return;
    const a = app.state.active;
    const next = dir > 0 ? (ms.find((r) => r > a) ?? ms[0]) : ([...ms].reverse().find((r) => r < a) ?? ms[ms.length - 1]);
    app.selectRecord(next);
    this.onActiveChanged(true);
  }

  foldAll(collapse: boolean): void {
    const app = this.app;
    const v = app.model.value(0);
    const f = app.folds(0);
    f.clear();
    if (collapse && v !== undefined) for (const k of containerKeys(v)) f.add(k);
    this.heights.delete(0);
    this.lineCache.delete(0);
    this.forgetMeasured(0);
    this.scroller.scrollTop = 0;
    this.render();
    app.scheduleReport();
  }

  fillReport(r: RenderReport): void {
    let expanded = 0;
    for (let i = 0; i < this.recCount; i++) {
      const r = this.recAt(i);
      if (this.app.model.get(r).kind === 'value' && this.isExpanded(r)) expanded++;
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
    return !app.model.isJsonl || app.state.expandMode === 'all' || app.state.selected.has(r);
  }

  private recordHeight(r: number): number {
    const p = this.app.model.get(r);
    if (p.kind === 'blank') return 1;
    if (p.kind === 'error') return 2;
    if (!this.isExpanded(r)) return 1;
    let h = this.heights.get(r);
    if (h === undefined) {
      h = countLines(p.value, this.app.folds(r));
      this.heights.set(r, h);
    }
    return h;
  }

  private layout(): void {
    const app = this.app;
    const m = app.model;
    if (this.modelRef !== m) {
      this.modelRef = m;
      this.heights.clear();
      this.lineCache.clear();
      this.measured.clear();
      this.estimates.clear();
    }
    if (!m.isJsonl) this.recs = [0];
    else if (app.state.filterOnly && app.query.text) this.recs = app.matches;
    else this.recs = null;
    this.recCount = this.recs ? this.recs.length : m.count;
    const n = this.recCount;
    const off = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + this.recordHeight(this.recAt(i));
    this.offsets = off;
    this.total = off[n];
    this.rowPx = app.state.wrap ? this.buildRowPx() : null;
    this.applyScrollHeight();
    this.lineMatches = !m.isJsonl && app.query.text && !app.query.path ? this.findLineMatches() : [];
  }

  private applyScrollHeight(): void {
    const full = this.topOf(this.total);
    this.ratio = full > MAX_SCROLL_PX ? MAX_SCROLL_PX / full : 1;
    this.spacer.style.height = `${full * this.ratio}px`;
  }

  /** Top of row k in unscaled px. */
  private topOf(k: number): number {
    return this.rowPx ? this.rowPx[Math.min(k, this.total)] : k * this.app.rh;
  }

  /** The row at unscaled px y. */
  private rowAt(y: number): number {
    if (!this.rowPx) return Math.floor(y / this.app.rh);
    let lo = 0;
    let hi = this.total - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.rowPx[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  /** Top of record r in scroller px, or -1 when it is not shown. */
  private rowTopPx(r: number): number {
    const i = this.indexOf(r);
    if (i < 0 || i >= this.offsets.length - 1) return -1;
    return this.topOf(this.offsets[i]) * this.ratio;
  }

  // ---------- word wrap ----------

  private rowKey(r: number, j: number): string {
    return `${r}:${this.isExpanded(r) ? 'e' : 'c'}:${j}`;
  }

  private forgetMeasured(r: number): void {
    const prefix = `${r}:`;
    for (const k of [...this.measured.keys()]) if (k.startsWith(prefix)) this.measured.delete(k);
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
    const p = this.app.model.get(r);
    if (p.kind === 'blank') return rh;
    if (p.kind === 'error' && j === 1) return rh;
    if (p.kind === 'error' || !this.isExpanded(r)) {
      let e = this.estimates.get(r);
      if (e === undefined) {
        e = this.wrapLines(this.app.model.lines[r].slice(0, WRAP_PREVIEW_CHARS)) * rh;
        this.estimates.set(r, e);
      }
      return e;
    }
    const l = this.lineCache.get(r)?.[j];
    if (!l) return rh;
    const indent = l.d * this.app.config.indent;
    return this.wrapLines(lineText(l), indent) * rh;
  }

  private buildRowPx(): Float64Array {
    const px = new Float64Array(this.total + 1);
    let k = 0;
    for (let i = 0; i < this.recCount; i++) {
      const r = this.recAt(i);
      const h = this.offsets[i + 1] - this.offsets[i];
      for (let j = 0; j < h; j++, k++) px[k + 1] = px[k] + (this.measured.get(this.rowKey(r, j)) ?? this.estimate(r, j));
    }
    return px;
  }

  /** Records the real height of the rows on screen. Returns true when an estimate was wrong. */
  private measureRows(): boolean {
    let changed = false;
    for (const el of Array.from(this.rows.children) as HTMLElement[]) {
      if (!el.classList.contains('row')) continue;
      const r = Number(el.dataset.r);
      const j = Number(el.dataset.j);
      const key = this.rowKey(r, j);
      const h = el.offsetHeight;
      const known = this.measured.get(key) ?? this.estimate(r, j);
      this.measured.set(key, h);
      if (Math.abs(h - known) > 0.5) changed = true;
    }
    return changed;
  }

  private linesOf(r: number): PLine[] {
    let lines = this.lineCache.get(r);
    if (!lines) {
      const v = this.app.model.value(r);
      lines = v === undefined ? [] : buildLines(v, this.app.folds(r));
      if (this.lineCache.size >= LINE_CACHE) this.lineCache.delete(this.lineCache.keys().next().value as number);
      this.lineCache.set(r, lines);
    }
    return lines;
  }

  private findLineMatches(): number[] {
    const q = this.app.query.text;
    const out: number[] = [];
    this.linesOf(0).forEach((l, i) => {
      if (lineText(l).toLowerCase().includes(q)) out.push(i);
    });
    return out;
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
      this.rows.innerHTML = `<div class="empty-note">${app.state.filterOnly && app.query.text ? 'No line matches the search.' : 'The file is empty.'}</div>`;
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
      for (let j = row - start; j < h && row < last; j++, row++) html.push(this.rowHtml(r, j, h));
      i++;
    }
    this.rows.innerHTML = html.join('');
    this.rendered = html.length;
    if (app.query.text && !app.query.path) this.markMatches(app.query.text);
    if (this.rowPx && !this.remeasuring && this.measureRows()) {
      // Keep the row at the top of the screen still while the heights above it change.
      const anchor = this.rowAt(virtTop);
      const into = virtTop - this.topOf(anchor);
      this.rowPx = this.buildRowPx();
      this.applyScrollHeight();
      this.remeasuring = true;
      this.scroller.scrollTop = (this.topOf(anchor) + into) * this.ratio;
      this.paint();
      this.remeasuring = false;
    }
  }

  private rowHtml(r: number, j: number, h: number): string {
    const app = this.app;
    const m = app.model;
    const s = app.state;
    const p = m.get(r);
    const cls = ['row'];
    if (m.isJsonl) {
      if (s.selected.has(r)) cls.push('sel');
      if (s.active === r) cls.push('act');
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
        fold = `<span class="mark-err" title="Invalid JSON">${icon('warning', 12)}</span>`;
        const raw = m.lines[r];
        code = highlightRaw(raw.slice(0, preview)) + (raw.length > preview ? this.truncNote(raw.length, preview) : '');
        actions = this.actionsHtml(r);
      } else {
        const col = p.offset !== undefined ? `, col ${p.offset + 1}` : '';
        code = `<span class="err-msg">${esc(`${p.message} · line ${r + 1}${col}`)}</span>`;
      }
    } else if (!this.isExpanded(r)) {
      cls.push('collapsed');
      const raw = m.lines[r];
      fold = `<span class="fold closed" data-expand="1" title="Expand">${icon('chev-right', 12)}</span>`;
      code = highlightRaw(raw.slice(0, preview)) + (raw.length > preview ? this.truncNote(raw.length, preview) : '');
    } else {
      const l = this.linesOf(r)[j];
      if (l) {
        path = l.path;
        if (l.kind === 'open') fold = `<span class="fold" data-k="${esc(l.path)}" title="Fold">${icon('chev-down', 12)}</span>`;
        else if (l.kind === 'folded') fold = `<span class="fold closed" data-k="${esc(l.path)}" title="Unfold">${icon('chev-right', 12)}</span>`;
        code = lineHtml(l, app.config.indent, !wrap);
        // Hanging indent: wrapped parts of a line start under its first character.
        if (wrap && l.d) indentStyle = ` style="padding-left:${l.d * app.config.indent}ch"`;
        if (!jsonl && this.focusLine === j) cls.push('hit');
      }
      if (j === 0 && jsonl) actions = this.actionsHtml(r);
    }
    return `<div class="${cls.join(' ')}" data-r="${r}" data-j="${j}"${path ? ` data-p="${esc(path)}"` : ''}><span class="gut">${gutter}</span><span class="fg">${fold}</span><span class="code-text"${indentStyle}>${code}</span>${actions}</div>`;
  }

  private actionsHtml(r: number): string {
    return `<span class="acts"><button class="rbtn a-edit" data-r="${r}" title="Edit this record (Enter)">${icon('edit', 12)}Edit</button><button class="rbtn a-copy" data-r="${r}" title="Copy the raw line">${icon('copy', 12)}Copy</button><button class="rbtn a-goto" data-r="${r}" title="Reveal in the text editor">${icon('goto', 12)}Source</button></span>`;
  }

  private truncNote(len: number, shown: number): string {
    return `<span class="trunc"> … ${(len - shown).toLocaleString()} more chars</span>`;
  }

  private markMatches(q: string): void {
    const walker = document.createTreeWalker(this.rows, NodeFilter.SHOW_TEXT);
    const hits: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = n as Text;
      if (t.data.toLowerCase().includes(q) && !(t.parentElement?.closest('.gut,.acts'))) hits.push(t);
    }
    for (const t of hits) {
      const text = t.data;
      const lower = text.toLowerCase();
      const frag = document.createDocumentFragment();
      let pos = 0;
      let k: number;
      while ((k = lower.indexOf(q, pos)) >= 0) {
        if (k > pos) frag.appendChild(document.createTextNode(text.slice(pos, k)));
        const mark = document.createElement('mark');
        mark.textContent = text.slice(k, k + q.length);
        frag.appendChild(mark);
        pos = k + q.length;
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
      t.replaceWith(frag);
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
      else if (act.classList.contains('a-copy')) app.post({ type: 'copy', text: app.model.lines[r] });
      else app.post({ type: 'reveal', line: r, path: [] });
      return;
    }
    const foldEl = target.closest('[data-k]') as HTMLElement | null;
    if (foldEl) {
      const key = foldEl.dataset.k as string;
      const f = app.folds(r);
      if (f.has(key)) f.delete(key);
      else f.add(key);
      this.heights.delete(r);
      this.lineCache.delete(r);
      this.forgetMeasured(r);
      this.render(r);
      app.scheduleReport();
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
    if (!rowEl || (e.target as HTMLElement).closest('.rbtn,[data-k]')) return;
    const r = Number(rowEl.dataset.r);
    const path = rowEl.dataset.p ? decodeKey(rowEl.dataset.p) : [];
    window.getSelection()?.removeAllRanges();
    this.app.post({ type: 'reveal', line: this.app.model.isJsonl ? r : 0, path });
  }
}
