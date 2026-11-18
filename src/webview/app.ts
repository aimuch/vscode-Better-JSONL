import { setLang, t } from '../shared/i18n';
import { errorMessage, prettyJson } from '../shared/jsonText';
import type {
  DocInfo,
  ExpandMode,
  ExportAssetFormat,
  ExportRowFormat,
  HostMessage,
  RenderReport,
  TextChange,
  ViewerConfig,
  ViewKind,
  WebviewMessage,
} from '../shared/protocol';
import { valueSpan } from '../locate';
import { ByteJsonError, parseJsonBytes } from './byteJson';
import { indexItems, ItemStore } from './items';
import { diffValues, type Difference } from './diff';
import { csvRow, mdDivider, mdRow } from './exporter';
import {
  decodeSmartValue,
  extractRecordEpochMs,
  formatDecodedSummary,
  renderMarkdownSafe,
  tryUnpackJsonString,
  type DecodedInfo,
} from './inspect';
import {
  childKey,
  esc,
  formatBytes,
  getAt,
  isArr,
  isContainer,
  isObj,
  pathToJq,
  pathToString,
  RawNum,
  stringifyPretty,
  type JObj,
  type JVal,
} from './json';
import { compactJson, compileQuery, pathOf, type Out, type Program } from './query';
import {
  ByteStore,
  DocModel,
  dropLastEmpty,
  KEEP_ALL_BYTES,
  lowerBound,
  matchesPathValue,
  matchesRecord,
  parseQuery,
  patchLines,
  stepIn,
  TreeSearch,
  tryParse,
  type Query,
} from './model';
import { icon } from './icons';
import { emitJsonSchema, emitPydantic, emitTypeScript, emitZod, inferSchema } from './schema';
import { SettingsPanel } from './settings';
import { buildTimeline, detectTimeColumn, renderTimelineHtml, type TimelineData } from './timeline';
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

/** Grid column filter: contains text, numeric min/max bounds, and unticked cell values. */
export interface ColFilter {
  text: string;
  exclude: Set<string>;
  min?: string;
  max?: string;
}

