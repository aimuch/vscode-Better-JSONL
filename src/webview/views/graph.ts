import { t } from '../../shared/i18n';
import type { JsonPath, RenderReport } from '../../shared/protocol';
import type { App, View } from '../app';
import { childKey, entriesHead, esc, isContainer, kindOf, pathToString, primClass, primText, sizeOf, stringifyPretty, summary, type JObj, type JVal } from '../json';
import { icon } from '../icons';
import { isTextQuery } from '../model';

const HEADER_H = 26;
const ROW_H = 22;
const MAX_ROWS = 100;
const MAX_TEXT = 48;
const COL_GAP = 90;
const ROW_GAP = 22;
const MAX_DEPTH = 1000;
const MAX_COMPARE = 10;

interface GRow {
  label: string;
  isIdx: boolean;
  text: string;
  cls: string;
  child?: GNode;
  note?: boolean;
}

interface GNode {
  id: number;
  key: string;
  line: number;
  path: JsonPath;
  title: string;
  value: JVal | undefined;
  rows: GRow[];
  children: GNode[];
  childRows: number[];
  collapsed: boolean;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  hit: boolean;
}

interface Source {
  title: string;
  line: number;
  value: JVal;
}

/** Graph view: objects and arrays are nodes; nested values are child nodes. */
export class GraphView implements View {
  readonly el: HTMLElement;
  private readonly canvasEl: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly vp: SVGGElement;
  private readonly inspector: HTMLElement;
  private readonly note: HTMLElement;
  private nodes: GNode[] = [];
  private edges = 0;
  private truncated = false;
  private tx = 40;
  private ty = 40;
  private k = 1;
  private sourceKey = '';
  private matchNodes: GNode[] = [];
  private matchIdx = -1;
  private drag: { x: number; y: number; tx: number; ty: number; moved: boolean } | null = null;
  private measureCtx: CanvasRenderingContext2D | null = null;
  private font = '12px monospace';
  /** The overview in a corner: every node, and the part of the graph the view shows. */
  private readonly mini: HTMLCanvasElement;
  private miniDrag = false;
  private miniMap = { x: 0, y: 0, scale: 1, ox: 0, oy: 0 };
  /** Ends the window listeners when the view is replaced. */
  private readonly gone = new AbortController();

