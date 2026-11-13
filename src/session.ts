import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { isJsonlDocument, isJsonlPath, readConfig, syncSelectionEnabled } from './config';
import { compare, encodingFor, fileState, innerName, LineConflict, readUtf8, replaceLine, type FileState } from './largeFile';
import { locatePath, valueSpan } from './locate';
import { t } from './shared/i18n';
import { errorMessage, minifyJson } from './shared/jsonText';
import { SETTING_KEYS, type HostMessage, type JsonPath, type RenderReport, type SettingKey, type TextChange, type WebviewMessage } from './shared/protocol';

type Waiter = { pred: (r: RenderReport) => boolean; resolve: (r: RenderReport) => void };

/** What a session needs from the extension. */
export interface SessionEnv {
  extensionUri: vscode.Uri;
  extensionId: string;
  /** Opens two texts in the VS Code diff editor. */
  showDiff(left: { title: string; text: string }, right: { title: string; text: string }): Promise<void>;
  /** True in the E2E tests: the session keeps the messages and render reports the tests read. */
  testMode: boolean;
}

/** What a view shows: a text document, or a file too large for VS Code to give to an extension. */
export type Target = { doc: vscode.TextDocument } | { uri: vscode.Uri; bytes: number; gzip?: boolean };

/** A file that VS Code does not give to extensions (too large, or compressed): read from disk. */
interface Large {
  bytes: number;
  gzip: boolean;
  encoding: string;
  /** Size, time and last bytes of the file when it was read: a file that only grew can be followed. */
  state?: FileState;
  follow: boolean;
}
const MAX_SYNC_LINES = 2000;
/** More changes or more new text than this between two updates: the whole text is sent instead. */
const MAX_EDITS = 500;
const MAX_EDIT_CHARS = 64 * 1024;

const oneOf =
  (...values: unknown[]) =>
  (v: unknown) =>
    values.includes(v);
