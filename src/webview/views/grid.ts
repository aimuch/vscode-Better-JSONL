import { t } from '../../shared/i18n';
import type { RenderReport } from '../../shared/protocol';
import { defer, type App, type ColFilter, type View } from '../app';
import { resolveAtPathKey, tryUnpackJsonString } from '../inspect';
import {
  childKey,
  compareNumbers,
  decodeKey,
  entriesHead,
  esc,
  isArr,
  isContainer,
  isObj,
  kindOf,
  parseNumLiteral,
  pathToString,
  plainText,
  primClass,
  RawNum,
  sizeOf,
  summary,
  type JObj,
  type JVal,
} from '../json';
import { icon } from '../icons';
import { lowerBound, type Parsed } from '../model';
import { compactJson } from '../query';

/** Browsers cap element height near 33.5M px. Above this the scroll space is scaled. */
const MAX_SCROLL_PX = 30_000_000;
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
  return v !== undefined && isContainer(v) ? new Shape(Array.isArray(v), sizeOf(v), compactJson(v).slice(0, 2000)) : v;
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
  private sorted = false;
  private idToRow: Map<number, number> | null = null;
  private offsets = new Float64Array(1);
  private ratio = 1;
  private readonly heights = new Map<number, number>();
  private readonly rowH: number;
  private dragging: { col: string; startX: number; startW: number } | null = null;
  private dragRaf = 0;
  private jsonActive = -1;
  private modelRef: unknown;
  private modelRev = -1;
  private structCached = false;
  /** Rows after the search, before the column filters. */
  private baseIds: number[] = [];
  /** What baseIds and rowIds were computed from. They are computed again only when this changes. */
  private baseSig = '';
  private rowSig = '';
  /** Keys of the root object (object mode). */
  private objKeys: string[] = [];
  /** All data column ids available in records mode (including past MAX_COLUMNS, for Column Manager). */
  private rawCols: string[] = [];
  /** Columns of a root array (records mode of a single JSON document). */
  private arrayCols: string[] = [];
  private colsCut = false;
  private hiddenCount = 0;
  /** Column widths that come from the content, by column id. */
  private readonly autoWidths = new Map<string, number>();
  /** Many rows of a large JSON Lines file: sort and filters use the column values read in the background. */
  private heavy = false;
  /** Large files: whole columns read for sort and filters, by column id (index = record number). */
  private readonly colCache = new Map<string, Cell[]>();
  private colModel: unknown;
  private colRev = -1;
  private colJob: { cols: string[]; stop: () => void } | undefined;
  private colPct = 0;
  /** The cell editor (an input over the cell), while a value is edited. */
  private editor: HTMLInputElement | null = null;
  /** The open filter popup: its column and the column's values. */
  private fcol: string | null = null;
  private fvalues: FilterValue[] = [];
  private readonly fel: HTMLElement;
  private readonly cpel: HTMLElement;
  private colSearch = '';
  private ftimer: ReturnType<typeof setTimeout> | undefined;
  private readonly resizes: ResizeObserver;
  private readonly gone = new AbortController();

  constructor(private readonly app: App) {
    this.rowH = app.rh + 6;
    this.el = document.createElement('div');
    this.el.className = 'view grid';
    this.el.innerHTML = `<div class="gscroll" role="table" tabindex="0" aria-label="${t('Grid')}"><div class="ghead" role="row"></div><div class="gbody"><div class="grows" role="rowgroup"></div></div></div>`;
    this.scroll = this.el.querySelector('.gscroll') as HTMLElement;
    this.head = this.el.querySelector('.ghead') as HTMLElement;
    this.bodyEl = this.el.querySelector('.gbody') as HTMLElement;
    this.rowsEl = this.el.querySelector('.grows') as HTMLElement;
    this.scroll.addEventListener('scroll', () => this.paint(), { passive: true });
    this.resizes = new ResizeObserver(() => {
      if (this.ratio < 1) this.applyScrollHeight();
      this.placeFilter();
      this.paint();
    });
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
    this.rowsEl.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.rowsEl.addEventListener('mouseover', (e) => this.onHover(e));
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
    this.cpel = document.createElement('div');
    this.cpel.className = 'col-picker';
    this.cpel.hidden = true;
    this.cpel.setAttribute('role', 'dialog');
    this.cpel.setAttribute('aria-label', t('Columns'));
    this.el.appendChild(this.cpel);
    this.cpel.addEventListener('input', (e) => this.onColPickerInput(e));
    this.cpel.addEventListener('change', (e) => this.onColPickerChange(e));
    this.cpel.addEventListener('click', (e) => this.onColPickerClick(e));
    this.cpel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeColPicker(true);
      }
      e.stopPropagation();
    });
    document.addEventListener(
      'pointerdown',
      (e) => {
        const t = e.target as HTMLElement;
        if (this.fcol !== null && !this.fel.contains(t) && !t.closest('[data-f]')) this.closeFilter();
        if (!this.cpel.hidden && !this.cpel.contains(t) && !t.closest('.cols-btn')) this.closeColPicker();
      },
      { signal },
    );
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && this.fcol !== null) this.closeFilter(true);
        else if (e.key === 'Escape' && !this.cpel.hidden) this.closeColPicker(true);
      },
      { signal },
    );
  }

  dispose(): void {
    clearTimeout(this.ftimer);
    cancelAnimationFrame(this.dragRaf);
    this.colJob?.stop();
    this.resizes.disconnect();
    this.gone.abort();
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.closeFilter();
    this.closeColPicker();
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
    if (!this.cpel.hidden) this.paintColPickerList();
  }

  refresh(): void {
    this.render();
  }

  notes(): string[] {
    const out: string[] = [];
    if (this.colsCut) out.push(t('Showing the first {0} columns', MAX_COLUMNS));
    if (this.hiddenCount > 0) out.push(t('{0} hidden', this.hiddenCount.toLocaleString()));
    if (this.colJob) out.push(t('Reading column values for sort and filters… {0}%', this.colPct));
    return out;
  }

  get canManageCols(): boolean {
    return this.mode === 'records' && this.rawCols.length > 0;
  }

  get colPickerOpen(): boolean {
    return !this.cpel.hidden;
  }

  visibleRecordIds(): readonly number[] {
    return this.rowIds;
  }

  hasActiveColumnFilters(): boolean {
    return this.activeFilters().length > 0;
  }

  clearAllFilters(): void {
    this.app.state.grid.filters.clear();
    this.refilter();
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

  private rowIndexOf(id: number): number {
    if (!this.rowIds.length) return -1;
    if (!this.sorted) {
      const i = lowerBound(this.rowIds, id);
      return i < this.rowIds.length && this.rowIds[i] === id ? i : -1;
    }
    if (!this.idToRow) {
      const map = new Map<number, number>();
      for (let i = 0; i < this.rowIds.length; i++) map.set(this.rowIds[i], i);
      this.idToRow = map;
    }
    return this.idToRow.get(id) ?? -1;
  }

  onActiveChanged(scroll: boolean): void {
    if (this.el.hidden) return;
    if (scroll && this.app.model.isJsonl) {
      const i = this.rowIndexOf(this.app.state.active);
      if (i >= 0) {
        const top = this.offsets[i];
        const vh = (this.scroll.clientHeight || 600) - this.rowH;
        const vt = this.scroll.scrollTop / this.ratio;
        if (top < vt || top + this.rowH > vt + vh) {
          this.scroll.scrollTop = this.toScrollTop(top - vh / 3);
        }
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
      el.classList.toggle('bookmarked', jsonl && s.bookmarks.has(id));
    }
  }

  stepMatch(dir: 1 | -1): void {
    const app = this.app;
    if (!app.query.text || !app.model.isJsonl || !this.rowIds.length) return;
    const i = this.rowIndexOf(app.state.active);
    const next = i < 0 ? this.rowIds[dir > 0 ? 0 : this.rowIds.length - 1] : this.rowIds[(i + dir + this.rowIds.length) % this.rowIds.length];
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

  private buildVisibleCols(raw: string[]): void {
    const g = this.app.state.grid;
    this.rawCols = raw;
    const hidden = g.hiddenCols;
    const pinned = g.pinnedCols;
    const order = g.colOrder;
    const rawSet = new Set(raw);
    this.hiddenCount = 0;
    for (const h of hidden) if (rawSet.has(h)) this.hiddenCount++;

    if (!order.length && !hidden.size && !pinned.size) {
      this.cols = raw.slice(0, MAX_COLUMNS);
      this.colsCut = raw.length > MAX_COLUMNS;
      return;
    }

    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const c of order) {
      if (rawSet.has(c) && !seen.has(c)) {
        seen.add(c);
        ordered.push(c);
      }
    }
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (seen.has(c)) continue;
      if (i < MAX_COLUMNS || pinned.has(c)) {
        seen.add(c);
        ordered.push(c);
      }
    }
    const shown = ordered.filter((c) => !hidden.has(c));
    const pinList = shown.filter((c) => pinned.has(c));
    const unpinList = shown.filter((c) => !pinned.has(c));
    this.cols = [...pinList, ...unpinList];
    this.colsCut = raw.length > seen.size;
  }

  private layout(): void {
    const app = this.app;
    const m = app.model;
    if (this.modelRef !== m || this.modelRev !== m.revision) {
      this.modelRef = m;
      this.modelRev = m.revision;
      this.heights.clear();
      this.baseSig = '';
      this.structCached = false;
    }
    const root = this.rootValue();
    const q = app.query.text;
    this.colsCut = false;
    this.hiddenCount = 0;
    // 1. The mode and the columns. This is cheap, and the columns grow while the file is scanned.
    if (m.isJsonl) {
      this.mode = 'records';
      const raw = m.columns.map(colId);
      if (m.hasNonObject || !raw.length) raw.unshift(VALUE_COL);
      this.buildVisibleCols(raw);
    } else if (root !== undefined && isArr(root)) {
      this.mode = 'records';
      if (!this.structCached) {
        const keys = new Set<string>();
        let nonObj = false;
        for (const item of root) {
          if (!isObj(item)) nonObj = true;
          else if (keys.size < 5000) for (const k in item) keys.add(k);
        }
        const raw = [...keys].map(colId);
        if (nonObj || !raw.length) raw.unshift(VALUE_COL);
        this.arrayCols = raw;
        this.structCached = true;
      }
      this.buildVisibleCols(this.arrayCols);
    } else if (root !== undefined && isObj(root)) {
      this.mode = 'object';
      this.rawCols = [];
      this.cols = [OKEY, OVAL];
      if (!this.structCached) {
        this.objKeys = Object.keys(root);
        this.structCached = true;
      }
    } else {
      this.mode = 'scalar';
      this.rawCols = [];
      this.cols = [VALUE_COL];
    }
    // 2. The rows after the search & global row filters. Computed again only when the lines or the matches change.
    const baseSig = `${m.count}|${m.revision}|${app.matchesVersion}|${q}|${app.globalFilterSig()}`;
    if (baseSig !== this.baseSig) {
      this.baseSig = baseSig;
      // One JSON document with a JSONPath or jq query: a row matches when a result is inside it.
      const hits = !m.isJsonl && app.query.program ? new Set(app.treeMatches.map((k) => decodeKey(k)[0])) : null;
      const matchStr = (s: string) => {
        if (!q) return true;
        if (app.query.re) return app.query.re.test(s);
        if (app.query.regex && app.query.error) return false;
        return app.query.caseSensitive ? s.includes(q) : s.toLowerCase().includes(q);
      };
      this.rowSig = '';
      this.autoWidths.clear();
      const ids: number[] = [];
      if (m.isJsonl) {
        const hasGlobal = app.hasGlobalRowFilter();
        if (q) {
          for (const i of app.matches) if (!m.isBlank(i) && (!hasGlobal || app.passesGlobalRowFilter(i))) ids.push(i);
        } else {
          for (let i = 0; i < m.count; i++) if (!m.isBlank(i) && (!hasGlobal || app.passesGlobalRowFilter(i))) ids.push(i);
        }
      } else if (root !== undefined && isArr(root)) {
        for (let i = 0; i < root.length; i++) {
          if (hits ? hits.has(i) : matchStr(compactJson(root[i]))) ids.push(i);
        }
      } else if (root !== undefined && isObj(root)) {
        for (let i = 0; i < this.objKeys.length; i++) {
          if (hits ? hits.has(this.objKeys[i]) : matchStr(this.objKeys[i] + ' ' + compactJson(root[this.objKeys[i]]))) ids.push(i);
        }
      } else if (root !== undefined) ids.push(0);
      this.baseIds = ids;
    }
    // 3. Column filters and the sort. Both read a cell of every row, so the result is kept.
    if (this.colModel !== m || this.colRev !== m.revision) {
      this.colModel = m;
      this.colRev = m.revision;
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
    const rowSig = JSON.stringify([sort, filters.map(([c, f]) => [c, f.text, f.min ?? '', f.max ?? '', [...f.exclude]])]);
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
      this.sorted = !!sort;
      this.idToRow = null;
    }
    this.computeOffsets();
    this.paintHead();
  }

  private computeOffsets(): void {
    const n = this.rowIds.length;
    const off = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + (this.heights.get(this.rowIds[i]) ?? this.rowH);
    this.offsets = off;
    this.applyScrollHeight();
  }

  private applyScrollHeight(): void {
    const full = this.offsets[this.rowIds.length] ?? 0;
    const vh = Math.max(1, (this.scroll.clientHeight || 600) - 28);
    if (full > MAX_SCROLL_PX && full > vh) {
      this.ratio = (MAX_SCROLL_PX - vh) / (full - vh);
      this.bodyEl.style.height = `${MAX_SCROLL_PX}px`;
    } else {
      this.ratio = 1;
      this.bodyEl.style.height = `${full}px`;
    }
  }

  private toScrollTop(virtY: number): number {
    const full = this.offsets[this.rowIds.length] ?? 0;
    const vh = Math.max(1, (this.scroll.clientHeight || 600) - 28);
    return Math.max(0, Math.min(Math.max(0, full - vh), virtY)) * this.ratio;
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
    const g = this.app.state.grid;
    const sort = g.sort;
    const pinned = g.pinnedCols;
    const cols = this.allCols();
    const filters = g.filters;
    const filterable = this.mode !== 'scalar';
    let lastPin = -1;
    cols.forEach((c, i) => {
      if (c === NUM || pinned.has(c)) lastPin = i;
    });
    this.applyWidths();
    this.head.innerHTML = cols
      .map((c, i) => {
        const isPin = c === NUM || pinned.has(c);
        const sorted = sort && sort.col === c ? (sort.dir > 0 ? icon('chev-up', 11) : icon('chev-down', 11)) : '';
        const pinMark = pinned.has(c) ? `<span class="pin-mark" title="${esc(t('Unpin column'))}">${icon('pin', 10)}</span>` : '';
        const label = c === VALUE_COL ? `<span class="dim">${t('(value)')}</span>` : esc(this.label(c));
        const f = filters.get(c);
        const on = isFilterActive(f);
        const fbtn =
          filterable && c !== NUM
            ? `<button class="gh-f${on ? ' on' : ''}${this.fcol === c ? ' open' : ''}" data-f="${esc(c)}" aria-label="${esc(t('Filter {0}', this.label(c)))}" aria-pressed="${on}" title="${t('Filter this column')}">${icon('filter', 12)}</button>`
            : '';
        const sortState = sort && sort.col === c ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none';
        const cls = ['gh'];
        if (c === NUM) cls.push('num');
        if (isPin) cls.push('sticky');
        if (i === lastPin) cls.push('last-pin');
        if (on) cls.push('filtered');
        const style = isPin ? `width:var(--w${i});left:var(--x${i})` : `width:var(--w${i})`;
        return `<div class="${cls.join(' ')}" role="columnheader" tabindex="0" aria-sort="${sortState}" data-col="${esc(c)}" style="${style}" title="${esc(this.label(c))}">${pinMark}<span class="gh-l">${label}</span>${sorted}${fbtn}<span class="rz" data-rz="${esc(c)}"></span></div>`;
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
      this.rowsEl.innerHTML = `<div class="empty-note">${this.app.query.text || filtered || this.app.hasGlobalRowFilter() ? t('No row matches the filter.') : t('No rows.')}${clear}</div>`;
      return;
    }
    const vh = this.scroll.clientHeight || 600;
    const st = this.scroll.scrollTop;
    const virtTop = st / this.ratio;
    const searchTop = Math.max(0, virtTop - this.rowH);
    let lo = 0;
    let hi = this.rowIds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= searchTop) lo = mid;
      else hi = mid - 1;
    }
    const first = Math.max(0, lo - 3);
    const html: string[] = [];
    let i = first;
    while (i < this.rowIds.length && this.offsets[i] < virtTop + vh + this.rowH * 4) {
      html.push(this.rowHtml(this.rowIds[i]));
      i++;
    }
    this.rowsEl.style.transform = `translateY(${st + this.offsets[first] - virtTop}px)`;
    this.rowsEl.innerHTML = html.join('');
    this.measure(first);
  }

  /** Rows with open sub-grids or wrapped cells are taller. Measure them and lay out again when needed. */
  private measure(firstIdx: number): void {
    let changed = false;
    this.rowsEl.querySelectorAll<HTMLElement>('.grow').forEach((el) => {
      const id = Number(el.dataset.id);
      const h = el.offsetHeight;
      const known = this.heights.get(id) ?? this.rowH;
      if (Math.abs(h - known) > 0.5) {
        if (Math.abs(h - this.rowH) < 0.5) this.heights.delete(id);
        else {
          if (this.heights.size >= 20_000 && !this.heights.has(id)) {
            const oldest = this.heights.keys().next().value;
            if (oldest !== undefined) this.heights.delete(oldest);
          }
          this.heights.set(id, h);
        }
        changed = true;
      }
    });
    if (changed) {
      this.computeOffsets();
      const st = this.scroll.scrollTop;
      const virtTop = st / this.ratio;
      if (firstIdx >= 0 && firstIdx < this.offsets.length) {
        this.rowsEl.style.transform = `translateY(${st + this.offsets[firstIdx] - virtTop}px)`;
      }
    }
  }

  private rowHtml(id: number): string {
    const app = this.app;
    const jsonl = app.model.isJsonl;
    const active = jsonl ? app.state.active === id : this.jsonActive === id;
    const sel = jsonl && app.state.selected.has(id);
    const bm = jsonl && app.state.bookmarks.has(id);
    const pinned = app.state.grid.pinnedCols;
    const cols = this.allCols();
    let lastPin = -1;
    cols.forEach((c, i) => {
      if (c === NUM || pinned.has(c)) lastPin = i;
    });
    const p = this.record(id);
    const cells: string[] = [];
    const details: string[] = [];
    const open = app.state.grid.open;
    const unpacked = app.unpackedOf(id);
    if (p.kind === 'error') {
      cells.push(`<div class="gc num sticky last-pin" role="cell" style="width:var(--w0);left:var(--x0)">${id + 1}</div>`);
      cells.push(`<div class="gc err-cell" role="cell">${icon('warning', 12)}<span>${esc(p.message)}</span></div>`);
    } else {
      cols.forEach((c, i) => {
        const isPin = c === NUM || pinned.has(c);
        const pinCls = isPin ? ` sticky${i === lastPin ? ' last-pin' : ''}` : '';
        const style = isPin ? `style="width:var(--w${i});left:var(--x${i})"` : `style="width:var(--w${i})"`;
        if (c === NUM) {
          cells.push(`<div class="gc num${pinCls}" role="cell" ${style}>${jsonl ? id + 1 : id}</div>`);
          return;
        }
        const v = this.cell(id, c);
        if (v === undefined) {
          cells.push(`<div class="gc miss${pinCls}" role="cell" ${style}></div>`);
          return;
        }
        if (c === OKEY) {
          cells.push(`<div class="gc tk${pinCls}" role="cell" ${style} title="${esc(String(v))}">${esc(String(v))}</div>`);
          return;
        }
        const rel = this.cellPath(id, c);
        if (typeof v === 'string' && unpacked.has(rel)) {
          const parsed = tryUnpackJsonString(v);
          if (parsed !== undefined && isContainer(parsed)) {
            const key = `${id}|${rel}`;
            const isOpen = open.has(key);
            cells.push(
              `<div class="gc${pinCls}" role="cell" ${style}>${chip(parsed, key, isOpen)}<button class="pill unpack-btn on" data-unpack="${esc(rel)}" title="${esc(t('Fold unpacked JSON'))}">↩</button></div>`,
            );
            if (isOpen) details.push(this.detailHtml(id, c, parsed));
            return;
          }
        }
        if (isContainer(v)) {
          const key = `${id}|${rel}`;
          const isOpen = open.has(key);
          cells.push(`<div class="gc${pinCls}" role="cell" ${style}>${chip(v, key, isOpen)}</div>`);
          if (isOpen) details.push(this.detailHtml(id, c, v));
          return;
        }
        const txt = plainText(v);
        const max = app.state.wrap ? CELL_CHARS_WRAP : CELL_CHARS;
        const shown = txt.length > max ? txt.slice(0, max) + '…' : txt;
        const cls = primClass(v) + (typeof v === 'number' || v instanceof RawNum ? ' right' : '') + pinCls;
        const canUnpack = typeof v === 'string' && v.length <= 262_144 && tryUnpackJsonString(v) !== undefined;
        const ubtn = canUnpack ? `<button class="pill unpack-btn" data-unpack="${esc(rel)}" title="${esc(t('Unpack JSON'))}">{…}</button>` : '';
        cells.push(`<div class="gc ${cls}" role="cell" ${style} title="${esc(txt.slice(0, 1000))}"><span class="gc-t">${esc(shown)}</span>${ubtn}</div>`);
      });
    }
    const cls = ['grow'];
    if (sel) cls.push('sel');
    if (active) cls.push('act');
    if (bm) cls.push('bookmarked');
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
    const maxChars = this.app.state.wrap ? CELL_CHARS_WRAP : CELL_CHARS;
    const inner = (child: JVal, key: string): string => {
      if (!isContainer(child)) {
        const txt = plainText(child);
        return `<span class="${primClass(child)}" title="${esc(txt.slice(0, 1000))}">${esc(txt.length > maxChars ? txt.slice(0, maxChars) + '…' : txt)}</span>`;
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
          `<tr><td class="num dim" data-p="${esc(base)}">${i}</td>${keys.map((k) => {
            const pk = childKey(base, k);
            return k in o ? `<td data-p="${esc(pk)}">${inner(o[k], pk)}</td>` : '<td class="miss"></td>';
          }).join('')}</tr>`,
        );
      });
    } else {
      rows.push(`<tr><th>${isArr(v) ? '#' : t('key')}</th><th>${t('value')}</th></tr>`);
      entriesHead(v, NESTED_ROWS).forEach(([k, child]) => {
        const pk = childKey(rel, k);
        const label = typeof k === 'number' ? `<td class="num dim" data-p="${esc(pk)}">${k}</td>` : `<td class="tk" data-p="${esc(pk)}">${esc(k)}</td>`;
        rows.push(`<tr>${label}<td data-p="${esc(pk)}">${inner(child, pk)}</td></tr>`);
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
    if (this.app.state.wrap && !this.dragRaf) {
      // Wrapped cells change height with the column width: coalesce reflows to animation frames.
      this.dragRaf = requestAnimationFrame(() => {
        this.dragRaf = 0;
        if (!this.el.hidden) {
          this.heights.clear();
          this.computeOffsets();
          this.paint();
        }
      });
    }
  }

  private onHeadClick(e: MouseEvent): void {
    const tEl = e.target as HTMLElement;
    if (tEl.closest('[data-rz]')) return;
    const fb = tEl.closest('[data-f]') as HTMLElement | null;
    if (fb) {
      const col = fb.dataset.f as string;
      if (this.fcol === col) this.closeFilter();
      else this.openFilter(col);
      return;
    }
    const h = tEl.closest('[data-col]') as HTMLElement | null;
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
    const tEl = e.target as HTMLElement;
    if (tEl.closest('[data-clear-filters]')) {
      this.app.state.grid.filters.clear();
      this.refilter();
      return;
    }
    const rowEl = tEl.closest('.grow') as HTMLElement | null;
    if (!rowEl) return;
    const id = Number(rowEl.dataset.id);
    const unpackBtn = tEl.closest('[data-unpack]') as HTMLElement | null;
    if (unpackBtn) {
      const rel = unpackBtn.dataset.unpack as string;
      const key = `${id}|${rel}`;
      const wasUnpacked = this.app.unpackedOf(id).has(rel);
      this.app.toggleUnpack(id, rel);
      if (!wasUnpacked) this.app.state.grid.open.add(key);
      else this.app.state.grid.open.delete(key);
      this.render();
      this.app.stateChanged();
      return;
    }
    const chipEl = tEl.closest('[data-c]') as HTMLElement | null;
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
    if (e.altKey && tEl.closest('.gc.num') && this.app.model.isJsonl) {
      this.app.toggleBookmark(id);
      return;
    }
    if (tEl.closest('.gdetail')) return;
    if (this.app.model.isJsonl) {
      const how = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'set';
      this.app.selectRecord(id, how);
    } else {
      this.jsonActive = id;
      this.markRows();
    }
  }

  private onDblClick(e: MouseEvent): void {
    const tEl = e.target as HTMLElement;
    const rowEl = tEl.closest('.grow') as HTMLElement | null;
    if (!rowEl || tEl.closest('[data-c],[data-unpack]')) return;
    const id = Number(rowEl.dataset.id);
    const subTd = tEl.closest('.ng td[data-p]') as HTMLElement | null;
    if (subTd) {
      window.getSelection()?.removeAllRanges();
      const pk = subTd.dataset.p as string;
      if (!subTd.classList.contains('tk') && !subTd.classList.contains('num') && this.startSubEdit(id, pk, subTd)) return;
      const path = this.recordPath(id, pk);
      if (!this.app.canRevealSource) {
        const recP = this.record(id);
        const val = recP.kind === 'value' ? resolveAtPathKey(recP.value, pk, this.app.unpackedOf(id)) : undefined;
        this.app.openValueInspector(id, path, val);
        return;
      }
      this.app.reveal(id, path);
      return;
    }
    const cellEl = tEl.closest('.gc') as HTMLElement | null;
    const idx = cellEl ? Array.from(cellEl.parentElement!.children).indexOf(cellEl) : -1;
    const col = idx >= 0 ? this.allCols()[idx] : undefined;
    // A value cell opens the cell editor; the # cell and the others go to the source (or Value Inspector on .gz).
    if (cellEl && col && this.startEdit(id, col, cellEl)) return;
    const rel = col && col !== NUM ? this.cellPath(id, col) : '';
    const path = this.recordPath(id, rel);
    if (!this.app.canRevealSource) {
      const val = col && col !== NUM ? this.cell(id, col) : this.record(id).kind === 'value' ? (this.record(id) as { kind: 'value'; value: JVal }).value : undefined;
      this.app.openValueInspector(id, path, val);
      return;
    }
    this.app.reveal(id, path);
  }

  private onContextMenu(e: MouseEvent): void {
    const tEl = e.target as HTMLElement;
    const rowEl = tEl.closest('.grow') as HTMLElement | null;
    if (!rowEl) return;
    e.preventDefault();
    const id = Number(rowEl.dataset.id);
    if (this.app.model.isJsonl && !this.app.state.selected.has(id)) this.app.selectRecord(id, 'set');
    const subTd = tEl.closest('.ng td[data-p]') as HTMLElement | null;
    if (subTd) {
      const pk = subTd.dataset.p as string;
      const recP = this.record(id);
      const val = recP.kind === 'value' ? resolveAtPathKey(recP.value, pk, this.app.unpackedOf(id)) : undefined;
      this.app.openContextMenu(e, { record: id, path: this.recordPath(id, pk), value: val, hasValue: val !== undefined });
      return;
    }
    const cellEl = tEl.closest('.gc') as HTMLElement | null;
    const idx = cellEl ? Array.from(cellEl.parentElement!.children).indexOf(cellEl) : -1;
    const col = idx >= 0 ? this.allCols()[idx] : undefined;
    const rel = col && col !== NUM ? this.cellPath(id, col) : '';
    const val = col && col !== NUM ? this.cell(id, col) : this.record(id).kind === 'value' ? (this.record(id) as { kind: 'value'; value: JVal }).value : undefined;
    this.app.openContextMenu(e, { record: id, path: this.recordPath(id, rel), value: val, hasValue: val !== undefined });
  }

  private onHover(e: MouseEvent): void {
    const cellEl = (e.target as HTMLElement).closest('.gc.ts, .gc.tn') as HTMLElement | null;
    if (!cellEl || cellEl.dataset.tip === '1') return;
    cellEl.dataset.tip = '1';
    const rowEl = cellEl.closest('.grow') as HTMLElement | null;
    if (!rowEl) return;
    const id = Number(rowEl.dataset.id);
    const idx = Array.from(cellEl.parentElement!.children).indexOf(cellEl);
    const col = idx >= 0 ? this.allCols()[idx] : undefined;
    if (!col || col === NUM) return;
    const v = this.cell(id, col);
    if (v === undefined) return;
    const tip = this.app.smartTooltip(id, v);
    if (tip) cellEl.title = tip;
  }

  // ---------- cell editing ----------

  private openOverlayInput(anchorEl: HTMLElement, label: string, initial: string, isString: boolean, onCommit: (jsonText: string) => void): boolean {
    this.cancelEdit();
    const host = this.el.getBoundingClientRect();
    const r = anchorEl.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 140), Math.max(140, host.width - 8));
    const left = Math.max(4, Math.min(r.left - host.left, host.width - width - 4));
    const top = Math.max(0, r.top - host.top);
    const input = document.createElement('input');
    input.className = 'gedit';
    input.spellcheck = false;
    input.value = initial;
    input.setAttribute('aria-label', t('Edit the value of {0}', label));
    if (!isString && initial === '') input.placeholder = '"text", 42, true, null';
    input.style.cssText = `left:${left}px;top:${top}px;width:${width}px;height:${r.height}px`;
    const original = isString ? JSON.stringify(initial) : initial;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelEdit();
        this.scroll.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        let text = isString ? JSON.stringify(input.value) : input.value.trim();
        if (!isString && !text) {
          this.cancelEdit();
          return;
        }
        try {
          JSON.parse(text);
        } catch {
          input.classList.add('bad');
          input.title = t('Not a JSON value. Put text in quotes to make it a string.');
          return;
        }
        if (text === original) {
          this.cancelEdit();
          return;
        }
        if (!isString && /^-?\d/.test(text)) text = text.replace(/\s+/g, '');
        this.cancelEdit();
        onCommit(text);
      }
    });
    input.addEventListener('blur', () => this.cancelEdit());
    this.el.appendChild(input);
    this.editor = input;
    input.focus();
    input.select();
    return true;
  }

  /**
   * Opens the cell editor on a value cell (including missing cells on object rows). A string cell
   * stays a string; another cell takes a JSON value (type "text" in quotes to make it a string).
   */
  private startEdit(id: number, col: string, cellEl: HTMLElement): boolean {
    const app = this.app;
    const rec = this.record(id);
    if (!app.canEditCells || col === NUM || col === OKEY || rec.kind !== 'value') return false;
    const v = this.cell(id, col);
    if (v === undefined) {
      if (col === VALUE_COL || this.mode !== 'records' || !isObj(rec.value)) return false;
      const key = keyOf(col);
      return this.openOverlayInput(cellEl, this.label(col), '', false, (text) => {
        app.insertMissingCell(id, this.recordPath(id, childKey('', key)), key, text);
      });
    }
    if (isContainer(v)) return false;
    if (typeof v === 'string' && app.unpackedOf(id).has(this.cellPath(id, col))) return false;
    const isString = typeof v === 'string';
    const initial = isString ? v : v instanceof RawNum ? v.src : String(v);
    return this.openOverlayInput(cellEl, this.label(col), initial, isString, (text) => {
      const rel = decodeKey(this.cellPath(id, col));
      app.editCell(id, app.model.isJsonl ? rel : this.recordPath(id, this.cellPath(id, col)), text);
    });
  }

  private startSubEdit(id: number, pathKey: string, tdEl: HTMLElement): boolean {
    const app = this.app;
    const rec = this.record(id);
    if (!app.canEditCells || rec.kind !== 'value') return false;
    if (app.unpackedOf(id).size > 0) {
      // Check if an ancestor was unpacked from a string: direct source span editing does not apply inside a string literal.
      let prefix = '';
      for (const seg of decodeKey(pathKey)) {
        if (app.unpackedOf(id).has(prefix)) return false;
        prefix = childKey(prefix, seg);
      }
    }
    const v = resolveAtPathKey(rec.value, pathKey);
    if (v === undefined || isContainer(v)) return false;
    const isString = typeof v === 'string';
    const initial = isString ? v : v instanceof RawNum ? v.src : String(v);
    return this.openOverlayInput(tdEl, pathToString(decodeKey(pathKey)), initial, isString, (text) => {
      app.editCell(id, app.model.isJsonl ? decodeKey(pathKey) : this.recordPath(id, pathKey), text);
    });
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
    const g = this.app.state.grid;
    const customCols = g.hiddenCols.size > 0 || g.colOrder.length > 0 || g.pinnedCols.size > 0;
    const cols = !customCols && this.mode === 'records' && this.rawCols.length > this.cols.length ? this.rawCols : this.cols;
    const root = this.rootValue();
    const header = cols.map((c) => (c === VALUE_COL ? '(value)' : c === OKEY ? 'key' : c === OVAL ? 'value' : keyOf(c)));
    return {
      ids: [...this.rowIds],
      header,
      line: (id) => {
        if (m.isJsonl) return m.line(id);
        if (this.mode === 'object') return compactJson({ key: this.objKeys[id], value: (root as JObj)[this.objKeys[id]] });
        const p = this.record(id);
        return p.kind === 'value' ? compactJson(p.value) : '';
      },
      cells: (id) => cols.map((c) => cellText(this.cell(id, c))),
    };
  }

  // ---------- column manager ----------

  toggleColPicker(): void {
    if (!this.cpel.hidden) {
      this.closeColPicker(true);
      return;
    }
    this.closeFilter();
    this.colSearch = '';
    this.cpel.innerHTML = `
      <div class="gf-title">${icon('columns', 13)}<span>${esc(t('Columns'))}</span></div>
      <label class="search gf-search">${icon('search')}<span class="sr">${esc(t('Filter columns'))}</span><input type="search" data-csearch placeholder="${esc(t('Filter columns'))}" spellcheck="false"></label>
      <div class="gf-list cp-list" role="group"></div>
      <div class="gf-foot">
        <button class="btn" data-cshowall>${esc(t('Show all'))}</button>
        <button class="btn" data-creset>${esc(t('Reset columns'))}</button>
        <span class="spring"></span>
        <span class="dim cp-count"></span>
      </div>`;
    this.cpel.hidden = false;
    this.paintColPickerList();
    this.placeColPicker();
    (this.cpel.querySelector('[data-csearch]') as HTMLInputElement).focus();
  }

  closeColPicker(focusBtn = false): void {
    if (this.cpel.hidden) return;
    this.cpel.hidden = true;
    this.cpel.innerHTML = '';
    this.app.paintChrome();
    if (focusBtn) (document.querySelector('.cols-btn') as HTMLElement | null)?.focus();
  }

  private placeColPicker(): void {
    if (this.cpel.hidden) return;
    const btn = document.querySelector('.cols-btn') as HTMLElement | null;
    const host = this.el.getBoundingClientRect();
    const w = this.cpel.offsetWidth || 280;
    const r = btn?.getBoundingClientRect();
    const left = r ? Math.max(4, Math.min(r.left - host.left, host.width - w - 8)) : Math.max(4, host.width - w - 12);
    this.cpel.style.left = `${left}px`;
    this.cpel.style.top = '6px';
    this.cpel.style.maxHeight = `${Math.max(180, Math.min(440, host.height - 16))}px`;
  }

  private paintColPickerList(): void {
    if (this.cpel.hidden) return;
    const g = this.app.state.grid;
    const q = this.colSearch.toLowerCase();
    const visibleSet = new Set(this.cols);
    // Show visible columns first in their active order, followed by hidden / unmounted rawCols.
    const all = [...this.cols, ...this.rawCols.filter((c) => !visibleSet.has(c))];
    const matched = q ? all.filter((c) => this.label(c).toLowerCase().includes(q)) : all;
    const list = this.cpel.querySelector('.cp-list') as HTMLElement;
    const rows = matched.slice(0, 400).map((c) => {
      const checked = visibleSet.has(c);
      const pinned = g.pinnedCols.has(c);
      const name = this.label(c);
      return `<div class="cp-row" data-ccol="${esc(c)}">
        <label class="cp-lbl" title="${esc(name)}"><input type="checkbox" data-ctoggle="${esc(c)}"${checked ? ' checked' : ''}><span class="gf-v">${esc(name)}</span></label>
        <button class="icon-btn cp-act${pinned ? ' on' : ''}" data-cpin="${esc(c)}" title="${esc(t(pinned ? 'Unpin column' : 'Pin column to left'))}" aria-pressed="${pinned}">${icon('pin', 12)}</button>
        <button class="icon-btn cp-act" data-cmove="-1" data-cc="${esc(c)}" title="${esc(t('Move column left'))}">${icon('chev-left', 12)}</button>
        <button class="icon-btn cp-act" data-cmove="1" data-cc="${esc(c)}" title="${esc(t('Move column right'))}">${icon('chev-right', 12)}</button>
      </div>`;
    });
    if (!rows.length) rows.push(`<div class="gf-more">${esc(t('No value contains this text.'))}</div>`);
    list.innerHTML = rows.join('');
    const countEl = this.cpel.querySelector('.cp-count') as HTMLElement | null;
    if (countEl) countEl.textContent = `${this.cols.length} / ${this.rawCols.length}`;
  }

  private ensureColOrder(): string[] {
    const g = this.app.state.grid;
    if (!g.colOrder.length) g.colOrder = [...this.cols, ...this.rawCols.filter((c) => !this.cols.includes(c)).slice(0, MAX_COLUMNS)];
    return g.colOrder;
  }

  private onColPickerInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (!input.hasAttribute('data-csearch')) return;
    this.colSearch = input.value.trim();
    this.paintColPickerList();
  }

  private onColPickerChange(e: Event): void {
    const box = e.target as HTMLInputElement;
    const col = box.dataset.ctoggle;
    if (!col) return;
    const g = this.app.state.grid;
    if (box.checked) {
      g.hiddenCols.delete(col);
      const ord = this.ensureColOrder();
      if (!ord.includes(col)) ord.push(col);
    } else {
      g.hiddenCols.add(col);
      g.pinnedCols.delete(col);
    }
    this.layout();
    this.paint();
    this.paintColPickerList();
    this.app.paintChrome();
    this.app.stateChanged();
  }

  private onColPickerClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!btn) return;
    const g = this.app.state.grid;
    if (btn.hasAttribute('data-cshowall')) {
      g.hiddenCols.clear();
      g.colOrder = this.rawCols.slice(0, Math.max(MAX_COLUMNS, this.rawCols.length));
    } else if (btn.hasAttribute('data-creset')) {
      g.hiddenCols.clear();
      g.pinnedCols.clear();
      g.colOrder = [];
      g.widths = {};
    } else if (btn.dataset.cpin !== undefined) {
      const col = btn.dataset.cpin;
      if (!g.pinnedCols.delete(col)) {
        g.pinnedCols.add(col);
        g.hiddenCols.delete(col);
      }
    } else if (btn.dataset.cmove !== undefined) {
      const col = btn.dataset.cc as string;
      const dir = Number(btn.dataset.cmove);
      const ord = this.ensureColOrder();
      if (!ord.includes(col)) ord.push(col);
      const visibleOrd = ord.filter((c) => !g.hiddenCols.has(c) && g.pinnedCols.has(c) === g.pinnedCols.has(col));
      const pos = visibleOrd.indexOf(col);
      const target = visibleOrd[pos + dir];
      if (pos >= 0 && target !== undefined) {
        const ia = ord.indexOf(col);
        const ib = ord.indexOf(target);
        ord[ia] = target;
        ord[ib] = col;
      }
    } else return;
    this.layout();
    this.paint();
    this.paintColPickerList();
    this.app.paintChrome();
    this.app.stateChanged();
  }

  // ---------- column filters ----------

  /** Filters that narrow the rows, on columns that exist. `except` leaves one column out. */
  private activeFilters(except?: string): [string, ColFilter][] {
    const out: [string, ColFilter][] = [];
    for (const [c, f] of this.app.state.grid.filters) {
      if (c !== except && isFilterActive(f) && this.cols.includes(c)) out.push([c, f]);
    }
    return out;
  }

  private passes(id: number, filters: [string, ColFilter][]): boolean {
    for (const [c, f] of filters) {
      const v = this.val(id, c);
      if (f.exclude.size && f.exclude.has(valueKey(v))) return false;
      if (f.text) {
        const q = f.text.toLowerCase();
        if (!cellText(v).toLowerCase().includes(q) && !valueLabel(v).toLowerCase().includes(q)) return false;
      }
      if (f.min !== undefined && f.min !== '' && !Number.isNaN(Number(f.min))) {
        if (typeof v !== 'number' && !(v instanceof RawNum)) return false;
        if (compareNumbers(v, parseNumLiteral(f.min)) < 0) return false;
      }
      if (f.max !== undefined && f.max !== '' && !Number.isNaN(Number(f.max))) {
        if (typeof v !== 'number' && !(v instanceof RawNum)) return false;
        if (compareNumbers(v, parseNumLiteral(f.max)) > 0) return false;
      }
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

  /** Values the search box and numeric range let through. */
  private shownValues(): FilterValue[] {
    const f = this.app.state.grid.filters.get(this.fcol as string);
    const q = f?.text.toLowerCase() ?? '';
    const hasMin = f?.min !== undefined && f.min !== '' && !Number.isNaN(Number(f.min));
    const hasMax = f?.max !== undefined && f.max !== '' && !Number.isNaN(Number(f.max));
    const minVal = hasMin ? parseNumLiteral(f!.min!) : 0;
    const maxVal = hasMax ? parseNumLiteral(f!.max!) : 0;
    if (!q && !hasMin && !hasMax) return this.fvalues;
    return this.fvalues.filter((x) => {
      if (q && !x.text.includes(q) && !valueLabel(x.v).toLowerCase().includes(q)) return false;
      if (hasMin || hasMax) {
        if (typeof x.v !== 'number' && !(x.v instanceof RawNum)) return false;
        if (hasMin && compareNumbers(x.v, minVal) < 0) return false;
        if (hasMax && compareNumbers(x.v, maxVal) > 0) return false;
      }
      return true;
    });
  }

  private openFilter(col: string): void {
    this.closeColPicker();
    this.fcol = col;
    this.fvalues = this.valuesOf(col);
    const f = this.app.state.grid.filters.get(col);
    const name = this.label(col);
    const hasNums = this.fvalues.some((x) => typeof x.v === 'number' || x.v instanceof RawNum) || !!(f?.min || f?.max);
    const rangeHtml = hasNums
      ? `<div class="gf-range"><input type="text" inputmode="decimal" data-fmin placeholder="${esc(t('Min'))}" aria-label="${esc(t('Min'))}" value="${esc(f?.min ?? '')}"><input type="text" inputmode="decimal" data-fmax placeholder="${esc(t('Max'))}" aria-label="${esc(t('Max'))}" value="${esc(f?.max ?? '')}"></div>`
      : '';
    this.fel.setAttribute('aria-label', t('Filter {0}', name));
    this.fel.innerHTML = `
      <div class="gf-title" title="${esc(name)}">${icon('filter', 12)}<span>${esc(name)}</span></div>
      <div class="gf-stats dim">${statsHtml(this.fvalues)}</div>
      <div class="gf-sort">
        <button class="btn" data-fsort="1">${icon('chev-up', 11)}${t('Sort ascending')}</button>
        <button class="btn" data-fsort="-1">${icon('chev-down', 11)}${t('Sort descending')}</button>
      </div>
      ${rangeHtml}
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
    if (!isFilterActive(f)) this.app.state.grid.filters.delete(col);
    this.paintHead();
    if (focusGrid) {
      const btn = this.head.querySelector(`[data-col="${CSS.escape(col)}"] .gh-f`) as HTMLElement | null;
      (btn ?? this.scroll).focus();
    }
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
    this.fel.style.maxHeight = `${Math.max(120, Math.min(460, host.height - top - 8))}px`;
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
    if (this.fcol === null) return;
    const isRange = input.hasAttribute('data-fmin') || input.hasAttribute('data-fmax');
    if (input.type !== 'search' && !isRange) return;
    const f = this.filterOf(this.fcol);
    if (input.hasAttribute('data-fmin')) f.min = input.value.trim() || undefined;
    else if (input.hasAttribute('data-fmax')) f.max = input.value.trim() || undefined;
    else f.text = input.value.trim();
    clearTimeout(this.ftimer);
    this.ftimer = setTimeout(() => {
      if (this.fcol === null) return;
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

function isFilterActive(f: ColFilter | undefined): boolean {
  return !!f && (!!f.text || f.exclude.size > 0 || !!(f.min && f.min.length) || !!(f.max && f.max.length));
}

/** Key that groups equal cells in a column filter. Strings and numbers never share a key. */
function valueKey(v: Cell): string {
  if (v === undefined) return MISSING;
  if (v instanceof Shape) return 'j' + v.text;
  if (v === null) return 'z';
  if (typeof v === 'boolean') return v ? 'b1' : 'b0';
  if (typeof v === 'number' || v instanceof RawNum) return 'n' + plainText(v);
  if (typeof v === 'string') return 's' + v;
  return 'j' + compactJson(v);
}

/** Text a column filter searches: the shown text, or compact JSON for objects and arrays. */
function cellText(v: Cell): string {
  if (v === undefined) return '';
  if (v instanceof Shape) return v.text;
  return isContainer(v) ? compactJson(v) : plainText(v);
}

/** The type of a cell, for the column statistics. */
function cellType(v: Cell): string {
  if (v === undefined) return 'missing';
  if (v instanceof Shape) return v.arr ? 'array' : 'object';
  return kindOf(v);
}

function formatNumStat(v: number | RawNum): string {
  if (v instanceof RawNum) {
    if (/^-?\d+$/.test(v.src)) {
      const neg = v.src.startsWith('-');
      const digits = neg ? v.src.slice(1) : v.src;
      return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }
    return v.src;
  }
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Column statistics from the distinct values and their counts: types, distinct count,
 * exact min/max/mean, p50/p95/p99 percentiles, sum, and a 12-bin distribution histogram.
 */
function statsHtml(values: FilterValue[]): string {
  const types = new Map<string, number>();
  const numItems: { v: number | RawNum; f: number; count: number }[] = [];
  let nums = 0;
  let sum = 0;
  let minVal: number | RawNum | undefined;
  let maxVal: number | RawNum | undefined;
  let minF = Infinity;
  let maxF = -Infinity;
  let shortest = Infinity;
  let longest = 0;
  for (const x of values) {
    const type = cellType(x.v);
    types.set(type, (types.get(type) ?? 0) + x.n);
    if (type === 'number') {
      const nv = x.v as number | RawNum;
      const nf = nv instanceof RawNum ? Number(nv.src) : nv;
      nums += x.n;
      sum += nf * x.n;
      if (minVal === undefined || compareNumbers(nv, minVal) < 0) minVal = nv;
      if (maxVal === undefined || compareNumbers(nv, maxVal) > 0) maxVal = nv;
      if (nf < minF) minF = nf;
      if (nf > maxF) maxF = nf;
      numItems.push({ v: nv, f: nf, count: x.n });
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
  let histHtml = '';
  if (nums && minVal !== undefined && maxVal !== undefined) {
    lines.push(t('min {0} · max {1} · mean {2}', formatNumStat(minVal), formatNumStat(maxVal), formatNumStat(sum / nums)));
    if (nums >= 3) {
      const quantile = (q: number): number | RawNum => {
        const target = Math.max(1, Math.ceil(nums * q));
        let acc = 0;
        for (const it of numItems) {
          acc += it.count;
          if (acc >= target) return it.v;
        }
        return numItems[numItems.length - 1].v;
      };
      lines.push(`${t('p50 {0} · p95 {1} · p99 {2}', formatNumStat(quantile(0.5)), formatNumStat(quantile(0.95)), formatNumStat(quantile(0.99)))} · ${t('sum {0}', formatNumStat(sum))}`);
    }
    if (nums >= 2 && Number.isFinite(minF) && Number.isFinite(maxF) && maxF > minF) {
      const BINS = 12;
      const bins = new Int32Array(BINS);
      const span = maxF - minF;
      for (const it of numItems) {
        if (!Number.isFinite(it.f)) continue;
        const b = Math.min(BINS - 1, Math.max(0, Math.floor(((it.f - minF) / span) * BINS)));
        bins[b] += it.count;
      }
      let peak = 1;
      for (let i = 0; i < BINS; i++) if (bins[i] > peak) peak = bins[i];
      const bars: string[] = [];
      for (let i = 0; i < BINS; i++) {
        const h = bins[i] > 0 ? Math.max(12, Math.round((bins[i] / peak) * 100)) : 0;
        const lo = minF + (i / BINS) * span;
        const hi = minF + ((i + 1) / BINS) * span;
        bars.push(`<span class="gf-hbar" style="height:${h}%" title="${esc(`${formatNumStat(lo)}–${formatNumStat(hi)}: ${bins[i]}`)}"></span>`);
      }
      histHtml = `<div class="gf-hist" aria-hidden="true">${bars.join('')}</div>`;
    }
  }
  if (Number.isFinite(shortest)) lines.push(t('length {0}–{1}', shortest.toLocaleString(), longest.toLocaleString()));
  return lines.map((l) => `<div>${esc(l)}</div>`).join('') + histHtml;
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

function chip(v: JVal, key: string, open: boolean): string {
  const label = t(open ? 'Collapse {0}' : 'Expand {0}', t(kindOf(v)));
  return `<button class="vchip${open ? ' open' : ''}" data-c="${esc(key)}" aria-expanded="${open}" title="${esc(label)}">${icon(open ? 'chev-down' : 'chev-right', 10)}${summary(v as JObj)}</button>`;
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
  if (ra === 0) return compareNumbers(a as number | RawNum, b as number | RawNum);
  if (ra === 1) return (a as string).localeCompare(b as string);
  if (ra === 2) return Number(a) - Number(b);
  if (ra === 3) return (a instanceof Shape ? a.size : sizeOf(a as JObj)) - (b instanceof Shape ? b.size : sizeOf(b as JObj));
  return 0;
}
