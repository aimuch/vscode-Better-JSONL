import { setLang, t } from '../shared/i18n';
import { prettyJson } from '../shared/jsonText';
import type { DocInfo, ExpandMode, HostMessage, RenderReport, TextChange, ViewerConfig, ViewKind, WebviewMessage } from '../shared/protocol';
import { errorMessage } from '../shared/jsonText';
import { esc, formatBytes } from './json';
import { ByteStore, DocModel, dropLastEmpty, KEEP_ALL_BYTES, lowerBound, matchesRecord, parseQuery, patchLines, TreeSearch, tryParse, type Query } from './model';
import { icon } from './icons';
import { SettingsPanel } from './settings';
import { FormattedView } from './views/formatted';
import { GraphView } from './views/graph';
import { GridView } from './views/grid';

export interface View {
  readonly el: HTMLElement;
  /** Re-renders from the current state. `anchor` keeps that record still on screen. */
  render(anchor?: number): void;
  /** Re-renders after the model learned more (errors, columns, new lines). The scroll position stays. */
  refresh(): void;
  /** Limits that hide data in this view right now, for the status bar. */
  notes(): string[];
  /** The active record changed. Scroll it into view when `scroll` is true. */
  onActiveChanged(scroll: boolean): void;
  /** Word wrap turned on or off. Measured row heights are no longer valid. */
  onWrapChanged(): void;
  stepMatch(dir: 1 | -1): void;
  fillReport(r: RenderReport): void;
  show(): void;
  hide(): void;
  /** The view is replaced: remove what it added outside its own element (window and document listeners). */
  dispose(): void;
}

/** Grid column filter: a "contains" text and the cell values that are unticked. */
export interface ColFilter {
  text: string;
  exclude: Set<string>;
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
  /** Containers the user toggled, by record (see lines.isFolded). */
  folds: Map<number, Set<string>>;
  /** Single JSON documents: containers at this depth or deeper start folded. */
  foldDepth: number;
  grid: { sort: { col: string; dir: 1 | -1 } | null; widths: Record<string, number>; open: Set<string>; filters: Map<string, ColFilter> };
  graph: { collapsed: Set<string>; selectedNode: string | null };
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** State kept by VS Code for the webview (vscode.setState). Sets and maps are stored as arrays, with limits. */
interface Saved {
  uri?: string;
  view?: ViewKind;
  expandMode?: ExpandMode;
  active?: number;
  selected?: number[];
  query?: string;
  filterOnly?: boolean;
  foldDepth?: number | null;
  folds?: [number, string[]][];
  grid?: { sort: UIState['grid']['sort']; widths: Record<string, number>; open: string[]; filters: [string, { text: string; exclude: string[] }][] };
  graph?: { collapsed: string[] };
}

/** Above this size a search runs in time slices, so the view stays responsive. */
const SYNC_SEARCH_BYTES = 16 * 1024 * 1024;
/** Time for the first scan before the first paint. Small files are complete after it. */
const FIRST_SCAN_MS = 40;
/** A single JSON document above this size opens with its second level folded. */
const BIG_JSON_BYTES = 8 * 1024 * 1024;
const MAX_RANGE = 2000;
const NO_FOLDS: ReadonlySet<string> = new Set();

/** Milliseconds of background work before the view gets its turn again. */
const SLICE_MS = 12;

const tasks = new Map<number, () => void>();
let nextTask = 1;
const channel = new MessageChannel();
channel.port1.onmessage = (e: MessageEvent<number>) => {
  const fn = tasks.get(e.data);
  tasks.delete(e.data);
  fn?.();
};

/**
 * Runs `fn` in a new task and returns a function that cancels it.
 * The task is a message, not a timer: the browser slows timers down a lot in a window that is
 * in the background or covered, and a scan or search of a large file would almost stop there.
 * Input and painting still come between two tasks. `waitMs` asks for a real pause (a timer).
 */
function defer(fn: () => void, waitMs = 0): () => void {
  if (waitMs > 0) {
    const timer = setTimeout(fn, waitMs);
    return () => clearTimeout(timer);
  }
  const id = nextTask++;
  tasks.set(id, fn);
  channel.port2.postMessage(id);
  return () => tasks.delete(id);
}

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
  /** Length of the document text in the text editor (UTF-16 units). It checks that edits keep both sides in step. */
  private chars = 0;
  query: Query = { raw: '', text: '' };
  matches: number[] = [];
  matchSet = new Set<number>();
  /** One JSON document: the members that match, as path keys in document order (see model.TreeSearch). */
  treeMatches: string[] = [];
  /** The tree search stopped at its limit: there may be more matches. */
  treeCapped = false;
  /** The match the Formatted view went to last (-1: none yet). */
  treeIndex = -1;
  /** Grows when `matches` or `treeMatches` change. Views use it to keep derived lists. */
  matchesVersion = 0;
  /** A sliced search over a large file is running. */
  searching = false;
  private searchPct = 0;
  private stopSearch: (() => void) | undefined;
  /** Large file: the bytes received so far, and what they are shown as. */
  private loadStore: ByteStore | undefined;
  private loadMode: 'undecided' | 'jsonl' | 'json' = 'undecided';
  private lastLoadPaint = 0;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private rangeCapped = false;
  private lastMode: boolean | undefined;
  /** Row height of code lines in px. */
  readonly rh: number;