export interface UIState {
  view: ViewKind;
  expandMode: ExpandMode;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  literal: boolean;
  filterOnly: boolean;
  bookmarkedOnly: boolean;
  bookmarks: Set<number>;
  unpacked: Map<number, Set<string>>;
  multiline: Map<number, Set<string>>;
  timelineOpen: boolean;
  timelineRange: [number, number] | null;
  /** JSON Lines: stay at the end when lines are added (like tail -f). */
  follow: boolean;
  wrap: boolean;
  active: number;
  anchor: number;
  selected: Set<number>;
  /** Containers the user toggled, by record (see lines.isFolded). */
  folds: Map<number, Set<string>>;
  /** Single JSON documents: containers at this depth or deeper start folded. */
  foldDepth: number;
  grid: {
    sort: { col: string; dir: 1 | -1 } | null;
    widths: Record<string, number>;
    open: Set<string>;
    filters: Map<string, ColFilter>;
    hiddenCols: Set<string>;
    pinnedCols: Set<string>;
    colOrder: string[];
  };
  graph: { collapsed: Set<string>; selectedNode: string | null };
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface DocSaved {
  uri: string;
  view?: ViewKind;
  expandMode?: ExpandMode;
  wrap?: boolean;
  active?: number;
  selected?: number[];
  query?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  literal?: boolean;
  filterOnly?: boolean;
  bookmarkedOnly?: boolean;
  bookmarks?: number[];
  follow?: boolean;
  foldDepth?: number | null;
  folds?: [number, string[]][];
  grid?: {
    sort: UIState['grid']['sort'];
    widths: Record<string, number>;
    open: string[];
    filters: [string, { text: string; exclude: string[]; min?: string; max?: string }][];
    hiddenCols?: string[];
    pinnedCols?: string[];
    colOrder?: string[];
  };
  graph?: { collapsed: string[] };
}

interface SavedStore extends Partial<DocSaved> {
  docs?: DocSaved[];
  queryHistory?: string[];
  savedQueries?: string[];
}

const MAX_SAVED_DOCS = 15;
const MAX_QUERY_HISTORY = 20;
const MAX_PROJECTED_ROWS = 100_000;

/** Above this size a search runs in time slices, so the view stays responsive. */
const SYNC_SEARCH_BYTES = 16 * 1024 * 1024;
/** Time for the first scan before the first paint. Small files are complete after it. */
const FIRST_SCAN_MS = 40;
/**
 * One JSON value from this many bytes on is parsed from the bytes (parseJsonBytes): a
 * JavaScript string holds at most about 2^29 characters. The tests set a smaller value.
 */
const BYTE_JSON_AT = (globalThis as { __betterJsonlByteJsonAt?: number }).__betterJsonlByteJsonAt ?? 2 ** 29 - 64;
/** Text sent to the host in one piece of an export. */
const EXPORT_PIECE = 2 * 1024 * 1024;
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
export function defer(fn: () => void, waitMs = 0): () => void {
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

const QUERY_EXAMPLES = [
  '.level == "error"',
  'select(.ms > 100) | {id, ms, msg}',
  '[inputs | .ms // 0] | add',
  '$..name',
];

export class App {
  model!: DocModel;
  /** Underlying document model while Transform (`jq` projection) mode is active. */
  private baseModel: DocModel | undefined;
  private transformMode = false;
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
  /** A JSONPath or jq query: what the status bar says about it (an error, or results that have no place). */
  private queryNotes: string[] = [];
  /** jq module files read through the host (import / include), and the ones asked for. */
  private readonly jqModules = new Map<string, string | null>();
  private readonly modulesAsked = new Set<string>();
  /** Grows when `matches` or `treeMatches` change. Views use it to keep derived lists. */
  matchesVersion = 0;
  private bookmarksRev = 0;
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
  /** File bytes read so far while a large file loads (compressed bytes for a .gz file). */
  private loadRead = 0;
  /** A cell edit waits for the host. */
  private cellPending = false;
  /** After inserting a blank record below `r`, open the editor on `r + 1` once the document updates. */
  private pendingOpenRecord = -1;
  /** The user confirmed Expand all for this file over 50 MB. */
  private bigExpandOK = false;
  /** Ends the document listeners of the shell when it is built again. */
  private shellGone = new AbortController();
  private nextExport = 1;
  /** The export in progress: it sends the next piece when the host is ready for it. */
  private exporting: { id: number; next: () => string | null } | undefined;
  /** Row height of code lines in px. */
  readonly rh: number;

  private queryHistory: string[] = [];
  private savedQueries: string[] = [];
  private histCursor = -1;

  private timelineData: TimelineData | undefined;
  private timelineModelRef: unknown;
  private timelineModelRev = -1;
  private timelineBrushStart = -1;

  private readonly root: HTMLElement;
  private toolbar!: HTMLElement;
  private timelineEl!: HTMLElement;
  private body!: HTMLElement;
  private status!: HTMLElement;
  private banner!: HTMLElement;
  private views!: Record<ViewKind, View>;
  private stopScan: (() => void) | undefined;
  private stopExpand: (() => void) | undefined;
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

  get shellSignal(): AbortSignal {
    return this.shellGone.signal;
  }

  get isProjected(): boolean {
    return this.transformMode && this.baseModel !== undefined;
  }

  get canRevealSource(): boolean {
    return !this.doc.large?.gzip && !this.isProjected;
  }

  post(msg: WebviewMessage): void {
    vscode.postMessage(msg);
  }

  /** The folds of record r, for reading. It does not create an entry. */
  foldsOf(r: number): ReadonlySet<string> {
    return this.state.folds.get(r) ?? NO_FOLDS;
  }

  unpackedOf(r: number): ReadonlySet<string> {
    return this.state.unpacked.get(r) ?? NO_FOLDS;
  }

  multilineOf(r: number): ReadonlySet<string> {
    return this.state.multiline.get(r) ?? NO_FOLDS;
  }

  /** Fold depth of record r: only single JSON documents use it. */
  foldDepthOf(): number {
    return this.model.isJsonl ? Infinity : this.state.foldDepth;
  }

  get readOnly(): boolean {
    return !!this.doc.readOnly || !!this.model?.items || this.isProjected;
  }

  /** Asks the host to show record `r` (at `path`) in the text editor: at its line in the file. */
  reveal(r: number, path: (string | number)[]): void {
    if (!this.canRevealSource) {
      const rv = this.model.value(r);
      this.openValueInspector(r, path, rv !== undefined ? getAt(rv, path) : undefined);
      return;
    }
    const m = this.model;
    this.post({ type: 'reveal', line: m.isJsonl ? m.fileLine(r) : 0, path });
  }

  folds(r: number): Set<string> {
    let f = this.state.folds.get(r);
    if (!f) {
      f = new Set();
      this.state.folds.set(r, f);
    }
    return f;
  }

  toggleUnpack(r: number, pathKey: string): void {
    let set = this.state.unpacked.get(r);
    if (!set) {
      set = new Set();
      this.state.unpacked.set(r, set);
    }
    if (!set.delete(pathKey)) set.add(pathKey);
    (this.views.formatted as FormattedView).invalidateRecord(r);
    if (this.state.view === 'formatted') this.activeView.render(r);
    this.stateChanged();
  }

  toggleMultiline(r: number, pathKey: string): void {
    let set = this.state.multiline.get(r);
    if (!set) {
      set = new Set();
      this.state.multiline.set(r, set);
    }
    if (!set.delete(pathKey)) set.add(pathKey);
    (this.views.formatted as FormattedView).invalidateRecord(r);
    if (this.state.view === 'formatted') this.activeView.render(r);
    this.stateChanged();
  }

  toggleBookmark(r: number): void {
    if (!this.model.isJsonl || r < 0 || r >= this.model.count) return;
    const bm = this.state.bookmarks;
    if (!bm.delete(r)) bm.add(r);
    if (bm.size === 0 && this.state.bookmarkedOnly) this.state.bookmarkedOnly = false;
    this.bookmarksRev++;
    this.activeView.render(r);
    this.paintChrome();
    this.stateChanged();
  }

  stepBookmark(dir: 1 | -1): void {
    if (!this.model.isJsonl || !this.state.bookmarks.size) return;
    const sorted = [...this.state.bookmarks].filter((r) => r < this.model.count).sort((a, b) => a - b);
    if (!sorted.length) return;
    const next = stepIn(sorted, this.state.active, dir);
    this.selectRecord(next);
    this.activeView.onActiveChanged(true);
  }

  hasGlobalRowFilter(): boolean {
    return this.state.bookmarkedOnly || this.state.timelineRange !== null;
  }

  globalFilterSig(): string {
    return `${this.state.bookmarkedOnly ? 1 : 0}|${this.bookmarksRev}|${this.state.timelineRange ? this.state.timelineRange.join(':') : ''}`;
  }

  passesGlobalRowFilter(r: number): boolean {
    if (this.state.bookmarkedOnly && !this.state.bookmarks.has(r)) return false;
    if (this.state.timelineRange) {
      const td = this.ensureTimelineData();
      if (!td || r >= td.rowTimes.length) return false;
      const ms = td.rowTimes[r];
      if (Number.isNaN(ms) || ms < this.state.timelineRange[0] || ms > this.state.timelineRange[1]) return false;
    }
    return true;
  }

  recsFiltered(): boolean {
    return (this.state.filterOnly && !!this.query.text) || this.hasGlobalRowFilter();
  }

  formattedRecords(): number[] | null {
    const s = this.state;
    const hasSearchFilter = s.filterOnly && !!this.query.text;
    const hasGlobal = this.hasGlobalRowFilter();
    if (!hasSearchFilter && !hasGlobal) return null;
    if (hasSearchFilter && !hasGlobal) return this.matches;
    if (hasSearchFilter) return this.matches.filter((r) => this.passesGlobalRowFilter(r));
    const out: number[] = [];
    for (let i = 0; i < this.model.count; i++) {
      if (!this.model.isBlank(i) && this.passesGlobalRowFilter(i)) out.push(i);
    }
    return out;
  }

  smartTooltip(r: number, v: JVal): string | undefined {
    let prevMs: number | undefined;
    if (this.model.isJsonl) {
      const refLine = this.state.active !== r ? this.state.active : r > 0 ? r - 1 : undefined;
      if (refLine !== undefined && refLine >= 0 && refLine < this.model.count) {
        prevMs = extractRecordEpochMs(this.model.value(refLine));
      }
    }
    const dec = decodeSmartValue(v, prevMs);
    if (!dec.length) return undefined;
    return dec.map(formatDecodedSummary).join('\n');
  }

  get activeView(): View {
    return this.views[this.state.view];
  }

  // ---------- messages ----------

  private onMessage(m: HostMessage): void {
    switch (m.type) {
      case 'init':
        this.persistNow();
        if (m.doc.large) this.initLarge(m.doc, m.version, m.config);
        else {
          this.chars = m.text.length;
          this.init(m.doc, m.version, m.config, new DocModel(m.text, m.doc.isJsonl, m.bytes));
        }
        break;
      case 'chunk':
        if (m.read !== undefined) this.loadRead = m.read;
        this.onChunk(m.version, m.data, m.done);
        break;
      case 'append':
        this.onAppend(m.version, m.data);
        break;
      case 'modules':
        for (const [k, v] of Object.entries(m.files)) this.jqModules.set(k, v);
        if (this.model && this.views) this.startSearch(() => this.repaint());
        break;
      case 'exportReady':
        this.onExportReady(m.id, m.ok);
        break;
      case 'exportDone':
        if (this.exporting?.id === m.id) this.exporting = undefined;
        if (this.views) this.showBanner(m.message);
        break;
      case 'update':
        if (!this.model || !this.views || this.doc.large) break;
        if (this.baseModel) {
          this.model = this.baseModel;
          this.baseModel = undefined;
        }
        this.chars = m.text.length;
        this.swap(new DocModel(m.text, this.doc.isJsonl, m.bytes, false, this.model.detectedJsonl), m.version);
        break;
      case 'edit':
        if (this.baseModel) {
          this.model = this.baseModel;
          this.baseModel = undefined;
        }
        this.applyEdit(m.base, m.version, m.changes, m.eol, m.lineCount, m.chars);
        break;
      case 'selection':
        if (this.isProjected) break;
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
      case 'exportRows':
        if (this.views && this.model) this.exportRows(m.which, m.format);
        break;
      case 'editResult':
        this.onEditResult(m.ok, m.message, m.line, m.text, m.cell, m.batch);
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
    this.baseModel = undefined;
    this.transformMode = false;
    this.timelineData = undefined;
    this.pendingOpenRecord = -1;
    this.doc = doc;
    this.config = config;
    this.version = version;
    this.start(model);
  }

  /** Shows `model` from scratch: state (restored when seen in per-URI LRU), shell, first paint. */
  private start(model: DocModel): void {
    const doc = this.doc;
    const config = this.config;
    const store = (vscode.getState() ?? {}) as SavedStore;
    if (Array.isArray(store.queryHistory)) this.queryHistory = store.queryHistory.slice(0, MAX_QUERY_HISTORY);
    if (Array.isArray(store.savedQueries)) this.savedQueries = store.savedQueries.slice(0, 50);
    const old: Partial<DocSaved> =
      store.docs?.find((d) => d.uri === doc.uri) ?? (store.uri === doc.uri ? store : {});
    setLang(config.lang);
    document.documentElement.lang = config.lang === 'zh-cn' ? 'zh-CN' : 'en';
    this.model = model;
    if (!model.loading) model.parseSome(FIRST_SCAN_MS);
    const prev = this.state;
    const last = Math.max(0, model.count - 1);
    const within = (r: number) => Number.isInteger(r) && r >= 0 && (r < model.count || model.loading);
    let expandMode = old.expandMode || prev?.expandMode || config.expandMode;
    // A new file over 50 MB asks again before it expands every line.
    this.bigExpandOK = false;
    if (expandMode === 'all' && !model.keepsAll) expandMode = 'focus';
    this.state = {
      view: old.view || prev?.view || config.defaultView,
      expandMode,
      query: old.query ?? '',
      caseSensitive: !!old.caseSensitive,
      regex: !!old.regex,
      literal: !!old.literal,
      filterOnly: !!old.filterOnly,
      bookmarkedOnly: !!old.bookmarkedOnly && !!(old.bookmarks && old.bookmarks.length),
      bookmarks: new Set((old.bookmarks ?? []).filter(within)),
      unpacked: new Map(),
      multiline: new Map(),
      timelineOpen: false,
      timelineRange: null,
      follow: !!old.follow,
      wrap: old.wrap !== undefined ? old.wrap : config.wrap,
      active: old.active !== undefined ? (model.loading ? old.active : Math.min(old.active, last)) : 0,
      anchor: 0,
      selected: new Set((old.selected ?? []).filter(within)),
      folds: new Map((old.folds ?? []).filter(([r]) => within(r)).map(([r, keys]) => [r, new Set(keys)])),
      foldDepth: old.foldDepth !== undefined ? (old.foldDepth ?? Infinity) : !model.isJsonl && model.bytes > BIG_JSON_BYTES ? 1 : Infinity,
      grid: {
        sort: old.grid?.sort ?? null,
        widths: { ...(old.grid?.widths ?? {}) },
        open: new Set(old.grid?.open ?? []),
        filters: new Map(
          (old.grid?.filters ?? []).map(([c, f]) => [c, { text: f.text, exclude: new Set(f.exclude), min: f.min, max: f.max }]),
        ),
        hiddenCols: new Set(old.grid?.hiddenCols ?? []),
        pinnedCols: new Set(old.grid?.pinnedCols ?? []),
        colOrder: [...(old.grid?.colOrder ?? [])],
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
    this.baseModel = undefined;
    this.transformMode = false;
    this.timelineData = undefined;
    this.pendingOpenRecord = -1;
    this.doc = doc;
    this.config = config;
    this.version = version;
    this.model = undefined as unknown as DocModel;
    this.views = undefined as unknown as Record<ViewKind, View>;
    this.settings = undefined;
    setLang(config.lang);
    this.applyTheme();
    this.loadStore = new ByteStore();
    this.loadRead = 0;
    this.loadMode = doc.isJsonl ? 'jsonl' : 'undecided';
    this.paintBoot();
  }

  private paintBoot(text?: string): void {
    const total = this.doc.large?.bytes ?? 0;
    const msg = text ?? t('Loading {0} of {1}…', formatBytes(Math.min(this.loadRead, total)), formatBytes(total));
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
      if (done) {
        this.loadStore = undefined;
        // Small compressed `.gz` files keep all parsed records in memory once decompressed under 50 MB.
        if (this.doc.large?.gzip) this.model.allowKeepAll();
        this.clampStateToModel();
      }
      const now = performance.now();
      if (done || now - this.lastLoadPaint > 250) {
        this.lastLoadPaint = now;
        // The graph shows the selected lines only: more lines do not change it.
        if (this.state.view !== 'graph') this.activeView.refresh();
        this.paintChrome();
      }
      if (done) {
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
        // Too long for one string. An array (or an object that is mostly one array): its items
        // become records, read when needed. Another shape is parsed from the bytes as a whole.
        const items = store.total >= BYTE_JSON_AT ? indexItems(store) : undefined;
        if (items) model = new DocModel(new ItemStore(store, items), true);
        else model = store.total >= BYTE_JSON_AT ? DocModel.fromValue(parseJsonBytes(store.chunkList()), store.total) : new DocModel(store.takeText(), false, store.total);
      } catch (e) {
        const why = e instanceof ByteJsonError ? t('not valid JSON: {0}', e.message) : errorMessage(e);
        this.paintBoot(t('This file cannot be shown as one JSON value ({0}).', why));
        return;
      }
      if (this.doc.large?.gzip) model.allowKeepAll();
      this.start(model);
    }, 30);
  }

  private clampStateToModel(): void {
    const n = this.model.count;
    const s = this.state;
    const last = Math.max(0, n - 1);
    s.active = Math.min(Math.max(0, s.active), last);
    s.anchor = Math.min(Math.max(0, s.anchor), last);
    for (const r of [...s.selected]) if (r >= n) s.selected.delete(r);
    if (this.model.isJsonl && !s.selected.size && n > 0) s.selected.add(s.active);
    for (const r of [...s.folds.keys()]) if (r >= n) s.folds.delete(r);
    for (const r of [...s.bookmarks]) if (r >= n) s.bookmarks.delete(r);
    if (!s.bookmarks.size) s.bookmarkedOnly = false;
  }

  /**
   * Changes of a JSON Lines document, instead of its whole text. The lines are patched; the
   * result must have the line count and length the host reports, or the whole text is asked for.
   */
  private applyEdit(base: number, version: number, changes: TextChange[], eol: number, lineCount: number, chars: number): void {
    const old = this.model;
    const lines = old && this.views && old.isJsonl && base === this.version ? old.editorLines() : undefined;
    const grown = lines && patchLines(lines, changes, eol);
    if (!lines || !grown || lines.length !== lineCount || this.chars + grown.chars !== chars) {
      this.post({ type: 'resync' });
      return;
    }
    this.chars = chars;
    const endsWithEol = dropLastEmpty(lines);
    const next = new DocModel(lines, true, old.bytes + grown.bytes, endsWithEol);
    next.detectedJsonl = old.detectedJsonl;
    this.swap(next, version);
  }

  /** The document changed: `model` takes the place of the one on screen. */
  private swap(model: DocModel, version: number): void {
    this.version = version;
    const before = this.model.count;
    // Records that did not change keep their parse results, folds and selection.
    const map = model.adopt(this.model);
    this.model = model;
    this.timelineData = undefined;
    model.parseSome(FIRST_SCAN_MS);
    const n = model.count;
    const s = this.state;
    const move = (r: number) => {
      const to = map(r);
      return to >= 0 && to < n ? to : -1;
    };
    const remapMap = <V>(src: Map<number, V>): Map<number, V> => {
      const out = new Map<number, V>();
      for (const [r, v] of src) if (move(r) >= 0) out.set(move(r), v);
      return out;
    };
    s.folds = remapMap(s.folds);
    s.unpacked = remapMap(s.unpacked);
    s.multiline = remapMap(s.multiline);
    const nextBm = new Set<number>();
    for (const r of s.bookmarks) if (move(r) >= 0) nextBm.add(move(r));
    s.bookmarks = nextBm;
    if (!s.bookmarks.size) s.bookmarkedOnly = false;

    if (this.editRecord >= 0) {
      const movedEdit = move(this.editRecord);
      if (movedEdit >= 0) {
        this.editRecord = movedEdit;
        const titleEl = this.root.querySelector('.editpanel .ep-title');
        if (titleEl) titleEl.textContent = t('Edit line {0}', movedEdit + 1);
      }
    }

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
    if (s.expandMode === 'all' && !model.keepsAll && !this.bigExpandOK) s.expandMode = 'focus';
    let painted = false;
    this.startSearch(() => painted && this.repaint());
    this.startBackground();
    this.renderAll();
    painted = true;
    this.postMode();
    if (this.pendingOpenRecord >= 0 && this.pendingOpenRecord < n) {
      const target = this.pendingOpenRecord;
      this.pendingOpenRecord = -1;
      this.selectRecord(target, 'set');
      this.activeView.onActiveChanged(true);
      this.openEditor(target);
    } else if (s.follow && model.isJsonl && n > before) {
      this.jumpToEnd();
    }
  }

  private runOverInputs(
    srcModel: DocModel,
    program: Program,
    finish: (out: number[], tree?: { matches: string[]; capped: boolean }) => void,
  ): void {
    const recordsOf = function* (): Generator<Out> {
      if (!srcModel.isJsonl) {
        const root = srcModel.value(0);
        if (root !== undefined) yield { v: root, p: null };
        return;
      }
      for (let i = 0; i < srcModel.count; i++) {
        const v = srcModel.scanValue(i);
        if (v !== undefined) yield { v, p: { up: null, k: i } };
      }
    };
    const notes: string[] = [];
    const records = new Set<number>();
    const places = new Set<string>();
    try {
      const run = (program.runWith as NonNullable<Program['runWith']>)(null, { [Symbol.iterator]: recordsOf });
      const loose: string[] = [];
      for (const o of run.outs) {
        const path = o.p === undefined ? undefined : pathOf(o.p);
        if (path === undefined || (srcModel.isJsonl && !path.length)) {
          if (loose.length < 3) loose.push(compactJson(o.v).slice(0, 80));
        } else if (srcModel.isJsonl) records.add(path[0] as number);
        else places.add(path.reduce<string>((k, seg) => childKey(k, seg), ''));
      }
      if (run.capped) notes.push(t('The query stopped: too many results'));
      if (loose.length) notes.push(t('Result: {0}', loose.join(', ')));
    } catch (e) {
      notes.push(`jq: ${errorMessage(e)}`);
    }
    finish([...records].sort((a, b) => a - b), srcModel.isJsonl ? undefined : { matches: [...places], capped: false });
    this.queryNotes = notes;
  }

  /** Tells the host what the document is shown as, so both sides read line numbers the same way. */
  private postMode(): void {
    const src = this.baseModel ?? this.model;
    const isJsonl = src.isJsonl;
    if (this.lastMode === isJsonl) return;
    this.lastMode = isJsonl;
    this.post({ type: 'docMode', isJsonl });
  }

  private stopJobs(): void {
    this.stopScan?.();
    this.stopSearch?.();
    this.stopExpand?.();
    this.stopExpand = undefined;
    if (this.exporting) {
      this.post({ type: 'exportData', id: this.exporting.id, data: '', done: false, cancel: true });
      this.exporting = undefined;
    }
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

  /** `notify`: move the text editor cursor too (follow mode does not). */
  selectRecord(r: number, how: 'set' | 'toggle' | 'range' = 'set', notify = true): void {
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
    } else if (s.view === 'grid' && this.model.isJsonl) {
      const order = (this.views.grid as GridView).visibleRecordIds();
      const ia = order.indexOf(s.anchor);
      const ib = order.indexOf(r);
      if (ia >= 0 && ib >= 0) {
        const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
        s.selected = new Set();
        const step = ia <= ib ? 1 : -1;
        for (let k = ia; k >= lo && k <= hi && s.selected.size < MAX_RANGE; k += step) s.selected.add(order[k]);
        this.rangeCapped = hi - lo + 1 > MAX_RANGE;
      } else {
        s.selected = new Set([r]);
        s.anchor = r;
      }
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
    if (notify && this.model.isJsonl && !this.isProjected) this.post({ type: 'select', line: r });
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

  /** Expand all is on. In a file over 50 MB only after the user confirmed it (it parses every record). */
  get expandAll(): boolean {
    return this.state.expandMode === 'all' && (this.model.keepsAll || this.bigExpandOK);
  }

  setExpandMode(m: ExpandMode): void {
    if (this.state.expandMode === m) return;
    if (m === 'focus') {
      if (this.stopExpand) {
        this.stopExpand();
        this.stopExpand = undefined;
        this.bigExpandOK = false;
      }
    }
    if (m === 'all' && !this.model.keepsAll && !this.bigExpandOK) {
      // Every record is parsed and measured, and the row heights of all of them are kept.
      this.showBanner(t('This file is {0}. Expand all parses every line: it can take a while and use a lot of memory.', formatBytes(this.model.bytes)), undefined, [
        {
          label: t('Expand all'),
          run: () => {
            this.bigExpandOK = true;
            this.showBanner(t('Expanding all lines…'));
            this.stopExpand?.();
            this.stopExpand = (this.views.formatted as FormattedView).prepareExpandAll(
              (pct) => this.showBanner(t('Expanding all lines… {0}%', pct)),
              () => {
                this.stopExpand = undefined;
                if (!this.model.keepsAll && this.bigExpandOK) {
                  this.setExpandMode('all');
                  this.banner.hidden = true;
                }
              },
            );
          },
        },
        {
          label: t('Cancel'),
          run: () => {
            this.bigExpandOK = false;
          },
        },
      ]);
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
      this.showBanner(
        this.isProjected
          ? t('Exit transform')
          : this.model.items
            ? t('This file is read-only here: open it as text to edit it.')
            : t('This file is read-only here: it is not on this computer.'),
      );
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
    const panel = this.root.querySelector('.editpanel') as HTMLElement | null;
    if (panel) panel.hidden = true;
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
    this.post({ type: 'editLine', line: this.editRecord, original: this.editOriginal, text: ta.value, cell: false });
  }

  private onEditResult(ok: boolean, message?: string, line?: number, text?: string, cell?: boolean, batch?: boolean): void {
    // A large file: the host wrote the line on disk; the view shows it at once.
    if (ok && line !== undefined && text !== undefined && this.model?.large && line < this.model.count) {
      this.model.replaceLine(line, text);
      this.timelineData = undefined;
      this.startSearch(() => this.repaint());
      this.startBackground();
      this.activeView.refresh();
      this.paintChrome();
      this.stateChanged();
    }
    if (batch) {
      if (ok) this.closeBatchPanel();
      else {
        const berr = this.root.querySelector('.batchpanel .ep-err') as HTMLElement | null;
        if (berr && !berr.closest('[hidden]')) berr.textContent = message ?? t('The edit failed.');
        else this.showBanner(message ?? t('The edit failed.'));
      }
      return;
    }
    const isCell = cell !== undefined ? cell : this.cellPending;
    if (isCell) {
      this.cellPending = false;
      if (!ok) this.showBanner(message ?? t('The edit failed.'));
      return;
    }
    if (ok) {
      this.closeEditor();
      return;
    }
    const err = this.root.querySelector('.editpanel .ep-err') as HTMLElement | null;
    if (err) err.textContent = message ?? t('The edit failed.');
  }

  /** Grid cells can be edited: JSON Lines that can be written, or one JSON document of normal size. */
  get canEditCells(): boolean {
    return !this.readOnly && (this.model.isJsonl || !this.doc.large);
  }

  /**
   * Writes one cell. JSON Lines: only the text of that value changes in its line (the rest of
   * the line stays as it is). One JSON document: the host replaces the value at its path.
   */
  editCell(record: number, path: (string | number)[], json: string): void {
    const m = this.model;
    this.cellPending = true;
    if (!m.isJsonl) {
      this.post({ type: 'editValue', path, version: this.version, text: json, cell: true });
      return;
    }
    const line = m.line(record);
    const span = valueSpan(line, path);
    if (!span) {
      this.cellPending = false;
      this.showBanner(t('The value is no longer in line {0}.', record + 1));
      return;
    }
    const text = line.slice(0, span.offset) + json + line.slice(span.offset + span.length);
    this.post({ type: 'editLine', line: record, original: line, text, exact: true, cell: true });
  }

  /** Inserts a new property on an object row when editing a missing cell in the Grid. */
  insertMissingCell(record: number, fullPath: (string | number)[], key: string, jsonVal: string): void {
    const m = this.model;
    this.cellPending = true;
    if (!m.isJsonl) {
      this.post({ type: 'editValue', path: fullPath, version: this.version, text: jsonVal, cell: true });
      return;
    }
    const line = m.line(record);
    const v = m.value(record);
    const span = valueSpan(line, []);
    if (!span || v === undefined || !isObj(v)) {
      this.cellPending = false;
      this.showBanner(t('The value is no longer in line {0}.', record + 1));
      return;
    }
    const closeBrace = span.offset + span.length - 1;
    const hasKeys = Object.keys(v).length > 0;
    const insertion = `${hasKeys ? ',' : ''}${JSON.stringify(key)}:${jsonVal}`;
    const text = line.slice(0, closeBrace) + insertion + line.slice(closeBrace);
    this.post({ type: 'editLine', line: record, original: line, text, exact: true, cell: true });
  }

  // ---------- row mutations & batch jq rewrite ----------

  private insertLineBelow(r: number): void {
    if (this.readOnly || !this.model.isJsonl) return;
    this.pendingOpenRecord = r + 1;
    this.post({ type: 'mutateLines', version: this.version, mutation: { op: 'insert', after: r, text: '{}' } });
  }

  private duplicateLine(r: number): void {
    if (this.readOnly || !this.model.isJsonl) return;
    this.post({ type: 'mutateLines', version: this.version, mutation: { op: 'insert', after: r, text: this.model.line(r) } });
  }

  private deleteLines(targetRecord: number): void {
    if (this.readOnly || !this.model.isJsonl) return;
    const lines = this.state.selected.has(targetRecord) && this.state.selected.size > 1
      ? [...this.state.selected].sort((a, b) => a - b)
      : [targetRecord];
    this.post({ type: 'mutateLines', version: this.version, mutation: { op: 'delete', lines } });
  }

  private openBatchRewrite(): void {
    if (this.readOnly || !this.model.isJsonl) return;
    const panel = this.root.querySelector('.batchpanel') as HTMLElement;
    const hasFilter = !!this.query.text || this.hasGlobalRowFilter();
    let previewEdits: { line: number; original: string; text: string }[] = [];
    panel.innerHTML = `
      <div class="ep-head"><span class="ep-title">${icon('wand', 14)} ${esc(t('Batch jq rewrite'))}</span><span class="ep-err" role="alert"></span></div>
      <div class="batch-bar">
        <input type="text" class="batch-expr mono" spellcheck="false" placeholder="${esc(t('jq expression (for example: .level |= ascii_upcase or del(.debug))'))}" aria-label="${esc(t('Batch jq rewrite'))}">
        ${hasFilter ? `<label class="batch-scope"><input type="checkbox" data-bscope checked> ${esc(t('Show only matching lines'))}</label>` : ''}
        <button class="btn batch-prev">${esc(t('Preview'))}</button>
      </div>
      <div class="cmp-scroll batch-diff" hidden></div>
      <div class="ep-actions">
        <button class="btn primary batch-apply" disabled>${esc(t('Apply'))}</button>
        <button class="btn batch-close">${esc(t('Cancel'))} <kbd>Esc</kbd></button>
        <span class="ep-hint batch-summary"></span>
      </div>`;
    panel.hidden = false;
    const exprInput = panel.querySelector('.batch-expr') as HTMLInputElement;
    const errEl = panel.querySelector('.ep-err') as HTMLElement;
    const diffEl = panel.querySelector('.batch-diff') as HTMLElement;
    const applyBtn = panel.querySelector('.batch-apply') as HTMLButtonElement;
    const sumEl = panel.querySelector('.batch-summary') as HTMLElement;

    const runPreview = () => {
      errEl.textContent = '';
      previewEdits = [];
      const expr = exprInput.value.trim();
      if (!expr) {
        applyBtn.disabled = true;
        diffEl.hidden = true;
        sumEl.textContent = '';
        return;
      }
      const c = compileQuery(expr, this.jqModules, true);
      if (c.needs?.length) {
        const ask = c.needs.filter((k) => !this.modulesAsked.has(k));
        ask.forEach((k) => this.modulesAsked.add(k));
        if (ask.length) this.post({ type: 'readModules', keys: ask });
        errEl.textContent = t('jq: reading modules {0}…', c.needs.join(', '));
        return;
      }
      if (!c.program || c.error) {
        errEl.textContent = c.error ?? 'Invalid jq expression';
        applyBtn.disabled = true;
        return;
      }
      const onlyMatches = !!(panel.querySelector('[data-bscope]') as HTMLInputElement | null)?.checked;
      const targetIds = onlyMatches
        ? (this.query.text ? this.matches : Array.from({ length: this.model.count }, (_, i) => i)).filter((i) => !this.hasGlobalRowFilter() || this.passesGlobalRowFilter(i))
        : Array.from({ length: this.model.count }, (_, i) => i);
      const samples: [number, string, string][] = [];
      let checked = 0;
      for (const i of targetIds) {
        if (this.model.isBlank(i)) continue;
        const v = this.model.scanValue(i);
        if (v === undefined) continue;
        checked++;
        try {
          const res = c.program.run(v);
          if (!res.outs.length) continue;
          const nextText = compactJson(res.outs[0].v);
          const oldText = this.model.line(i);
          if (nextText !== oldText && nextText !== compactJson(v)) {
            previewEdits.push({ line: i, original: oldText, text: nextText });
            if (samples.length < 25) samples.push([i, oldText, nextText]);
          } else if (nextText !== oldText && expr === '.') {
            previewEdits.push({ line: i, original: oldText, text: nextText });
            if (samples.length < 25) samples.push([i, oldText, nextText]);
          }
        } catch (e) {
          errEl.textContent = `Line ${i + 1}: ${errorMessage(e)}`;
          return;
        }
      }
      if (!previewEdits.length) {
        sumEl.textContent = t('No lines changed.');
        applyBtn.disabled = true;
        diffEl.hidden = true;
        return;
      }
      sumEl.textContent = t('{0} of {1} lines will change.', previewEdits.length.toLocaleString(), checked.toLocaleString());
      applyBtn.textContent = t('Rewrite {0} lines', previewEdits.length.toLocaleString());
      applyBtn.disabled = false;
      diffEl.innerHTML = `<table class="cmp"><tr><th>#</th><th>${esc(t('Before'))}</th><th>${esc(t('After'))}</th></tr>${samples
        .map(([ln, bef, aft]) => `<tr class="cmp-changed"><td class="num dim">${ln + 1}</td><td class="mono">${esc(bef.slice(0, 240))}</td><td class="mono">${esc(aft.slice(0, 240))}</td></tr>`)
        .join('')}</table>`;
      diffEl.hidden = false;
    };

    panel.querySelector('.batch-prev')!.addEventListener('click', runPreview);
    exprInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !applyBtn.disabled) {
        e.preventDefault();
        applyBtn.click();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        runPreview();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.closeBatchPanel();
      }
      e.stopPropagation();
    });
    applyBtn.addEventListener('click', () => {
      if (!previewEdits.length) return;
      applyBtn.disabled = true;
      errEl.textContent = t('Saving…');
      this.post({ type: 'mutateLines', version: this.version, mutation: { op: 'rewrite', edits: previewEdits } });
    });
    panel.querySelector('.batch-close')!.addEventListener('click', () => this.closeBatchPanel());
    exprInput.focus();
  }

  private closeBatchPanel(): void {
    const panel = this.root.querySelector('.batchpanel') as HTMLElement | null;
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = '';
    }
  }

  // ---------- value inspector & schema generator & context menu ----------

  openValueInspector(r: number, path: (string | number)[], explicitVal?: JVal): void {
    const rootVal = this.model.value(this.model.isJsonl ? r : 0);
    const val = explicitVal !== undefined ? explicitVal : rootVal !== undefined ? getAt(rootVal, path) : undefined;
    const panel = this.root.querySelector('.valpanel') as HTMLElement;
    if (val === undefined) {
      const rawLine = this.model.isJsonl && r < this.model.count ? this.model.line(r) : '';
      if (!rawLine) return;
      panel.innerHTML = `
        <div class="ep-head"><span class="ep-title">${esc(t('Value inspector'))}</span><span class="dim">${esc(t('Line {0}', r + 1))}</span></div>
        <pre class="val-body mono" tabindex="0">${esc(rawLine)}</pre>
        <div class="ep-actions"><button class="btn primary vp-copy">${esc(t('Copy'))}</button><button class="btn vp-close">${esc(t('Close'))} <kbd>Esc</kbd></button></div>`;
      panel.hidden = false;
      panel.querySelector('.vp-copy')!.addEventListener('click', () => this.post({ type: 'copy', text: rawLine }));
      panel.querySelector('.vp-close')!.addEventListener('click', () => this.closeValueInspector());
      (panel.querySelector('.vp-close') as HTMLElement).focus();
      return;
    }

    let prevMs: number | undefined;
    if (this.model.isJsonl && r > 0) prevMs = extractRecordEpochMs(this.model.value(r - 1));
    const decoded = decodeSmartValue(val, prevMs);
    const unpackedJson = typeof val === 'string' ? tryUnpackJsonString(val) : undefined;
    const isStr = typeof val === 'string';
    const hasJsonTab = isContainer(val) || unpackedJson !== undefined;
    const tabs: { id: string; label: string }[] = [{ id: 'text', label: t('Text') }];
    if (isStr) tabs.push({ id: 'md', label: t('Markdown') });
    if (hasJsonTab) tabs.push({ id: 'json', label: t('JSON') });
    if (decoded.length) tabs.push({ id: 'dec', label: t('Decoded') });

    let activeTab = decoded.length ? 'dec' : unpackedJson !== undefined ? 'json' : isStr && (val.includes('\n#') || val.includes('```') || val.includes('**')) ? 'md' : 'text';
    const pathStr = pathToString(path);
    const pathKey = path.reduce<string>((acc, seg) => childKey(acc, seg), '');
    const canToggleUnpack = isStr && unpackedJson !== undefined && isContainer(unpackedJson) && (this.state.view === 'formatted' || this.state.view === 'grid');

    const renderDecodedCards = (items: DecodedInfo[]): string =>
      items
        .map((d) => {
          if (d.kind === 'timestamp') {
            return `<div class="dec-card">
              <div class="dec-head">${esc(t(d.sourceKind === 'unix' ? 'Unix timestamp' : 'ISO timestamp'))}</div>
              <div class="dec-grid">
                <span class="dim">${esc(t('Local time'))}</span><span class="mono">${esc(d.local)}</span>
                <span class="dim">${esc(t('UTC time'))}</span><span class="mono">${esc(d.utc)}</span>
                <span class="dim">Epoch (ms)</span><span class="mono">${d.epochMs}</span>
                ${d.delta ? `<span class="dim">${esc(t('Delta from previous'))}</span><span class="mono">${esc(d.delta)}</span>` : ''}
              </div>
            </div>`;
          }
          if (d.kind === 'jwt') {
            const statusText = d.status ? t(d.expired ? 'Expired ({0})' : 'Valid until {0}', d.status) : '';
            return `<div class="dec-card">
              <div class="dec-head">${esc(t('JWT token'))} ${statusText ? `<span class="badge ${d.expired ? 'bad' : ''}">${esc(statusText)}</span>` : ''}</div>
              <div class="insp-label">${esc(t('Header'))}</div>
              <pre class="dec-pre mono">${esc(stringifyPretty(d.header, 2, 50_000))}</pre>
              <div class="insp-label">${esc(t('Payload'))}</div>
              <pre class="dec-pre mono">${esc(stringifyPretty(d.payload, 2, 100_000))}</pre>
            </div>`;
          }
          if (d.kind === 'base64') {
            return `<div class="dec-card">
              <div class="dec-head">${esc(t('Base64 decoded'))}</div>
              <pre class="dec-pre mono">${esc(d.json !== undefined ? stringifyPretty(d.json, 2, 200_000) : d.text)}</pre>
            </div>`;
          }
          return `<div class="dec-card">
            <div class="dec-head">${esc(t('URL decoded'))}</div>
            <pre class="dec-pre mono">${esc(d.decoded)}</pre>
            ${
              d.params.length
                ? `<div class="insp-label">${esc(t('Query parameters'))}</div><table class="cmp">${d.params
                    .map(([k, pv]) => `<tr><td class="mono tk">${esc(k)}</td><td class="mono">${esc(pv)}</td></tr>`)
                    .join('')}</table>`
                : ''
            }
          </div>`;
        })
        .join('');

    const paintBody = () => {
      panel.querySelectorAll<HTMLButtonElement>('[data-vtab]').forEach((b) => {
        const on = b.dataset.vtab === activeTab;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      });
      const host = panel.querySelector('.vp-host') as HTMLElement;
      if (activeTab === 'md' && isStr) {
        host.innerHTML = `<div class="val-body md-body" tabindex="0">${renderMarkdownSafe(val)}</div>`;
      } else if (activeTab === 'json') {
        const target = unpackedJson !== undefined ? unpackedJson : val;
        host.innerHTML = `<pre class="val-body mono" tabindex="0">${esc(stringifyPretty(target, this.config.indent, 2_000_000))}</pre>`;
      } else if (activeTab === 'dec') {
        host.innerHTML = `<div class="val-body dec-list" tabindex="0">${renderDecodedCards(decoded)}</div>`;
      } else {
        const txt = isStr ? val : stringifyPretty(val, this.config.indent, 2_000_000);
        host.innerHTML = `<pre class="val-body mono" tabindex="0">${esc(txt)}</pre>`;
      }
    };

    const where = this.model.isJsonl ? `${t('Line {0}', r + 1)} · ` : '';
    panel.innerHTML = `
      <div class="ep-head">
        <span class="ep-title">${icon('inspect', 14)} ${esc(t('Value inspector'))}</span>
        <span class="dim mono">${esc(where + pathStr)}</span>
        <div class="spring"></div>
        ${
          tabs.length > 1
            ? `<div class="seg" role="tablist">${tabs
                .map((tb) => `<button role="tab" class="seg-btn sub" data-vtab="${tb.id}">${esc(tb.label)}</button>`)
                .join('')}</div>`
            : ''
        }
      </div>
      <div class="vp-host"></div>
      <div class="ep-actions">
        <button class="btn primary vp-copy">${icon('copy', 12)}${esc(t('Copy'))}</button>
        ${canToggleUnpack ? `<button class="btn vp-unpack">${esc(t(this.unpackedOf(r).has(pathKey) ? 'Fold unpacked JSON' : 'Unpack JSON'))}</button>` : ''}
        <button class="btn vp-close">${esc(t('Close'))} <kbd>Esc</kbd></button>
      </div>`;
    panel.hidden = false;
    paintBody();

    panel.onclick = (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;
      if (btn.dataset.vtab) {
        activeTab = btn.dataset.vtab;
        paintBody();
      } else if (btn.classList.contains('vp-copy')) {
        const copyText =
          activeTab === 'json' && unpackedJson !== undefined
            ? stringifyPretty(unpackedJson, this.config.indent, 5_000_000)
            : isStr
              ? val
              : stringifyPretty(val, this.config.indent, 5_000_000);
        this.post({ type: 'copy', text: copyText });
      } else if (btn.classList.contains('vp-unpack')) {
        this.toggleUnpack(r, pathKey);
        if (this.state.view === 'grid') this.activeView.render();
        this.closeValueInspector();
      } else if (btn.classList.contains('vp-close')) {
        this.closeValueInspector();
      }
    };
    (panel.querySelector('.vp-close') as HTMLElement).focus();
  }

  private closeValueInspector(): void {
    const panel = this.root.querySelector('.valpanel') as HTMLElement | null;
    if (panel) {
      panel.onclick = null;
      panel.hidden = true;
      panel.innerHTML = '';
    }
  }

  private openSchemaGenerator(): void {
    const m = this.model;
    const recordsIter = (function* (app: App): Generator<JVal> {
      if (!m.isJsonl) {
        const root = m.value(0);
        if (root === undefined) return;
        if (isArr(root) && root.length > 0) {
          for (const item of root) yield item;
        } else {
          yield root;
        }
        return;
      }
      const ids =
        app.state.view === 'grid'
          ? (app.views.grid as GridView).visibleRecordIds()
          : app.query.text
            ? app.matches
            : Array.from({ length: m.count }, (_, i) => i);
      for (const id of ids) {
        if (m.isBlank(id)) continue;
        const v = m.scanValue(id);
        if (v !== undefined) yield v;
      }
    })(this);

    const { schema, sampled } = inferSchema(recordsIter);
    const stem = this.doc.fileName.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
    const typeName = stem.replace(/[^A-Za-z0-9]+/g, ' ').trim().split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : '')).join('') || 'RecordItem';
    const safeRoot = /^[0-9]/.test(typeName) ? `T${typeName}` : typeName;

    type TabKind = 'ts' | 'jsonschema' | 'pydantic' | 'zod';
    let curTab: TabKind = 'ts';
    const renderCode = (kind: TabKind): { code: string; format: ExportAssetFormat; suffix: string } => {
      switch (kind) {
        case 'ts':
          return { code: emitTypeScript(schema, safeRoot), format: 'ts', suffix: '.d.ts' };
        case 'jsonschema':
          return { code: emitJsonSchema(schema, safeRoot), format: 'json', suffix: '.schema.json' };
        case 'pydantic':
          return { code: emitPydantic(schema, safeRoot), format: 'py', suffix: '_models.py' };
        case 'zod':
          return { code: emitZod(schema, `${safeRoot}Schema`), format: 'ts', suffix: '.zod.ts' };
      }
    };

    const panel = this.root.querySelector('.schemapanel') as HTMLElement;
    panel.innerHTML = `
      <div class="ep-head">
        <span class="ep-title">${icon('schema', 14)} ${esc(t('Schema & Types'))}</span>
        <span class="dim">${esc(t('Inferred from {0} records', sampled.toLocaleString()))}</span>
        <div class="spring"></div>
        <div class="seg" role="tablist">
          <button role="tab" class="seg-btn sub on" data-stab="ts">TypeScript</button>
          <button role="tab" class="seg-btn sub" data-stab="jsonschema">JSON Schema</button>
          <button role="tab" class="seg-btn sub" data-stab="pydantic">Pydantic</button>
          <button role="tab" class="seg-btn sub" data-stab="zod">Zod</button>
        </div>
      </div>
      <pre class="val-body mono sp-code" tabindex="0"></pre>
      <div class="ep-actions">
        <button class="btn primary sp-copy">${icon('copy', 12)}${esc(t('Copy'))}</button>
        <button class="btn sp-save">${icon('download', 12)}${esc(t('Save file…'))}</button>
        <button class="btn sp-close">${esc(t('Close'))} <kbd>Esc</kbd></button>
      </div>`;
    panel.hidden = false;
    const codeEl = panel.querySelector('.sp-code') as HTMLElement;
    const paint = () => {
      panel.querySelectorAll<HTMLButtonElement>('[data-stab]').forEach((b) => {
        const on = b.dataset.stab === curTab;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
      });
      codeEl.textContent = renderCode(curTab).code;
    };
    paint();

    panel.onclick = (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;
      if (btn.dataset.stab) {
        curTab = btn.dataset.stab as TabKind;
        paint();
      } else if (btn.classList.contains('sp-copy')) {
        this.post({ type: 'copy', text: renderCode(curTab).code });
      } else if (btn.classList.contains('sp-save')) {
        const { code, format } = renderCode(curTab);
        const suffix = curTab === 'jsonschema' ? `${stem}.schema` : curTab === 'zod' ? `${stem}.zod` : `${stem}.types`;
        this.post({ type: 'export', format, data: code, name: suffix });
      } else if (btn.classList.contains('sp-close')) {
        this.closeSchemaPanel();
      }
    };
    (panel.querySelector('.sp-close') as HTMLElement).focus();
  }

