import { setLang, t } from '../shared/i18n';
import { prettyJson } from '../shared/jsonText';
import type { DocInfo, ExpandMode, HostMessage, RenderReport, ViewerConfig, ViewKind, WebviewMessage } from '../shared/protocol';
import { esc, formatBytes } from './json';
import { DocModel, findMatches, parseQuery, type Query } from './model';
import { icon } from './icons';
import { SettingsPanel } from './settings';
import { FormattedView } from './views/formatted';
import { GraphView } from './views/graph';
import { GridView } from './views/grid';

export interface View {
  readonly el: HTMLElement;
  /** Re-renders from the current state. `anchor` keeps that record still on screen. */
  render(anchor?: number): void;
  /** The active record changed. Scroll it into view when `scroll` is true. */
  onActiveChanged(scroll: boolean): void;
  /** Word wrap turned on or off. Measured row heights are no longer valid. */
  onWrapChanged(): void;
  stepMatch(dir: 1 | -1): void;
  fillReport(r: RenderReport): void;
  show(): void;
  hide(): void;
}

export interface UIState {
  view: ViewKind;
  expandMode: ExpandMode;
  query: string;
  filterOnly: boolean;
  wrap: boolean;
  active: number;
  anchor: number;
  selected: Set<number>;
  folds: Map<number, Set<string>>;
  grid: { sort: { col: string; dir: 1 | -1 } | null; widths: Record<string, number>; open: Set<string> };
  graph: { collapsed: Set<string>; selectedNode: string | null; zoom: number };
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const VIEWS: { id: ViewKind; label: string }[] = [
  { id: 'formatted', label: 'Formatted' },
  { id: 'grid', label: 'Grid' },
  { id: 'graph', label: 'Graph' },
];

export class App {
  model!: DocModel;
  doc!: DocInfo;
  config!: ViewerConfig;
  state!: UIState;
  version = 0;
  query: Query = { raw: '', text: '' };
  matches: number[] = [];
  matchSet = new Set<number>();
  /** Row height of code lines in px. */
  readonly rh: number;

  private readonly root: HTMLElement;
  private toolbar!: HTMLElement;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private banner!: HTMLElement;
  private views!: Record<ViewKind, View>;
  private bgTimer: ReturnType<typeof setTimeout> | undefined;
  private reportTimer: ReturnType<typeof setTimeout> | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private editRecord = -1;
  private editOriginal = '';
  private lastStatsPaint = 0;
  private settings: SettingsPanel | undefined;
  private readonly darkMedia = window.matchMedia('(prefers-color-scheme: dark)');
  /** The theme in use: 'vscode' when the VS Code theme applies. */
  effectiveTheme: 'vscode' | 'light' | 'dark' = 'vscode';