  private readonly root: HTMLElement;
  private toolbar!: HTMLElement;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private banner!: HTMLElement;
  private views!: Record<ViewKind, View>;
  private stopScan: (() => void) | undefined;
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
      this.stateChanged();
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    root.innerHTML = `<div class="boot">${t('Loading…')}</div>`;
    this.post({ type: 'ready' });
  }

  post(msg: WebviewMessage): void {
    vscode.postMessage(msg);
  }

  /** The folds of record r, for reading. It does not create an entry. */
  foldsOf(r: number): ReadonlySet<string> {
    return this.state.folds.get(r) ?? NO_FOLDS;
  }

  /** Fold depth of record r: only single JSON documents use it. */
  foldDepthOf(): number {
    return this.model.isJsonl ? Infinity : this.state.foldDepth;
  }

  get readOnly(): boolean {
    return !!this.doc.readOnly;
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
        if (m.doc.large) this.initLarge(m.doc, m.version, m.config);
        else {
          this.chars = m.text.length;
          this.init(m.doc, m.version, m.config, new DocModel(m.text, m.doc.isJsonl, m.bytes));
        }
        break;
      case 'chunk':
        this.onChunk(m.version, m.data, m.done);
        break;
      case 'update':
        if (!this.model || !this.views || this.doc.large) break;
        this.chars = m.text.length;
        this.swap(new DocModel(m.text, this.doc.isJsonl, m.bytes), m.version);
        break;
      case 'edit':
        this.applyEdit(m.base, m.version, m.changes, m.eol, m.lineCount, m.chars);
        break;
      case 'selection':
        this.fromEditorSelection(m.lines, m.active, !!m.truncated);
        break;
      case 'config': {
        const old = this.config;
        this.config = m.config;
        this.applyTheme();
        if (!this.views || !old) break;
        if (old.lang !== m.config.lang) {
          this.relabel();
          break;
        }
        if (old.wordWrap !== m.config.wordWrap || old.wrap !== m.config.wrap) this.setWrap(m.config.wrap);
        else if (old.indent !== m.config.indent || old.graphMaxNodes !== m.config.graphMaxNodes) this.activeView.render();
        this.settings?.refresh();
        this.stateChanged();
        break;
      }
      case 'toggleWrap':
        if (this.views) this.setWrap(!this.state.wrap);
        break;
      case 'setView':
        this.setView(m.view);
        break;
      case 'toggleExpandMode':
        if (this.views) this.setExpandMode(this.state.expandMode === 'focus' ? 'all' : 'focus');
        break;
      case 'editResult':
        this.onEditResult(m.ok, m.message);
        break;
      case 'notice':
        // While a large file loads there is no banner yet: the message takes the place of the progress text.
        if (this.views) this.showBanner(m.message, m.action);
        else if (this.loadStore) this.paintBoot(m.message);
        break;
    }
  }

  private init(doc: DocInfo, version: number, config: ViewerConfig, model: DocModel): void {
    this.stopJobs();
    this.loadStore = undefined;
    this.doc = doc;
    this.config = config;
    this.version = version;
    this.start(model);
  }

  /** Shows `model` from scratch: state (restored when it is the same document), shell, first paint. */
  private start(model: DocModel): void {
    const doc = this.doc;
    const config = this.config;
    const saved = (vscode.getState() ?? {}) as Saved;
    const sameDoc = saved.uri === doc.uri;
    const old: Saved = sameDoc ? saved : {};
    setLang(config.lang);
    document.documentElement.lang = config.lang === 'zh-cn' ? 'zh-CN' : 'en';
    this.model = model;
    if (!model.loading) model.parseSome(FIRST_SCAN_MS);
    const prev = this.state;
    const last = Math.max(0, model.count - 1);
    const within = (r: number) => Number.isInteger(r) && r >= 0 && (r < model.count || model.loading);
    let expandMode = old.expandMode || prev?.expandMode || config.expandMode;
    if (expandMode === 'all' && !model.keepsAll) expandMode = 'focus';
    this.state = {
      view: old.view || prev?.view || config.defaultView,
      expandMode,
      query: old.query ?? '',
      filterOnly: !!old.filterOnly,
      wrap: prev?.wrap ?? config.wrap,
      active: old.active !== undefined ? (model.loading ? old.active : Math.min(old.active, last)) : 0,
      anchor: 0,
      selected: new Set((old.selected ?? []).filter(within)),
      folds: new Map((old.folds ?? []).filter(([r]) => within(r)).map(([r, keys]) => [r, new Set(keys)])),
      foldDepth: old.foldDepth !== undefined ? (old.foldDepth ?? Infinity) : !model.isJsonl && model.bytes > BIG_JSON_BYTES ? 1 : Infinity,
      grid: {
        sort: old.grid?.sort ?? null,
        widths: { ...(old.grid?.widths ?? {}) },
        open: new Set(old.grid?.open ?? []),
        filters: new Map((old.grid?.filters ?? []).map(([c, f]) => [c, { text: f.text, exclude: new Set(f.exclude) }])),
      },
      graph: { collapsed: new Set(old.graph?.collapsed ?? []), selectedNode: null },
    };
    const s = this.state;
    s.anchor = s.active;
    if (model.isJsonl) {
      if (!s.selected.size && (model.count || model.loading)) s.selected.add(s.active);
    } else s.selected.clear();
    this.rangeCapped = false;
    this.query = { raw: '', text: '' };
    this.matches = [];
    this.matchSet = new Set();
    this.matchesVersion++;
    this.buildShell();
    this.applyTheme();
    document.body.classList.toggle('wrap', s.wrap);
    let painted = false;
    this.startSearch(() => painted && this.repaint());
    this.startBackground();
    this.renderAll();
    painted = true;
    this.postMode();
  }

  /** A large file: the text follows as "chunk" messages. */
  private initLarge(doc: DocInfo, version: number, config: ViewerConfig): void {
    this.stopJobs();
    this.doc = doc;
    this.config = config;
    this.version = version;
    this.model = undefined as unknown as DocModel;
    this.views = undefined as unknown as Record<ViewKind, View>;
    this.settings = undefined;
    setLang(config.lang);
    this.applyTheme();
    this.loadStore = new ByteStore();
    this.loadMode = doc.isJsonl ? 'jsonl' : 'undecided';
    this.paintBoot();
  }

  private paintBoot(text?: string): void {
    const total = this.doc.large?.bytes ?? 0;
    const got = this.loadStore?.total ?? 0;
    const msg = text ?? t('Loading {0} of {1}…', formatBytes(got), formatBytes(total));
    this.root.innerHTML = `<div class="boot">${esc(msg)}</div>`;
  }

  private onChunk(version: number, data: Uint8Array, done: boolean): void {
    const store = this.loadStore;
    if (!store || version !== this.version) return;
    store.append(data, done);
    if (this.loadMode === 'undecided') {
      // A .json file: one value per line (JSON Lines) can be shown while it loads; one JSON value needs the whole file.
      const first = store.firstLine(8 * 1024 * 1024);
      if (first !== undefined && tryParse(first).kind === 'value') {
        if (store.hasMoreThanOneLine()) this.loadMode = 'jsonl';
        else if (done) this.loadMode = 'json';
      } else if (first !== undefined || done) this.loadMode = 'json';
    }
    if (this.loadMode === 'jsonl') {
      if (!this.views) {
        const model = new DocModel(store, true);
        model.detectedJsonl = !this.doc.isJsonl;
        this.start(model);
      }
      const now = performance.now();
      if (done || now - this.lastLoadPaint > 250) {
        this.lastLoadPaint = now;
        // The graph shows the selected lines only: more lines do not change it.
        if (this.state.view !== 'graph') this.activeView.refresh();
        this.paintChrome();
      }
      if (done) {
        this.loadStore = undefined;
        let painted = false;
        this.startSearch(() => painted && this.repaint());
        painted = true;
        this.startBackground();
        this.stateChanged();
      }
      return;
    }
    if (!done) {
      this.paintBoot();
      return;
    }
    this.paintBoot(t('Parsing {0}…', formatBytes(store.total)));
    // Let the "Parsing" text paint first: JSON.parse of a large file blocks for a while.
    setTimeout(() => {
      if (version !== this.version || this.loadStore !== store) return;
      this.loadStore = undefined;
      let model: DocModel;
      try {
        model = new DocModel(store.takeText(), false, store.total);
      } catch (e) {
        this.paintBoot(t('This file is too large to show as one JSON value ({0}).', errorMessage(e)));
        return;
      }
      this.start(model);
    }, 30);
  }

  /**
   * Changes of a JSON Lines document, instead of its whole text. The lines are patched; the
   * result must have the line count and length the host reports, or the whole text is asked for.
   */
  private applyEdit(base: number, version: number, changes: TextChange[], eol: number, lineCount: number, chars: number): void {
    const old = this.model;
    const lines = old && this.views && this.doc.isJsonl && base === this.version ? old.editorLines() : undefined;
    const grown = lines && patchLines(lines, changes, eol);
    if (!lines || !grown || lines.length !== lineCount || this.chars + grown.chars !== chars) {
      this.post({ type: 'resync' });
      return;
    }
    this.chars = chars;
    const endsWithEol = dropLastEmpty(lines);
    this.swap(new DocModel(lines, true, old.bytes + grown.bytes, endsWithEol), version);
  }

  /** The document changed: `model` takes the place of the one on screen. */
  private swap(model: DocModel, version: number): void {
    this.version = version;
    // Records that did not change keep their parse results, folds and selection.
    const map = model.adopt(this.model);
    this.model = model;
    model.parseSome(FIRST_SCAN_MS);
    const n = model.count;
    const s = this.state;
    const move = (r: number) => {
      const to = map(r);
      return to >= 0 && to < n ? to : -1;
    };
    const folds = new Map<number, Set<string>>();
    for (const [r, f] of s.folds) if (move(r) >= 0) folds.set(move(r), f);
    s.folds = folds;
    if (model.isJsonl) {
      const open = new Set<string>();
      for (const key of s.grid.open) {
        const bar = key.indexOf('|');
        const to = move(Number(key.slice(0, bar)));
        if (to >= 0) open.add(to + key.slice(bar));
      }
      s.grid.open = open;
    }
    const selected = new Set<number>();
    for (const r of s.selected) if (move(r) >= 0) selected.add(move(r));
    s.selected = selected;
    const clamp = (r: number) => Math.min(Math.max(0, r), Math.max(0, n - 1));
    s.active = move(s.active) >= 0 ? move(s.active) : clamp(s.active);
    s.anchor = move(s.anchor) >= 0 ? move(s.anchor) : s.active;
    if (model.isJsonl && !s.selected.size && n) s.selected.add(s.active);
    if (!model.isJsonl) s.selected.clear();
    if (s.expandMode === 'all' && !model.keepsAll) s.expandMode = 'focus';
    let painted = false;
    this.startSearch(() => painted && this.repaint());
    this.startBackground();
    this.renderAll();
    painted = true;
    this.postMode();
  }

  /** Tells the host what the document is shown as, so both sides read line numbers the same way. */
  private postMode(): void {
    const isJsonl = this.model.isJsonl;
    if (this.lastMode === isJsonl) return;
    this.lastMode = isJsonl;
    this.post({ type: 'docMode', isJsonl });
  }

  private stopJobs(): void {
    this.stopScan?.();
    this.stopSearch?.();
    // A save that is still waiting belongs to the document before this one.
    clearTimeout(this.persistTimer);
    this.searching = false;
    this.lastMode = undefined;
  }

  private repaint(): void {
    this.activeView.render();
    this.paintChrome();
    this.stateChanged();
  }

  private fromEditorSelection(lines: number[], active: number, truncated: boolean): void {
    if (!this.model || !this.views || !this.model.isJsonl) return;
    const n = this.model.count;
    const sel = lines.filter((l) => l < n);
    if (!sel.length || active >= n) return;
    const s = this.state;
    const same = s.active === active && sel.length === s.selected.size && sel.every((l) => s.selected.has(l));
    if (same) return;
    s.selected = new Set(sel);
    s.active = active;
    s.anchor = active;
    this.rangeCapped = truncated;
    if (s.expandMode === 'focus' && s.view === 'formatted') this.activeView.render();
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.stateChanged();
  }

  // ---------- state changes ----------

  selectRecord(r: number, how: 'set' | 'toggle' | 'range' = 'set'): void {
    const s = this.state;
    if (r < 0 || r >= this.model.count) return;
    this.rangeCapped = false;
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
      // The range grows from the anchor, so the capped part is the far end.
      const step = s.anchor <= r ? 1 : -1;
      for (let i = s.anchor; i >= a && i <= b && s.selected.size < MAX_RANGE; i += step) s.selected.add(i);
      this.rangeCapped = b - a + 1 > MAX_RANGE;
    }
    s.active = r;
    s.graph.selectedNode = null;
    if (s.view === 'formatted' || s.view === 'graph') this.activeView.render(r);
    this.activeView.onActiveChanged(false);
    if (this.model.isJsonl) this.post({ type: 'select', line: r });
    this.paintChrome();
    this.stateChanged();
  }

  setView(v: ViewKind): void {
    if (!this.views || this.state.view === v) return;
    this.activeView.hide();
    this.state.view = v;
    this.activeView.show();
    this.activeView.render();
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.stateChanged();
  }

  setExpandMode(m: ExpandMode): void {
    if (this.state.expandMode === m) return;
    if (m === 'all' && !this.model.keepsAll) {
      this.showBanner(t('Expand all is off for files over {0}. Only the selected lines are expanded.', formatBytes(KEEP_ALL_BYTES)));
      return;
    }
    this.state.expandMode = m;
    if (this.state.view === 'formatted') {
      this.activeView.render(this.state.active);
      this.activeView.onActiveChanged(true);
    }
    this.paintChrome();
    this.stateChanged();
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
    this.stateChanged();
  }

  /** Applies the theme setting: VS Code colors, a fixed light or dark palette, or the OS choice. */
  applyTheme(): void {
    const mode = this.config.theme;
    const eff = mode === 'system' ? (this.darkMedia.matches ? 'dark' : 'light') : mode;
    this.effectiveTheme = eff;
    if (eff === 'vscode') delete document.body.dataset.theme;
    else document.body.dataset.theme = eff;
  }

  /** Call after any change of the view state: it saves the state and (in tests) reports the render. */
  stateChanged(): void {
    this.persist();
    if (!this.config.reports) return;
    clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => this.sendReport(), 40);
  }

  // ---------- record editor ----------

  openEditor(r: number): void {
    if (this.readOnly) {
      this.showBanner(t('This file is read-only here: it is too large for VS Code to edit through an extension.'));
      return;
    }
    if (!this.model.isJsonl) {
      this.post({ type: 'openAsText' });
      return;
    }
    const raw = this.model.line(r);
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
    // The views of the shell before this one hold listeners on the window and the document.
    if (this.views) for (const v of Object.values(this.views)) v.dispose();
    this.editRecord = -1;
    this.root.innerHTML = `
      <div class="toolbar" role="toolbar" aria-label="${t('Better JSONL toolbar')}"></div>
      <div class="banner" hidden role="status"></div>
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
        this.stateChanged();
      } else if (t.classList.contains('open-text')) this.post({ type: 'openAsText' });
      else if (t.classList.contains('wrap-btn')) this.setWrap(!this.state.wrap);
      else if (t.classList.contains('gear-btn')) this.settings?.toggle();
      else if (t.classList.contains('err-chip')) this.nextError();
    });
    const input = tb.querySelector('.search input') as HTMLInputElement;
    input.value = this.state.query;
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
    this.startSearch(() => {
      this.activeView.render();
      if (this.matches.length && this.model.isJsonl && !this.matchSet.has(this.state.active)) this.activeView.stepMatch(1);
      this.paintChrome();
      this.stateChanged();
    });
    if (this.searching) this.repaint();
  }

  /**
   * Finds the records that match the query. Small documents: at once. Large ones: in time
   * slices; `done` runs when the result is ready (at once, or later).
   */
  private startSearch(done: () => void): void {
    this.stopSearch?.();
    const m = this.model;
    this.query = parseQuery(this.state.query, m);
    const q = this.query;
    const finish = (out: number[], tree?: TreeSearch) => {
      this.matches = out;
      this.matchSet = new Set(out);
      this.treeMatches = tree ? tree.matches : [];
      this.treeCapped = !!tree?.capped;
      this.treeIndex = -1;
      this.matchesVersion++;
      this.searching = false;
      done();
    };
    const sync = m.bytes <= SYNC_SEARCH_BYTES;
    const begin = () => {
      this.matches = [];
      this.matchSet = new Set();
      this.treeMatches = [];
      this.treeCapped = false;
      this.treeIndex = -1;
      this.matchesVersion++;
      this.searching = !sync;
      this.searchPct = 0;
    };
    if (!q.text) {
      finish([]);
      return;
    }
    if (!m.isJsonl) {
      // One JSON document: search the value itself, so folded nodes are searched too.
      const root = m.value(0);
      if (root === undefined || q.path) {
        finish([]);
        return;
      }
      const tree = new TreeSearch(root, q.text);
      begin();
      const walk = () => {
        if (m !== this.model) return;
        if (tree.step(sync ? Infinity : SLICE_MS)) finish([], tree);
        else this.stopSearch = defer(walk);
      };
      walk();
      return;
    }
    const out: number[] = [];
    let i = 0;
    begin();
    const step = () => {
      if (m !== this.model) return;
      const end = sync ? Infinity : performance.now() + SLICE_MS;
      const n = m.count;
      while (i < n) {
        if (matchesRecord(m, i, q)) out.push(i);
        i++;
        if ((i & 127) === 0 && performance.now() > end) break;
      }
      if (i >= n) {
        finish(out);
        return;
      }
      this.searchPct = Math.floor((i / n) * 100);
      this.paintCount();
      this.stopSearch = defer(step);
    };
    step();
  }

  private stepLine(d: number): void {
    const n = this.model.count;
    let r = this.state.active + d;
    while (r >= 0 && r < n && this.model.isBlank(r)) r += d;
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

  /** A line under the toolbar. `action: 'reload'` adds a button that asks the host to read the file again. */
  showBanner(text: string, action?: 'reload'): void {
    const b = this.banner;
    b.textContent = '';
    const span = document.createElement('span');
    span.textContent = text;
    b.appendChild(span);
    if (action === 'reload') {
      const btn = document.createElement('button');
      btn.className = 'btn banner-act';
      btn.textContent = t('Reload');
      btn.addEventListener('click', () => this.post({ type: 'reload' }));
      b.appendChild(btn);
    }
    const close = document.createElement('button');
    close.className = 'icon-btn banner-close';
    close.setAttribute('aria-label', t('Dismiss'));
    close.innerHTML = icon('close', 14);
    close.addEventListener('click', () => (b.hidden = true));
    b.appendChild(close);
    b.hidden = false;
  }

  private renderAll(): void {
    this.activeView.render();
    this.activeView.onActiveChanged(true);
    this.paintChrome();
    this.stateChanged();
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
    const allBtn = tb.querySelector('[data-mode="all"]') as HTMLButtonElement;
    allBtn.disabled = !m.keepsAll;
    allBtn.title = m.keepsAll ? t('All lines are pretty-printed') : t('Expand all is off for files over {0}. Only the selected lines are expanded.', formatBytes(KEEP_ALL_BYTES));
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
    this.paintCount();
    this.paintStats();

    const parts: string[] = [];
    if (m.isJsonl) {
      parts.push(t('Line {0}', s.active + 1));
      if (s.selected.size > 1) parts.push(t('{0} selected', s.selected.size));
    } else parts.push(m.jsonc ? t('JSON with Comments') : 'JSON');
    if (s.view === 'formatted' && m.isJsonl) parts.push(s.expandMode === 'focus' ? t('Focus: selected lines are expanded') : t('All lines expanded'));
    if (s.view === 'grid') {
      const f = (this.views.grid as GridView).filterStatus();
      if (f) parts.push(f);
    }
    if (this.readOnly) parts.push(t('Read-only (large file)'));
    parts.push(...this.notes());
    const hint =
      s.view === 'graph'
        ? t('Drag or scroll to pan · {0}+scroll to zoom · click a node to inspect', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
        : s.view === 'grid'
          ? t('Click a header to sort · the funnel filters a column · drag a header edge to resize')
          : m.isJsonl
            ? this.readOnly
              ? t('↑/↓ move · Shift extends · double-click jumps to source')
              : t('↑/↓ move · Shift extends · Enter edits · double-click jumps to source')
            : t('Click ▸ to fold · double-click jumps to source');
    this.status.innerHTML = `<span>${esc(parts.join(' · '))}</span><span class="spring"></span><span class="dim">${esc(hint)}</span>`;
  }

  /** Limits that hide data right now. */
  private notes(): string[] {
    const out = this.activeView.notes();
    if (this.rangeCapped) out.push(t('The selection stops at {0} lines', MAX_RANGE.toLocaleString()));
    return out;
  }

  /** The match counter beside the search box. */
  paintCount(): void {
    const count = this.toolbar?.querySelector('.count') as HTMLElement | null;
    if (!count) return;
    const m = this.model;
    if (!this.query.text) count.textContent = '';
    else if (!m.isJsonl) {
      // One JSON document: the Formatted view steps through the matches in the value.
      if (this.state.view !== 'formatted' || this.query.path) count.textContent = '';
      else if (this.searching) count.textContent = t('Searching…');
      else count.textContent = `${this.treeIndex >= 0 ? this.treeIndex + 1 : '–'} / ${this.treeMatches.length.toLocaleString()}${this.treeCapped ? '+' : ''}`;
    } else if (this.searching) count.textContent = t('searching {0}%', this.searchPct);
    else {
      const ri = this.matchSet.has(this.state.active) ? lowerBound(this.matches, this.state.active) : -1;
      count.textContent = `${ri >= 0 ? ri + 1 : '–'} / ${this.matches.length.toLocaleString()}`;
    }
  }

  private paintStats(): void {
    const m = this.model;
    const st = this.toolbar.querySelector('.stats') as HTMLElement;
    const bits: string[] = [];
    if (m.isJsonl) bits.push(`<span>${t('{0} lines', m.count.toLocaleString())}</span>`);
    else bits.push(`<span class="badge">${m.jsonc ? 'JSONC' : 'JSON'}</span>`);
    if (m.loading) bits.push(`<span class="dim">${t('loading {0}%', Math.floor((m.bytes / Math.max(1, this.doc.large?.bytes ?? m.bytes)) * 100))}</span>`);
    else if (!m.complete) bits.push(`<span class="dim">${t('parsing {0}%', Math.floor((m.parsed / Math.max(1, m.count)) * 100))}</span>`);
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
    this.stopScan?.();
    const model = this.model;
    if (model.complete) return;
    let errors = model.errorsVersion;
    let columns = model.columns.length;
    const step = () => {
      if (model !== this.model) return;
      const done = model.parseSome(SLICE_MS);
      const now = performance.now();
      if (done || now - this.lastStatsPaint > 250) {
        this.lastStatsPaint = now;
        this.paintStats();
        // New errors change row heights in the Formatted view; new keys add columns to the Grid.
        const view = this.state.view;
        if ((view === 'formatted' && model.errorsVersion !== errors) || (view === 'grid' && (done || model.columns.length !== columns))) this.activeView.refresh();
        errors = model.errorsVersion;
        columns = model.columns.length;
      }
      if (done) {
        // A path query needs the column names: read the query again now that all are known.
        if (!!parseQuery(this.state.query, model).path !== !!this.query.path) this.startSearch(() => this.repaint());
        this.stateChanged();
        return;
      }
      // While a large file loads, the scan waits for more lines.
      this.stopScan = defer(step, model.loading && model.parsed >= model.count ? 120 : 0);
    };
    this.stopScan = defer(step);
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
    if (tag === 'INPUT' || tag === 'TEXTAREA' || !this.model || !this.views) return;
    // Enter and Space on a button press that button; they are not "edit the record".
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('button, [role="button"], [role="columnheader"]')) return;
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
    } else if (e.key === 'Enter' && this.state.view === 'formatted' && !this.readOnly) {
      e.preventDefault();
      this.openEditor(this.state.active);
    } else if (mod && e.key.toLowerCase() === 'c') {
      const text = [...this.state.selected].sort((a, b) => a - b).map((r) => this.model.line(r)).join('\n');
      if (text && !window.getSelection()?.toString()) {
        e.preventDefault();
        this.post({ type: 'copy', text });
      }
    }
  }

  // ---------- persistence and reports ----------

  /** Saves the view state (soon), so a restored webview shows the same thing. */
  private persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const s = this.state;
      if (!s || !this.doc) return;
      const head = <T>(it: Iterable<T>, n: number) => {
        const out: T[] = [];
        for (const x of it) {
          if (out.length >= n) break;
          out.push(x);
        }
        return out;
      };
      const saved: Saved = {
        uri: this.doc.uri,
        view: s.view,
        expandMode: s.expandMode,
        active: s.active,
        selected: head(s.selected, MAX_RANGE),
        query: s.query,
        filterOnly: s.filterOnly,
        foldDepth: Number.isFinite(s.foldDepth) ? s.foldDepth : null,
        folds: head(s.folds, 200)
          .filter(([, f]) => f.size > 0)
          .map(([r, f]) => [r, head(f, 500)]),
        grid: {
          sort: s.grid.sort,
          widths: s.grid.widths,
          open: head(s.grid.open, 500),
          filters: head(s.grid.filters, 50).map(([c, f]) => [c, { text: f.text, exclude: head(f.exclude, 500) }]),
        },
        graph: { collapsed: head(s.graph.collapsed, 500) },
      };
      vscode.setState(saved);
    }, 120);
  }

  private sendReport(): void {
    if (!this.model || !this.views) return;
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
      activeText: m.isJsonl && s.active < m.count ? m.head(s.active, 300) : undefined,
      matches: m.isJsonl ? this.matches.length : this.treeMatches.length,
      filterOnly: s.filterOnly,
      wrap: s.wrap,
      theme: this.effectiveTheme,
      large: !!this.doc.large,
      loading: m.loading,
      searching: this.searching,
      notes: this.notes(),
      settingsOpen: !!this.settings?.open,
      lang: this.config.lang,
      version: this.version,
    };
    this.activeView.fillReport(r);
    this.post({ type: 'report', report: r });
  }
}