  private closeSchemaPanel(): void {
    const panel = this.root.querySelector('.schemapanel') as HTMLElement | null;
    if (panel) {
      panel.onclick = null;
      panel.hidden = true;
      panel.innerHTML = '';
    }
  }

  openContextMenu(
    e: MouseEvent,
    ctx: { record: number; path: (string | number)[]; value?: JVal; hasValue: boolean },
  ): void {
    const menu = this.root.querySelector('.ctx-menu') as HTMLElement;
    const m = this.model;
    const items: { id: string; label: string; sepBefore?: boolean }[] = [];
    const pathKey = ctx.path.reduce<string>((acc, seg) => childKey(acc, seg), '');
    const unpackable = typeof ctx.value === 'string' && ctx.value.length <= 262_144 && tryUnpackJsonString(ctx.value) !== undefined;
    const alreadyUnpacked = this.unpackedOf(ctx.record).has(pathKey);

    if (ctx.hasValue || (m.isJsonl && ctx.record < m.count)) {
      items.push({ id: 'inspect', label: t('Inspect value') });
    }
    if ((unpackable || alreadyUnpacked) && (this.state.view === 'formatted' || this.state.view === 'grid')) {
      items.push({ id: 'unpack', label: t(alreadyUnpacked ? 'Fold unpacked JSON' : 'Unpack JSON') });
    }
    if (ctx.hasValue && ctx.value !== undefined) {
      items.push({ id: 'copy-raw', label: t('Copy raw value') });
      items.push({ id: 'copy-json', label: t('Copy as JSON') });
    } else if (m.isJsonl && ctx.record < m.count) {
      items.push({ id: 'copy-line', label: t('Copy the raw line') });
    }
    if (ctx.path.length > 0) {
      items.push({ id: 'copy-jpath', label: t('Copy JSONPath'), sepBefore: true });
      items.push({ id: 'copy-jq', label: t('Copy jq path') });
      if (m.isJsonl && ctx.hasValue && ctx.value !== undefined && !isContainer(ctx.value)) {
        const jqP = pathToJq(ctx.path);
        items.push({ id: 'filter-eq', label: t('Filter: {0} = value', jqP) });
        items.push({ id: 'filter-neq', label: t('Filter: {0} != value', jqP) });
      }
    }
    if (m.isJsonl && !this.isProjected && ctx.record < m.count) {
      items.push({ id: 'bookmark', label: t('Toggle bookmark (B)'), sepBefore: true });
      if (!this.readOnly) {
        items.push({ id: 'edit', label: t('Edit record') });
        items.push({ id: 'insert', label: t('Insert line below') });
        items.push({ id: 'dup', label: t('Duplicate line') });
        const delCount = this.state.selected.has(ctx.record) && this.state.selected.size > 1 ? this.state.selected.size : 1;
        items.push({
          id: 'del',
          label: delCount > 1 ? t('Delete {0} selected lines', delCount.toLocaleString()) : t('Delete line'),
        });
      }
    }
    if (this.canRevealSource && ctx.record < m.count) {
      items.push({ id: 'reveal', label: t('Reveal in editor'), sepBefore: true });
    }
    if (!items.length) return;

    menu.innerHTML = items
      .map(
        (it) =>
          `${it.sepBefore ? '<div class="menu-sep" role="separator"></div>' : ''}<button class="menu-item" role="menuitem" data-ctx="${it.id}">${esc(it.label)}</button>`,
      )
      .join('');
    menu.hidden = false;
    const hostRect = this.root.getBoundingClientRect();
    const mw = menu.offsetWidth || 240;
    const mh = menu.offsetHeight || 220;
    const left = Math.max(4, Math.min(e.clientX - hostRect.left, hostRect.width - mw - 4));
    const top = Math.max(4, Math.min(e.clientY - hostRect.top, hostRect.height - mh - 4));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.right = 'auto';

    menu.onclick = (ev) => {
      const b = (ev.target as HTMLElement).closest('[data-ctx]') as HTMLElement | null;
      if (!b) return;
      menu.hidden = true;
      const action = b.dataset.ctx;
      const v = ctx.value;
      switch (action) {
        case 'inspect':
          this.openValueInspector(ctx.record, ctx.path, v);
          break;
        case 'unpack':
          this.toggleUnpack(ctx.record, pathKey);
          if (this.state.view === 'grid') this.activeView.render();
          break;
        case 'copy-raw':
          if (v !== undefined) this.post({ type: 'copy', text: typeof v === 'string' ? v : v instanceof RawNum ? v.src : compactJson(v) });
          break;
        case 'copy-json':
          if (v !== undefined) this.post({ type: 'copy', text: stringifyPretty(v, this.config.indent, 5_000_000) });
          break;
        case 'copy-line':
          this.post({ type: 'copy', text: m.line(ctx.record) });
          break;
        case 'copy-jpath':
          this.post({ type: 'copy', text: pathToString(ctx.path) });
          break;
        case 'copy-jq':
          this.post({ type: 'copy', text: pathToJq(ctx.path) });
          break;
        case 'filter-eq':
        case 'filter-neq':
          if (v !== undefined) {
            const op = action === 'filter-eq' ? '==' : '!=';
            const rhs = v instanceof RawNum ? v.src : JSON.stringify(v);
            this.applyQueryFromUI(`${pathToJq(ctx.path)} ${op} ${rhs}`, true);
          }
          break;
        case 'bookmark':
          this.toggleBookmark(ctx.record);
          break;
        case 'edit':
          this.openEditor(ctx.record);
          break;
        case 'insert':
          this.insertLineBelow(ctx.record);
          break;
        case 'dup':
          this.duplicateLine(ctx.record);
          break;
        case 'del':
          this.deleteLines(ctx.record);
          break;
        case 'reveal':
          this.reveal(ctx.record, ctx.path);
          break;
      }
    };
    (menu.querySelector('button') as HTMLElement | null)?.focus();
  }