  constructor(root: HTMLElement) {
    this.root = root;
    const fs = parseFloat(getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-size')) || 13;
    this.rh = Math.max(16, Math.round(fs * 1.6));
    document.documentElement.style.setProperty('--rh', `${this.rh}px`);
    window.addEventListener('message', (e) => this.onMessage(e.data as HostMessage));
    this.darkMedia.addEventListener('change', () => {
      if (this.config?.theme !== 'system') return;
      this.applyTheme();
      this.scheduleReport();
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    root.innerHTML = `<div class="boot">${t('Loading…')}</div>`;
    this.post({ type: 'ready' });
  }

  post(msg: WebviewMessage): void {
    vscode.postMessage(msg);
  }

  folds(r: number): Set<string> {
    let f = this.state.folds.get(r);
    if (!f) {
      f = new Set();
      this.state.folds.set(r, f);
    }
    return f;
  }

  get activeView(): View {
    return this.views[this.state.view];
  }

  // ---------- messages ----------

  private onMessage(m: HostMessage): void {
    switch (m.type) {
      case 'init':
        this.init(m.doc, m.text, m.version, m.config);
        break;
      case 'update':
        this.update(m.text, m.version);
        break;
      case 'selection':
        this.fromEditorSelection(m.lines, m.active);
        break;
      case 'config': {
        const old = this.config;
        this.config = m.config;
        this.applyTheme();
        if (!this.views) break;
        if (old.lang !== m.config.lang) {
          this.relabel();
          break;
        }
        if (old.wordWrap !== m.config.wordWrap || old.wrap !== m.config.wrap) this.setWrap(m.config.wrap);
        else if (old.indent !== m.config.indent || old.graphMaxNodes !== m.config.graphMaxNodes) this.activeView.render();
        this.settings?.refresh();
        this.scheduleReport();
        break;
      }
      case 'toggleWrap':
        if (this.views) this.setWrap(!this.state.wrap);
        break;
      case 'setView':
        this.setView(m.view);
        break;
      case 'toggleExpandMode':
        this.setExpandMode(this.state.expandMode === 'focus' ? 'all' : 'focus');
        break;
      case 'editResult':
        this.onEditResult(m.ok, m.message);
        break;
      case 'notice':
        this.showBanner(m.message);
        break;
    }
  }

  private init(doc: DocInfo, text: string, version: number, config: ViewerConfig): void {
    const saved = (vscode.getState() ?? {}) as { uri?: string; view?: ViewKind; expandMode?: ExpandMode; active?: number };
    const sameDoc = saved.uri === doc.uri;
    this.doc = doc;
    this.config = config;
    setLang(config.lang);
    document.documentElement.lang = config.lang === 'zh-cn' ? 'zh-CN' : 'en';
    this.version = version;
    this.model = new DocModel(text, doc.isJsonl);
    const prev = this.state;
    this.state = {
      view: (sameDoc && saved.view) || prev?.view || config.defaultView,
      expandMode: (sameDoc && saved.expandMode) || prev?.expandMode || config.expandMode,
      query: '',
      filterOnly: false,
      wrap: prev?.wrap ?? config.wrap,
      active: sameDoc && saved.active !== undefined ? Math.min(saved.active, Math.max(0, this.model.count - 1)) : 0,
      anchor: 0,
      selected: new Set(),
      folds: new Map(),
      grid: { sort: null, widths: {}, open: new Set() },
      graph: { collapsed: new Set(), selectedNode: null, zoom: 1 },
    };
    if (this.model.isJsonl && this.model.count) this.state.selected.add(this.state.active);
    this.query = { raw: '', text: '' };
    this.matches = [];
    this.matchSet = new Set();
    this.buildShell();
    this.applyTheme();
    document.body.classList.toggle('wrap', this.state.wrap);
    this.persist();
    this.startBackground();
    this.renderAll();
  }

  private update(text: string, version: number): void {
    if (!this.model) return;
    this.version = version;
    const before = this.model.count;
    this.model = new DocModel(text, this.doc.isJsonl);
    const n = this.model.count;
    const s = this.state;
    if (n !== before) s.folds.clear();
    else for (const r of [...s.folds.keys()]) if (r >= n) s.folds.delete(r);
    s.active = Math.min(s.active, Math.max(0, n - 1));
    s.selected = new Set([...s.selected].filter((r) => r < n));
    if (this.model.isJsonl && !s.selected.size && n) s.selected.add(s.active);
    s.grid.open.clear();
    this.recomputeMatches();
    this.startBackground();
    this.renderAll();
  }

  private fromEditorSelection(lines: number[], active: number): void {
    if (!this.model || !this.model.isJsonl) return;
    const n = this.model.count;
    const sel = lines.filter((l) => l < n);
    if (!sel.length || active >= n) return;
    const s = this.state;
    const same = s.active === active && sel.length === s.selected.size && sel.every((l) => s.selected.has(l));
    if (same) return;
    s.selected = new Set(sel);
    s.active = active;
    s.anchor = active;
    this.persist();
    if (s.expandMode === 'focus' && s.view === 'formatted') this.activeView.render();
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.scheduleReport();
  }

  // ---------- state changes ----------

  selectRecord(r: number, how: 'set' | 'toggle' | 'range' = 'set', notify = true): void {
    const s = this.state;
    if (r < 0 || r >= this.model.count) return;
    if (how === 'set') {
      s.selected = new Set([r]);
      s.anchor = r;
    } else if (how === 'toggle') {
      if (s.selected.has(r) && s.selected.size > 1) s.selected.delete(r);
      else s.selected.add(r);
      s.anchor = r;
    } else {
      const [a, b] = s.anchor < r ? [s.anchor, r] : [r, s.anchor];
      s.selected = new Set();
      for (let i = a; i <= b && s.selected.size < 2000; i++) s.selected.add(i);
    }
    s.active = r;
    s.graph.selectedNode = null;
    this.persist();
    if (s.view === 'formatted' || s.view === 'graph') this.activeView.render(r);
    this.activeView.onActiveChanged(false);
    if (notify && this.model.isJsonl) this.post({ type: 'select', line: r });
    this.paintChrome();
    this.scheduleReport();
  }

  setView(v: ViewKind): void {
    if (!this.views || this.state.view === v) return;
    this.activeView.hide();
    this.state.view = v;
    this.persist();
    this.activeView.show();
    this.activeView.render();
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.scheduleReport();
  }

  setExpandMode(m: ExpandMode): void {
    if (this.state.expandMode === m) return;
    this.state.expandMode = m;
    this.persist();
    if (this.state.view === 'formatted') {
      this.activeView.render(this.state.active);
      this.activeView.onActiveChanged(true);
    }
    this.paintChrome();
    this.scheduleReport();
  }

  /** The UI language changed: rebuild the toolbar, views and panels with the new text. */
  private relabel(): void {
    setLang(this.config.lang);
    document.documentElement.lang = this.config.lang === 'zh-cn' ? 'zh-CN' : 'en';
    const reopen = !!this.settings?.open;
    this.buildShell();
    this.applyTheme();
    document.body.classList.toggle('wrap', this.state.wrap);
    this.renderAll();
    if (reopen) this.settings?.show();
  }

  /** Word wrap for this view (Alt+Z, the toolbar button, or the setting). */
  setWrap(on: boolean): void {
    this.state.wrap = on;
    document.body.classList.toggle('wrap', on);
    for (const v of Object.values(this.views)) v.onWrapChanged();
    this.activeView.render(this.model.isJsonl ? this.state.active : undefined);
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.scheduleReport();
  }

  /** Applies the theme setting: VS Code colors, a fixed light or dark palette, or the OS choice. */
  applyTheme(): void {
    const mode = this.config.theme;
    const eff = mode === 'system' ? (this.darkMedia.matches ? 'dark' : 'light') : mode;
    this.effectiveTheme = eff;
    if (eff === 'vscode') delete document.body.dataset.theme;
    else document.body.dataset.theme = eff;
  }

  scheduleReport(): void {
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => this.sendReport(), 40);
  }

  // ---------- record editor ----------

  openEditor(r: number): void {
    if (!this.model.isJsonl) {
      this.post({ type: 'openAsText' });
      return;
    }
    const raw = this.model.lines[r];
    const p = this.model.get(r);
    this.editRecord = r;
    this.editOriginal = raw;
    const panel = this.root.querySelector('.editpanel') as HTMLElement;
    const ta = panel.querySelector('textarea') as HTMLTextAreaElement;
    (panel.querySelector('.ep-title') as HTMLElement).textContent = t('Edit line {0}', r + 1);
    (panel.querySelector('.ep-err') as HTMLElement).textContent = '';
    ta.value = p.kind === 'value' ? prettyJson(raw, this.config.indent) : raw;
    panel.hidden = false;
    ta.focus();
  }

  private closeEditor(): void {
    const panel = this.root.querySelector('.editpanel') as HTMLElement;
    panel.hidden = true;
    this.editRecord = -1;
  }

  private applyEditor(): void {
    if (this.editRecord < 0) return;
    const panel = this.root.querySelector('.editpanel') as HTMLElement;
    const ta = panel.querySelector('textarea') as HTMLTextAreaElement;
    const err = panel.querySelector('.ep-err') as HTMLElement;
    try {
      JSON.parse(ta.value);
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e);
      return;
    }
    err.textContent = t('Saving…');
    this.post({ type: 'editLine', line: this.editRecord, original: this.editOriginal, text: ta.value });
  }

  private onEditResult(ok: boolean, message?: string): void {
    if (ok) {
      this.closeEditor();
      return;
    }
    const err = this.root.querySelector('.ep-err') as HTMLElement | null;
    if (err) err.textContent = message ?? t('The edit failed.');
  }

  // ---------- shell ----------

  private buildShell(): void {
    this.root.innerHTML = `
      <div class="toolbar" role="toolbar" aria-label="${t('Better JSONL toolbar')}"></div>
      <div class="banner" hidden></div>
      <div class="body"></div>
      <div class="status"></div>
      <div class="editpanel" hidden role="dialog" aria-label="${t('Edit record')}">
        <div class="ep-head"><span class="ep-title"></span><span class="ep-err" role="alert"></span></div>
        <textarea spellcheck="false" aria-label="${t('Record JSON')}"></textarea>
        <div class="ep-actions">
          <button class="btn primary ep-apply">${t('Apply')} <kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</kbd></button>
          <button class="btn ep-cancel">${t('Cancel')} <kbd>Esc</kbd></button>
          <span class="ep-hint">${t('The record is saved back as one compact line.')}</span>
        </div>
      </div>`;
    this.toolbar = this.root.querySelector('.toolbar') as HTMLElement;
    this.banner = this.root.querySelector('.banner') as HTMLElement;
    this.body = this.root.querySelector('.body') as HTMLElement;
    this.status = this.root.querySelector('.status') as HTMLElement;
    const panel = this.root.querySelector('.editpanel') as HTMLElement;
    panel.querySelector('.ep-apply')!.addEventListener('click', () => this.applyEditor());
    panel.querySelector('.ep-cancel')!.addEventListener('click', () => this.closeEditor());
    panel.querySelector('textarea')!.addEventListener('keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter' && (ke.metaKey || ke.ctrlKey)) {
        ke.preventDefault();
        this.applyEditor();
      } else if (ke.key === 'Escape') {
        ke.preventDefault();
        this.closeEditor();
      }
      ke.stopPropagation();
    });
    this.buildToolbar();
    this.settings = new SettingsPanel(this);
    this.root.appendChild(this.settings.el);
    this.views = {
      formatted: new FormattedView(this),
      grid: new GridView(this),
      graph: new GraphView(this),
    };
    for (const v of Object.values(this.views)) {
      this.body.appendChild(v.el);
      v.hide();
    }
    this.activeView.show();
    if (this.model.detectedJsonl) this.showBanner(t('This .json file holds one JSON value per line. It is shown as JSON Lines.'));
    else if (this.model.jsonc) this.showBanner(t('Parsed as JSON with Comments (comments or trailing commas found).'));
  }

