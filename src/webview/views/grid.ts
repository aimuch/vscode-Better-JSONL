import { t } from '../../shared/i18n';
import type { RenderReport } from '../../shared/protocol';
import { defer, type App, type ColFilter, type View } from '../app';
import { childKey, decodeKey, entriesHead, esc, isArr, isContainer, isObj, kindOf, pathToString, plainText, primClass, RawNum, sizeOf, summary, type JObj, type JVal } from '../json';
import { icon } from '../icons';
import type { Parsed } from '../model';

const MAX_COLUMNS = 300;
const NESTED_ROWS = 200;
const NESTED_COLS = 50;
const CELL_CHARS = 300;
const CELL_CHARS_WRAP = 5000;
/**
 * Column ids. A data key is its own id. The built-in columns start with U+0001, and a data key
 * that starts with U+0001 gets one more in front, so no key in a file can take a built-in id.
 */
const ESC = '\u0001';
/** The row-number column. */
const NUM = ESC + '#';
/** Records that are not objects show here. */
const VALUE_COL = ESC + 'v';
/** The two columns of a root object. */
const OKEY = ESC + 'k';
const OVAL = ESC + 'o';
const colId = (key: string): string => (key.startsWith(ESC) ? ESC + key : key);
const keyOf = (id: string): string => (id.startsWith(ESC) ? id.slice(1) : id);
/**
 * JSON Lines whose records are not all kept in memory (large files): above this many rows,
 * sorting and column filters first read the values of the columns they need, in the background.
 */
const HEAVY_ROWS = 200_000;

/**
 * An object or array in a column read for sorting or filtering: its size and compact text
 * (cut at 2 000 characters), not the value itself, so a column of a large file stays small.
 */
class Shape {
  constructor(
    readonly arr: boolean,
    readonly size: number,
    readonly text: string,
  ) {}
}

type Cell = JVal | Shape | undefined;

function shapeOf(v: JVal | undefined): Cell {
  return v !== undefined && isContainer(v) ? new Shape(Array.isArray(v), sizeOf(v), compact(v).slice(0, 2000)) : v;
}
/** Values listed in a column filter before "… n more". */
const FILTER_LIST = 500;
/** Filter key of a missing cell. */
const MISSING = '\u0000';

interface FilterValue {
  key: string;
  v: Cell;
  n: number;
  /** Position in the sorted list. */
  i: number;
  /** Lower-case cell text, for the search box. */
  text: string;
}

type Mode = 'records' | 'object' | 'scalar';

/**
 * Grid view. JSONL or a root array: one row per record, columns = top-level keys.
 * Root object: key/value rows. Nested values open as sub-grids under the row.
 */
export class GridView implements View {
  readonly el: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly head: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly rowsEl: HTMLElement;
  private mode: Mode = 'records';
  private cols: string[] = [];
  private rowIds: number[] = [];
  private offsets = new Float64Array(1);
  private readonly heights = new Map<number, number>();
  private readonly rowH: number;
  private dragging: { col: string; startX: number; startW: number } | null = null;
  private jsonActive = -1;
  private modelRef: unknown;
  /** Rows after the search, before the column filters. */
  private baseIds: number[] = [];
  /** What baseIds and rowIds were computed from. They are computed again only when this changes. */
  private baseSig = '';
  private rowSig = '';
  /** Keys of the root object (object mode). */
  private objKeys: string[] = [];
  /** Columns of a root array (records mode of a single JSON document). */
  private arrayCols: string[] = [];
  private arrayColsCut = false;
  private colsCut = false;
  /** Column widths that come from the content, by column id. */
  private readonly autoWidths = new Map<string, number>();
  /** Many rows of a large JSON Lines file: sort and filters use the column values read in the background. */
  private heavy = false;
  /** Large files: whole columns read for sort and filters, by column id (index = record number). */
  private readonly colCache = new Map<string, Cell[]>();
  private colModel: unknown;
  private colJob: { cols: string[]; stop: () => void } | undefined;
  private colPct = 0;
  /** The cell editor (an input over the cell), while a value is edited. */
  private editor: HTMLInputElement | null = null;
  /** The open filter popup: its column and the column's values. */
  private fcol: string | null = null;
  private fvalues: FilterValue[] = [];
  private readonly fel: HTMLElement;
  private ftimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resizes: ResizeObserver;
  private readonly gone = new AbortController();