  // ---------- timeline ----------

  private ensureTimelineData(): TimelineData | undefined {
    const m = this.model;
    if (this.timelineModelRef === m && this.timelineModelRev === m.revision && this.timelineData) return this.timelineData;
    const col = detectTimeColumn(m);
    if (!col) {
      this.timelineData = undefined;
      return undefined;
    }
    this.timelineModelRef = m;
    this.timelineModelRev = m.revision;
    this.timelineData = buildTimeline(m, col);
    return this.timelineData;
  }

  private paintTimeline(): void {
    if (!this.timelineEl) return;
    if (!this.state.timelineOpen && !this.state.timelineRange) {
      this.timelineEl.hidden = true;
      return;
    }
    const td = this.ensureTimelineData();
    if (!td) {
      this.timelineEl.hidden = true;
      return;
    }
    this.timelineEl.hidden = false;
    this.timelineEl.innerHTML = renderTimelineHtml(td, this.state.timelineRange);
  }

  // ---------- follow ----------

  private setFollow(on: boolean): void {
    this.state.follow = on;
    if (this.doc.large) this.post({ type: 'follow', on });
    if (on) this.jumpToEnd();
    this.paintChrome();
    this.stateChanged();
  }

  /** Follow mode: the last record becomes the current one. */
  private jumpToEnd(): void {
    const m = this.model;
    let r = m.count - 1;
    while (r > 0 && m.isBlank(r)) r--;
    if (r < 0) return;
    if (this.state.active !== r || this.state.selected.size !== 1) this.selectRecord(r, 'set', false);
    this.activeView.onActiveChanged(true);
  }

