import { t } from '../../shared/i18n';
import type { RenderReport } from '../../shared/protocol';
import type { App, View } from '../app';
import { childKey, decodeKey, esc, highlightRaw } from '../json';
import { icon } from '../icons';
import { isTextQuery, K_ERROR, K_VALUE, stepIn } from '../model';
import { buildLines, countLines, isFolded, lineHtml, lineText, type PLine } from './lines';

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
  private focusPath: string | null = null;
  private matchesSeen = -1;
  /** Word wrap: top of every row in px (length total + 1), or null when not wrapping. */
  private rowPx: Float64Array | null = null;
  /** Word wrap: measured row heights. Key: the record number for a collapsed record, "record:state:line" otherwise. */
  private readonly measured = new Map<number | string, number>();
  /** The model's errorsVersion this layout was made for. */
  private errorsSeen = -1;
  private relayout = 0;
  /** Word wrap: estimated height of collapsed and error rows, by record. */
  private readonly estimates = new Map<number, number>();
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
      }
      this.paint();
    });
    this.resizes.observe(this.scroller);
    this.rows.addEventListener('click', (e) => this.onClick(e));
    this.rows.addEventListener('dblclick', (e) => this.onDblClick(e));
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
    const before = anchor !== undefined ? this.rowTopPx(anchor) - this.scroller.scrollTop : undefined;
    this.layout();
    if (anchor !== undefined && before !== undefined) {
      const after = this.rowTopPx(anchor);
      if (after >= 0) this.scroller.scrollTop = after - before;
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
      this.heights.delete(0);
      this.lineCache.delete(0);
      this.forgetMeasured(0);
    }
    this.matchesSeen = app.matchesVersion;
    this.focusPath = key;
    this.layout();
    const j = this.linesOf(0).findIndex((l) => l.path === key && l.kind !== 'close');
    if (j >= 0) {
      const top = this.topOf(j) * this.ratio;
      const st = this.scroller.scrollTop;
      const vh = this.scroller.clientHeight;
      if (top < st || top + this.app.rh > st + vh) this.scroller.scrollTop = Math.max(0, top - vh / 3);
    }
    this.paint();
  }

  foldAll(collapse: boolean): void {
    const app = this.app;
    // "Collapse all" folds everything below the root; the toggles of single nodes start again.
    app.folds(0).clear();
    app.state.foldDepth = collapse ? 1 : Infinity;
    this.heights.delete(0);
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
    else if (app.state.expandMode === 'all' && m.keepsAll) {
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
    return !app.model.isJsonl || (app.state.expandMode === 'all' && app.model.keepsAll) || app.state.selected.has(r);
  }

  /**
   * Rows of record r. A collapsed record is not parsed for this: it has one row, or two when
   * it is already known to be invalid. The view lays out again when more errors are found.
   */
  private recordHeight(r: number): number {
    const m = this.app.model;
    if (!this.isExpanded(r)) return m.kind(r) === K_ERROR ? 2 : 1;
    const p = m.get(r);
    if (p.kind === 'blank') return 1;
    if (p.kind === 'error') return 2;
    let h = this.heights.get(r);
    if (h === undefined) {
      h = countLines(p.value, this.app.foldsOf(r), this.app.foldDepthOf());
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
    this.errorsSeen = m.errorsVersion;
    this.rowPx = app.state.wrap ? this.buildRowPx() : null;
    this.applyScrollHeight();
    // A new search result: the match that was in focus belongs to the old one.
    if (app.matchesVersion !== this.matchesSeen) {
      this.matchesSeen = app.matchesVersion;
      this.focusPath = null;
    }
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

  private rowKey(r: number, j: number): number | string {
    const expanded = this.isExpanded(r);
    return j === 0 && !expanded ? r : `${r}:${expanded ? 'e' : 'c'}:${j}`;
  }

  private forgetMeasured(r: number): void {
    const prefix = `${r}:`;
    this.measured.delete(r);
    for (const k of [...this.measured.keys()]) if (typeof k === 'string' && k.startsWith(prefix)) this.measured.delete(k);
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
      // A large file: the estimate comes from the line length alone, so no line is decoded for it.
      if (m.large) return Math.max(1, Math.ceil(Math.min(m.lineSize(r), WRAP_PREVIEW_CHARS) / Math.max(10, this.columns()))) * rh;
      let e = this.estimates.get(r);
      if (e === undefined) {
        e = this.wrapLines(m.head(r, WRAP_PREVIEW_CHARS)) * rh;
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
    const known = this.measured.size > 0;
    let k = 0;
    for (let i = 0; i < this.recCount; i++) {
      const r = this.recAt(i);
      const h = this.offsets[i + 1] - this.offsets[i];
      for (let j = 0; j < h; j++, k++) px[k + 1] = px[k] + ((known ? this.measured.get(this.rowKey(r, j)) : undefined) ?? this.estimate(r, j));
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
      lines = v === undefined ? [] : buildLines(v, this.app.foldsOf(r), this.app.foldDepthOf());
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
      const note = app.model.loading ? t('Loading…') : app.searching ? t('Searching…') : app.state.filterOnly && app.query.text ? t('No line matches the search.') : t('The file is empty.');
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
      for (let j = row - start; j < h && row < last; j++, row++) html.push(this.rowHtml(r, j, h));
      i++;
    }
    const focus = this.focusedControl();
    this.rows.innerHTML = html.join('');
    this.rendered = html.length;
    if (focus) this.refocus(focus);
    if (isTextQuery(app.query)) this.markMatches(app.query.text);
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
    const kind = a.classList.contains('rbtn') ? `.rbtn.${a.classList[1]}` : '.fold';
    return { r: row.dataset.r as string, j: row.dataset.j as string, kind };
  }

  private refocus(f: { r: string; j: string; kind: string }): void {
    const row = this.rows.querySelector(`.row[data-r="${f.r}"][data-j="${f.j}"]`);
    // A placeholder ("… 3 keys") that was opened is gone: the fold arrow of its line takes the focus.
    const el = (row?.querySelector(f.kind) ?? row?.querySelector('.fold')) as HTMLElement | null;
    el?.focus({ preventScroll: true });
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
    return `<div class="${cls.join(' ')}" data-r="${r}" data-j="${j}"${path ? ` data-p="${esc(path)}"` : ''}><span class="gut">${gutter}</span><span class="fg">${fold}</span><span class="code-text"${indentStyle}>${code}</span>${actions}</div>`;
  }

  /** The start of the raw line, highlighted. Only that part is read from the store. */
  private rawHtml(r: number, preview: number): string {
    const m = this.app.model;
    const raw = m.head(r, preview);
    const size = m.lineSize(r);
    // A byte store knows the size in bytes; it is only a note, so the line is not decoded to count characters.
    const more = m.large ? (raw.length >= preview ? size - preview : 0) : size - raw.length;
    return highlightRaw(raw) + (more > 0 ? this.truncNote(more, m.large) : '');
  }

  private actionsHtml(r: number): string {
    const edit = this.app.readOnly ? '' : `<button class="rbtn a-edit" data-r="${r}" title="${t('Edit this record (Enter)')}">${icon('edit', 12)}${t('Edit')}</button>`;
    return `<span class="acts">${edit}<button class="rbtn a-copy" data-r="${r}" title="${t('Copy the raw line')}">${icon('copy', 12)}${t('Copy')}</button><button class="rbtn a-goto" data-r="${r}" title="${t('Reveal in the text editor')}">${icon('goto', 12)}${t('Source')}</button></span>`;
  }


  private truncNote(more: number, bytes: boolean): string {
    return `<span class="trunc">${t(bytes ? ' … about {0} more bytes' : ' … {0} more chars', more.toLocaleString())}</span>`;
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
      else if (act.classList.contains('a-copy')) app.post({ type: 'copy', text: app.model.line(r) });
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
      app.stateChanged();
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