  constructor(private readonly app: App) {
    this.rowH = app.rh + 6;
    this.el = document.createElement('div');
    this.el.className = 'view grid';
    this.el.innerHTML = `<div class="gscroll" tabindex="0" aria-label="${t('Grid')}"><div class="ghead" role="row"></div><div class="gbody"><div class="grows"></div></div></div>`;
    this.scroll = this.el.querySelector('.gscroll') as HTMLElement;
    this.head = this.el.querySelector('.ghead') as HTMLElement;
    this.bodyEl = this.el.querySelector('.gbody') as HTMLElement;
    this.rowsEl = this.el.querySelector('.grows') as HTMLElement;
    this.scroll.addEventListener('scroll', () => this.paint(), { passive: true });
    this.resizes = new ResizeObserver(() => this.paint());
    this.resizes.observe(this.scroll);
    // Listeners outside this view go away with it (dispose).
    const signal = this.gone.signal;
    this.head.addEventListener('pointerdown', (e) => this.onHeadPointer(e));
    this.head.addEventListener('click', (e) => this.onHeadClick(e));
    this.head.addEventListener('keydown', (e) => {
      // Enter or Space on a header sorts by it, like a click. The header is painted again: keep the focus on it.
      const h = e.target as HTMLElement;
      if ((e.key !== 'Enter' && e.key !== ' ') || !h.classList.contains('gh')) return;
      e.preventDefault();
      const col = h.dataset.col as string;
      h.click();
      (this.head.querySelector(`[data-col="${CSS.escape(col)}"]`) as HTMLElement | null)?.focus();
    });
    this.rowsEl.addEventListener('click', (e) => this.onClick(e));
    this.rowsEl.addEventListener('dblclick', (e) => this.onDblClick(e));
    window.addEventListener('pointermove', (e) => this.onDrag(e), { signal });
    window.addEventListener('pointerup', () => (this.dragging = null), { signal });
    this.scroll.addEventListener(
      'scroll',
      () => {
        this.placeFilter();
        this.cancelEdit();
      },
      { passive: true },
    );
    this.fel = document.createElement('div');
    this.fel.className = 'gfilter';
    this.fel.hidden = true;
    this.fel.setAttribute('role', 'dialog');
    this.el.appendChild(this.fel);
    this.fel.addEventListener('input', (e) => this.onFilterInput(e));
    this.fel.addEventListener('change', (e) => this.onFilterChange(e));
    this.fel.addEventListener('click', (e) => this.onFilterClick(e));
    this.fel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeFilter(true);
      }
      e.stopPropagation();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target as HTMLElement;
        if (this.fcol !== null && !this.fel.contains(t) && !t.closest('[data-f]')) this.closeFilter();
      },
      { signal },
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && this.fcol !== null) this.closeFilter(true);
      },
      { signal },
    );
  }

  dispose(): void {
    clearTimeout(this.ftimer);
    this.colJob?.stop();
    this.resizes.disconnect();
    this.gone.abort();
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.closeFilter();
    this.cancelEdit();
    this.el.hidden = true;
  }

  render(): void {
    this.layout();
    this.paint();
    if (this.fcol !== null) {
      if (this.cols.includes(this.fcol)) {
        this.fvalues = this.valuesOf(this.fcol);
        this.paintFilterList();
        this.placeFilter();
      } else this.closeFilter();
    }
  }

  refresh(): void {
    this.render();
  }

  notes(): string[] {
    const out: string[] = [];
    if (this.colsCut) out.push(t('Showing the first {0} columns', MAX_COLUMNS));
    if (this.colJob) out.push(t('Reading column values for sort and filters… {0}%', this.colPct));
    return out;
  }

  /** A cell for sorting and filtering: from the column read in the background when there is one. */
  private val(id: number, col: string): Cell {
    if (this.heavy) {
      const c = this.colCache.get(col);
      if (c) return c[id];
    }
    return this.cell(id, col);
  }

  /**
   * Large files: reads the values of `cols` for every record, in time slices. The grid lays
   * out again when they are there.
   */
  private readColumns(cols: string[]): void {
    const m = this.app.model;
    if (this.colJob && this.colJob.cols.join('\u0002') === cols.join('\u0002')) return;
    this.colJob?.stop();
    const n = m.count;
    const arrays = cols.map(() => new Array<Cell>(n));
    const keys = cols.map((c) => (c === VALUE_COL ? null : keyOf(c)));
    let i = 0;
    let stop = () => undefined as void;
    const job = { cols, stop: () => stop() };
    this.colJob = job;
    this.colPct = 0;
    const step = () => {
      if (this.colJob !== job || this.app.model !== m) return;
      const end = performance.now() + 12;
      for (; i < n; i++) {
        const v = m.scanValue(i);
        for (let k = 0; k < cols.length; k++) {
          const key = keys[k];
          const cell = v === undefined ? undefined : key === null ? (isObj(v) ? undefined : v) : isObj(v) && Object.prototype.hasOwnProperty.call(v, key) ? v[key] : undefined;
          arrays[k][i] = shapeOf(cell);
        }
        if ((i & 255) === 255 && performance.now() > end) {
          i++;
          break;
        }
      }
      if (i < n) {
        const pct = Math.floor((i / n) * 100);
        if (pct !== this.colPct) {
          this.colPct = pct;
          this.app.paintChrome();
        }
        stop = defer(step);
        return;
      }
      cols.forEach((c, k) => this.colCache.set(c, arrays[k]));
      this.colJob = undefined;
      this.rowSig = '';
      this.render();
      this.app.paintChrome();
      this.app.stateChanged();
    };
    stop = defer(step);
  }

  /** The text a column shows in its header. */
  private label(col: string): string {
    if (col === NUM) return '#';
    if (col === VALUE_COL) return t('(value)');
    if (col === OKEY) return t('key');
    if (col === OVAL) return t('value');
    return keyOf(col);
  }

  onWrapChanged(): void {
    this.heights.clear();
  }

  onActiveChanged(scroll: boolean): void {
    if (this.el.hidden) return;
    if (scroll && this.app.model.isJsonl) {
      const i = this.rowIds.indexOf(this.app.state.active);
      if (i >= 0) {
        const top = this.offsets[i];
        const vh = this.scroll.clientHeight - this.rowH;
        const st = this.scroll.scrollTop;
        if (top < st || top + this.rowH > st + vh) this.scroll.scrollTop = Math.max(0, top - vh / 3);
      }
    }
    // The rows stay: only their marks change. (New rows would end a double-click that started on the old ones.)
    this.markRows();
  }

  /** The current and selected rows on screen get their marks. A scroll paints the rows anyway. */
  private markRows(): void {
    const s = this.app.state;
    const jsonl = this.app.model.isJsonl;
    for (const el of Array.from(this.rowsEl.children) as HTMLElement[]) {
      if (!el.classList.contains('grow')) continue;
      const id = Number(el.dataset.id);
      el.classList.toggle('act', jsonl ? s.active === id : this.jsonActive === id);
      el.classList.toggle('sel', jsonl && s.selected.has(id));
    }
  }

  stepMatch(dir: 1 | -1): void {
    const app = this.app;
    if (!app.model.isJsonl || !this.rowIds.length) return;
    const i = this.rowIds.indexOf(app.state.active);
    const next = this.rowIds[(i + dir + this.rowIds.length) % this.rowIds.length];
    app.selectRecord(next);
    this.onActiveChanged(true);
  }

  fillReport(r: RenderReport): void {
    const name = (c: string) => (c === VALUE_COL ? '(value)' : c === OKEY ? 'key' : c === OVAL ? 'value' : keyOf(c));
    const filters: Record<string, { text: string; exclude: number }> = {};
    for (const [c, f] of this.activeFilters()) filters[name(c)] = { text: f.text, exclude: f.exclude.size };
    r.grid = { rows: this.rowIds.length, columns: this.cols.map(name), openCells: this.app.state.grid.open.size, unfiltered: this.baseIds.length, filters };
  }

  /** Status bar text while column filters are on, e.g. "Filtered: level, ms · 5 of 20 rows". */
  filterStatus(): string {
    const f = this.activeFilters();
    if (!f.length) return '';
    const names = f.map(([c]) => this.label(c)).join(', ');
    return `${t('Filtered: {0}', names)} · ${t('{0} of {1} rows', this.rowIds.length.toLocaleString(), this.baseIds.length.toLocaleString())}`;
  }

  // ---------- data ----------

  private rootValue(): JVal | undefined {
    return this.app.model.isJsonl ? undefined : this.app.model.value(0);
  }

  private record(id: number): Parsed {
    const m = this.app.model;
    if (m.isJsonl) return m.get(id);
    const root = this.rootValue();
    if (this.mode === 'records' && isArr(root as JVal)) return { kind: 'value', value: (root as JVal[])[id] };
    return { kind: 'value', value: root as JVal };
  }

  private cell(id: number, col: string): JVal | undefined {
    if (this.mode === 'object') {
      const key = this.objKeys[id];
      return col === OKEY ? key : (this.rootValue() as JObj)[key];
    }
    const p = this.record(id);
    if (p.kind !== 'value') return undefined;
    if (col === VALUE_COL) return isObj(p.value) ? undefined : p.value;
    if (!isObj(p.value)) return undefined;
    const key = keyOf(col);
    return Object.prototype.hasOwnProperty.call(p.value, key) ? p.value[key] : undefined;
  }

  private layout(): void {
    const app = this.app;
    const m = app.model;
    if (this.modelRef !== m) {
      this.modelRef = m;
      this.heights.clear();
      this.baseSig = '';
    }
    const root = this.rootValue();
    const q = app.query.text;
    this.colsCut = false;
    // 1. The mode and the columns. This is cheap, and the columns grow while the file is scanned.
    if (m.isJsonl) {
      this.mode = 'records';
      this.colsCut = m.columns.length > MAX_COLUMNS;
      this.cols = m.columns.slice(0, MAX_COLUMNS).map(colId);
      // Non-object records (arrays, strings, numbers) show in a first "(value)" column.
      if (m.hasNonObject || !this.cols.length) this.cols.unshift(VALUE_COL);
    } else if (root !== undefined && isArr(root)) {
      this.mode = 'records';
    } else if (root !== undefined && isObj(root)) {
      this.mode = 'object';
      this.cols = [OKEY, OVAL];
    } else {
      this.mode = 'scalar';
      this.cols = [VALUE_COL];
    }
    // 2. The rows after the search. Computed again only when the lines or the matches change.
    const baseSig = `${m.count}|${app.matchesVersion}|${q}`;
    if (baseSig !== this.baseSig) {
      this.baseSig = baseSig;
      // One JSON document with a JSONPath or jq query: a row matches when a result is inside it.
      const hits = !m.isJsonl && app.query.program ? new Set(app.treeMatches.map((k) => decodeKey(k)[0])) : null;
      this.rowSig = '';
      this.autoWidths.clear();
      const ids: number[] = [];
      if (m.isJsonl) {
        if (q) {
          for (const i of app.matches) if (!m.isBlank(i)) ids.push(i);
        } else {
          for (let i = 0; i < m.count; i++) if (!m.isBlank(i)) ids.push(i);
        }
      } else if (root !== undefined && isArr(root)) {
        const keys = new Set<string>();
        let nonObj = false;
        for (const item of root) {
          if (!isObj(item)) nonObj = true;
          else if (keys.size <= MAX_COLUMNS) for (const k in item) keys.add(k);
        }
        this.arrayCols = [...keys].slice(0, MAX_COLUMNS).map(colId);
        this.arrayColsCut = keys.size > MAX_COLUMNS;
        if (nonObj || !this.arrayCols.length) this.arrayCols.push(VALUE_COL);
        for (let i = 0; i < root.length; i++) {
          if (hits ? hits.has(i) : !q || JSON.stringify(root[i] instanceof RawNum ? (root[i] as RawNum).src : root[i]).toLowerCase().includes(q)) ids.push(i);
        }
      } else if (root !== undefined && isObj(root)) {
        this.objKeys = Object.keys(root);
        for (let i = 0; i < this.objKeys.length; i++) {
          if (hits ? hits.has(this.objKeys[i]) : !q || (this.objKeys[i] + ' ' + JSON.stringify(root[this.objKeys[i]])).toLowerCase().includes(q)) ids.push(i);
        }
      } else if (root !== undefined) ids.push(0);
      this.baseIds = ids;
    }
    if (!m.isJsonl && this.mode === 'records') {
      this.cols = this.arrayCols;
      this.colsCut = this.arrayColsCut;
    }
    // 3. Column filters and the sort. Both read a cell of every row, so the result is kept.
    if (this.colModel !== m) {
      this.colModel = m;
      this.colCache.clear();
      this.colJob?.stop();
      this.colJob = undefined;
    }
    this.heavy = m.isJsonl && !m.keepsAll && this.baseIds.length > HEAVY_ROWS;
    let filters = this.activeFilters();
    const g = app.state.grid.sort;
    let sort = g && (g.col === NUM || this.cols.includes(g.col)) ? g : null;
    if (this.heavy) {
      // The columns are read first; until then the rows show in file order.
      const need = new Set<string>(filters.map(([c]) => c));
      if (sort && sort.col !== NUM) need.add(sort.col);
      if (this.fcol !== null) need.add(this.fcol);
      const missing = [...need].filter((c) => !this.colCache.has(c));
      if (missing.length) {
        this.readColumns([...need]);
        filters = [];
        sort = null;
      }
    }
    const rowSig = JSON.stringify([sort, filters.map(([c, f]) => [c, f.text, [...f.exclude]])]);
    if (rowSig !== this.rowSig) {
      this.rowSig = rowSig;
      let ids = this.baseIds;
      if (filters.length) ids = ids.filter((id) => this.passes(id, filters));
      if (sort) {
        const s = sort;
        const keys = s.col === NUM ? null : ids.map((id) => this.val(id, s.col));
        const order = ids.map((_, k) => k);
        order.sort((a, b) => {
          if (!keys) return s.dir * (ids[a] - ids[b]);
          // Missing values stay at the bottom in both directions.
          const ma = keys[a] === undefined;
          const mb = keys[b] === undefined;
          if (ma !== mb) return ma ? 1 : -1;
          return s.dir * compare(keys[a], keys[b]) || ids[a] - ids[b];
        });
        ids = order.map((k) => ids[k]);
      }
      this.rowIds = ids;
    }
    this.computeOffsets();
    this.paintHead();
  }

  private computeOffsets(): void {
    const n = this.rowIds.length;
    const off = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + (this.heights.get(this.rowIds[i]) ?? this.rowH);
    this.offsets = off;
    this.bodyEl.style.height = `${off[n]}px`;
  }

  private width(col: string): number {
    const w = this.app.state.grid.widths[col];
    if (w) return w;
    if (col === NUM) return 64;
    // A width from the content is kept until the rows change: every layout asks for every column.
    let auto = this.autoWidths.get(col);
    if (auto === undefined) {
      auto = this.measureWidth(col);
      this.autoWidths.set(col, auto);
    }
    return auto;
  }

  private measureWidth(col: string): number {
    // The header also holds the sort arrow and the filter button.
    let max = this.label(col).length + 5;
    // Measured on the rows before the column filters, so filtering does not resize the columns.
    const ids = this.baseIds;
    for (let i = 0; i < Math.min(40, ids.length); i++) {
      const v = this.cell(ids[i], col);
      const len = v === undefined ? 0 : isContainer(v) ? summary(v).length + 3 : plainText(v).length;
      if (len > max) max = len;
    }
    return Math.min(360, Math.max(64, max * 7.6 + 24));
  }

  private allCols(): string[] {
    return this.mode === 'records' ? [NUM, ...this.cols] : this.cols;
  }

  private paintHead(): void {
    const sort = this.app.state.grid.sort;
    const cols = this.allCols();
    const filters = this.app.state.grid.filters;
    const filterable = this.mode !== 'scalar';
    this.applyWidths();
    this.head.innerHTML = cols
      .map((c, i) => {
        const sorted = sort && sort.col === c ? (sort.dir > 0 ? icon('chev-up', 11) : icon('chev-down', 11)) : '';
        const label = c === VALUE_COL ? `<span class="dim">${t('(value)')}</span>` : esc(this.label(c));
        const f = filters.get(c);
        const on = !!f && (!!f.text || f.exclude.size > 0);
        const fbtn =
          filterable && c !== NUM
            ? `<button class="gh-f${on ? ' on' : ''}${this.fcol === c ? ' open' : ''}" data-f="${esc(c)}" aria-label="${esc(t('Filter {0}', this.label(c)))}" aria-pressed="${on}" title="${t('Filter this column')}">${icon('filter', 12)}</button>`
            : '';
        const sortState = sort && sort.col === c ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
        return `<div class="gh${c === NUM ? ' num' : ''}${on ? ' filtered' : ''}" role="columnheader" tabindex="0" aria-sort="${sortState}" data-col="${esc(c)}" style="width:var(--w${i})" title="${esc(this.label(c))}"><span class="gh-l">${label}</span>${sorted}${fbtn}<span class="rz" data-rz="${esc(c)}"></span></div>`;
      })
      .join('');
  }

  // ---------- painting ----------

  private paint(): void {
    if (this.el.hidden || !this.app.model) return;
    if (!this.rowIds.length) {
      this.rowsEl.style.transform = '';
      const filtered = this.activeFilters().length > 0;
      const clear = filtered ? ` <button class="btn gf-clear-all" data-clear-filters>${t('Clear all filters')}</button>` : '';
      this.rowsEl.innerHTML = `<div class="empty-note">${this.app.query.text || filtered ? t('No row matches the filter.') : t('No rows.')}${clear}</div>`;
      return;
    }
    const vh = this.scroll.clientHeight || 600;
    const st = Math.max(0, this.scroll.scrollTop - this.rowH);
    let lo = 0;
    let hi = this.rowIds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= st) lo = mid;
      else hi = mid - 1;
    }
    const first = Math.max(0, lo - 3);
    const html: string[] = [];
    let i = first;
    while (i < this.rowIds.length && this.offsets[i] < st + vh + this.rowH * 4) {
      html.push(this.rowHtml(this.rowIds[i]));
      i++;
    }
    this.rowsEl.style.transform = `translateY(${this.offsets[first]}px)`;
    this.rowsEl.innerHTML = html.join('');
    this.measure();
  }

  /** Rows with open sub-grids are taller. Measure them and lay out again when needed. */
  private measure(): void {
    let changed = false;
    this.rowsEl.querySelectorAll<HTMLElement>('.grow').forEach((el) => {
      const id = Number(el.dataset.id);
      const h = el.offsetHeight;
      const known = this.heights.get(id) ?? this.rowH;
      if (Math.abs(h - known) > 0.5) {
        if (Math.abs(h - this.rowH) < 0.5) this.heights.delete(id);
        else this.heights.set(id, h);
        changed = true;
      }
    });
    if (changed) {
      this.computeOffsets();
      const first = this.rowsEl.firstElementChild as HTMLElement | null;
      if (first) {
        const idx = this.rowIds.indexOf(Number(first.dataset.id));
        if (idx >= 0) this.rowsEl.style.transform = `translateY(${this.offsets[idx]}px)`;
      }
    }
  }

  private rowHtml(id: number): string {
    const app = this.app;
    const jsonl = app.model.isJsonl;
    const active = jsonl ? app.state.active === id : this.jsonActive === id;
    const sel = jsonl && app.state.selected.has(id);
    const cols = this.allCols();
    const p = this.record(id);
    const cells: string[] = [];
    const details: string[] = [];
    const open = app.state.grid.open;
    if (p.kind === 'error') {
      cells.push(`<div class="gc num" style="width:var(--w0)">${id + 1}</div>`);
      cells.push(`<div class="gc err-cell">${icon('warning', 12)}<span>${esc(p.message)}</span></div>`);
    } else {
      cols.forEach((c, i) => {
        const style = `style="width:var(--w${i})"`;
        if (c === NUM) {
          cells.push(`<div class="gc num" ${style}>${jsonl ? id + 1 : id}</div>`);
          return;
        }
        const v = this.cell(id, c);
        if (v === undefined) {
          cells.push(`<div class="gc miss" ${style}></div>`);
          return;
        }
        if (c === OKEY) {
          cells.push(`<div class="gc tk" ${style} title="${esc(String(v))}">${esc(String(v))}</div>`);
          return;
        }
        if (isContainer(v)) {
          const key = `${id}|${this.cellPath(id, c)}`;
          const isOpen = open.has(key);
          cells.push(`<div class="gc" ${style}>${chip(v, key, isOpen)}</div>`);
          if (isOpen) details.push(this.detailHtml(id, c, v));
          return;
        }
        const t = plainText(v);
        const max = app.state.wrap ? CELL_CHARS_WRAP : CELL_CHARS;
        const shown = t.length > max ? t.slice(0, max) + '…' : t;
        const cls = primClass(v) + (typeof v === 'number' || v instanceof RawNum ? ' right' : '');
        cells.push(`<div class="gc ${cls}" ${style} title="${esc(t.slice(0, 1000))}">${esc(shown)}</div>`);
      });
    }
    const cls = ['grow'];
    if (sel) cls.push('sel');
    if (active) cls.push('act');
    if (p.kind === 'error') cls.push('err');
    const det = details.length ? `<div class="gdetail">${details.join('')}</div>` : '';
    return `<div class="${cls.join(' ')}" data-id="${id}" role="row"><div class="gcells">${cells.join('')}</div>${det}</div>`;
  }

  /** Path key of a top-level cell, relative to the record. */
  private cellPath(id: number, col: string): string {
    if (this.mode === 'object') return childKey('', this.objKeys[id]);
    if (col === VALUE_COL) return '';
    return childKey('', keyOf(col));
  }

  private recordPath(id: number, rel: string): (string | number)[] {
    const inner = decodeKey(rel);
    return this.app.model.isJsonl || this.mode === 'object' ? inner : [id, ...inner];
  }

  /** Column widths (--wN), column left edges (--xN) and the total width (--gw) as CSS variables. */
  private applyWidths(): void {
    let left = 0;
    this.allCols().forEach((c, i) => {
      const w = this.width(c);
      this.scroll.style.setProperty(`--w${i}`, `${w}px`);
      this.scroll.style.setProperty(`--x${i}`, `${left}px`);
      left += w;
    });
    this.scroll.style.setProperty('--gw', `${left}px`);
  }

  private detailHtml(id: number, col: string, v: JVal): string {
    const rel = this.cellPath(id, col);
    const path = this.recordPath(id, rel);
    const where = this.app.model.isJsonl ? t('line {0} · ', id + 1) : '';
    const n = sizeOf(v as JObj);
    const kind = Array.isArray(v) ? `${t('array')} · ${t(n === 1 ? '{0} item' : '{0} items', n)}` : `${t('object')} · ${t(n === 1 ? '{0} key' : '{0} keys', n)}`;
    // The sub-grid starts under the column that was opened.
    const i = Math.max(0, this.allCols().indexOf(this.mode === 'object' ? OVAL : col));
    return `<div class="gsub" style="margin-left:var(--x${i})"><div class="gsub-h"><span class="mono">${esc(pathToString(path))}</span><span class="dim">${where}${kind}</span></div>${this.nested(v, id, rel, 0)}</div>`;
  }

  private nested(v: JVal, id: number, rel: string, depth: number): string {
    if (!isContainer(v)) return '';
    if (depth > 60) return '<span class="dim">…</span>';
    const open = this.app.state.grid.open;
    const inner = (child: JVal, key: string): string => {
      if (!isContainer(child)) {
        const t = plainText(child);
        return `<span class="${primClass(child)}" title="${esc(t.slice(0, 1000))}">${esc(t.length > CELL_CHARS ? t.slice(0, CELL_CHARS) + '…' : t)}</span>`;
      }
      const ck = `${id}|${key}`;
      const isOpen = open.has(ck);
      return chip(child, ck, isOpen) + (isOpen ? this.nested(child, id, key, depth + 1) : '');
    };
    const rows: string[] = [];
    let colsCut = 0;
    if (isArr(v) && v.length && v.every((x) => isObj(x))) {
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const item of v.slice(0, NESTED_ROWS)) {
        for (const k in item as JObj) {
          if (seen.has(k)) continue;
          seen.add(k);
          if (keys.length < NESTED_COLS) keys.push(k);
          else colsCut++;
        }
      }
      rows.push(`<tr><th class="num">#</th>${keys.map((k) => `<th>${esc(k)}</th>`).join('')}</tr>`);
      v.slice(0, NESTED_ROWS).forEach((item, i) => {
        const o = item as JObj;
        const base = childKey(rel, i);
        rows.push(
          `<tr><td class="num dim">${i}</td>${keys.map((k) => (k in o ? `<td>${inner(o[k], childKey(base, k))}</td>` : '<td class="miss"></td>')).join('')}</tr>`,
        );
      });
    } else {
      rows.push(`<tr><th>${isArr(v) ? '#' : t('key')}</th><th>${t('value')}</th></tr>`);
      entriesHead(v, NESTED_ROWS).forEach(([k, child]) => {
          const label = typeof k === 'number' ? `<td class="num dim">${k}</td>` : `<td class="tk">${esc(k)}</td>`;
        rows.push(`<tr>${label}<td>${inner(child, childKey(rel, k))}</td></tr>`);
      });
    }
    const cut: string[] = [];
    if (sizeOf(v) > NESTED_ROWS) cut.push(t('… {0} more', (sizeOf(v) - NESTED_ROWS).toLocaleString()));
    if (colsCut) cut.push(t('… {0} more columns', colsCut.toLocaleString()));
    const more = cut.length ? `<div class="dim more">${esc(cut.join(' · '))}</div>` : '';
    return `<table class="ng">${rows.join('')}</table>${more}`;
  }

  // ---------- events ----------

  private onHeadPointer(e: PointerEvent): void {
    const rz = (e.target as HTMLElement).closest('[data-rz]') as HTMLElement | null;
    if (!rz) return;
    e.preventDefault();
    const col = rz.dataset.rz as string;
    this.dragging = { col, startX: e.clientX, startW: this.width(col) };
  }

  private onDrag(e: PointerEvent): void {
    if (!this.dragging) return;
    const d = this.dragging;
    const w = Math.max(40, Math.round(d.startW + e.clientX - d.startX));
    this.app.state.grid.widths[d.col] = w;
    this.applyWidths();
    if (this.app.state.wrap) {
      // Wrapped cells change height with the column width.
      this.heights.clear();
      this.computeOffsets();
      this.paint();
    }
  }

  private onHeadClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('[data-rz]')) return;
    const fb = t.closest('[data-f]') as HTMLElement | null;
    if (fb) {
      const col = fb.dataset.f as string;
      if (this.fcol === col) this.closeFilter();
      else this.openFilter(col);
      return;
    }
    const h = t.closest('[data-col]') as HTMLElement | null;
    if (!h) return;
    const col = h.dataset.col as string;
    const g = this.app.state.grid;
    if (!g.sort || g.sort.col !== col) g.sort = { col, dir: 1 };
    else if (g.sort.dir === 1) g.sort = { col, dir: -1 };
    else g.sort = null;
    this.render();
    this.app.stateChanged();
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('[data-clear-filters]')) {
      this.app.state.grid.filters.clear();
      this.refilter();
      return;
    }
    const chipEl = t.closest('[data-c]') as HTMLElement | null;
    const rowEl = t.closest('.grow') as HTMLElement | null;
    if (!rowEl) return;
    const id = Number(rowEl.dataset.id);
    if (chipEl) {
      const key = chipEl.dataset.c as string;
      const open = this.app.state.grid.open;
      if (open.has(key)) {
        for (const k of [...open]) if (k === key || k.startsWith(key + '\u001f')) open.delete(k);
      } else open.add(key);
      this.render();
      this.app.stateChanged();
      return;
    }
    if (t.closest('.gdetail')) return;
    if (this.app.model.isJsonl) {
      const how = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'set';
      this.app.selectRecord(id, how);
    } else {
      this.jsonActive = id;
      this.markRows();
    }
  }

  private onDblClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    const rowEl = t.closest('.grow') as HTMLElement | null;
    if (!rowEl || t.closest('[data-c]')) return;
    const id = Number(rowEl.dataset.id);
    const cellEl = t.closest('.gc') as HTMLElement | null;
    const idx = cellEl ? Array.from(cellEl.parentElement!.children).indexOf(cellEl) : -1;
    const col = idx >= 0 ? this.allCols()[idx] : undefined;
    // A value cell opens the cell editor; the # cell and the others go to the source.
    if (cellEl && col && this.startEdit(id, col, cellEl)) return;
    const rel = col && col !== NUM ? this.cellPath(id, col) : '';
    const path = this.recordPath(id, rel);
    this.app.post({ type: 'reveal', line: this.app.model.isJsonl ? id : 0, path });
  }

  // ---------- cell editing ----------

  /**
   * Opens the cell editor on a value cell. A string cell stays a string; another cell takes a
   * JSON value (type "text" in quotes to make it a string). Enter writes it, Esc cancels.
   * Returns false when the cell cannot be edited.
   */
  private startEdit(id: number, col: string, cellEl: HTMLElement): boolean {
    const app = this.app;
    if (!app.canEditCells || col === NUM || col === OKEY || this.record(id).kind !== 'value') return false;
    const v = this.cell(id, col);
    if (v === undefined || isContainer(v)) return false;
    this.cancelEdit();
    const host = this.el.getBoundingClientRect();
    const r = cellEl.getBoundingClientRect();
    const input = document.createElement('input');
    input.className = 'gedit';
    input.spellcheck = false;
    input.value = typeof v === 'string' ? v : v instanceof RawNum ? v.src : String(v);
    input.setAttribute('aria-label', t('Edit the value of {0}', this.label(col)));
    input.style.cssText = `left:${r.left - host.left}px;top:${r.top - host.top}px;width:${Math.max(r.width, 120)}px;height:${r.height}px`;
    const isString = typeof v === 'string';
    const original = isString ? JSON.stringify(v) : input.value;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
        this.scroll.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        let text = isString ? JSON.stringify(input.value) : input.value.trim();
        try {
          JSON.parse(text);
        } catch {
          // Not JSON: a cell that was not a string takes it as JSON only.
          input.classList.add('bad');
          input.title = t('Not a JSON value. Put text in quotes to make it a string.');
          return;
        }
        if (text === original) {
          this.cancelEdit();
          return;
        }
        if (!isString && /^-?\d/.test(text)) text = text.replace(/\s+/g, '');
        const rel = decodeKey(this.cellPath(id, col));
        this.cancelEdit();
        app.editCell(id, app.model.isJsonl ? rel : this.recordPath(id, this.cellPath(id, col)), text);
      }
    });
    input.addEventListener('blur', () => this.cancelEdit());
    this.el.appendChild(input);
    this.editor = input;
    input.focus();
    input.select();
    return true;
  }

  private cancelEdit(): void {
    const ed = this.editor;
    if (!ed) return;
    this.editor = null;
    ed.remove();
  }

  // ---------- export ----------

  /** The rows on screen (after search, filters and sort), for an export. */
  exportSource(): { ids: number[]; header: string[]; line(id: number): string; cells(id: number): string[] } {
    this.layout();
    const m = this.app.model;
    const cols = this.cols;
    const root = this.rootValue();
    const header = cols.map((c) => (c === VALUE_COL ? '(value)' : c === OKEY ? 'key' : c === OVAL ? 'value' : keyOf(c)));
    return {
      ids: [...this.rowIds],
      header,
      line: (id) => {
        if (m.isJsonl) return m.line(id);
        if (this.mode === 'object') return compact({ key: this.objKeys[id], value: (root as JObj)[this.objKeys[id]] });
        const p = this.record(id);
        return p.kind === 'value' ? compact(p.value) : '';
      },
      cells: (id) => cols.map((c) => cellText(this.cell(id, c))),
    };
  }

  // ---------- column filters ----------

  /** Filters that narrow the rows, on columns that exist. `except` leaves one column out. */
  private activeFilters(except?: string): [string, ColFilter][] {
    const out: [string, ColFilter][] = [];
    for (const [c, f] of this.app.state.grid.filters) {
      if (c !== except && (f.text || f.exclude.size) && this.cols.includes(c)) out.push([c, f]);
    }
    return out;
  }

  private passes(id: number, filters: [string, ColFilter][]): boolean {
    for (const [c, f] of filters) {
      const v = this.val(id, c);
      if (f.exclude.size && f.exclude.has(valueKey(v))) return false;
      if (f.text && !cellText(v).toLowerCase().includes(f.text.toLowerCase())) return false;
    }
    return true;
  }

  /** Distinct values of a column, with counts, among the rows the other filters keep. */
  private valuesOf(col: string): FilterValue[] {
    const others = this.activeFilters(col);
    // Large files: the list waits for the columns read in the background (the grid paints it then).
    if (this.heavy && [col, ...others.map(([c]) => c)].some((c) => !this.colCache.has(c))) return [];
    const map = new Map<string, FilterValue>();
    for (const id of this.baseIds) {
      if (others.length && !this.passes(id, others)) continue;
      const v = this.val(id, col);
      const key = valueKey(v);
      const e = map.get(key);
      if (e) e.n++;
      else map.set(key, { key, v, n: 1, i: 0, text: cellText(v).toLowerCase() });
    }
    const out = [...map.values()].sort((a, b) => {
      const ma = a.v === undefined;
      const mb = b.v === undefined;
      if (ma !== mb) return ma ? 1 : -1;
      return compare(a.v, b.v) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    });
    out.forEach((x, i) => (x.i = i));
    return out;
  }

  private filterOf(col: string): ColFilter {
    const all = this.app.state.grid.filters;
    let f = all.get(col);
    if (!f) {
      f = { text: '', exclude: new Set() };
      all.set(col, f);
    }
    return f;
  }

  /** Values the search box lets through. */
  private shownValues(): FilterValue[] {
    const f = this.app.state.grid.filters.get(this.fcol as string);
    const q = f?.text.toLowerCase() ?? '';
    return q ? this.fvalues.filter((x) => x.text.includes(q)) : this.fvalues;
  }

  private openFilter(col: string): void {
    this.fcol = col;
    this.fvalues = this.valuesOf(col);
    const f = this.app.state.grid.filters.get(col);
    const name = this.label(col);
    this.fel.setAttribute('aria-label', t('Filter {0}', name));
    this.fel.innerHTML = `
      <div class="gf-title" title="${esc(name)}">${icon('filter', 12)}<span>${esc(name)}</span></div>
      <div class="gf-stats dim">${statsHtml(this.fvalues)}</div>
      <div class="gf-sort">
        <button class="btn" data-fsort="1">${icon('chev-up', 11)}${t('Sort ascending')}</button>
        <button class="btn" data-fsort="-1">${icon('chev-down', 11)}${t('Sort descending')}</button>
      </div>
      <label class="search gf-search">${icon('search')}<span class="sr">${t('Search values')}</span><input type="search" placeholder="${t('Search values')}" spellcheck="false" value="${esc(f?.text ?? '')}"></label>
      <label class="gf-item gf-all"><input type="checkbox" data-fall><span class="gf-v">${t('(Select all)')}</span><span class="gf-n"></span></label>
      <div class="gf-list" role="group"></div>
      <div class="gf-foot"><button class="btn gf-clear">${t('Clear filter')}</button><span class="spring"></span><span class="dim gf-count"></span></div>`;
    this.fel.hidden = false;
    this.paintFilterList();
    this.paintHead();
    this.placeFilter();
    const input = this.fel.querySelector('input[type="search"]') as HTMLInputElement;
    input.focus();
    input.select();
  }

  closeFilter(focusGrid = false): void {
    if (this.fcol === null) return;
    clearTimeout(this.ftimer);
    const col = this.fcol;
    this.fcol = null;
    this.fel.hidden = true;
    this.fel.innerHTML = '';
    const f = this.app.state.grid.filters.get(col);
    if (f && !f.text && !f.exclude.size) this.app.state.grid.filters.delete(col);
    this.paintHead();
    if (focusGrid) this.scroll.focus();
  }

  /** The popup sits under its header and stays inside the view. */
  private placeFilter(): void {
    if (this.fcol === null) return;
    const h = this.head.querySelector(`[data-col="${CSS.escape(this.fcol)}"]`) as HTMLElement | null;
    if (!h) return;
    const host = this.el.getBoundingClientRect();
    const r = h.getBoundingClientRect();
    const w = this.fel.offsetWidth || 280;
    const left = Math.max(4, Math.min(r.left - host.left, host.width - w - 4));
    const top = r.bottom - host.top + 2;
    this.fel.style.left = `${left}px`;
    this.fel.style.top = `${top}px`;
    this.fel.style.maxHeight = `${Math.max(160, Math.min(440, host.height - top - 8))}px`;
  }

  private paintFilterList(): void {
    const col = this.fcol;
    if (col === null) return;
    const f = this.app.state.grid.filters.get(col);
    const ex = f?.exclude ?? new Set<string>();
    const shown = this.shownValues();
    const list = this.fel.querySelector('.gf-list') as HTMLElement;
    const html: string[] = [];
    let total = 0;
    let ticked = 0;
    for (const x of shown) {
      total += x.n;
      if (!ex.has(x.key)) ticked++;
    }
    shown.slice(0, FILTER_LIST).forEach((x) => {
      html.push(
        `<label class="gf-item" title="${esc(valueLabel(x.v).slice(0, 1000))}"><input type="checkbox" data-fi="${x.i}"${ex.has(x.key) ? '' : ' checked'}><span class="gf-v ${valueClass(x.v)}">${esc(valueLabel(x.v).slice(0, 200))}</span><span class="gf-n">${x.n.toLocaleString()}</span></label>`,
      );
    });
    if (!shown.length) html.push(`<div class="gf-more">${t('No value contains this text.')}</div>`);
    else if (shown.length > FILTER_LIST) html.push(`<div class="gf-more">${t('… {0} more values · type to narrow the list', (shown.length - FILTER_LIST).toLocaleString())}</div>`);
    list.innerHTML = html.join('');
    const all = this.fel.querySelector('[data-fall]') as HTMLInputElement;
    all.checked = shown.length > 0 && ticked === shown.length;
    all.indeterminate = ticked > 0 && ticked < shown.length;
    all.disabled = !shown.length;
    (this.fel.querySelector('.gf-all .gf-n') as HTMLElement).textContent = total.toLocaleString();
    this.paintFilterFoot();
  }

  private paintFilterFoot(): void {
    const c = this.fel.querySelector('.gf-count') as HTMLElement | null;
    if (c) c.textContent = t('{0} of {1} rows', this.rowIds.length.toLocaleString(), this.baseIds.length.toLocaleString());
  }

  /** Lays the rows out again after a filter change, keeping the popup as it is. */
  private refilter(): void {
    this.layout();
    this.paint();
    this.paintFilterFoot();
    this.placeFilter();
    this.app.paintChrome();
    this.app.stateChanged();
  }

  private onFilterInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.type !== 'search' || this.fcol === null) return;
    clearTimeout(this.ftimer);
    this.ftimer = setTimeout(() => {
      if (this.fcol === null) return;
      this.filterOf(this.fcol).text = input.value.trim();
      this.refilter();
      this.paintFilterList();
    }, 120);
  }

  private onFilterChange(e: Event): void {
    const box = e.target as HTMLInputElement;
    if (box.type !== 'checkbox' || this.fcol === null) return;
    const f = this.filterOf(this.fcol);
    if (box.dataset.fall !== undefined) {
      for (const x of this.shownValues()) {
        if (box.checked) f.exclude.delete(x.key);
        else f.exclude.add(x.key);
      }
    } else {
      const x = this.fvalues[Number(box.dataset.fi)];
      if (!x) return;
      if (box.checked) f.exclude.delete(x.key);
      else f.exclude.add(x.key);
    }
    this.refilter();
    this.paintFilterList();
  }

  private onFilterClick(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!b || this.fcol === null) return;
    if (b.dataset.fsort) {
      this.app.state.grid.sort = { col: this.fcol, dir: Number(b.dataset.fsort) as 1 | -1 };
      this.closeFilter(true);
      this.render();
      this.app.stateChanged();
    } else if (b.classList.contains('gf-clear')) {
      this.app.state.grid.filters.delete(this.fcol);
      this.closeFilter(true);
      this.refilter();
    }
  }
}