  /** A large file grew: its new bytes. */
  private onAppend(version: number, data: Uint8Array): void {
    const m = this.baseModel ?? this.model;
    if (!m || !this.views || !m.large || version !== this.version) return;
    if (this.baseModel) {
      this.model = this.baseModel;
      this.baseModel = undefined;
    }
    const before = m.count;
    m.append(data);
    this.timelineData = undefined;
    this.startSearch(() => this.repaint());
    this.startBackground();
    if (this.state.follow && this.model.count > before) this.jumpToEnd();
    if (this.state.view !== 'graph') this.activeView.refresh();
    this.paintChrome();
    this.stateChanged();
  }

  // ---------- export ----------

  /** Streams rows to the host as JSON Lines, CSV, JSON Array, or Markdown Table. */
  private exportRows(which: 'rows' | 'selected', format: ExportRowFormat): void {
    const m = this.model;
    let ids: number[];
    let header: string[];
    let line: (id: number) => string;
    let cells: (id: number) => string[];
    if (this.state.view === 'grid') {
      const src = (this.views.grid as GridView).exportSource();
      header = src.header;
      line = src.line;
      cells = src.cells;
      if (which === 'selected') {
        const visibleSel = src.ids.filter((id) => this.state.selected.has(id));
        ids = visibleSel.length ? visibleSel : [...this.state.selected].filter((id) => id < m.count && !m.isBlank(id)).sort((a, b) => a - b);
      } else {
        ids = src.ids;
      }
    } else if (!m.isJsonl) {
      const root = m.value(0);
      const items = root !== undefined && isArr(root) ? root : root !== undefined ? [root] : [];
      ids = items.map((_, idx) => idx);
      const colSet = new Set<string>();
      let nonObj = false;
      for (const it of items) {
        if (!isObj(it)) nonObj = true;
        else for (const k in it) colSet.add(k);
      }
      const cols = [...(nonObj || !colSet.size ? ['(value)'] : []), ...colSet];
      header = cols;
      line = (idx) => compactJson(items[idx]);
      cells = (idx) => {
        const v = items[idx];
        return cols.map((c, k) => {
          if (c === '(value)' && k === 0 && (nonObj || !colSet.size)) return isObj(v) ? '' : cellString(v);
          return isObj(v) && Object.prototype.hasOwnProperty.call(v, c) ? cellString((v as JObj)[c]) : '';
        });
      };
    } else {
      const all =
        which === 'selected'
          ? [...this.state.selected].sort((a, b) => a - b)
          : this.query.text
            ? this.matches.filter((i) => !this.hasGlobalRowFilter() || this.passesGlobalRowFilter(i))
            : Array.from({ length: m.count }, (_, i) => i).filter((i) => !this.hasGlobalRowFilter() || this.passesGlobalRowFilter(i));
      ids = all.filter((i) => i < m.count && !m.isBlank(i));
      const cols = [...(m.hasNonObject ? ['(value)'] : []), ...m.columns];
      header = cols;
      line = (id) => m.line(id);
      cells = (id) => {
        const v = m.scanValue(id);
        return cols.map((c, k) => {
          if (v === undefined) return k === 0 ? m.line(id) : '';
          if (c === '(value)' && k === 0 && m.hasNonObject) return isObj(v) ? '' : cellString(v);
          return isObj(v) && Object.prototype.hasOwnProperty.call(v, c) ? cellString(v[c]) : '';
        });
      };
    }
    const safeHeader = header.length ? header : ['(value)'];
    let i = 0;
    let first = true;
    const id = this.nextExport++;
    const next = (): string | null => {
      if (i >= ids.length && !first) return null;
      if (format === 'json') {
        if (ids.length === 0) {
          first = false;
          return '[]\n';
        }
        const chunks: string[] = [];
        let size = 0;
        for (; i < ids.length && size < EXPORT_PIECE; i++) {
          const raw = line(ids[i]).trim();
          const validItem = tryParse(raw).kind === 'value' ? raw : JSON.stringify(raw);
          const prefix = first ? '[\n  ' : ',\n  ';
          first = false;
          const tail = i === ids.length - 1 ? '\n]\n' : '';
          const piece = prefix + validItem + tail;
          chunks.push(piece);
          size += piece.length;
        }
        return chunks.join('');
      }
      const parts: string[] = [];
      let size = 0;
      if (first) {
        first = false;
        if (format === 'csv') parts.push('\ufeff' + csvRow(safeHeader));
        else if (format === 'md') parts.push(mdRow(safeHeader), mdDivider(safeHeader.length));
      }
      for (; i < ids.length && size < EXPORT_PIECE; i++) {
        const rowCells = format === 'csv' || format === 'md' ? cells(ids[i]) : [];
        const padded = rowCells.length ? rowCells : [line(ids[i])];
        const row = format === 'csv' ? csvRow(padded) : format === 'md' ? mdRow(padded) : line(ids[i]);
        parts.push(row);
        size += row.length + 1;
      }
      return parts.length ? parts.join('\n') + '\n' : '';
    };
    this.exporting = { id, next };
    const base = this.doc.fileName.replace(/\.gz$/i, '').replace(/\.[^.]+$/, '');
    this.post({ type: 'exportStart', id, format, name: `${base}-${which === 'selected' ? 'selected' : 'rows'}`, rows: ids.length });
    this.showBanner(t('Exporting {0} rows…', ids.length.toLocaleString()));
  }

  /** The host is ready for the next piece of the export (or the user cancelled the save dialog). */
  private onExportReady(id: number, ok: boolean): void {
    const e = this.exporting;
    if (!e || e.id !== id) return;
    if (!ok) {
      this.exporting = undefined;
      this.banner.hidden = true;
      return;
    }
    const piece = e.next();
    this.post({ type: 'exportData', id, data: piece ?? '', done: piece === null });
  }

  private placeMenuBelow(btn: HTMLElement, menu: HTMLElement): void {
    const hostRect = this.root.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    const mw = menu.offsetWidth || 260;
    const left = Math.max(4, Math.min(r.right - hostRect.left - mw, hostRect.width - mw - 4));
    const top = Math.max(4, r.bottom - hostRect.top + 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.right = 'auto';
  }

  private toggleExportMenu(): void {
    const menu = this.root.querySelector('.export-menu') as HTMLElement;
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    const m = this.model;
    const grid = this.state.view === 'grid';
    const rows = grid
      ? (this.views.grid as GridView).exportSource().ids.length
      : !m.isJsonl
        ? m.value(0) !== undefined && isArr(m.value(0) as JVal)
          ? (m.value(0) as JVal[]).length
          : m.valid
        : this.query.text
          ? this.matches.filter((i) => !this.hasGlobalRowFilter() || this.passesGlobalRowFilter(i)).length
          : this.hasGlobalRowFilter()
            ? (this.formattedRecords()?.length ?? 0)
            : m.count - m.blank;
    const sel = m.isJsonl ? [...this.state.selected].filter((r) => r < m.count && !m.isBlank(r)).length : 0;
    const what = grid || this.query.text || this.hasGlobalRowFilter() ? t('{0} rows on screen', rows.toLocaleString()) : t('All {0} rows', rows.toLocaleString());
    const items: [string, string][] = [
      ['rows:jsonl', t('{0} as JSON Lines…', what)],
      ['rows:csv', t('{0} as CSV…', what)],
      ['rows:json', t('{0} as JSON array…', what)],
      ['rows:md', t('{0} as Markdown table…', what)],
    ];
    if (sel > 0) {
      if (sel === 1) {
        items.push(
          ['selected:jsonl', t('1 selected line as JSON Lines…')],
          ['selected:csv', t('1 selected line as CSV…')],
          ['selected:json', t('1 selected line as JSON array…')],
          ['selected:md', t('1 selected line as Markdown table…')],
        );
      } else {
        const sc = sel.toLocaleString();
        items.push(
          ['selected:jsonl', t('{0} selected lines as JSON Lines…', sc)],
          ['selected:csv', t('{0} selected lines as CSV…', sc)],
          ['selected:json', t('{0} selected lines as JSON array…', sc)],
          ['selected:md', t('{0} selected lines as Markdown table…', sc)],
        );
      }
    }
    menu.innerHTML = items.map(([k, label]) => `<button class="menu-item" role="menuitem" data-export="${k}">${esc(label)}</button>`).join('');
    menu.hidden = false;
    const btn = this.toolbar.querySelector('.export-btn') as HTMLElement | null;
    if (btn) this.placeMenuBelow(btn, menu);
    (menu.querySelector('button') as HTMLElement).focus();
  }

  private toggleHistoryMenu(): void {
    const menu = this.root.querySelector('.hist-menu') as HTMLElement;
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    this.paintHistoryMenu();
    menu.hidden = false;
    const btn = this.toolbar.querySelector('.hist-btn') as HTMLElement | null;
    if (btn) this.placeMenuBelow(btn, menu);
    (menu.querySelector('button') as HTMLElement | null)?.focus();
  }

  private paintHistoryMenu(): void {
    const menu = this.root.querySelector('.hist-menu') as HTMLElement;
    const parts: string[] = [];
    if (this.savedQueries.length) {
      parts.push(`<div class="menu-head">${esc(t('SAVED QUERIES'))}</div>`);
      for (const q of this.savedQueries) {
        parts.push(
          `<div class="hist-row"><button class="menu-item mono" role="menuitem" data-hq="${esc(q)}">${esc(q)}</button><button class="icon-btn" data-hdel="${esc(q)}" title="${esc(t('Remove saved query'))}">${icon('close', 11)}</button></div>`,
        );
      }
    }
    parts.push(`<div class="menu-head">${esc(t('RECENT QUERIES'))}</div>`);
    if (this.queryHistory.length) {
      for (const q of this.queryHistory.slice(0, 10)) {
        parts.push(`<button class="menu-item mono" role="menuitem" data-hq="${esc(q)}">${esc(q)}</button>`);
      }
    } else {
      parts.push(`<div class="gf-more">${esc(t('No recent queries yet.'))}</div>`);
    }
    parts.push(`<div class="menu-head">${esc(t('EXAMPLES'))}</div>`);
    for (const ex of QUERY_EXAMPLES) {
      parts.push(`<button class="menu-item mono dim" role="menuitem" data-hq="${esc(ex)}">${esc(ex)}</button>`);
    }
    menu.innerHTML = parts.join('');
  }

  private recordQueryHistory(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length < 2) return;
    this.queryHistory = [trimmed, ...this.queryHistory.filter((x) => x !== trimmed)].slice(0, MAX_QUERY_HISTORY);
    this.histCursor = -1;
  }

  private toggleSaveQuery(): void {
    const q = this.state.query.trim();
    if (!q) return;
    const idx = this.savedQueries.indexOf(q);
    if (idx >= 0) this.savedQueries.splice(idx, 1);
    else this.savedQueries.unshift(q);
    this.paintChrome();
    this.stateChanged();
  }

  // ---------- compare ----------

