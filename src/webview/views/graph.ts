import { t } from '../../shared/i18n';
import type { JsonPath, RenderReport } from '../../shared/protocol';
import type { App, View } from '../app';
import { decodeSmartValue, formatDecodedSummary } from '../inspect';
import { childKey, decodeKey, entriesHead, esc, isContainer, kindOf, pathToString, primClass, primText, sizeOf, stringifyPretty, summary, type JObj, type JVal } from '../json';
import { icon } from '../icons';
import { isTextQuery, stepIn } from '../model';
import { pathOf } from '../query';

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
  rawKey?: string | number;
  rawVal?: JVal;
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
    this.svg.addEventListener('contextmenu', (e) => this.onContextMenu(e));
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
    const key = JSON.stringify([sources.map((s) => s.line), this.app.version, this.app.model.revision]);
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
    const app = this.app;
    if (!app.query.text) return;
    const m = app.model;
    if (m.isJsonl) {
      const len = this.matchNodes.length;
      const nextInNode = this.matchIdx < 0 ? (dir > 0 ? 0 : len - 1) : this.matchIdx + dir;
      const canStepLocal = len > 0 && ((this.matchIdx >= 0 && nextInNode >= 0 && nextInNode < len) || (this.matchIdx < 0 && app.matchSet.has(app.state.active)) || app.matches.length <= 1);
      if (canStepLocal && nextInNode >= 0 && nextInNode < len) {
        this.matchIdx = nextInNode;
        const n = this.matchNodes[this.matchIdx];
        app.state.graph.selectedNode = n.key;
        this.centerOn(n);
        this.paint();
        this.paintInspector();
        app.paintCount();
        app.stateChanged();
        return;
      }
      if (!app.matches.length) return;
      const nextRec = stepIn(app.matches, app.state.active, dir);
      app.selectRecord(nextRec);
      if (this.matchNodes.length) {
        this.matchIdx = dir > 0 ? 0 : this.matchNodes.length - 1;
        const n = this.matchNodes[this.matchIdx];
        app.state.graph.selectedNode = n.key;
        this.centerOn(n);
        this.paint();
        this.paintInspector();
      }
      app.paintCount();
      app.stateChanged();
      return;
    }
    if (!this.matchNodes.length && app.treeMatches.length && app.state.graph.collapsed.size) {
      // Unfold collapsed ancestors along the target match path so it becomes visible.
      const targetKey = app.treeMatches[dir > 0 ? 0 : app.treeMatches.length - 1];
      let cur = 'L0';
      for (const seg of decodeKey(targetKey)) {
        app.state.graph.collapsed.delete(cur);
        cur = childKey(cur, seg);
      }
      app.state.graph.collapsed.delete(cur);
      this.build(this.sources());
      this.layout();
      this.markSearch();
    }
    if (!this.matchNodes.length) return;
    this.matchIdx = this.matchIdx < 0 ? (dir > 0 ? 0 : this.matchNodes.length - 1) : (this.matchIdx + dir + this.matchNodes.length) % this.matchNodes.length;
    const n = this.matchNodes[this.matchIdx];
    app.state.graph.selectedNode = n.key;
    this.centerOn(n);
    this.paint();
    this.paintInspector();
    app.paintCount();
    app.stateChanged();
  }

  fillReport(r: RenderReport): void {
    const sel = this.selectedNode();
    r.graph = { nodes: this.nodes.length, edges: this.edges, truncated: this.truncated, selectedPath: sel ? pathToString(sel.path) : undefined };
    r.matches = this.app.model.isJsonl ? r.matches : this.matchNodes.length;
  }

  /** Number of matches in the current single-JSON graph, and the 0-based active match index. */
  matchProgress(): { count: number; index: number } {
    return { count: this.matchNodes.length, index: this.matchIdx };
  }

  // ---------- build ----------

  private sources(): Source[] {
    const app = this.app;
    const m = app.model;
    if (!m.isJsonl) {
      const v = m.value(0);
      return v === undefined ? [] : [{ title: t('root'), line: 0, value: v }];
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
        const row: GRow = {
          label: clip(s.title, 28),
          isIdx: false,
          text: isContainer(s.value) ? summary(s.value) : clip(primText(s.value), 32),
          cls: isContainer(s.value) ? 'dim' : primClass(s.value),
        };
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
        n.rows.push({ label: '', rawVal: v, isIdx: false, text: clip(primText(v)), cls: primClass(v) });
        continue;
      }
      if (n.collapsed) continue;
      const size = sizeOf(v);
      for (const [k, c] of entriesHead(v, MAX_ROWS)) {
        const rawLabel = String(k);
        const label = clip(rawLabel, 28);
        const valBudget = Math.max(18, 48 - label.length);
        const isIdx = typeof k === 'number';
        if (!isContainer(c)) {
          n.rows.push({ label, rawKey: k, rawVal: c, isIdx, text: clip(primText(c), valBudget), cls: primClass(c) });
          continue;
        }
        const row: GRow = { label, rawKey: k, rawVal: c, isIdx, text: summary(c), cls: 'dim' };
        if (sizeOf(c) > 0) {
          if (nodes.length < max && n.depth < MAX_DEPTH) {
            row.child = make(c, rawLabel, childKey(n.key, k), n.line, [...n.path, k], n.depth + 1);
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
      let w = this.textWidth(clip(n.title, 32)) + 140;
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

  private matchesRowSearch(s: string): boolean {
    const q = this.app.query;
    if (!isTextQuery(q)) return false;
    if (q.re) return q.re.test(s);
    if (q.regex && q.error) return false;
    return q.caseSensitive ? s.includes(q.text) : s.toLowerCase().includes(q.text);
  }

  private markSearch(): void {
    const app = this.app;
    const isText = isTextQuery(app.query);
    let treeHits: Set<string> | null = null;
    if (!app.model.isJsonl && app.query.program) {
      treeHits = new Set(app.treeMatches);
    } else if (app.model.isJsonl && app.query.program && !app.query.program.usesInputs) {
      treeHits = new Set();
      for (const n of this.nodes) {
        if (n.depth <= 1 && n.path.length === 0 && n.value !== undefined && n.line >= 0) {
          try {
            const run = app.query.program.run(n.value);
            for (const o of run.outs) {
              if (o.p !== undefined) {
                const pk = pathOf(o.p).reduce<string>((acc, seg) => childKey(acc, seg), `L${n.line}|`);
                treeHits.add(pk);
              }
            }
          } catch {
            // Query runtime errors on non-matching records are ignored.
          }
        }
      }
    }
    this.matchNodes = [];
    for (const n of this.nodes) {
      n.hit = false;
      if (treeHits) {
        const prefix = app.model.isJsonl ? `L${n.line}|` : '';
        const nodePath = n.path.reduce<string>((acc, seg) => childKey(acc, seg), prefix);
        if (treeHits.has(nodePath)) n.hit = true;
        else {
          for (const r of n.rows) {
            if (!r.note && r.rawKey !== undefined && treeHits.has(childKey(nodePath, r.rawKey))) {
              n.hit = true;
              break;
            }
          }
        }
      } else if (isText) {
        if (this.matchesRowSearch(n.title)) n.hit = true;
        for (const r of n.rows) if (this.matchesRowSearch(`${r.label} ${r.text}`)) n.hit = true;
      }
      if (n.hit) this.matchNodes.push(n);
    }
    this.matchIdx = -1;
  }

  // ---------- paint ----------

  private paint(): void {
    const sel = this.app.state.graph.selectedNode;
    const isText = isTextQuery(this.app.query);
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
          const hit = isText && this.matchesRowSearch(`${r.label} ${r.text}`) ? `<rect class="ghit" x="1" y="${y}" width="${n.w - 2}" height="${ROW_H}"/>` : '';
          const label = r.label ? `<tspan class="${r.isIdx ? 'tz-idx' : 'tk'}">${esc(r.label)}</tspan><tspan class="tp">${r.child || r.cls === 'dim' ? ' ' : ': '}</tspan>` : '';
          const sep = r.child && i > 0 && !n.rows[i - 1].child ? `<line class="gsep" x1="0" x2="${n.w}" y1="${y}" y2="${y}"/>` : '';
          return `${hit}${sep}<text x="10" y="${y + ROW_H / 2 + 4}" data-ri="${i}">${label}<tspan class="${r.cls}">${esc(r.text)}</tspan></text>`;
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
    this.inspector.classList.toggle('has-sel', !!n && n.value !== undefined);
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
    const decoded = !isContainer(v) ? decodeSmartValue(v) : [];
    const decHtml = decoded.length
      ? `<div class="insp-sec"><span class="insp-label">${esc(t('Decoded'))}</span><div class="insp-dec mono">${decoded.map((d) => `<div>${esc(formatDecodedSummary(d))}</div>`).join('')}</div></div>`
      : '';
    const revealBtn = this.app.canRevealSource ? `<button class="btn primary" data-i="reveal">${t('Reveal in editor')}</button>` : '';
    const inspectBtn = `<button class="btn${this.app.canRevealSource ? '' : ' primary'}" data-i="inspect">${icon('inspect', 12)}${esc(t('Inspect value'))}</button>`;
    this.inspector.innerHTML = `
      <div class="insp-head"><span class="insp-title">${t('Node')}</span><span class="dim">${esc(line)}</span><button class="icon-btn insp-close" data-i="close" aria-label="${esc(t('Close'))}">${icon('close', 13)}</button></div>
      <div class="insp-sec"><span class="insp-label">${t('PATH')}</span>
        <div class="insp-path"><span class="mono">${esc(pathToString(n.path))}</span><button class="icon-btn" data-i="copy-path" aria-label="${t('Copy path')}">${icon('copy')}</button></div></div>
      <div class="insp-sec"><span class="insp-label">${t('TYPE')}</span><span>${esc(type)}</span></div>
      ${decHtml}
      <div class="insp-sec spring"><span class="insp-label">${t('VALUE')}</span><pre class="insp-val mono" tabindex="0">${esc(stringifyPretty(v, this.app.config.indent, 20_000))}</pre></div>
      <div class="insp-actions">
        ${revealBtn}
        ${inspectBtn}
        <div class="row2"><button class="btn" data-i="copy-path">${t('Copy path')}</button><button class="btn" data-i="copy-value">${t('Copy value')}</button></div>
      </div>`;
  }

  private onInspector(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest('[data-i]') as HTMLElement | null;
    if (!b) return;
    if (b.dataset.i === 'close') {
      this.selectNode(null);
      return;
    }
    const n = this.selectedNode();
    if (!n || n.value === undefined) return;
    const what = b.dataset.i;
    if (what === 'copy-path') this.app.post({ type: 'copy', text: pathToString(n.path) });
    else if (what === 'copy-value') this.app.post({ type: 'copy', text: stringifyPretty(n.value, this.app.config.indent, 5_000_000) });
    else if (what === 'reveal') this.app.reveal(n.line, n.path);
    else if (what === 'inspect') this.app.openValueInspector(Math.max(0, n.line), n.path, n.value);
  }

  private onContextMenu(e: MouseEvent): void {
    const tEl = e.target as Element;
    const g = tEl.closest('.gn') as SVGElement | null;
    if (!g) return;
    e.preventDefault();
    const n = this.nodes[Number(g.getAttribute('data-n'))];
    if (!n || n.value === undefined) return;
    this.selectNode(n.key);
    const rowEl = tEl.closest('[data-ri]') as SVGElement | null;
    const ri = rowEl ? Number(rowEl.getAttribute('data-ri')) : -1;
    const row = ri >= 0 ? n.rows[ri] : undefined;
    if (row && row.rawKey !== undefined && row.rawVal !== undefined) {
      this.app.openContextMenu(e, { record: Math.max(0, n.line), path: [...n.path, row.rawKey], value: row.rawVal, hasValue: true });
      return;
    }
    this.app.openContextMenu(e, { record: Math.max(0, n.line), path: n.path, value: n.value, hasValue: true });
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
    const edge = v('--vscode-editorIndentGuide-activeBackground1', v('--vscode-editorIndentGuide-activeBackground', '#707070'));
    const ff = v('--vscode-editor-font-family', 'monospace');
    const bg = v('--bg', v('--vscode-editor-background', '#1e1e1e'));
    const fg = v('--fg', v('--vscode-editor-foreground', '#ccc'));
    const dim = v('--dim', v('--vscode-descriptionForeground', '#9d9d9d'));
    const border = v('--border', v('--vscode-widget-border', '#454545'));
    const nodeBg = v('--vscode-editorWidget-background', bg);
    const style = `
      text{font-family:${ff};font-size:12px;fill:${fg}}
      .gn-bg{fill:${nodeBg};stroke:${border}}
      .gsep{stroke:${border}}
      .ge{fill:none;stroke:${edge};stroke-width:1.5}
      .gdot{fill:${edge}}
      .gtitle{font-weight:600}.dim{fill:${dim}}
      .tk{fill:${v('--tok-key', '#9cdcfe')}}.ts{fill:${v('--tok-string', '#ce9178')}}.tn{fill:${v('--tok-number', '#b5cea8')}}
      .tb,.tz{fill:${v('--tok-keyword', '#569cd6')}}.tz-idx{fill:${dim}}.tp{fill:${fg}}
`;
    const xmlStyle = style.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body = this.exportMarkup();
    const w = Math.ceil(b.w + pad * 2);
    const h = Math.ceil(b.h + pad * 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${b.x - pad} ${b.y - pad} ${w} ${h}"><style>${xmlStyle}</style><rect x="${b.x - pad}" y="${b.y - pad}" width="${w}" height="${h}" fill="${esc(bg)}"/>${body}</svg>`;
    const stem = this.app.doc.fileName.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
    const name = this.app.model.isJsonl ? `${stem}-line${this.app.state.active + 1}` : stem;
    if (format === 'svg') {
      this.app.post({ type: 'export', format, data: svg, name });
      return;
    }
    const maxArea = 67_108_864;
    const scale = Math.min(2, 16000 / Math.max(1, w, h), Math.sqrt(maxArea / Math.max(1, w * h)));
    const img = new Image();
    img.onerror = () => this.app.showBanner(t('The export failed: {0}', t('SVG image failed to load')));
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w * scale));
      c.height = Math.max(1, Math.ceil(h * scale));
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      const url = c.toDataURL('image/png');
      if (!url.startsWith('data:image/png;base64,')) {
        this.app.showBanner(t('The export failed: {0}', t('the graph image is too large')));
        return;
      }
      this.app.post({ type: 'export', format, data: url, name });
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
}

function clip(s: string, n = MAX_TEXT): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