/** Key that groups equal cells in a column filter. Strings and numbers never share a key. */
function valueKey(v: Cell): string {
  if (v === undefined) return MISSING;
  if (v instanceof Shape) return 'j' + v.text;
  if (v === null) return 'z';
  if (typeof v === 'boolean') return v ? 'b1' : 'b0';
  if (typeof v === 'number' || v instanceof RawNum) return 'n' + plainText(v);
  if (typeof v === 'string') return 's' + v;
  return 'j' + compact(v);
}

/** Text a column filter searches: the shown text, or compact JSON for objects and arrays. */
function cellText(v: Cell): string {
  if (v === undefined) return '';
  if (v instanceof Shape) return v.text;
  return isContainer(v) ? compact(v) : plainText(v);
}

/** The type of a cell, for the column statistics. */
function cellType(v: Cell): string {
  if (v === undefined) return 'missing';
  if (v instanceof Shape) return v.arr ? 'array' : 'object';
  return kindOf(v);
}

/**
 * Column statistics from the distinct values and their counts: the types, the number of
 * distinct values, and min, max and mean of the numbers.
 */
function statsHtml(values: FilterValue[]): string {
  const types = new Map<string, number>();
  let nums = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let shortest = Infinity;
  let longest = 0;
  for (const x of values) {
    const type = cellType(x.v);
    types.set(type, (types.get(type) ?? 0) + x.n);
    if (type === 'number') {
      const n = Number(x.v instanceof RawNum ? x.v.src : x.v);
      nums += x.n;
      sum += n * x.n;
      if (n < min) min = n;
      if (n > max) max = n;
    } else if (type === 'string') {
      const len = (x.v as string).length;
      if (len < shortest) shortest = len;
      if (len > longest) longest = len;
    }
  }
  const order = ['number', 'string', 'boolean', 'null', 'object', 'array', 'missing'];
  const typeText = [...types]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([type, n]) => `${t(type === 'missing' ? '(missing)' : type)} ${n.toLocaleString()}`)
    .join(' · ');
  const lines = [typeText, t('{0} distinct', values.length.toLocaleString())];
  const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));
  if (nums) lines.push(t('min {0} · max {1} · mean {2}', fmt(min), fmt(max), fmt(sum / nums)));
  if (Number.isFinite(shortest)) lines.push(t('length {0}–{1}', shortest.toLocaleString(), longest.toLocaleString()));
  return lines.map((l) => `<div>${esc(l)}</div>`).join('');
}