  /** The two selected lines, field by field. */
  private openCompare(): void {
    const m = this.model;
    const [a, b] = [...this.state.selected].sort((x, y) => x - y);
    const va = m.value(a);
    const vb = m.value(b);
    if (b === undefined || va === undefined || vb === undefined) {
      this.showBanner(t('Select two valid lines to compare them.'));
      return;
    }
    const { rows, more } = diffValues(va, vb);
    const panel = this.root.querySelector('.comparepanel') as HTMLElement;
    const cell = (v: JVal | undefined) => (v === undefined ? `<td class="dim">${t('(missing)')}</td>` : `<td class="mono">${esc(compactJson(v).slice(0, 300))}</td>`);
    const body = rows
      .map((d: Difference) => `<tr class="cmp-${d.kind}"><td class="mono">${esc(pathToString(d.path))}</td>${cell(d.a)}${cell(d.b)}</tr>`)
      .join('');
    panel.innerHTML = `
      <div class="ep-head"><span class="ep-title">${esc(t('Line {0} and line {1}', a + 1, b + 1))}</span><span class="dim">${esc(rows.length ? t(rows.length === 1 ? '{0} difference' : '{0} differences', `${rows.length.toLocaleString()}${more ? '+' : ''}`) : t('The two records are equal.'))}</span></div>
      ${rows.length ? `<div class="cmp-scroll"><table class="cmp"><tr><th>${t('Path')}</th><th>${esc(t('Line {0}', a + 1))}</th><th>${esc(t('Line {0}', b + 1))}</th></tr>${body}</table></div>` : ''}
      <div class="ep-actions">
        <button class="btn primary cmp-diff">${t('Open in the diff editor')}</button>
        <button class="btn cmp-close">${t('Close')} <kbd>Esc</kbd></button>
      </div>`;
    panel.hidden = false;
    (panel.querySelector('.cmp-close') as HTMLElement).addEventListener('click', () => this.closeCompare());
    (panel.querySelector('.cmp-diff') as HTMLElement).addEventListener('click', () => {
      const side = (r: number) => ({ title: t('{0} line {1}', this.doc.fileName, r + 1), text: prettyJson(m.line(r), this.config.indent) + '\n' });
      this.post({ type: 'diff', left: side(a), right: side(b) });
    });
    (panel.querySelector('.cmp-close') as HTMLElement).focus();
  }

  private closeCompare(): void {
    const panel = this.root.querySelector('.comparepanel') as HTMLElement | null;
    if (panel) panel.hidden = true;
  }

  // ---------- shell ----------

