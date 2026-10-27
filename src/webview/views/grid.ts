import type { RenderReport } from '../../shared/protocol';
import type { App, View } from '../app';
import { childKey, decodeKey, entriesOf, esc, isArr, isContainer, isObj, kindOf, pathToString, plainText, primClass, RawNum, sizeOf, summary, type JObj, type JVal } from '../json';
import { icon } from '../icons';
import type { Parsed } from '../model';

const MAX_COLUMNS = 300;
const NESTED_ROWS = 200;
const NESTED_COLS = 50;
const CELL_CHARS = 300;
const CELL_CHARS_WRAP = 5000;
const VALUE_COL = '(value)';

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

  constructor(private readonly app: App) {
    this.rowH = app.rh + 6;
    this.el = document.createElement('div');
    this.el.className = 'view grid';
    this.el.innerHTML = `<div class="gscroll" tabindex="0" aria-label="Grid"><div class="ghead" role="row"></div><div class="gbody"><div class="grows"></div></div></div>`;
    this.scroll = this.el.querySelector('.gscroll') as HTMLElement;
    this.head = this.el.querySelector('.ghead') as HTMLElement;
    this.bodyEl = this.el.querySelector('.gbody') as HTMLElement;
    this.rowsEl = this.el.querySelector('.grows') as HTMLElement;
    this.scroll.addEventListener('scroll', () => this.paint(), { passive: true });
    new ResizeObserver(() => this.paint()).observe(this.scroll);
    this.head.addEventListener('pointerdown', (e) => this.onHeadPointer(e));
    this.head.addEventListener('click', (e) => this.onHeadClick(e));
    this.rowsEl.addEventListener('click', (e) => this.onClick(e));
    this.rowsEl.addEventListener('dblclick', (e) => this.onDblClick(e));
    window.addEventListener('pointermove', (e) => this.onDrag(e));
    window.addEventListener('pointerup', () => (this.dragging = null));
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  render(): void {
    this.layout();
    this.paint();
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
    this.paint();
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
    r.grid = { rows: this.rowIds.length, columns: [...this.cols], openCells: this.app.state.grid.open.size };
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
      const root = this.rootValue() as JObj;
      const key = Object.keys(root)[id];
      return col === 'key' ? key : root[key];
    }
    const p = this.record(id);
    if (p.kind !== 'value') return undefined;
    if (col === VALUE_COL) return isObj(p.value) ? undefined : p.value;
    return isObj(p.value) ? p.value[col] : undefined;
  }

  private layout(): void {
    const app = this.app;
    const m = app.model;
    if (this.modelRef !== m) {
      this.modelRef = m;
      this.heights.clear();
    }
    const root = this.rootValue();
    let ids: number[] = [];
    if (m.isJsonl) {
      this.mode = 'records';
      const q = app.query.text;
      const base = q ? app.matches : Array.from({ length: m.count }, (_, i) => i);
      ids = base.filter((i) => m.get(i).kind !== 'blank');
      this.cols = m.columns.slice(0, MAX_COLUMNS);
      // Non-object records (arrays, strings, numbers) show in a first "(value)" column.
      if (m.hasNonObject || !this.cols.length) this.cols.unshift(VALUE_COL);
    } else if (root !== undefined && isArr(root)) {
      this.mode = 'records';
      const keys = new Set<string>();
      let nonObj = false;
      for (const item of root) {
        if (isObj(item)) for (const k in item) keys.add(k);
        else nonObj = true;
        if (keys.size > MAX_COLUMNS) break;
      }
      this.cols = [...keys].slice(0, MAX_COLUMNS);
      if (nonObj || !this.cols.length) this.cols.push(VALUE_COL);
      ids = root.map((_, i) => i);
      const q = app.query.text;
      if (q) ids = ids.filter((i) => JSON.stringify(root[i] instanceof RawNum ? (root[i] as RawNum).src : root[i]).toLowerCase().includes(q));
    } else if (root !== undefined && isObj(root)) {
      this.mode = 'object';
      this.cols = ['key', 'value'];
      ids = Object.keys(root).map((_, i) => i);
      const q = app.query.text;
      if (q) {
        const keys = Object.keys(root);
        ids = ids.filter((i) => (keys[i] + ' ' + JSON.stringify(root[keys[i]])).toLowerCase().includes(q));
      }
    } else {
      this.mode = 'scalar';
      this.cols = [VALUE_COL];
      ids = root === undefined ? [] : [0];
    }
    const sort = app.state.grid.sort;
    if (sort && (sort.col === '#' || this.cols.includes(sort.col))) {
      const keyed = ids.map((id) => [id, sort.col === '#' ? id : this.cell(id, sort.col)] as [number, JVal | number | undefined]);
      keyed.sort((a, b) => {
        // Missing values stay at the bottom in both directions.
        const ma = a[1] === undefined;
        const mb = b[1] === undefined;
        if (ma !== mb) return ma ? 1 : -1;
        return sort.dir * compare(a[1] as JVal | undefined, b[1] as JVal | undefined) || a[0] - b[0];
      });
      ids = keyed.map((k) => k[0]);
    }
    this.rowIds = ids;
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
    if (col === '#') return 64;
    let max = col.length;
    for (let i = 0; i < Math.min(40, this.rowIds.length); i++) {
      const v = this.cell(this.rowIds[i], col);
      const len = v === undefined ? 0 : isContainer(v) ? summary(v).length + 3 : plainText(v).length;
      if (len > max) max = len;
    }
    return Math.min(360, Math.max(64, max * 7.6 + 24));
  }

  private allCols(): string[] {
    return this.mode === 'records' ? ['#', ...this.cols] : this.cols;
  }

  private paintHead(): void {
    const sort = this.app.state.grid.sort;
    const cols = this.allCols();
    this.applyWidths();
    this.head.innerHTML = cols
      .map((c, i) => {
        const sorted = sort && sort.col === c ? (sort.dir > 0 ? icon('chev-up', 11) : icon('chev-down', 11)) : '';
        const label = c === VALUE_COL ? '<span class="dim">(value)</span>' : esc(c);
        return `<div class="gh${c === '#' ? ' num' : ''}" role="columnheader" data-col="${esc(c)}" style="width:var(--w${i})" title="${esc(c)}"><span class="gh-l">${label}</span>${sorted}<span class="rz" data-rz="${esc(c)}"></span></div>`;
      })
      .join('');
  }

  // ---------- painting ----------

  private paint(): void {
    if (this.el.hidden || !this.app.model) return;
    if (!this.rowIds.length) {
      this.rowsEl.style.transform = '';
      this.rowsEl.innerHTML = `<div class="empty-note">${this.app.query.text ? 'No row matches the filter.' : 'No rows.'}</div>`;
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
        if (c === '#') {
          cells.push(`<div class="gc num" ${style}>${jsonl ? id + 1 : id}</div>`);
          return;
        }
        const v = this.cell(id, c);
        if (v === undefined) {
          cells.push(`<div class="gc miss" ${style}></div>`);
          return;
        }
        if (this.mode === 'object' && c === 'key') {
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
    if (this.mode === 'object') return childKey('', Object.keys(this.rootValue() as JObj)[id]);
    if (col === VALUE_COL) return '';
    return childKey('', col);
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
    const where = this.app.model.isJsonl ? `line ${id + 1} · ` : '';
    const kind = Array.isArray(v) ? `array · ${v.length} item${v.length === 1 ? '' : 's'}` : `object · ${sizeOf(v as JObj)} keys`;
    // The sub-grid starts under the column that was opened.
    const i = Math.max(0, this.allCols().indexOf(this.mode === 'object' ? 'value' : col));
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
    if (isArr(v) && v.length && v.every((x) => isObj(x))) {
      const keys: string[] = [];
      const seen = new Set<string>();
      for (const item of v.slice(0, NESTED_ROWS)) {
        for (const k in item as JObj) {
          if (!seen.has(k) && keys.length < NESTED_COLS) {
            seen.add(k);
            keys.push(k);
          }
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
      rows.push(`<tr><th>${isArr(v) ? '#' : 'key'}</th><th>value</th></tr>`);
      entriesOf(v)
        .slice(0, NESTED_ROWS)
        .forEach(([k, child]) => {
          const label = typeof k === 'number' ? `<td class="num dim">${k}</td>` : `<td class="tk">${esc(k)}</td>`;
          rows.push(`<tr>${label}<td>${inner(child, childKey(rel, k))}</td></tr>`);
        });
    }
    const more = sizeOf(v) > NESTED_ROWS ? `<div class="dim more">… ${(sizeOf(v) - NESTED_ROWS).toLocaleString()} more</div>` : '';
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
    const h = t.closest('[data-col]') as HTMLElement | null;
    if (!h) return;
    const col = h.dataset.col as string;
    const g = this.app.state.grid;
    if (!g.sort || g.sort.col !== col) g.sort = { col, dir: 1 };
    else if (g.sort.dir === 1) g.sort = { col, dir: -1 };
    else g.sort = null;
    this.render();
    this.app.scheduleReport();
  }

  private onClick(e: MouseEvent): void {
    const t = e.target as HTMLElement;
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
      this.app.scheduleReport();
      return;
    }
    if (t.closest('.gdetail')) return;
    if (this.app.model.isJsonl) {
      const how = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'set';
      this.app.selectRecord(id, how);
    } else {
      this.jsonActive = id;
      this.paint();
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
    const rel = col && col !== '#' ? this.cellPath(id, col) : '';
    const path = this.recordPath(id, rel);
    this.app.post({ type: 'reveal', line: this.app.model.isJsonl ? id : 0, path });
  }
}

function chip(v: JVal, key: string, open: boolean): string {
  return `<button class="vchip${open ? ' open' : ''}" data-c="${esc(key)}" title="${open ? 'Collapse' : 'Expand'} ${kindOf(v)}">${icon(open ? 'chev-down' : 'chev-right', 10)}${summary(v as JObj)}</button>`;
}

function rank(v: JVal | undefined): number {
  if (v === undefined) return 6;
  if (v === null) return 5;
  if (typeof v === 'number' || v instanceof RawNum) return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

function compare(a: JVal | undefined, b: JVal | undefined): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return Number(a instanceof RawNum ? a.src : a) - Number(b instanceof RawNum ? b.src : b);
  if (ra === 1) return (a as string).localeCompare(b as string);
  if (ra === 2) return Number(a) - Number(b);
  if (ra === 3) return sizeOf(a as JObj) - sizeOf(b as JObj);
  return 0;
}