  constructor(private readonly app: App) {
    this.el = document.createElement('div');
    this.el.className = 'view graph';
    this.el.innerHTML = `
      <div class="gcanvas" tabindex="0" aria-label="${t('Graph canvas')}">
        <svg class="gsvg" xmlns="http://www.w3.org/2000/svg"><g class="vp"></g></svg>
        <div class="gnote" hidden></div>
        <div class="exportbar" role="group" aria-label="${t('Export graph')}">
          <button class="btn" data-export="svg">${icon('download')}SVG</button>
          <button class="btn" data-export="png">${icon('download')}PNG</button>
        </div>
        <canvas class="gmini" hidden aria-label="${t('Overview: click or drag to move the view')}"></canvas>
        <div class="zoombar" role="group" aria-label="${t('Zoom')}">
          <button class="icon-btn" data-z="out" aria-label="${t('Zoom out')}">${icon('minus')}</button>
          <span class="zlabel">100%</span>
          <button class="icon-btn" data-z="in" aria-label="${t('Zoom in')}">${icon('plus')}</button>
          <button class="icon-btn" data-z="fit" aria-label="${t('Fit to view')}">${icon('fit')}</button>
        </div>
      </div>
      <aside class="inspector" aria-label="${t('Node inspector')}"></aside>`;
    this.canvasEl = this.el.querySelector('.gcanvas') as HTMLElement;
    this.svg = this.el.querySelector('.gsvg') as SVGSVGElement;
    this.vp = this.el.querySelector('.vp') as SVGGElement;
    this.inspector = this.el.querySelector('.inspector') as HTMLElement;
    this.note = this.el.querySelector('.gnote') as HTMLElement;
    this.mini = this.el.querySelector('.gmini') as HTMLCanvasElement;
    this.mini.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.mini.setPointerCapture(e.pointerId);
      this.miniDrag = true;
      this.miniGo(e);
    });
    this.mini.addEventListener('pointermove', (e) => this.miniDrag && this.miniGo(e));
    this.mini.addEventListener('pointerup', () => (this.miniDrag = false));
    this.canvasEl.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvasEl.addEventListener('keydown', (e) => this.onKey(e));
    this.svg.addEventListener('focusin', (e) => this.onFocus(e));
    window.addEventListener('pointermove', (e) => this.onMove(e), { signal: this.gone.signal });
    window.addEventListener('pointerup', (e) => this.onUp(e), { signal: this.gone.signal });
    this.el.querySelector('.zoombar')!.addEventListener('click', (e) => {
      const z = ((e.target as HTMLElement).closest('[data-z]') as HTMLElement | null)?.dataset.z;
      if (z === 'in') this.zoomAt(1.25);
      else if (z === 'out') this.zoomAt(0.8);
      else if (z === 'fit') this.fit();
    });
    this.inspector.addEventListener('click', (e) => this.onInspector(e));
    this.el.querySelector('.exportbar')!.addEventListener('click', (e) => {
      const f = ((e.target as HTMLElement).closest('[data-export]') as HTMLElement | null)?.dataset.export;
      if (f === 'svg' || f === 'png') this.exportImage(f);
    });
  }

  show(): void {
    this.el.hidden = false;
  }

  hide(): void {
    this.el.hidden = true;
  }

  dispose(): void {
    this.gone.abort();
  }

  render(): void {
    if (this.el.hidden) return;
    const sources = this.sources();
    const key = JSON.stringify([sources.map((s) => s.line), this.app.version]);
    const fresh = key !== this.sourceKey;
    this.sourceKey = key;
    this.build(sources);
    this.layout();
    this.markSearch();
    this.paint();
    if (fresh) this.fit();
    this.paintInspector();
  }

  refresh(): void {
    this.render();
  }

  notes(): string[] {
    const n = this.app.model.isJsonl ? this.app.state.selected.size : 0;
    return n > MAX_COMPARE ? [t('The graph shows the first {0} of {1} selected lines', MAX_COMPARE, n.toLocaleString())] : [];
  }

  onWrapChanged(): void {
    // Graph nodes do not wrap. The inspector value wraps through CSS.
  }

  onActiveChanged(): void {
    if (!this.el.hidden) this.render();
  }

  stepMatch(dir: 1 | -1): void {
    if (!this.matchNodes.length) return;
    this.matchIdx = (this.matchIdx + dir + this.matchNodes.length) % this.matchNodes.length;
    const n = this.matchNodes[this.matchIdx];
    this.app.state.graph.selectedNode = n.key;
    this.centerOn(n);
    this.paint();
    this.paintInspector();
    this.app.stateChanged();
  }

  fillReport(r: RenderReport): void {
    const sel = this.selectedNode();
    r.graph = { nodes: this.nodes.length, edges: this.edges, truncated: this.truncated, selectedPath: sel ? pathToString(sel.path) : undefined };
    r.matches = this.app.model.isJsonl ? r.matches : this.matchNodes.length;
  }

  // ---------- build ----------

  private sources(): Source[] {
    const app = this.app;
    const m = app.model;
    if (!m.isJsonl) {
      const v = m.value(0);
      return v === undefined ? [] : [{ title: 'root', line: 0, value: v }];
    }
    const sel = [...app.state.selected].sort((a, b) => a - b);
    const lines = sel.length > 1 ? sel.slice(0, MAX_COMPARE) : [app.state.active];
    const out: Source[] = [];
    for (const l of lines) {
      const v = m.value(l);
      if (v !== undefined) out.push({ title: t('line {0}', l + 1), line: l, value: v });
    }
    return out;
  }

  private build(sources: Source[]): void {
    const max = this.app.config.graphMaxNodes;
    const collapsed = this.app.state.graph.collapsed;
    const nodes: GNode[] = [];
    const queue: GNode[] = [];
    this.truncated = false;
    this.edges = 0;
    const make = (value: JVal | undefined, title: string, key: string, line: number, path: JsonPath, depth: number): GNode => {
      const n: GNode = {
        id: nodes.length,
        key,
        line,
        path,
        title,
        value,
        rows: [],
        children: [],
        childRows: [],
        collapsed: collapsed.has(key),
        depth,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        hit: false,
      };
      nodes.push(n);
      queue.push(n);
      return n;
    };
    const multi = sources.length > 1;
    if (multi) {
      const root = make(undefined, t('{0} selected lines', sources.length), 'sel', -1, [], 0);
      for (const s of sources) {
        const row: GRow = { label: s.title, isIdx: false, text: isContainer(s.value) ? summary(s.value) : primText(s.value), cls: isContainer(s.value) ? 'dim' : primClass(s.value) };
        row.child = make(s.value, s.title, `L${s.line}`, s.line, [], 1);
        root.rows.push(row);
      }
    } else if (sources.length) {
      const s = sources[0];
      make(s.value, s.title, `L${s.line}`, s.line, [], 0);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const n = queue[qi];
      const v = n.value;
      if (v === undefined) continue;
      if (!isContainer(v)) {
        n.rows.push({ label: '', isIdx: false, text: clip(primText(v)), cls: primClass(v) });
        continue;
      }
      if (n.collapsed) continue;
      const size = sizeOf(v);
      for (const [k, c] of entriesHead(v, MAX_ROWS)) {
        const label = String(k);
        const isIdx = typeof k === 'number';
        if (!isContainer(c)) {
          n.rows.push({ label, isIdx, text: clip(primText(c)), cls: primClass(c) });
          continue;
        }
        const row: GRow = { label, isIdx, text: summary(c), cls: 'dim' };
        if (sizeOf(c) > 0) {
          if (nodes.length < max && n.depth < MAX_DEPTH) {
            row.child = make(c, label, childKey(n.key, k), n.line, [...n.path, k], n.depth + 1);
          } else this.truncated = true;
        }
        n.rows.push(row);
      }
      if (size > MAX_ROWS) n.rows.push({ label: '', isIdx: false, text: t('… {0} more', (size - MAX_ROWS).toLocaleString()), cls: 'dim', note: true });
    }
    for (const n of nodes) {
      n.rows.forEach((r, i) => {
        if (r.child) {
          n.children.push(r.child);
          n.childRows.push(i);
          this.edges++;
        }
      });
    }
    this.nodes = nodes;
    if (!sources.length) {
      const p = this.app.model.isJsonl ? this.app.model.get(this.app.state.active) : this.app.model.get(0);
      this.showNote(p.kind === 'error' ? t('Line {0} is not valid JSON: {1}', this.app.state.active + 1, p.message) : t('Nothing to show for this line.'));
    } else if (this.truncated) this.showNote(t('The graph stops at {0} nodes (setting betterJsonl.graph.maxNodes). Collapse nodes or pick a smaller record.', max.toLocaleString()));
    else this.showNote('');
  }

  private showNote(text: string): void {
    this.note.textContent = text;
    this.note.hidden = !text;
  }

  private textWidth(s: string): number {
    if (!this.measureCtx) {
      this.measureCtx = document.createElement('canvas').getContext('2d');
      const ff = getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
      this.font = `12px ${ff}`;
    }
    const ctx = this.measureCtx;
    if (!ctx) return s.length * 7.2;
    ctx.font = this.font;
    return ctx.measureText(s).width;
  }

  private layout(): void {
    const colW: number[] = [];
    for (const n of this.nodes) {
      let w = this.textWidth(n.title) + 140;
      for (const r of n.rows) w = Math.max(w, this.textWidth(r.label ? `${r.label}: ${r.text}` : r.text) + 32);
      n.w = Math.min(420, Math.max(140, Math.ceil(w)));
      n.h = HEADER_H + Math.max(1, n.rows.length) * ROW_H + (n.rows.length ? 4 : 0);
      colW[n.depth] = Math.max(colW[n.depth] ?? 0, n.w);
    }
    const colX: number[] = [0];
    for (let d = 1; d < colW.length; d++) colX[d] = colX[d - 1] + colW[d - 1] + COL_GAP;
    for (const n of this.nodes) n.x = colX[n.depth];
    const shift = (n: GNode, dy: number) => {
      const stack = [n];
      while (stack.length) {
        const x = stack.pop() as GNode;
        x.y += dy;
        stack.push(...x.children);
      }
    };
    // Each subtree owns the band [top, bottom], so subtrees never overlap.
    // A parent is moved so its child rows line up with the middle of its children.
    const place = (n: GNode, top: number): number => {
      if (!n.children.length) {
        n.y = top;
        return top + n.h;
      }
      let cur = top;
      let bottom = top;
      for (const c of n.children) {
        bottom = place(c, cur);
        cur = bottom + ROW_GAP;
      }
      const rowMid = HEADER_H + ((n.childRows[0] + n.childRows[n.childRows.length - 1]) / 2) * ROW_H + ROW_H / 2;
      const kidsMid = (n.children[0].y + n.children[n.children.length - 1].y) / 2 + HEADER_H / 2;
      let y = kidsMid - rowMid;
      if (y < top) {
        const dy = top - y;
        for (const c of n.children) shift(c, dy);
        bottom += dy;
        y = top;
      }
      n.y = y;
      return Math.max(bottom, y + n.h);
    };
    if (this.nodes.length) place(this.nodes[0], 0);
  }

  private markSearch(): void {
    const q = isTextQuery(this.app.query) ? this.app.query.text : '';
    this.matchNodes = [];
    for (const n of this.nodes) {
      n.hit = false;
      if (!q) continue;
      if (n.title.toLowerCase().includes(q)) n.hit = true;
      for (const r of n.rows) if (`${r.label} ${r.text}`.toLowerCase().includes(q)) n.hit = true;
      if (n.hit) this.matchNodes.push(n);
    }
    this.matchIdx = -1;
  }

  // ---------- paint ----------

  private paint(): void {
    const sel = this.app.state.graph.selectedNode;
    const q = isTextQuery(this.app.query) ? this.app.query.text : '';
    const edges: string[] = [];
    const nodes: string[] = [];
    for (const n of this.nodes) {
      n.children.forEach((c, i) => {
        const y1 = n.y + HEADER_H + n.childRows[i] * ROW_H + ROW_H / 2;
        const x1 = n.x + n.w;
        const x2 = c.x;
        const y2 = c.y + HEADER_H / 2;
        const dx = (x2 - x1) / 2;
        const on = sel === c.key || sel === n.key;
        edges.push(`<path class="ge${on ? ' on' : ''}" d="M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}"/><circle class="gdot${on ? ' on' : ''}" cx="${x1}" cy="${y1}" r="3"/>`);
      });
      const rows = n.rows
        .map((r, i) => {
          const y = HEADER_H + i * ROW_H;
          const hit = q && `${r.label} ${r.text}`.toLowerCase().includes(q) ? `<rect class="ghit" x="1" y="${y}" width="${n.w - 2}" height="${ROW_H}"/>` : '';
          const label = r.label ? `<tspan class="${r.isIdx ? 'tz-idx' : 'tk'}">${esc(r.label)}</tspan><tspan class="tp">${r.child || r.cls === 'dim' ? ' ' : ': '}</tspan>` : '';
          const sep = r.child && i > 0 && !n.rows[i - 1].child ? `<line class="gsep" x1="0" x2="${n.w}" y1="${y}" y2="${y}"/>` : '';
          return `${hit}${sep}<text x="10" y="${y + ROW_H / 2 + 4}">${label}<tspan class="${r.cls}">${esc(r.text)}</tspan></text>`;
        })
        .join('');
      const kind = n.value === undefined ? t('selection') : isContainer(n.value) ? `${t(kindOf(n.value))} · ${sizeOf(n.value as JObj)}` : t(kindOf(n.value));
      const canFold = n.value !== undefined && isContainer(n.value) && sizeOf(n.value as JObj) > 0 && n.id !== 0;
      const chev = canFold
        ? `<g class="gtoggle" data-toggle="${esc(n.key)}" transform="translate(${n.w - 22},5)"><rect width="16" height="16" rx="3"/><path d="${n.collapsed ? 'M6 4l4 4-4 4' : 'M4 6l4 4 4-4'}"/></g>`
        : '';
      nodes.push(
        `<g class="gn${sel === n.key ? ' sel' : ''}${n.hit ? ' hitnode' : ''}" data-n="${n.id}" data-key="${esc(n.key)}" tabindex="0" role="button" aria-label="${esc(`${n.title} · ${kind}`)}"${canFold ? ` aria-expanded="${!n.collapsed}"` : ''} transform="translate(${n.x},${n.y})">` +
          `<rect class="gn-bg" width="${n.w}" height="${n.h}" rx="6"/>` +
          `<line class="gsep" x1="0" x2="${n.w}" y1="${HEADER_H}" y2="${HEADER_H}"/>` +
          `<text class="gtitle" x="10" y="17">${esc(clip(n.title, 32))}<tspan class="dim" dx="8">${esc(kind)}</tspan></text>` +
          chev +
          rows +
          `</g>`,
      );
    }
    // Painting replaces every node: the one with the keyboard focus gets it back.
    const focused = (document.activeElement as Element | null)?.closest?.('.gn');
    const focusKey = focused && this.vp.contains(focused) ? focused.getAttribute('data-key') : null;
    this.vp.innerHTML = `<g class="edges">${edges.join('')}</g><g class="nodes">${nodes.join('')}</g>`;
    if (focusKey !== null) (this.vp.querySelector(`.gn[data-key="${CSS.escape(focusKey)}"]`) as SVGGElement | null)?.focus({ preventScroll: true });
    this.applyTransform();
  }

  private applyTransform(): void {
    this.vp.setAttribute('transform', `translate(${this.tx},${this.ty}) scale(${this.k})`);
    (this.el.querySelector('.zlabel') as HTMLElement).textContent = `${Math.round(this.k * 100)}%`;
    this.paintMini();
  }

  /** Draws the overview. It shows only when part of the graph is outside the view. */
  private paintMini(): void {
    const c = this.mini;
    const vw = this.canvasEl.clientWidth;
    const vh = this.canvasEl.clientHeight;
    const b = this.bounds();
    const sx = b.x * this.k + this.tx;
    const sy = b.y * this.k + this.ty;
    const inside = sx >= -1 && sy >= -1 && sx + b.w * this.k <= vw + 1 && sy + b.h * this.k <= vh + 1;
    c.hidden = this.nodes.length < 2 || !vw || inside;
    if (c.hidden) return;
    const W = 180;
    const H = 120;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== W * dpr) {
      c.width = W * dpr;
      c.height = H * dpr;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const scale = Math.min((W - 8) / b.w, (H - 8) / b.h);
    const ox = (W - b.w * scale) / 2;
    const oy = (H - b.h * scale) / 2;
    this.miniMap = { x: b.x, y: b.y, scale, ox, oy };
    const css = getComputedStyle(document.body);
    const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const sel = this.app.state.graph.selectedNode;
    const dim = color('--dim', '#888');
    const accent = color('--accent', '#0078d4');
    for (const n of this.nodes) {
      ctx.fillStyle = n.key === sel || n.hit ? accent : dim;
      ctx.globalAlpha = n.key === sel || n.hit ? 0.9 : 0.45;
      ctx.fillRect(ox + (n.x - b.x) * scale, oy + (n.y - b.y) * scale, Math.max(1, n.w * scale), Math.max(1, n.h * scale));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + (-this.tx / this.k - b.x) * scale, oy + (-this.ty / this.k - b.y) * scale, (vw / this.k) * scale, (vh / this.k) * scale);
  }

  /** A click or drag in the overview puts that point in the middle of the view. */
  private miniGo(e: PointerEvent): void {
    const r = this.mini.getBoundingClientRect();
    const m = this.miniMap;
    const gx = m.x + (e.clientX - r.left - m.ox) / m.scale;
    const gy = m.y + (e.clientY - r.top - m.oy) / m.scale;
    this.tx = this.canvasEl.clientWidth / 2 - gx * this.k;
    this.ty = this.canvasEl.clientHeight / 2 - gy * this.k;
    this.applyTransform();
  }

  private bounds(): { x: number; y: number; w: number; h: number } {
    let x1 = Infinity;
    let y1 = Infinity;
    let x2 = -Infinity;
    let y2 = -Infinity;
    for (const n of this.nodes) {
      x1 = Math.min(x1, n.x);
      y1 = Math.min(y1, n.y);
      x2 = Math.max(x2, n.x + n.w);
      y2 = Math.max(y2, n.y + n.h);
    }
    if (!this.nodes.length) return { x: 0, y: 0, w: 1, h: 1 };
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  private fit(): void {
    const b = this.bounds();
    const vw = this.canvasEl.clientWidth || 800;
    const vh = this.canvasEl.clientHeight || 600;
    this.k = Math.min(1, Math.max(0.1, Math.min((vw - 80) / b.w, (vh - 80) / b.h)));
    this.tx = (vw - b.w * this.k) / 2 - b.x * this.k;
    this.ty = Math.max(20, (vh - b.h * this.k) / 2) - b.y * this.k;
    this.applyTransform();
  }

  private centerOn(n: GNode): void {
    const vw = this.canvasEl.clientWidth || 800;
    const vh = this.canvasEl.clientHeight || 600;
    this.tx = vw / 2 - (n.x + n.w / 2) * this.k;
    this.ty = vh / 2 - (n.y + n.h / 2) * this.k;
    this.applyTransform();
  }

  private zoomAt(f: number, cx?: number, cy?: number): void {
    const vw = this.canvasEl.clientWidth;
    const vh = this.canvasEl.clientHeight;
    const px = cx ?? vw / 2;
    const py = cy ?? vh / 2;
    const k2 = Math.min(3, Math.max(0.05, this.k * f));
    this.tx = px - ((px - this.tx) * k2) / this.k;
    this.ty = py - ((py - this.ty) * k2) / this.k;
    this.k = k2;
    this.applyTransform();
  }

  // ---------- inspector ----------

  private selectedNode(): GNode | undefined {
    const key = this.app.state.graph.selectedNode;
    return key ? this.nodes.find((n) => n.key === key) : undefined;
  }

  private paintInspector(): void {
    const n = this.selectedNode();
    if (!n || n.value === undefined) {
      this.inspector.innerHTML = `<div class="insp-empty dim">${t('Click a node to see its path and value.')}</div>`;
      return;
    }
    const line = this.app.model.isJsonl ? t('line {0}', n.line + 1) : '';
    const v = n.value;
    const size = isContainer(v) ? sizeOf(v as JObj) : 0;
    const type = isContainer(v)
      ? `${t(kindOf(v))} · ${t(Array.isArray(v) ? (size === 1 ? '{0} item' : '{0} items') : size === 1 ? '{0} key' : '{0} keys', size)}`
      : t(kindOf(v));
    this.inspector.innerHTML = `
      <div class="insp-head"><span class="insp-title">${t('Node')}</span><span class="dim">${esc(line)}</span></div>
      <div class="insp-sec"><span class="insp-label">${t('PATH')}</span>
        <div class="insp-path"><span class="mono">${esc(pathToString(n.path))}</span><button class="icon-btn" data-i="copy-path" aria-label="${t('Copy path')}">${icon('copy')}</button></div></div>
      <div class="insp-sec"><span class="insp-label">${t('TYPE')}</span><span>${esc(type)}</span></div>
      <div class="insp-sec spring"><span class="insp-label">${t('VALUE')}</span><pre class="insp-val mono">${esc(stringifyPretty(v, this.app.config.indent, 20_000))}</pre></div>
      <div class="insp-actions">
        <button class="btn primary" data-i="reveal">${t('Reveal in editor')}</button>
        <div class="row2"><button class="btn" data-i="copy-path">${t('Copy path')}</button><button class="btn" data-i="copy-value">${t('Copy value')}</button></div>
      </div>`;
  }

  private onInspector(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
    const n = this.selectedNode();
    if (!b || !n || n.value === undefined) return;
    const what = b.dataset.i;
    if (what === 'copy-path') this.app.post({ type: 'copy', text: pathToString(n.path) });
    else if (what === 'copy-value') this.app.post({ type: 'copy', text: stringifyPretty(n.value, this.app.config.indent, 5_000_000) });
    else if (what === 'reveal') this.app.post({ type: 'reveal', line: n.line, path: n.path });
  }

  // ---------- pointer ----------

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const rect = this.canvasEl.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
    else {
      this.tx -= e.deltaX;
      this.ty -= e.deltaY;
      this.applyTransform();
    }
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    this.canvasEl.classList.add('panning');
    this.tx = d.tx + dx;
    this.ty = d.ty + dy;
    this.applyTransform();
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvasEl.classList.remove('panning');
    if (!d || d.moved) return;
    const t = e.target as Element;
    if (!this.svg.contains(t)) return;
    const toggle = t.closest('[data-toggle]') as SVGElement | null;
    if (toggle) {
      this.toggleNode(toggle.getAttribute('data-toggle') as string);
      return;
    }
    const g = t.closest('[data-n]') as SVGElement | null;
    this.selectNode(g ? g.getAttribute('data-key') : null);
  }

  private toggleNode(key: string): void {
    const c = this.app.state.graph.collapsed;
    if (!c.delete(key)) c.add(key);
    this.build(this.sources());
    this.layout();
    this.markSearch();
    this.paint();
    this.app.stateChanged();
  }

  private selectNode(key: string | null): void {
    this.app.state.graph.selectedNode = key;
    this.paint();
    this.paintInspector();
    this.app.stateChanged();
  }

  // ---------- keyboard ----------

  /**
   * Tab moves between nodes. On a node: Enter or Space selects it (the inspector shows it),
   * Left folds it, Right unfolds it. On the canvas: + and - zoom, 0 fits the graph.
   */
  private onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const g = (e.target as Element).closest?.('.gn');
    const node = g ? this.nodes[Number(g.getAttribute('data-n'))] : undefined;
    if (node && (e.key === 'Enter' || e.key === ' ')) this.selectNode(node.key);
    else if (node && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const canFold = node.id !== 0 && node.value !== undefined && isContainer(node.value) && sizeOf(node.value as JObj) > 0;
      if (!canFold || node.collapsed === (e.key === 'ArrowLeft')) return;
      this.toggleNode(node.key);
    } else if (e.key === '+' || e.key === '=') this.zoomAt(1.25);
    else if (e.key === '-') this.zoomAt(0.8);
    else if (e.key === '0') this.fit();
    else return;
    e.preventDefault();
  }

  /** A node that gets the focus off screen is brought to the middle. */
  private onFocus(e: FocusEvent): void {
    const g = (e.target as Element).closest?.('.gn');
    const node = g ? this.nodes[Number(g.getAttribute('data-n'))] : undefined;
    if (!node) return;
    const x = node.x * this.k + this.tx;
    const y = node.y * this.k + this.ty;
    const seen = x + node.w * this.k > 0 && y + node.h * this.k > 0 && x < this.canvasEl.clientWidth && y < this.canvasEl.clientHeight;
    if (!seen) this.centerOn(node);
  }

  // ---------- export ----------

  /**
   * The drawing as SVG markup for a file. It is a copy without the parts that only the live
   * view needs (fold buttons, search marks, attributes for scripts and the keyboard): path keys
   * hold control characters, and one of those makes an SVG file invalid XML.
   */
  private exportMarkup(): string {
    const copy = this.vp.cloneNode(true) as SVGGElement;
    copy.querySelectorAll('.gtoggle, .ghit').forEach((el) => el.remove());
    for (const el of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) {
        if (/^(data-|aria-)|^(tabindex|role)$/.test(attr.name)) el.removeAttribute(attr.name);
      }
    }
    const xml = new XMLSerializer();
    return Array.from(copy.childNodes)
      .map((n) => xml.serializeToString(n))
      .join('')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd');
  }

  exportImage(format: 'svg' | 'png'): void {
    const b = this.bounds();
    const pad = 24;
    const css = getComputedStyle(document.body);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    // The same variable chain as style.css, so the export has the colors of the screen.
    const edge = v('--vscode-editorIndentGuide-activeBackground1', v('--vscode-editorIndentGuide-activeBackground', '#707070'));
    const style = `
      text{font:12px ${v('--vscode-editor-font-family', 'monospace')};fill:${v('--vscode-editor-foreground', '#ccc')}}
      .gn-bg{fill:${v('--vscode-editorWidget-background', '#252526')};stroke:${v('--vscode-widget-border', '#454545')}}
      .gsep{stroke:${v('--vscode-widget-border', '#454545')}}
      .ge{fill:none;stroke:${edge};stroke-width:1.5}
      .gdot{fill:${edge}}
      .gtitle{font-weight:600}.dim{fill:${v('--vscode-descriptionForeground', '#9d9d9d')}}
      .tk{fill:${v('--tok-key', '#9cdcfe')}}.ts{fill:${v('--tok-string', '#ce9178')}}.tn{fill:${v('--tok-number', '#b5cea8')}}
      .tb,.tz{fill:${v('--tok-keyword', '#569cd6')}}.tz-idx{fill:${v('--vscode-descriptionForeground', '#9d9d9d')}}.tp{fill:${v('--vscode-editor-foreground', '#ccc')}}
`;
    const body = this.exportMarkup();
    const bg = v('--vscode-editor-background', '#1e1e1e');
    const w = Math.ceil(b.w + pad * 2);
    const h = Math.ceil(b.h + pad * 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}"><style>${style}</style><rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" fill="${bg}"/>${body}</svg>`;
    const name = this.app.model.isJsonl ? `${this.app.doc.fileName.replace(/\.[^.]+$/, '')}-line${this.app.state.active + 1}` : this.app.doc.fileName.replace(/\.[^.]+$/, '');
    if (format === 'svg') {
      this.app.post({ type: 'export', format, data: svg, name });
      return;
    }
    const scale = Math.min(2, 16000 / Math.max(w, h));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.ceil(w * scale);
      c.height = Math.ceil(h * scale);
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      this.app.post({ type: 'export', format, data: c.toDataURL('image/png'), name });
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