  private buildToolbar(): void {
    const tb = this.toolbar;
    const mac = navigator.platform.includes('Mac');
    tb.innerHTML = `
      <div class="seg" role="tablist" aria-label="${t('View')}">
        ${VIEWS.map((v) => `<button role="tab" class="seg-btn" data-view="${v.id}">${icon(v.id)}<span>${t(v.label)}</span></button>`).join('')}
      </div>
      <div class="seg mode" role="radiogroup" aria-label="${t('JSONL format mode')}">
        <button role="radio" class="seg-btn sub" data-mode="focus" title="${t('Only the current or selected lines are pretty-printed')}">${t('Focus')}</button>
        <button role="radio" class="seg-btn sub" data-mode="all" title="${t('All lines are pretty-printed')}">${t('Expand all')}</button>
      </div>
      <div class="seg foldall" role="group" aria-label="${t('Fold')}">
        <button class="seg-btn sub" data-fold="expand" title="${t('Expand every node')}">${t('Expand all')}</button>
        <button class="seg-btn sub" data-fold="collapse" title="${t('Collapse every node below the root')}">${t('Collapse all')}</button>
      </div>
      <div class="linesel" role="group" aria-label="${t('Line selector')}">
        <span class="dim">${t('Line')}</span>
        <button class="icon-btn" data-line="-1" aria-label="${t('Previous line')}">${icon('chev-left')}</button>
        <input class="line-input" type="text" inputmode="numeric" aria-label="${t('Line number')}">
        <button class="icon-btn" data-line="1" aria-label="${t('Next line')}">${icon('chev-right')}</button>
        <span class="dim line-of"></span>
      </div>
      <label class="search">
        ${icon('search')}
        <span class="sr">${t('Search')}</span>
        <input type="search" placeholder="${t('Search · or path:text, path=value  ({0}F)', mac ? '⌘' : 'Ctrl+')}" spellcheck="false">
        <span class="count dim"></span>
        <button class="icon-btn" data-step="-1" aria-label="${t('Previous match')}">${icon('chev-up')}</button>
        <button class="icon-btn" data-step="1" aria-label="${t('Next match')}">${icon('chev-down')}</button>
        <button class="icon-btn filter-btn" aria-label="${t('Show only matching lines')}" aria-pressed="false" title="${t('Show only matching lines')}">${icon('filter')}</button>
      </label>
      <div class="spring"></div>
      <div class="stats"></div>
      <button class="icon-btn wrap-btn" aria-label="${t('Word wrap ({0})', mac ? '⌥Z' : 'Alt+Z')}" title="${t('Word wrap ({0})', mac ? '⌥Z' : 'Alt+Z')}" aria-pressed="false">${icon('wrap')}</button>
      <button class="icon-btn open-text" aria-label="${t('Open as text')}" title="${t('Open as text')}">${icon('file-code')}</button>
      <button class="icon-btn gear-btn" aria-label="${t('Settings')}" title="${t('Settings')}">${icon('gear')}</button>`;

    tb.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!t) return;
      if (t.dataset.view) this.setView(t.dataset.view as ViewKind);
      else if (t.dataset.mode) this.setExpandMode(t.dataset.mode as ExpandMode);
      else if (t.dataset.fold) this.foldAll(t.dataset.fold === 'collapse');
      else if (t.dataset.step) this.activeView.stepMatch(Number(t.dataset.step) as 1 | -1);
      else if (t.dataset.line) this.stepLine(Number(t.dataset.line));
      else if (t.classList.contains('filter-btn')) {
        this.state.filterOnly = !this.state.filterOnly;
        this.activeView.render();
        this.paintChrome();
        this.scheduleReport();
      } else if (t.classList.contains('open-text')) this.post({ type: 'openAsText' });
      else if (t.classList.contains('wrap-btn')) this.setWrap(!this.state.wrap);
      else if (t.classList.contains('gear-btn')) this.settings?.toggle();
      else if (t.classList.contains('err-chip')) this.nextError();
    });
    const input = tb.querySelector('.search input') as HTMLInputElement;
    input.addEventListener('input', () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.setQuery(input.value), 160);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(this.searchTimer);
        if (input.value !== this.state.query) this.setQuery(input.value);
        else this.activeView.stepMatch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        input.value = '';
        this.setQuery('');
        input.blur();
      }
      e.stopPropagation();
    });
    const lineInput = tb.querySelector('.line-input') as HTMLInputElement;
    lineInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = parseInt(lineInput.value, 10);
        if (n >= 1 && n <= this.model.count) this.selectRecord(n - 1);
      }
      e.stopPropagation();
    });
  }

  private setQuery(q: string): void {
    this.state.query = q;
    this.recomputeMatches();
    this.activeView.render();
    if (this.matches.length && this.model.isJsonl && !this.matchSet.has(this.state.active)) {
      this.activeView.stepMatch(1);
    }
    this.paintChrome();
    this.scheduleReport();
  }

  private recomputeMatches(): void {
    this.query = parseQuery(this.state.query, this.model);
    this.matches = this.model.isJsonl ? findMatches(this.model, this.query) : [];
    this.matchSet = new Set(this.matches);
  }

  private stepLine(d: number): void {
    const n = this.model.count;
    let r = this.state.active + d;
    while (r >= 0 && r < n && this.model.get(r).kind === 'blank') r += d;
    if (r >= 0 && r < n) this.selectRecord(r);
  }

  private nextError(): void {
    const errs = this.model.errorRecords();
    if (!errs.length) return;
    const next = errs.find((r) => r > this.state.active) ?? errs[0];
    if (this.state.view === 'graph') this.setView('formatted');
    this.selectRecord(next);
    this.activeView.onActiveChanged(true);
  }

  private foldAll(collapse: boolean): void {
    (this.views.formatted as FormattedView).foldAll(collapse);
  }

  private showBanner(text: string): void {
    this.banner.textContent = text;
    this.banner.hidden = false;
  }

  private renderAll(): void {
    this.activeView.render();
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.scheduleReport();
  }

  /** Updates the toolbar and status bar from the state. */
  paintChrome(): void {
    const s = this.state;
    const m = this.model;
    const tb = this.toolbar;
    tb.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => {
      const on = b.dataset.view === s.view;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    tb.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
      const on = b.dataset.mode === s.expandMode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    (tb.querySelector('.mode') as HTMLElement).hidden = !(s.view === 'formatted' && m.isJsonl);
    (tb.querySelector('.foldall') as HTMLElement).hidden = !(s.view === 'formatted' && !m.isJsonl);
    (tb.querySelector('.linesel') as HTMLElement).hidden = !(s.view === 'graph' && m.isJsonl);
    const wrapBtn = tb.querySelector('.wrap-btn') as HTMLButtonElement;
    wrapBtn.classList.toggle('on', s.wrap);
    wrapBtn.setAttribute('aria-pressed', String(s.wrap));
    wrapBtn.hidden = s.view === 'graph';
    const filterBtn = tb.querySelector('.filter-btn') as HTMLButtonElement;
    filterBtn.hidden = !(s.view === 'formatted' && m.isJsonl);
    filterBtn.classList.toggle('on', s.filterOnly);
    filterBtn.setAttribute('aria-pressed', String(s.filterOnly));
    const lineInput = tb.querySelector('.line-input') as HTMLInputElement;
    if (document.activeElement !== lineInput) lineInput.value = String(s.active + 1);
    (tb.querySelector('.line-of') as HTMLElement).textContent = t('of {0}', m.count.toLocaleString());
    const count = tb.querySelector('.count') as HTMLElement;
    const ri = this.matches.indexOf(s.active);
    count.textContent = this.query.text && m.isJsonl ? `${ri >= 0 ? ri + 1 : '–'} / ${this.matches.length.toLocaleString()}` : '';
    this.paintStats();

    const parts: string[] = [];
    if (m.isJsonl) {
      parts.push(t('Line {0}', s.active + 1));
      if (s.selected.size > 1) parts.push(t('{0} selected', s.selected.size));
    } else parts.push(m.jsonc ? t('JSON with Comments') : 'JSON');
    if (s.view === 'formatted' && m.isJsonl) parts.push(s.expandMode === 'focus' ? t('Focus: selected lines are expanded') : t('All lines expanded'));
    const hint =
      s.view === 'graph'
        ? t('Drag or scroll to pan · {0}+scroll to zoom · click a node to inspect', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
        : s.view === 'grid'
          ? t('Click a header to sort · drag a header edge to resize')
          : m.isJsonl
            ? t('↑/↓ move · Shift extends · Enter edits · double-click jumps to source')
            : t('Click ▸ to fold · double-click jumps to source');
    this.status.innerHTML = `<span>${esc(parts.join(' · '))}</span><span class="spring"></span><span class="dim">${esc(hint)}</span>`;
  }

  private paintStats(): void {
    const m = this.model;
    const st = this.toolbar.querySelector('.stats') as HTMLElement;
    const bits: string[] = [];
    if (m.isJsonl) bits.push(`<span>${t('{0} lines', m.count.toLocaleString())}</span>`);
    else bits.push(`<span class="badge">${m.jsonc ? 'JSONC' : 'JSON'}</span>`);
    if (!m.complete) bits.push(`<span class="dim">${t('parsing {0}%', Math.floor((m.parsed / Math.max(1, m.count)) * 100))}</span>`);
    if (m.errors) {
      bits.push(
        `<button class="chip err-chip" title="${t('Go to the next error')}">${icon('warning')}${t(m.errors === 1 ? '{0} error' : '{0} errors', m.errors.toLocaleString())}</button>`,
      );
    }
    bits.push(`<span class="dim">${formatBytes(m.bytes)}</span>`);
    st.innerHTML = bits.join('');
  }

  // ---------- background parsing ----------

  private startBackground(): void {
    clearTimeout(this.bgTimer);
    const model = this.model;
    const step = () => {
      if (model !== this.model) return;
      const done = model.parseSome(12);
      const now = performance.now();
      if (done || now - this.lastStatsPaint > 250) {
        this.lastStatsPaint = now;
        this.paintStats();
      }
      if (done) {
        if (this.query.path) {
          this.recomputeMatches();
          this.activeView.render();
          this.paintChrome();
        } else if (this.state.view === 'grid') this.activeView.render();
        this.scheduleReport();
        return;
      }
      this.bgTimer = setTimeout(step, 0);
    };
    this.bgTimer = setTimeout(step, 0);
  }

  // ---------- keyboard ----------

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && this.settings?.open) {
      e.preventDefault();
      this.settings.close();
      return;
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const input = this.toolbar?.querySelector('.search input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || !this.model) return;
    if (!this.model.isJsonl || this.state.view === 'graph') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      const recs = this.state.filterOnly && this.query.text ? this.matches : null;
      let r: number;
      if (recs) {
        const i = recs.indexOf(this.state.active);
        r = recs[Math.min(recs.length - 1, Math.max(0, (i < 0 ? 0 : i + d)))];
      } else r = Math.min(this.model.count - 1, Math.max(0, this.state.active + d));
      if (r === undefined) return;
      this.selectRecord(r, e.shiftKey ? 'range' : 'set');
      this.activeView.onActiveChanged(true);
    } else if (e.key === 'Enter' && this.state.view === 'formatted') {
      e.preventDefault();
      this.openEditor(this.state.active);
    } else if (mod && e.key.toLowerCase() === 'c') {
      const text = [...this.state.selected].sort((a, b) => a - b).map((r) => this.model.lines[r]).join('\n');
      if (text && !window.getSelection()?.toString()) {
        e.preventDefault();
        this.post({ type: 'copy', text });
      }
    }
  }

  // ---------- persistence and reports ----------

  private persist(): void {
    vscode.setState({ uri: this.doc.uri, view: this.state.view, expandMode: this.state.expandMode, active: this.state.active });
  }

  private sendReport(): void {
    if (!this.model) return;
    const m = this.model;
    const s = this.state;
    const r: RenderReport = {
      fileName: this.doc.fileName,
      view: s.view,
      expandMode: s.expandMode,
      isJsonl: m.isJsonl,
      active: s.active,
      selected: [...s.selected].sort((a, b) => a - b),
      stats: { lines: m.count, valid: m.valid, errors: m.errors, blank: m.blank, parsed: m.parsed, jsonc: m.jsonc },
      matches: this.matches.length,
      filterOnly: s.filterOnly,
      wrap: s.wrap,
      theme: this.effectiveTheme,
      settingsOpen: !!this.settings?.open,
      lang: this.config.lang,
      version: this.version,
    };
    this.activeView.fillReport(r);
    this.post({ type: 'report', report: r });
  }
}