const int = (min: number, max: number) => (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const bool = (v: unknown) => typeof v === 'boolean';

/** The values each setting accepts from the webview (the same as in package.json). */
const SETTING_VALUES: Record<SettingKey, (v: unknown) => boolean> = {
  theme: oneOf('vscode', 'light', 'dark', 'system'),
  wordWrap: oneOf('followEditor', 'on', 'off'),
  indent: int(1, 8),
  defaultView: oneOf('formatted', 'grid', 'graph'),
  'jsonl.expandMode': oneOf('focus', 'all'),
  'graph.maxNodes': int(50, 20000),
  syncSelection: bool,
  'preview.followActiveEditor': bool,
  'formatDocument.enabled': bool,
  'expandLines.showReminder': bool,
  language: oneOf('auto', 'en', 'zh-cn'),
};

/**
 * Binds one Better JSONL webview to one file.
 * The file is named by its URI: the text document can close and open again while the view stays.
 */
export class ViewerSession implements vscode.Disposable {
  private uri: vscode.Uri | undefined;
  private doc: vscode.TextDocument | undefined;
  /** Set when the file is streamed from disk (read-only). */
  private large: Large | undefined;
  private appending = false;
  private appendAgain = false;
  /** Exports in progress, by id: where the text goes. */
  private readonly exports = new Map<number, { write(data: string): Promise<void>; finish(): Promise<void>; uri: vscode.Uri; rows: number }>();
  /** The E2E tests set this: the export goes there, with no save dialog. */
  testExportTarget: vscode.Uri | undefined;
  /** What the webview shows the document as. The webview decides (a .json file can hold JSON Lines). */
  private jsonl = false;
  private ready = false;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private watcher: vscode.Disposable | undefined;
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** An update waits because the panel is hidden. */
  private dirty = false;
  private lastSize = 0;
  /**
   * JSON Lines documents: the changes since the text the webview has (version `syncedVersion`).
   * Undefined when they cannot be used and the next update must be the whole text.
   */
  private edits: TextChange[] | undefined;
  private editChars = 0;
  private syncedVersion = -1;
  /** A document update waits for its timer. Line numbers of the text editor are ahead of the view until it is sent. */
  private updatePending = false;
  /** The cursor moved while an update was waiting: the selection goes out after the update. */
  private selectionLater = false;
  /** Each "init" of a large file has a number; chunks of an older one are dropped. */
  private generation = 0;
  /** The selection this session is setting in the text editor. Its change event is not sent back to the view. */
  private expected: vscode.Selection | undefined;
  private revealing = false;
  /** The session opened the text document itself (no editor shows it). */
  private selfOpened = false;
  private waiters: Waiter[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  lastReport: RenderReport | undefined;
  /** Messages the webview sent. Only kept in the E2E tests. */
  readonly received: WebviewMessage[] = [];
  /** The document messages this session sent ("init", "update", "edit"), in order. Only kept in the E2E tests. */
  readonly sentKinds: string[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly env: SessionEnv,
    readonly host: 'editor' | 'preview',
  ) {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(env.extensionUri, 'dist'), vscode.Uri.joinPath(env.extensionUri, 'media')],
    };
    webview.html = this.html(webview);
    panel.iconPath = {
      light: vscode.Uri.joinPath(env.extensionUri, 'media', 'glyph-light.svg'),
      dark: vscode.Uri.joinPath(env.extensionUri, 'media', 'glyph-dark.svg'),
    };
    webview.onDidReceiveMessage((m: WebviewMessage) => this.handle(m), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState(() => {
      if (panel.visible && this.dirty) this.flushUpdate();
    }, null, this.disposables);
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!this.isMine(e.document) || !e.contentChanges.length) return;
      if (this.doc !== e.document) this.edits = undefined;
      this.doc = e.document;
      this.selfOpened = false;
      this.queueEdits(e.contentChanges);
      this.scheduleUpdate();
    }, null, this.disposables);
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (!this.isMine(d) || this.doc === d) return;
      this.doc = d;
      this.edits = undefined;
      this.scheduleUpdate();
    }, null, this.disposables);
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (d !== this.doc) return;
      this.doc = undefined;
      // The closed document may have held changes that were not saved. Read the file again, once.
      const mine = this.selfOpened;
      this.selfOpened = false;
      if (!mine && this.host === 'preview') void this.reopen();
    }, null, this.disposables);
    vscode.window.onDidChangeTextEditorSelection((e) => this.onEditorSelection(e), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('betterJsonl') || e.affectsConfiguration('editor.wordWrap')) this.post({ type: 'config', config: readConfig(this.doc) });
    }, null, this.disposables);
  }

  /** The text document, while VS Code has it open. Undefined for large files. */
  get document(): vscode.TextDocument | undefined {
    return this.doc;
  }

  get resource(): vscode.Uri | undefined {
    return this.uri;
  }

  get isLarge(): boolean {
    return !!this.large;
  }

  /** Large files that cannot be written: compressed, not UTF-8, or not on a local disk. */
  private get readOnly(): boolean {
    const large = this.large;
    return !!large && (large.gzip || large.encoding !== 'utf-8' || this.uri?.scheme !== 'file');
  }

  bind(target: Target): void {
    if ('doc' in target) {
      if (this.doc === target.doc && !this.large) return;
      this.doc = target.doc;
      this.uri = target.doc.uri;
      this.large = undefined;
      this.jsonl = isJsonlDocument(target.doc);
    } else {
      this.doc = undefined;
      this.uri = target.uri;
      const gzip = !!target.gzip;
      this.large = { bytes: target.bytes, gzip, encoding: encodingFor(target.uri), follow: this.large?.follow ?? false };
      this.jsonl = isJsonlPath(gzip ? innerName(target.uri.path) : target.uri.path);
    }
    this.selfOpened = false;
    this.lastReport = undefined;
    this.expected = undefined;
    if (this.host === 'preview') this.panel.title = `Better JSONL · ${path.posix.basename(this.uri.path)}`;
    this.watch();
    if (this.ready) this.sendInit();
  }

  post(msg: HostMessage): void {
    if (this.disposed || !this.ready) return;
    if (this.env.testMode && (msg.type === 'init' || msg.type === 'update' || msg.type === 'edit')) {
      this.sentKinds.push(msg.type);
      if (this.sentKinds.length > 500) this.sentKinds.splice(0, 250);
    }
    void this.panel.webview.postMessage(msg);
  }

  /** Resolves with the first report that matches `pred`. Used by the E2E tests. */
  waitForReport(pred: (r: RenderReport) => boolean, timeoutMs = 10000): Promise<RenderReport> {
    if (this.lastReport && pred(this.lastReport)) return Promise.resolve(this.lastReport);
    return new Promise((resolve, reject) => {
      const w: Waiter = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error(`No matching report in ${timeoutMs} ms. Last: ${JSON.stringify(this.lastReport)}`));
      }, timeoutMs);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    clearTimeout(this.updateTimer);
    clearTimeout(this.noticeTimer);
    this.watcher?.dispose();
    this.disposables.forEach((d) => d.dispose());
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }

  // ---------- the file ----------

  private isMine(doc: vscode.TextDocument): boolean {
    return !this.large && !!this.uri && doc.uri.toString() === this.uri.toString();
  }

  /** The text document, opened again when VS Code closed it. Undefined for large files. */
  private async liveDoc(): Promise<vscode.TextDocument | undefined> {
    if (this.large || !this.uri) return undefined;
    if (this.doc && !this.doc.isClosed) return this.doc;
    const uri = this.uri;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (this.uri !== uri || this.large) return undefined;
    if (this.doc !== doc) {
      this.doc = doc;
      this.selfOpened = !vscode.window.visibleTextEditors.some((e) => e.document === doc);
    }
    return doc;
  }

  private async reopen(): Promise<void> {
    if (this.disposed) return;
    try {
      if (await this.liveDoc()) this.scheduleUpdate();
    } catch {
      // The file is gone. The view keeps its last content; the watcher tells the user.
    }
  }

  /** Watches the file on disk: a closed document does not send change events. */
  private watch(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
    const uri = this.uri;
    if (!uri || uri.scheme === 'untitled') return;
    try {
      const name = path.posix.basename(uri.path).replace(/[*?[\]{}]/g, '[$&]');
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(uri, '..'), name));
      const changed = () => {
        if (this.uri !== uri) return;
        if (this.large) {
          clearTimeout(this.noticeTimer);
          this.noticeTimer = setTimeout(() => void this.onLargeChanged(), 300);
        } else if (!this.doc || this.doc.isClosed) void this.reopen();
      };
      w.onDidChange(changed);
      w.onDidCreate(changed);
      w.onDidDelete(() => {
        if (this.uri === uri) this.post({ type: 'notice', message: t('The file was deleted or moved. The view shows its last content.') });
      });
      this.watcher = w;
    } catch {
      // No watcher for this kind of file system. The view still follows the open document.
    }
  }

  private sendInit(): void {
    const uri = this.uri;
    if (!uri) return;
    clearTimeout(this.updateTimer);
    this.dirty = false;
    const info = { uri: uri.toString(), fileName: path.posix.basename(uri.path), host: this.host };
    if (this.large) {
      const generation = ++this.generation;
      this.post({
        type: 'init',
        doc: { ...info, languageId: this.jsonl ? 'jsonl' : 'json', isJsonl: this.jsonl, large: { bytes: this.large.bytes, gzip: this.large.gzip }, readOnly: this.readOnly },
        text: '',
        version: generation,
        config: readConfig(),
      });
      void this.stream(uri, generation);
      return;
    }
    const doc = this.doc;
    if (!doc) return;
    const text = doc.getText();
    this.lastSize = text.length;
    this.synced(doc);
    this.post({
      type: 'init',
      doc: { ...info, languageId: doc.languageId, isJsonl: isJsonlDocument(doc) },
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      version: doc.version,
      config: readConfig(doc),
    });
    const editor = this.visibleEditor();
    if (editor) this.sendSelection(editor.selections);
  }

  /**
   * Sends a large file as "chunk" messages (UTF-8). Each one waits for the one before, so the
   * webview is not flooded. Only the bytes up to the size it had at the start are read: the
   * rest is new, and follow mode adds it.
   */
  private async stream(uri: vscode.Uri, generation: number): Promise<void> {
    const large = this.large;
    if (!large) return;
    const current = () => !this.disposed && generation === this.generation && this.large === large;
    try {
      const state = uri.scheme === 'file' && !large.gzip ? await fileState(uri.fsPath) : undefined;
      let prev: { data: Uint8Array; read: number } | undefined;
      for await (const piece of readUtf8(uri, { gzip: large.gzip, encoding: large.encoding, to: state?.size })) {
        if (!current()) return;
        if (prev) await this.panel.webview.postMessage({ type: 'chunk', version: generation, data: prev.data, done: false, read: prev.read } satisfies HostMessage);
        prev = piece;
      }
      if (!current()) return;
      large.state = state;
      await this.panel.webview.postMessage({ type: 'chunk', version: generation, data: prev?.data ?? new Uint8Array(0), done: true, read: prev?.read ?? 0 } satisfies HostMessage);
    } catch (e) {
      if (current()) this.post({ type: 'notice', message: t('Better JSONL could not read the file: {0}', errorMessage(e)) });
    }
  }

  /** The file of a large view changed on disk. */
  private async onLargeChanged(): Promise<void> {
    const large = this.large;
    const uri = this.uri;
    if (!large || !uri) return;
    if (!large.state || uri.scheme !== 'file') {
      this.post({ type: 'notice', message: t('The file changed on disk.'), action: 'reload' });
      return;
    }
    let how: 'same' | 'grew' | 'changed';
    try {
      how = await compare(uri.fsPath, large.state);
    } catch {
      return;
    }
    if (how === 'same') return;
    if (how === 'grew') {
      if (large.follow) await this.appendNew();
      else this.post({ type: 'notice', message: t('New lines were added to the file.'), action: 'append' });
      return;
    }
    if (large.follow) await this.reload();
    else this.post({ type: 'notice', message: t('The file changed on disk.'), action: 'reload' });
  }

  /** Sends the bytes that were added at the end of a large file. */
  private async appendNew(): Promise<void> {
    if (this.appending) {
      this.appendAgain = true;
      return;
    }
    this.appending = true;
    try {
      do {
        this.appendAgain = false;
        const large = this.large;
        const uri = this.uri;
        if (!large?.state || !uri || this.disposed) return;
        if ((await compare(uri.fsPath, large.state)) !== 'grew') return;
        const generation = this.generation;
        const now = await fileState(uri.fsPath);
        for await (const piece of readUtf8(uri, { gzip: false, encoding: large.encoding, from: large.state.size, to: now.size })) {
          if (this.disposed || generation !== this.generation || this.large !== large) return;
          if (piece.data.length) await this.panel.webview.postMessage({ type: 'append', version: generation, data: piece.data } satisfies HostMessage);
        }
        large.state = now;
        large.bytes = now.size;
      } while (this.appendAgain);
    } catch (e) {
      this.post({ type: 'notice', message: t('Better JSONL could not read the file: {0}', errorMessage(e)) });
    } finally {
      this.appending = false;
    }
  }

  private scheduleUpdate(): void {
    if (this.large) return;
    this.updatePending = true;
    clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => this.flushUpdate(), this.lastSize > 5_000_000 ? 400 : 120);
  }

  private flushUpdate(): void {
    this.updatePending = false;
    const doc = this.doc;
    if (!doc || this.large || this.disposed) return;
    // A hidden view is updated when it shows again, not on every change.
    if (!this.panel.visible) {
      this.dirty = true;
      this.edits = undefined;
      return;
    }
    this.dirty = false;
    const edits = this.edits;
    const base = this.syncedVersion;
    this.synced(doc);
    if (edits && edits.length) {
      const end = doc.lineAt(doc.lineCount - 1).range.end;
      this.lastSize = doc.offsetAt(end);
      this.post({ type: 'edit', base, version: doc.version, lineCount: doc.lineCount, chars: this.lastSize, eol: doc.eol === vscode.EndOfLine.CRLF ? 2 : 1, changes: edits });
    } else {
      const text = doc.getText();
      this.lastSize = text.length;
      this.post({ type: 'update', text, bytes: Buffer.byteLength(text, 'utf8'), version: doc.version });
    }
    this.selectionAfterUpdate();
  }

  /**
   * After a document update the view has the line numbers of the text editor again. When the
   * user works in that editor, or its cursor moved while the update waited, the view gets the
   * cursor now. (A selection sent before the update would point at the lines of the old text.)
   */
  private selectionAfterUpdate(): void {
    const editor = this.visibleEditor();
    const later = this.selectionLater;
    this.selectionLater = false;
    if (editor && (later || editor === vscode.window.activeTextEditor)) this.sendSelection(editor.selections);
  }

  /** The webview now has the text of `doc` at its version: changes are collected from here. */
  private synced(doc: vscode.TextDocument): void {
    this.syncedVersion = doc.version;
    // Only JSON Lines documents are patched: one JSON value is parsed again as a whole anyway.
    this.edits = isJsonlDocument(doc) ? [] : undefined;
    this.editChars = 0;
  }

  private queueEdits(changes: readonly vscode.TextDocumentContentChangeEvent[]): void {
    if (!this.edits) return;
    // The ranges of one event are in the text before the event: from the end to the start, each
    // one can be applied without moving the others.
    for (const c of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      this.edits.push({ sl: c.range.start.line, sc: c.range.start.character, el: c.range.end.line, ec: c.range.end.character, text: c.text });
      this.editChars += c.text.length;
    }
    if (this.edits.length > MAX_EDITS || this.editChars > MAX_EDIT_CHARS) this.edits = undefined;
  }

  // ---------- selection sync ----------

  private visibleEditor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => this.isMine(e.document));
  }

  private onEditorSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.isMine(e.textEditor.document)) return;
    // The change this session made itself is not news for the view. Everything else is.
    const expected = this.expected;
    this.expected = undefined;
    if (this.revealing) return;
    if (expected && e.selections.length === 1 && e.selections[0].isEqual(expected)) return;
    if (this.updatePending) {
      this.selectionLater = true;
      return;
    }
    this.sendSelection(e.selections);
  }

  private sendSelection(selections: readonly vscode.Selection[]): void {
    if (!this.doc || !this.jsonl || !syncSelectionEnabled()) return;
    const lines = new Set<number>();
    let truncated = false;
    for (const s of selections) {
      let end = s.end.line;
      if (end > s.start.line && s.end.character === 0) end--;
      for (let l = s.start.line; l <= end; l++) {
        if (lines.size >= MAX_SYNC_LINES) {
          truncated = true;
          break;
        }
        lines.add(l);
      }
    }
    this.post({ type: 'selection', lines: [...lines], active: selections[0].active.line, truncated });
  }

  /** Sets the selection of a text editor without an echo to the view. */
  private select(editor: vscode.TextEditor, range: vscode.Range): void {
    const sel = new vscode.Selection(range.start, range.end);
    if (!editor.selection.isEqual(sel) || editor.selections.length !== 1) {
      this.expected = sel;
      editor.selection = sel;
    }
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Handles one message from the webview. Public so the E2E tests can drive it. */
  async handle(m: WebviewMessage): Promise<void> {
    if (this.env.testMode) {
      this.received.push(m);
      if (this.received.length > 500) this.received.splice(0, 250);
    }
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          // VS Code may have closed the document while the webview loaded: open it again first.
          if (!this.large) await this.liveDoc().catch(() => undefined);
          this.sendInit();
          break;
        case 'docMode': {
          const changed = this.jsonl !== m.isJsonl;
          this.jsonl = m.isJsonl;
          const editor = this.visibleEditor();
          if (changed && editor) this.sendSelection(editor.selections);
          break;
        }
        case 'reload':
          await this.reload();
          break;
        case 'resync':
          this.edits = undefined;
          clearTimeout(this.updateTimer);
          this.flushUpdate();
          break;
        case 'select':
          this.revealLine(m.line);
          break;
        case 'reveal':
          await this.revealPath(m.line, m.path);
          break;
        case 'editLine':
          await this.editLine(m.line, m.original, m.text, !!m.exact);
          break;
        case 'editValue':
          await this.editValue(m.path, m.version, m.text);
          break;
        case 'follow':
          if (this.large) {
            this.large.follow = m.on;
            if (m.on) await this.onLargeChanged();
          }
          break;
        case 'loadAppended':
          await this.appendNew();
          break;
        case 'exportStart':
          await this.exportStart(m.id, m.format, m.name, m.rows);
          break;
        case 'exportData':
          await this.exportData(m.id, m.data, m.done);
          break;
        case 'diff':
          await this.env.showDiff(m.left, m.right);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage(t('Better JSONL: copied to clipboard'), 2000);
          break;
        case 'openAsText':
          await this.openAsText();
          break;
        case 'setSetting':
          await this.setSetting(m.key, m.value);
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${this.env.extensionId}`);
          break;
        case 'export':
          await this.exportFile(m.format, m.data, m.name);
          break;
        case 'report':
          if (!this.env.testMode) break;
          this.lastReport = m.report;
          for (const w of [...this.waiters]) {
            if (w.pred(m.report)) {
              this.waiters = this.waiters.filter((x) => x !== w);
              w.resolve(m.report);
            }
          }
          break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Better JSONL: ${errorMessage(e)}`);
    }
  }

  /** Reads a large file from disk again. */
  private async reload(): Promise<void> {
    if (!this.large || !this.uri) return;
    this.large = { ...this.large, bytes: (await vscode.workspace.fs.stat(this.uri)).size, state: undefined };
    this.sendInit();
  }

  private revealLine(line: number): void {
    const editor = this.visibleEditor();
    if (!editor || !syncSelectionEnabled() || line >= editor.document.lineCount) return;
    const pos = new vscode.Position(line, 0);
    this.select(editor, new vscode.Range(pos, pos));
  }

  private async revealPath(line: number, jsonPath: JsonPath): Promise<void> {
    const uri = this.uri;
    if (!uri) return;
    const column = this.visibleEditor()?.viewColumn ?? (this.host === 'preview' ? vscode.ViewColumn.One : vscode.ViewColumn.Beside);
    if (this.large) {
      // No text document for a large file: VS Code opens it and goes to the line.
      const at = new vscode.Range(this.jsonl ? line : 0, 0, this.jsonl ? line : 0, 0);
      await vscode.commands.executeCommand('vscode.open', uri, { selection: at, viewColumn: column, preview: false });
      return;
    }
    const doc = await this.liveDoc();
    if (!doc) return;
    let range: vscode.Range;
    if (this.jsonl) {
      if (line >= doc.lineCount) return;
      const text = doc.lineAt(line).text;
      const span = locatePath(text, jsonPath) ?? { offset: 0, length: text.length };
      range = new vscode.Range(line, span.offset, line, span.offset + span.length);
    } else {
      const text = doc.getText();
      const span = locatePath(text, jsonPath) ?? { offset: 0, length: 0 };
      range = new vscode.Range(doc.positionAt(span.offset), doc.positionAt(span.offset + span.length));
    }
    // Showing the editor can move its cursor. Only the final selection matters, and the view already has it.
    this.revealing = true;
    try {
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: false, preview: false });
      this.select(editor, range);
    } finally {
      this.revealing = false;
    }
  }

  private async editLine(line: number, original: string, text: string, exact: boolean): Promise<void> {
    const fail = (message: string) => this.post({ type: 'editResult', ok: false, message });
    try {
      JSON.parse(text);
    } catch (e) {
      return fail(errorMessage(e));
    }
    const out = exact ? text : minifyJson(text);
    if (/[\r\n]/.test(out)) return fail(t('A record must stay on one line.'));
    if (this.large) return this.editLargeLine(line, original, out);
    // The live document: the check below must see what is in the file now.
    const doc = await this.liveDoc();
    if (!doc) return fail(t('No document.'));
    if (line >= doc.lineCount || doc.lineAt(line).text !== original) {
      return fail(t('Line {0} changed after the edit started. Nothing was written.', line + 1));
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, doc.lineAt(line).range, out);
    const ok = await vscode.workspace.applyEdit(edit);
    this.post(ok ? { type: 'editResult', ok: true } : { type: 'editResult', ok: false, message: t('VS Code rejected the edit.') });
  }

  /**
   * A record of a large file: the line is replaced on disk (the file is written again).
   * It works when the file is as the view read it and the line still has the text the edit started from.
   */
  private async editLargeLine(line: number, original: string, text: string): Promise<void> {
    const fail = (message: string) => this.post({ type: 'editResult', ok: false, message });
    const large = this.large;
    const uri = this.uri;
    if (!large || !uri) return;
    if (this.readOnly) return fail(t('This file is read-only here (compressed, not UTF-8, or not on this computer).'));
    if (!large.state || (await compare(uri.fsPath, large.state)) !== 'same') return fail(t('The file changed on disk. Reload it, then edit again.'));
    try {
      large.state = await replaceLine(uri.fsPath, line, original, text);
      large.bytes = large.state.size;
    } catch (e) {
      return fail(e instanceof LineConflict ? t('Line {0} changed after the edit started. Nothing was written.', line + 1) : errorMessage(e));
    }
    this.post({ type: 'editResult', ok: true, line, text });
  }

  /**
   * One JSON document: the value at `path` gets the JSON `text`. Only that span of the file
   * changes, so the rest stays as it is (spacing, comments, number text).
   */
  private async editValue(jsonPath: JsonPath, version: number, text: string): Promise<void> {
    const fail = (message: string) => this.post({ type: 'editResult', ok: false, message });
    if (this.large) return fail(t('This file is read-only here: open it as text to edit it.'));
    try {
      JSON.parse(text);
    } catch (e) {
      return fail(errorMessage(e));
    }
    const doc = await this.liveDoc();
    if (!doc) return fail(t('No document.'));
    if (doc.version !== version) return fail(t('The document changed after the edit started. Nothing was written.'));
    const span = valueSpan(doc.getText(), jsonPath);
    if (!span) return fail(t('The value is no longer in the document.'));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(span.offset), doc.positionAt(span.offset + span.length)), text);
    const ok = await vscode.workspace.applyEdit(edit);
    this.post(ok ? { type: 'editResult', ok: true } : { type: 'editResult', ok: false, message: t('VS Code rejected the edit.') });
  }

  /** Export: asks where to save, then opens the file for the pieces that follow. */
  private async exportStart(id: number, format: 'jsonl' | 'csv', name: string, rows: number): Promise<void> {
    const dir = this.uri && this.uri.scheme === 'file' ? vscode.Uri.joinPath(this.uri, '..') : undefined;
    const target =
      this.testExportTarget ??
      (await vscode.window.showSaveDialog({
        defaultUri: dir ? vscode.Uri.joinPath(dir, `${name}.${format}`) : undefined,
        filters: format === 'csv' ? { CSV: ['csv'] } : { 'JSON Lines': ['jsonl', 'ndjson'] },
      }));
    if (!target) {
      this.post({ type: 'exportReady', id, ok: false });
      return;
    }
    if (target.scheme === 'file') {
      const fh = await fs.promises.open(target.fsPath, 'w');
      this.exports.set(id, {
        uri: target,
        rows,
        write: async (data) => {
          await fh.write(data, null, 'utf8');
        },
        finish: () => fh.close(),
      });
    } else {
      const parts: Buffer[] = [];
      this.exports.set(id, {
        uri: target,
        rows,
        write: async (data) => {
          parts.push(Buffer.from(data, 'utf8'));
        },
        finish: () => Promise.resolve(vscode.workspace.fs.writeFile(target, Buffer.concat(parts))),
      });
    }
    this.post({ type: 'exportReady', id, ok: true });
  }

  private async exportData(id: number, data: string, done: boolean): Promise<void> {
    const e = this.exports.get(id);
    if (!e) return;
    try {
      if (data) await e.write(data);
      if (!done) return;
      this.exports.delete(id);
      await e.finish();
      const name = path.posix.basename(e.uri.path);
      this.post({ type: 'exportDone', id, ok: true, message: t('Saved {0} rows to {1}.', e.rows.toLocaleString(), name) });
    } catch (err) {
      this.exports.delete(id);
      await e.finish().catch(() => undefined);
      this.post({ type: 'exportDone', id, ok: false, message: t('The export failed: {0}', errorMessage(err)) });
    }
  }

  async openAsText(): Promise<void> {
    const uri = this.uri;
    if (!uri) return;
    // VS Code shows a compressed file as binary data: there is no text to open.
    if (this.large?.gzip) {
      void vscode.window.showInformationMessage(t('Better JSONL: a compressed file has no text view.'));
      return;
    }
    if (this.host === 'editor') {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default', this.panel.viewColumn);
      this.panel.dispose();
      return;
    }
    const column = this.visibleEditor()?.viewColumn ?? vscode.ViewColumn.One;
    if (this.large) {
      await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: column, preview: false });
      return;
    }
    const doc = await this.liveDoc();
    if (doc) await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
  }

  /**
   * Writes one Better JSONL setting. It goes where the value in use comes from: the workspace
   * when the workspace sets it, the user settings otherwise. (The settings have the window
   * scope, so a value in a workspace folder is never the one in use.)
   * Other sessions get it through the config event.
   */
  private async setSetting(key: string, value: unknown): Promise<void> {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new Error(t('Unknown setting: {0}', key));
    if (!SETTING_VALUES[key as SettingKey](value)) throw new Error(t('Not a valid value for {0}: {1}', key, JSON.stringify(value)));
    const cfg = vscode.workspace.getConfiguration('betterJsonl');
    const target = cfg.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await cfg.update(key, value, target);
  }

  private async exportFile(format: 'svg' | 'png', data: string, name: string): Promise<void> {
    const dir = this.uri && this.uri.scheme === 'file' ? vscode.Uri.joinPath(this.uri, '..') : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri: dir ? vscode.Uri.joinPath(dir, `${name}.${format}`) : undefined,
      filters: format === 'svg' ? { [t('SVG image')]: ['svg'] } : { [t('PNG image')]: ['png'] },
    });
    if (!target) return;
    const bytes = format === 'svg' ? Buffer.from(data, 'utf8') : Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64');
    await vscode.workspace.fs.writeFile(target, bytes);
    vscode.window.setStatusBarMessage(t('Better JSONL: saved {0}', path.basename(target.path)), 3000);
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.env.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.env.extensionUri, 'dist', 'webview.css'));
    // Scripts: only the bundle (nonce). Styles: the bundle, plus style attributes the views write
    // for column widths and indents ('unsafe-inline' covers attributes; no style comes from the file).
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>Better JSONL</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