  private buildShell(): void {
    if (this.views) for (const v of Object.values(this.views)) v.dispose();
    this.shellGone.abort();
    this.shellGone = new AbortController();
    this.editRecord = -1;
    this.root.innerHTML = `
      <div class="toolbar" role="toolbar" aria-label="${t('Better JSONL toolbar')}"></div>
      <div class="timeline-bar" hidden></div>
      <div class="banner" hidden role="status"></div>
      <div class="body"></div>
      <div class="status"></div>
      <div class="editpanel" hidden role="dialog" aria-modal="true" aria-label="${t('Edit record')}">
        <div class="ep-head"><span class="ep-title"></span><span class="ep-err" role="alert"></span></div>
        <textarea spellcheck="false" aria-label="${t('Record JSON')}"></textarea>
        <div class="ep-actions">
          <button class="btn primary ep-apply">${t('Apply')} <kbd>${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</kbd></button>
          <button class="btn ep-cancel">${t('Cancel')} <kbd>Esc</kbd></button>
          <span class="ep-hint">${t('The record is saved back as one compact line.')}</span>
        </div>
      </div>
      <div class="comparepanel" hidden role="dialog" aria-modal="true" aria-label="${t('Compare two lines')}"></div>
      <div class="valpanel modal-panel" hidden role="dialog" aria-modal="true" aria-label="${t('Value inspector')}"></div>
      <div class="schemapanel modal-panel" hidden role="dialog" aria-modal="true" aria-label="${t('Schema & Types')}"></div>
      <div class="batchpanel modal-panel" hidden role="dialog" aria-modal="true" aria-label="${t('Batch jq rewrite')}"></div>
      <div class="export-menu menu" hidden role="menu" aria-label="${t('Export')}"></div>
      <div class="hist-menu menu" hidden role="menu" aria-label="${t('Query history and saved queries')}"></div>
      <div class="ctx-menu menu" hidden role="menu"></div>`;
    this.toolbar = this.root.querySelector('.toolbar') as HTMLElement;
    this.timelineEl = this.root.querySelector('.timeline-bar') as HTMLElement;
    this.banner = this.root.querySelector('.banner') as HTMLElement;
    this.body = this.root.querySelector('.body') as HTMLElement;
    this.status = this.root.querySelector('.status') as HTMLElement;

    this.status.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-clear-all-filters]')) this.clearAllActiveFilters();
    });

    this.setupTimelineEvents();

    const panel = this.root.querySelector('.editpanel') as HTMLElement;
    panel.querySelector('.ep-apply')!.addEventListener('click', () => this.applyEditor());
    panel.querySelector('.ep-cancel')!.addEventListener('click', () => this.closeEditor());
    panel.addEventListener('keydown', (e) => {
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
    const exportMenu = this.root.querySelector('.export-menu') as HTMLElement;
    const histMenu = this.root.querySelector('.hist-menu') as HTMLElement;
    const ctxMenu = this.root.querySelector('.ctx-menu') as HTMLElement;

    exportMenu.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-export]') as HTMLElement | null;
      if (!b) return;
      exportMenu.hidden = true;
      const [which, format] = (b.dataset.export as string).split(':') as ['rows' | 'selected', ExportRowFormat];
      this.exportRows(which, format);
    });

    histMenu.addEventListener('click', (e) => {
      const del = (e.target as HTMLElement).closest('[data-hdel]') as HTMLElement | null;
      if (del) {
        e.stopPropagation();
        const q = del.dataset.hdel as string;
        this.savedQueries = this.savedQueries.filter((x) => x !== q);
        this.paintHistoryMenu();
        this.paintChrome();
        this.stateChanged();
        return;
      }
      const pick = (e.target as HTMLElement).closest('[data-hq]') as HTMLElement | null;
      if (pick) {
        histMenu.hidden = true;
        this.applyQueryFromUI(pick.dataset.hq as string, false);
      }
    });

    const wireMenuKeys = (menu: HTMLElement, openerSel?: string) => {
      menu.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          menu.hidden = true;
          if (openerSel) (this.toolbar.querySelector(openerSel) as HTMLElement | null)?.focus();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const btns = [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')];
          if (!btns.length) return;
          e.preventDefault();
          e.stopPropagation();
          const cur = btns.indexOf(document.activeElement as HTMLButtonElement);
          const next = cur < 0 ? 0 : (cur + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
          btns[next].focus();
        }
      });
    };
    wireMenuKeys(exportMenu, '.export-btn');
    wireMenuKeys(histMenu, '.hist-btn');
    wireMenuKeys(ctxMenu);

    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target as HTMLElement;
        if (!exportMenu.hidden && !exportMenu.contains(target) && !target.closest('.export-btn')) exportMenu.hidden = true;
        if (!histMenu.hidden && !histMenu.contains(target) && !target.closest('.hist-btn')) histMenu.hidden = true;
        if (!ctxMenu.hidden && !ctxMenu.contains(target)) ctxMenu.hidden = true;
      },
      { signal: this.shellGone.signal },
    );

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
    const items = this.model.items;
    if (items)
      this.showBanner(
        t(
          'This JSON value is too large to keep in memory as a whole. The {0} items of {1} are shown as records, numbered from 1, and read when needed. Edit them as text.',
          items.count.toLocaleString(),
          pathToString(items.path),
        ),
      );
    else if (this.model.detectedJsonl) this.showBanner(t('This .json file holds one JSON value per line. It is shown as JSON Lines.'));
    else if (this.model.jsonc) this.showBanner(t('Parsed as JSON with Comments (comments or trailing commas found).'));
  }

  private setupTimelineEvents(): void {
    const el = this.timelineEl;
    const applyBrush = (b1: number, b2: number) => {
      const td = this.timelineData;
      if (!td) return;
      const lo = Math.max(0, Math.min(b1, b2));
      const hi = Math.min(td.buckets - 1, Math.max(b1, b2));
      const span = Math.max(1, td.maxMs - td.minMs);
      const startMs = td.minMs + (lo / td.buckets) * span;
      const endMs = hi === td.buckets - 1 ? td.maxMs : td.minMs + ((hi + 1) / td.buckets) * span;
      this.state.timelineRange = [startMs, endMs];
      this.paintTimeline();
      this.activeView.render();
      this.paintChrome();
      this.stateChanged();
    };
    el.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('.tl-clear')) {
        this.state.timelineRange = null;
        this.paintTimeline();
        this.activeView.render();
        this.paintChrome();
        this.stateChanged();
        return;
      }
      const slot = (e.target as HTMLElement).closest('[data-b]') as HTMLElement | null;
      if (!slot || e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      const b = Number(slot.dataset.b);
      this.timelineBrushStart = b;
      applyBrush(b, b);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.timelineBrushStart < 0 || !this.timelineData) return;
      const track = el.querySelector('.tl-track') as HTMLElement | null;
      if (!track) return;
      const r = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(0.9999, (e.clientX - r.left) / Math.max(1, r.width)));
      const b = Math.floor(pct * this.timelineData.buckets);
      applyBrush(this.timelineBrushStart, b);
    });
    el.addEventListener('pointerup', () => {
      this.timelineBrushStart = -1;
    });
  }

  private clearAllActiveFilters(): void {
    const s = this.state;
    s.filterOnly = false;
    s.bookmarkedOnly = false;
    s.timelineRange = null;
    s.grid.filters.clear();
    if (s.query) {
      const input = this.toolbar.querySelector('.search input') as HTMLInputElement | null;
      if (input) input.value = '';
      this.setQuery('');
    }
    this.paintTimeline();
    this.activeView.render();
    this.paintChrome();
    this.stateChanged();
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
      <div class="search" role="search">
        ${icon('search')}
        <input type="search" aria-label="${t('Search')}" placeholder="${t('Search · or path:text, path=value  ({0}F)', mac ? '⌘' : 'Ctrl+')}" spellcheck="false">
        <span class="count dim"></span>
        <button class="sopt-btn case-btn" aria-label="${t('Match case')}" aria-pressed="false" title="${t('Match case')}">Aa</button>
        <button class="sopt-btn regex-btn" aria-label="${t('Regular expression')}" aria-pressed="false" title="${t('Regular expression')}">.*</button>
        <button class="sopt-btn lit-btn" aria-label="${t('Literal text search (do not parse as jq or JSONPath)')}" aria-pressed="false" title="${t('Literal text search (do not parse as jq or JSONPath)')}">""</button>
        <button class="icon-btn star-btn" hidden aria-label="${t('Save current query')}" aria-pressed="false" title="${t('Save current query')}">${icon('star', 13)}</button>
        <button class="icon-btn hist-btn" aria-haspopup="menu" aria-label="${t('Query history and saved queries')}" title="${t('Query history and saved queries')}">${icon('history', 13)}</button>
        <button class="icon-btn" data-step="-1" aria-label="${t('Previous match')}">${icon('chev-up')}</button>
        <button class="icon-btn" data-step="1" aria-label="${t('Next match')}">${icon('chev-down')}</button>
        <button class="icon-btn filter-btn" aria-label="${t('Show only matching lines')}" aria-pressed="false" title="${t('Show only matching lines')}">${icon('filter')}</button>
        <button class="icon-btn xform-btn" hidden aria-label="${t('Transform')}" aria-pressed="false" title="${t('Transform view: show jq / JSONPath output as a virtual table')}">${icon('transform')}</button>
      </div>
      <div class="tb-right">
        <div class="stats"></div>
        <button class="icon-btn timeline-btn" hidden aria-pressed="false" aria-label="${t('Timeline')}" title="${t('Toggle timeline distribution bar')}">${icon('timeline')}</button>
        <button class="icon-btn bm-btn" hidden aria-pressed="false" aria-label="${t('Bookmark')}" title="${t('Show only bookmarked lines')}">${icon('bookmark')}</button>
        <button class="icon-btn cols-btn" hidden aria-pressed="false" aria-label="${t('Columns')}" title="${t('Show, hide, pin or reorder columns')}">${icon('columns')}</button>
        <button class="icon-btn schema-btn" aria-label="${t('Generate types / schema')}" title="${t('Infer TypeScript, JSON Schema, Pydantic or Zod from records')}">${icon('schema')}</button>
        <button class="icon-btn wand-btn" hidden aria-label="${t('Batch rewrite with jq…')}" title="${t('Batch rewrite with jq…')}">${icon('wand')}</button>
        <button class="icon-btn follow-btn" aria-pressed="false" aria-label="${t('Follow the end of the file')}" title="${t('Follow the end of the file: new lines show at once')}">${icon('follow')}</button>
        <button class="icon-btn compare-btn" aria-label="${t('Compare the two selected lines')}" title="${t('Compare the two selected lines')}">${icon('compare')}</button>
        <button class="icon-btn export-btn" aria-haspopup="menu" aria-label="${t('Export rows')}" title="${t('Export rows as JSON Lines, CSV, JSON or Markdown')}">${icon('download')}</button>
        <button class="icon-btn wrap-btn" aria-label="${t('Word wrap ({0})', mac ? '⌥Z' : 'Alt+Z')}" title="${t('Word wrap ({0})', mac ? '⌥Z' : 'Alt+Z')}" aria-pressed="false">${icon('wrap')}</button>
        <button class="icon-btn open-text" aria-label="${t('Open as text')}" title="${t('Open as text')}">${icon('file-code')}</button>
        <button class="icon-btn gear-btn" aria-label="${t('Settings')}" title="${t('Settings')}">${icon('gear')}</button>
      </div>`;

    tb.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
      if (!btn) return;
      if (btn.dataset.view) this.setView(btn.dataset.view as ViewKind);
      else if (btn.dataset.mode) this.setExpandMode(btn.dataset.mode as ExpandMode);
      else if (btn.dataset.fold) this.foldAll(btn.dataset.fold === 'collapse');
      else if (btn.dataset.step) this.activeView.stepMatch(Number(btn.dataset.step) as 1 | -1);
      else if (btn.dataset.line) this.stepLine(Number(btn.dataset.line));
      else if (btn.classList.contains('case-btn')) {
        this.state.caseSensitive = !this.state.caseSensitive;
        this.rerunSearch();
      } else if (btn.classList.contains('regex-btn')) {
        this.state.regex = !this.state.regex;
        if (this.state.regex) {
          this.state.literal = false;
          this.transformMode = false;
        }
        this.rerunSearch();
      } else if (btn.classList.contains('lit-btn')) {
        this.state.literal = !this.state.literal;
        if (this.state.literal) {
          this.state.regex = false;
          this.transformMode = false;
        }
        this.rerunSearch();
      } else if (btn.classList.contains('star-btn')) this.toggleSaveQuery();
      else if (btn.classList.contains('hist-btn')) this.toggleHistoryMenu();
      else if (btn.classList.contains('xform-btn')) {
        this.transformMode = !this.transformMode;
        this.rerunSearch();
      } else if (btn.hasAttribute('data-exit-xform')) {
        this.transformMode = false;
        this.rerunSearch();
      } else if (btn.classList.contains('filter-btn')) {
        this.state.filterOnly = !this.state.filterOnly;
        this.activeView.render();
        this.paintChrome();
        this.stateChanged();
      } else if (btn.classList.contains('timeline-btn')) {
        this.state.timelineOpen = !this.state.timelineOpen;
        this.paintTimeline();
        this.paintChrome();
        this.stateChanged();
      } else if (btn.classList.contains('bm-btn')) {
        if (this.state.bookmarks.size === 0) {
          this.toggleBookmark(this.state.active);
        } else {
          this.state.bookmarkedOnly = !this.state.bookmarkedOnly;
          this.activeView.render();
          this.paintChrome();
          this.stateChanged();
        }
      } else if (btn.classList.contains('cols-btn')) {
        (this.views.grid as GridView).toggleColPicker();
        this.paintChrome();
      } else if (btn.classList.contains('schema-btn')) this.openSchemaGenerator();
      else if (btn.classList.contains('wand-btn')) this.openBatchRewrite();
      else if (btn.classList.contains('open-text')) this.post({ type: 'openAsText' });
      else if (btn.classList.contains('wrap-btn')) this.setWrap(!this.state.wrap);
      else if (btn.classList.contains('follow-btn')) this.setFollow(!this.state.follow);
      else if (btn.classList.contains('compare-btn')) this.openCompare();
      else if (btn.classList.contains('export-btn')) this.toggleExportMenu();
      else if (btn.classList.contains('gear-btn')) this.settings?.toggle();
      else if (btn.classList.contains('err-chip')) this.nextError();
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
        this.recordQueryHistory(input.value);
        this.stateChanged();
      } else if (e.key === 'Escape') {
        input.value = '';
        if (this.transformMode) this.transformMode = false;
        this.setQuery('');
        input.blur();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && this.queryHistory.length > 0 && (e.altKey || !input.value || this.histCursor >= 0)) {
        e.preventDefault();
        const d = e.key === 'ArrowUp' ? 1 : -1;
        this.histCursor = Math.max(-1, Math.min(this.queryHistory.length - 1, this.histCursor + d));
        const nextVal = this.histCursor >= 0 ? this.queryHistory[this.histCursor] : '';
        input.value = nextVal;
        this.setQuery(nextVal);
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

  private applyQueryFromUI(q: string, filterInFormatted: boolean): void {
    const input = this.toolbar.querySelector('.search input') as HTMLInputElement | null;
    if (input) input.value = q;
    if (filterInFormatted && this.state.view === 'formatted' && this.model.isJsonl) {
      this.state.filterOnly = true;
    }
    this.recordQueryHistory(q);
    this.setQuery(q);
  }

  private rerunSearch(): void {
    this.startSearch(() => {
      this.activeView.render();
      if (this.matches.length && this.model.isJsonl && !this.matchSet.has(this.state.active)) this.activeView.stepMatch(1);
      this.paintChrome();
      this.stateChanged();
    });
    if (this.searching) this.repaint();
  }

  private setQuery(q: string): void {
    this.state.query = q;
    if (!q.trim()) this.transformMode = false;
    else if (q.trim().length >= 2) this.recordQueryHistory(q);
    // A new query reads its jq modules again (they may have changed).
    this.jqModules.clear();
    this.modulesAsked.clear();
    this.rerunSearch();
  }

  /**
   * Finds the records that match the query (or builds the projected virtual document in Transform mode).
   * Small documents: at once. Large ones: in time slices; `done` runs when the result is ready.
   */
  private startSearch(done: () => void): void {
    this.stopSearch?.();
    const srcModel = this.baseModel ?? this.model;
    const opts = { caseSensitive: this.state.caseSensitive, regex: this.state.regex, literal: this.state.literal, forceJq: this.transformMode };
    this.query = parseQuery(this.state.query, srcModel, this.jqModules, opts);
    const q = this.query;

    const restoreBaseModel = () => {
      if (this.baseModel) {
        this.model = this.baseModel;
        this.baseModel = undefined;
        this.timelineData = undefined;
        this.clampStateToModel();
      }
    };

    const finish = (out: number[], tree?: { matches: string[]; capped: boolean }) => {
      this.queryNotes = q.error ? [q.error] : q.needs ? [t('jq: reading modules {0}…', q.needs.map((k) => k.replace(/^\w+:/, '')).join(', '))] : [];
      this.matches = out;
      this.matchSet = new Set(out);
      this.treeMatches = tree ? tree.matches : [];
      this.treeCapped = !!tree?.capped;
      this.treeIndex = -1;
      this.matchesVersion++;
      this.searching = false;
      done();
    };

    const sync = srcModel.bytes <= SYNC_SEARCH_BYTES;
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

    if (q.needs) {
      restoreBaseModel();
      const ask = q.needs.filter((k) => !this.modulesAsked.has(k));
      ask.forEach((k) => this.modulesAsked.add(k));
      if (ask.length) this.post({ type: 'readModules', keys: ask });
      finish([]);
      return;
    }

    // F4: jq / JSONPath Transform projection mode!
    if (this.transformMode && q.program) {
      const prog = q.program;
      if (prog.usesInputs || !srcModel.isJsonl) {
        const outs: JVal[] = [];
        const notes: string[] = [];
        try {
          if (prog.usesInputs) {
            const recordsOf = function* (): Generator<Out> {
              if (!srcModel.isJsonl) {
                const root = srcModel.value(0);
                if (root !== undefined) yield { v: root, p: null };
                return;
              }
              for (let i = 0; i < srcModel.count; i++) {
                const v = srcModel.scanValue(i);
                if (v !== undefined) yield { v, p: { up: null, k: i } };
              }
            };
            const run = (prog.runWith as NonNullable<Program['runWith']>)(null, { [Symbol.iterator]: recordsOf });
            for (const o of run.outs) {
              if (outs.length >= MAX_PROJECTED_ROWS) break;
              outs.push(o.v);
            }
            if (run.capped || run.outs.length > MAX_PROJECTED_ROWS) notes.push(t('The query stopped: too many results'));
          } else {
            const root = srcModel.value(0);
            if (root !== undefined) {
              const run = prog.run(root);
              for (const o of run.outs) {
                if (outs.length >= MAX_PROJECTED_ROWS) break;
                outs.push(o.v);
              }
              if (run.capped || run.outs.length > MAX_PROJECTED_ROWS) notes.push(t('The query stopped: too many results'));
            }
          }
        } catch (e) {
          notes.push(`jq: ${errorMessage(e)}`);
        }
        this.baseModel = srcModel;
        this.model = DocModel.fromValues(outs);
        this.timelineData = undefined;
        this.state.active = 0;
        this.state.anchor = 0;
        this.state.selected = outs.length ? new Set([0]) : new Set();
        finish(outs.map((_, idx) => idx));
        this.queryNotes = notes;
        return;
      }

      // Sliced projection across JSONL records.
      const outs: JVal[] = [];
      let i = 0;
      let capped = false;
      begin();
      const stepProj = () => {
        if ((this.baseModel ?? this.model) !== srcModel) return;
        const end = sync ? Infinity : performance.now() + SLICE_MS;
        const n = srcModel.count;
        while (i < n && !capped) {
          const rec = srcModel.scanValue(i);
          if (rec !== undefined) {
            try {
              const run = prog.run(rec);
              for (const o of run.outs) {
                if (o.v === false || o.v === null) {
                  // Notice: in Transform mode (unlike Filter mode!), explicit `false` or `null` output from e.g. `.ok` IS a projected value!
                }
                outs.push(o.v);
                if (outs.length >= MAX_PROJECTED_ROWS) {
                  capped = true;
                  break;
                }
              }
            } catch {
              // Skip records where an unguarded expression throws, like jq's `?` idiom across mixed schemas.
            }
          }
          i++;
          if ((i & 127) === 0 && performance.now() > end) break;
        }
        if (i >= n || capped) {
          this.baseModel = srcModel;
          this.model = DocModel.fromValues(outs);
          this.timelineData = undefined;
          this.state.active = 0;
          this.state.anchor = 0;
          this.state.selected = outs.length ? new Set([0]) : new Set();
          finish(outs.map((_, idx) => idx));
          if (capped) this.queryNotes = [t('The query stopped: too many results')];
          return;
        }
        this.searchPct = Math.floor((i / n) * 100);
        this.paintCount();
        this.stopSearch = defer(stepProj);
      };
      stepProj();
      return;
    }

    restoreBaseModel();
    const m = this.model;
    if (!q.text) {
      finish([]);
      return;
    }
    if (q.program?.usesInputs) {
      this.runOverInputs(m, q.program, finish);
      return;
    }
    if (!m.isJsonl) {
      const root = m.value(0);
      if (root === undefined) {
        finish([]);
        return;
      }
      if (q.path) {
        const hit = matchesPathValue(getAt(root, q.path), q.op, q.value ?? '', q.caseSensitive);
        const key = q.path.reduce<string>((acc, seg) => childKey(acc, seg), '');
        finish([], { matches: hit ? [key] : [], capped: false });
        return;
      }
      if (q.program) {
        let result: { matches: string[]; capped: boolean } = { matches: [], capped: false };
        let notes: string[] = [];
        try {
          const run = q.program.run(root);
          const seen = new Set<string>();
          const loose: string[] = [];
          for (const o of run.outs) {
            if (o.p === undefined) {
              if (loose.length < 3) loose.push(compactJson(o.v).slice(0, 80));
              continue;
            }
            const key = pathOf(o.p).reduce<string>((k, seg) => childKey(k, seg), '');
            if (!seen.has(key)) seen.add(key);
          }
          result = { matches: [...seen], capped: run.capped };
          if (run.capped) notes.push(t('The query stopped: too many results'));
          if (loose.length) notes.push(t('Result: {0}', loose.join(', ')));
        } catch (e) {
          notes = [`${q.program.kind === 'jq' ? 'jq' : 'JSONPath'}: ${errorMessage(e)}`];
        }
        finish([], result);
        this.queryNotes = notes;
        return;
      }
      if (q.regex && q.error) {
        finish([]);
        return;
      }
      const tree = new TreeSearch(root, q.text, undefined, { caseSensitive: q.caseSensitive, re: q.re });
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
  showBanner(text: string, action?: 'reload' | 'append', buttons: { label: string; run: () => void }[] = []): void {
    const b = this.banner;
    b.textContent = '';
    const span = document.createElement('span');
    span.textContent = text;
    b.appendChild(span);
    buttons.forEach((x, i) => {
      const btn = document.createElement('button');
      btn.className = i === 0 ? 'btn primary banner-act' : 'btn banner-act';
      btn.textContent = x.label;
      btn.addEventListener('click', () => {
        b.hidden = true;
        x.run();
      });
      b.appendChild(btn);
    });
    if (action === 'reload' || action === 'append') {
      const btn = document.createElement('button');
      btn.className = 'btn banner-act';
      btn.textContent = action === 'reload' ? t('Reload') : t('Load new lines');
      btn.addEventListener('click', () => {
        b.hidden = true;
        this.post({ type: action === 'reload' ? 'reload' : 'loadAppended' });
      });
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
    this.paintTimeline();
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
    allBtn.title =
      m.keepsAll || this.bigExpandOK
        ? t('All lines are pretty-printed')
        : t('All lines are pretty-printed. This file is over {0}: you confirm first.', formatBytes(KEEP_ALL_BYTES));
    (tb.querySelector('.foldall') as HTMLElement).hidden = !(s.view === 'formatted' && !m.isJsonl);
    (tb.querySelector('.linesel') as HTMLElement).hidden = !(s.view === 'graph' && m.isJsonl);

    // Search option buttons
    const syncPressed = (sel: string, on: boolean) => {
      const el = tb.querySelector(sel) as HTMLButtonElement | null;
      if (!el) return;
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
    };
    syncPressed('.case-btn', s.caseSensitive);
    syncPressed('.regex-btn', s.regex);
    syncPressed('.lit-btn', s.literal);

    const starBtn = tb.querySelector('.star-btn') as HTMLButtonElement;
    const qTrim = s.query.trim();
    starBtn.hidden = !qTrim;
    const isSaved = qTrim.length > 0 && this.savedQueries.includes(qTrim);
    starBtn.classList.toggle('on', isSaved);
    starBtn.setAttribute('aria-pressed', String(isSaved));
    starBtn.title = t(isSaved ? 'Remove saved query' : 'Save current query');

    const xformBtn = tb.querySelector('.xform-btn') as HTMLButtonElement;
    xformBtn.hidden = !this.query.program && !this.isProjected && !(qTrim && !s.literal && !s.regex && /^[{[.]/.test(qTrim));
    xformBtn.classList.toggle('on', this.transformMode);
    xformBtn.setAttribute('aria-pressed', String(this.transformMode));

    const tlBtn = tb.querySelector('.timeline-btn') as HTMLButtonElement;
    const hasTime = m.isJsonl && detectTimeColumn(m) !== undefined;
    tlBtn.hidden = !hasTime;
    tlBtn.classList.toggle('on', s.timelineOpen || s.timelineRange !== null);
    tlBtn.setAttribute('aria-pressed', String(s.timelineOpen));

    const bmBtn = tb.querySelector('.bm-btn') as HTMLButtonElement;
    bmBtn.hidden = !m.isJsonl || this.isProjected;
    bmBtn.classList.toggle('on', s.bookmarkedOnly);
    bmBtn.setAttribute('aria-pressed', String(s.bookmarkedOnly));
    bmBtn.title = s.bookmarks.size ? t('Bookmarked lines ({0})', s.bookmarks.size.toLocaleString()) : t('Toggle bookmark (B)');

    const gridView = this.views.grid as GridView;
    const colsBtn = tb.querySelector('.cols-btn') as HTMLButtonElement;
    colsBtn.hidden = !(s.view === 'grid' && gridView.canManageCols);
    colsBtn.classList.toggle('on', gridView.colPickerOpen || s.grid.hiddenCols.size > 0 || s.grid.pinnedCols.size > 0);
    colsBtn.setAttribute('aria-pressed', String(gridView.colPickerOpen));

    const schemaBtn = tb.querySelector('.schema-btn') as HTMLButtonElement;
    schemaBtn.hidden = m.valid === 0;

    const wandBtn = tb.querySelector('.wand-btn') as HTMLButtonElement;
    wandBtn.hidden = !m.isJsonl || this.readOnly;

    const followBtn = tb.querySelector('.follow-btn') as HTMLButtonElement;
    followBtn.hidden = !m.isJsonl || !!m.items || this.isProjected;
    followBtn.classList.toggle('on', s.follow);
    followBtn.setAttribute('aria-pressed', String(s.follow));
    (tb.querySelector('.compare-btn') as HTMLButtonElement).hidden = !(m.isJsonl && s.selected.size === 2 && s.view !== 'graph');
    (tb.querySelector('.export-btn') as HTMLButtonElement).hidden = !(
      m.isJsonl ||
      (m.value(0) !== undefined && isContainer(m.value(0) as JVal))
    );
    (tb.querySelector('.open-text') as HTMLButtonElement).hidden = !!this.doc.large?.gzip;
    const wrapBtn = tb.querySelector('.wrap-btn') as HTMLButtonElement;
    wrapBtn.classList.toggle('on', s.wrap);
    wrapBtn.setAttribute('aria-pressed', String(s.wrap));
    wrapBtn.hidden = s.view === 'graph';
    const filterBtn = tb.querySelector('.filter-btn') as HTMLButtonElement;
    filterBtn.hidden = !(s.view === 'formatted' && m.isJsonl && !this.isProjected);
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
      if (s.bookmarks.size > 0) parts.push(s.bookmarkedOnly ? t('Bookmarked ({0})', s.bookmarks.size) : `★ ${s.bookmarks.size}`);
    } else parts.push(m.jsonc ? t('JSON with Comments') : 'JSON');
    if (s.view === 'formatted' && m.isJsonl) parts.push(s.expandMode === 'focus' ? t('Focus: selected lines are expanded') : t('All lines expanded'));
    if (s.view === 'grid') {
      const f = gridView.filterStatus();
      if (f) parts.push(f);
    }
    if (this.readOnly && !this.isProjected) {
      parts.push(this.doc.large && !this.doc.large.gzip ? t('Read-only (large file)') : t('Read-only'));
    }
    parts.push(...this.notes());

    const anyFilterActive =
      (s.filterOnly && !!this.query.text) ||
      s.bookmarkedOnly ||
      s.timelineRange !== null ||
      (s.view === 'grid' && gridView.hasActiveColumnFilters());
    const clearBtn = anyFilterActive
      ? `<button class="status-act" data-clear-all-filters>${esc(t('Clear all filters'))}</button>`
      : '';

    const canJump = this.canRevealSource;
    const hint =
      s.view === 'graph'
        ? t('Drag or scroll to pan · {0}+scroll to zoom · click a node to inspect', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl')
        : s.view === 'grid'
          ? t('Click a header to sort · the funnel filters a column · double-click a value to edit')
          : m.isJsonl
            ? this.readOnly
              ? canJump
                ? t('↑/↓ move · Shift extends · double-click jumps to source')
                : t('↑/↓ move · Shift extends')
              : canJump
                ? t('↑/↓ move · Shift extends · Enter edits · double-click jumps to source')
                : t('↑/↓ move · Shift extends · Enter edits')
            : canJump
              ? t('Click ▸ to fold · double-click jumps to source')
              : t('Click ▸ to fold');
    this.status.innerHTML = `<span class="status-main" title="${esc(parts.join(' · '))}">${esc(parts.join(' · '))}</span>${clearBtn}<span class="spring"></span><span class="dim status-hint">${esc(hint)}</span>`;
  }

  /** Limits that hide data right now. */
  private notes(): string[] {
    const out = [...this.queryNotes, ...this.activeView.notes()];
    if (this.rangeCapped) out.push(t('The selection stops at {0} lines', MAX_RANGE.toLocaleString()));
    return out;
  }

  /** The match counter beside the search box. */
  paintCount(): void {
    const count = this.toolbar?.querySelector('.count') as HTMLElement | null;
    if (!count) return;
    if (this.isProjected) {
      count.textContent = this.searching
        ? t('Transforming… {0}%', this.searchPct)
        : t('{0} lines', this.model.count.toLocaleString());
      return;
    }
    const m = this.model;
    const kind = this.query.program ? `${this.query.program.kind === 'jq' ? 'jq' : 'JSONPath'} · ` : '';
    if (!this.query.text) count.textContent = '';
    else if (!m.isJsonl) {
      if (this.state.view === 'grid') count.textContent = '';
      else if (this.searching) count.textContent = t('Searching…');
      else if (this.state.view === 'graph') {
        const gp = (this.views.graph as GraphView).matchProgress();
        count.textContent = `${kind}${gp.index >= 0 ? gp.index + 1 : '–'} / ${gp.count.toLocaleString()}`;
      } else count.textContent = `${kind}${this.treeIndex >= 0 ? this.treeIndex + 1 : '–'} / ${this.treeMatches.length.toLocaleString()}${this.treeCapped ? '+' : ''}`;
    } else if (this.searching) count.textContent = kind + t('searching {0}%', this.searchPct);
    else {
      const ri = this.matchSet.has(this.state.active) ? lowerBound(this.matches, this.state.active) : -1;
      count.textContent = `${kind}${ri >= 0 ? ri + 1 : '–'} / ${this.matches.length.toLocaleString()}`;
    }
  }

  private paintStats(): void {
    const m = this.model;
    const st = this.toolbar.querySelector('.stats') as HTMLElement;
    const bits: string[] = [];
    if (this.isProjected) {
      bits.push(
        `<button class="chip proj-chip" data-exit-xform title="${esc(t('Exit transform'))}">${icon('transform', 12)}${esc(t('Projected ({0} results)', m.count.toLocaleString()))} ×</button>`,
      );
      st.innerHTML = bits.join('');
      return;
    }
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
    const model = this.baseModel ?? this.model;
    if (model.complete) return;
    let errors = model.errorsVersion;
    let columns = model.columns.length;
    const step = () => {
      if (model !== (this.baseModel ?? this.model)) return;
      const done = model.parseSome(SLICE_MS);
      const now = performance.now();
      if (done || now - this.lastStatsPaint > 250) {
        this.lastStatsPaint = now;
        this.paintStats();
        const view = this.state.view;
        if (!this.isProjected && ((view === 'formatted' && model.errorsVersion !== errors) || (view === 'grid' && (done || model.columns.length !== columns)))) {
          this.activeView.refresh();
        }
        errors = model.errorsVersion;
        columns = model.columns.length;
      }
      if (done) {
        this.paintChrome();
        const opts = { caseSensitive: this.state.caseSensitive, regex: this.state.regex, literal: this.state.literal };
        const again = parseQuery(this.state.query, model, this.jqModules, opts);
        if (!!again.path !== !!this.query.path || !!again.program !== !!this.query.program) this.startSearch(() => this.repaint());
        this.stateChanged();
        return;
      }
      this.stopScan = defer(step, model.loading && model.parsed >= model.count ? 120 : 0);
    };
    this.stopScan = defer(step);
  }

  // ---------- keyboard ----------

  private hasOpenModal(): boolean {
    if (this.settings?.open) return true;
    for (const sel of ['.editpanel', '.comparepanel', '.valpanel', '.schemapanel', '.batchpanel']) {
      const el = this.root.querySelector(sel) as HTMLElement | null;
      if (el && !el.hidden) return true;
    }
    return false;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      for (const sel of ['.ctx-menu', '.export-menu', '.hist-menu']) {
        const m = this.root.querySelector(sel) as HTMLElement | null;
        if (m && !m.hidden) {
          e.preventDefault();
          m.hidden = true;
          return;
        }
      }
      const valP = this.root.querySelector('.valpanel') as HTMLElement | null;
      if (valP && !valP.hidden) {
        e.preventDefault();
        this.closeValueInspector();
        return;
      }
      const schP = this.root.querySelector('.schemapanel') as HTMLElement | null;
      if (schP && !schP.hidden) {
        e.preventDefault();
        this.closeSchemaPanel();
        return;
      }
      const batP = this.root.querySelector('.batchpanel') as HTMLElement | null;
      if (batP && !batP.hidden) {
        e.preventDefault();
        this.closeBatchPanel();
        return;
      }
      const editP = this.root.querySelector('.editpanel') as HTMLElement | null;
      if (editP && !editP.hidden) {
        e.preventDefault();
        this.closeEditor();
        return;
      }
      const compare = this.root.querySelector('.comparepanel') as HTMLElement | null;
      if (compare && !compare.hidden) {
        e.preventDefault();
        this.closeCompare();
        return;
      }
      if (this.settings?.open) {
        e.preventDefault();
        this.settings.close();
        return;
      }
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const input = this.toolbar?.querySelector('.search input') as HTMLInputElement | null;
      input?.focus();
      input?.select();
      return;
    }
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || !this.model || !this.views || this.hasOpenModal()) return;
    if (target.closest('.toolbar, .menu, .gfilter, .col-picker')) return;
    // Enter and Space on a button press that button; they are not "edit the record".
    if ((e.key === 'Enter' || e.key === ' ') && target.closest('button, [role="button"], [role="columnheader"]')) return;
    if (!this.model.isJsonl) return;

    if (!mod && !e.altKey) {
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        this.toggleBookmark(this.state.active);
        return;
      }
      if (e.key === ']' || e.key === '[') {
        e.preventDefault();
        this.stepBookmark(e.key === ']' ? 1 : -1);
        return;
      }
    }

    if (this.state.view === 'graph') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      let r: number | undefined;
      if (this.state.view === 'grid') {
        const order = (this.views.grid as GridView).visibleRecordIds();
        if (!order.length) return;
        const cur = order.indexOf(this.state.active);
        r = cur >= 0 ? order[Math.min(order.length - 1, Math.max(0, cur + d))] : order[d > 0 ? 0 : order.length - 1];
      } else {
        const recs = this.formattedRecords();
        if (recs) {
          if (!recs.length) return;
          const lb = lowerBound(recs, this.state.active);
          if (lb < recs.length && recs[lb] === this.state.active) {
            r = recs[Math.min(recs.length - 1, Math.max(0, lb + d))];
          } else {
            r = recs[d > 0 ? Math.min(recs.length - 1, lb) : Math.max(0, lb - 1)];
          }
        } else r = Math.min(this.model.count - 1, Math.max(0, this.state.active + d));
      }
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

  private buildDocSaved(): DocSaved | undefined {
    const s = this.state;
    if (!s || !this.doc) return undefined;
    const head = <T>(it: Iterable<T>, n: number) => {
      const out: T[] = [];
      for (const x of it) {
        if (out.length >= n) break;
        out.push(x);
      }
      return out;
    };
    return {
      uri: this.doc.uri,
      view: s.view,
      expandMode: s.expandMode,
      wrap: s.wrap,
      active: s.active,
      selected: head(s.selected, MAX_RANGE),
      query: s.query,
      caseSensitive: s.caseSensitive,
      regex: s.regex,
      literal: s.literal,
      filterOnly: s.filterOnly,
      bookmarkedOnly: s.bookmarkedOnly,
      bookmarks: head(s.bookmarks, MAX_RANGE),
      follow: s.follow,
      foldDepth: Number.isFinite(s.foldDepth) ? s.foldDepth : null,
      folds: head(s.folds, 200)
        .filter(([, f]) => f.size > 0)
        .map(([r, f]) => [r, head(f, 500)]),
      grid: {
        sort: s.grid.sort,
        widths: s.grid.widths,
        open: head(s.grid.open, 500),
        filters: head(s.grid.filters, 50).map(([c, f]) => [c, { text: f.text, exclude: head(f.exclude, 500), min: f.min, max: f.max }]),
        hiddenCols: head(s.grid.hiddenCols, 500),
        pinnedCols: head(s.grid.pinnedCols, 50),
        colOrder: s.grid.colOrder.slice(0, 500),
      },
      graph: { collapsed: head(s.graph.collapsed, 500) },
    };
  }

  private persistNow(): void {
    clearTimeout(this.persistTimer);
    const cur = this.buildDocSaved();
    if (!cur) return;
    const prev = (vscode.getState() ?? {}) as SavedStore;
    const docs = [cur, ...(prev.docs ?? []).filter((d) => d.uri !== cur.uri)].slice(0, MAX_SAVED_DOCS);
    const nextStore: SavedStore = {
      ...cur,
      docs,
      queryHistory: this.queryHistory.slice(0, MAX_QUERY_HISTORY),
      savedQueries: this.savedQueries.slice(0, 50),
    };
    vscode.setState(nextStore);
  }

  /** Saves the view state (soon), so a restored webview or revisited editor tab shows the same thing. */
  private persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), 120);
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

/** A cell for a CSV or Markdown table: text as it is, other values as compact JSON. */
function cellString(v: JVal): string {
  return typeof v === 'string' ? v : compactJson(v);
}