function valueLabel(v: Cell): string {
  if (v === undefined) return t('(missing)');
  if (v === '') return t('(empty string)');
  return cellText(v);
}

function valueClass(v: Cell): string {
  if (v === undefined || v === '') return 'dim';
  if (v instanceof Shape) return 'tp';
  return isContainer(v) ? 'tp' : primClass(v);
}

/** Compact JSON text of a value. Nesting deeper than 200 levels is cut, so the call stack stays small. */
function compact(v: JVal, depth = 0): string {
  if (v instanceof RawNum) return v.src;
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (depth > 200) return '…';
  if (Array.isArray(v)) return `[${v.map((x) => compact(x, depth + 1)).join(',')}]`;
  return `{${Object.keys(v).map((k) => `${JSON.stringify(k)}:${compact(v[k], depth + 1)}`).join(',')}}`;
}

function chip(v: JVal, key: string, open: boolean): string {
  return `<button class="vchip${open ? ' open' : ''}" data-c="${esc(key)}" title="${t(open ? 'Collapse' : 'Expand')} ${t(kindOf(v))}">${icon(open ? 'chev-down' : 'chev-right', 10)}${summary(v as JObj)}</button>`;
}

function rank(v: Cell): number {
  if (v === undefined) return 6;
  if (v === null) return 5;
  if (v instanceof Shape) return 3;
  if (typeof v === 'number' || v instanceof RawNum) return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

function compare(a: Cell, b: Cell): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return Number(a instanceof RawNum ? a.src : a) - Number(b instanceof RawNum ? b.src : b);
  if (ra === 1) return (a as string).localeCompare(b as string);
  if (ra === 2) return Number(a) - Number(b);
  if (ra === 3) return (a instanceof Shape ? a.size : sizeOf(a as JObj)) - (b instanceof Shape ? b.size : sizeOf(b as JObj));
  return 0;
}
