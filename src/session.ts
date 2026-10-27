import * as path from 'path';
import * as vscode from 'vscode';
import { isJsonlDocument, readConfig } from './config';
import { locatePath } from './locate';
import { errorMessage, minifyJson } from './shared/jsonText';
import { SETTING_KEYS, type HostMessage, type JsonPath, type RenderReport, type WebviewMessage } from './shared/protocol';

type Waiter = { pred: (r: RenderReport) => boolean; resolve: (r: RenderReport) => void };

/** Binds one Better JSONL webview to one text document. */
export class ViewerSession implements vscode.Disposable {
  private doc: vscode.TextDocument | undefined;
  private ready = false;
  private disposed = false;
  private readonly disposables: vscode.Disposable[] = [];
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private muteSelectionUntil = 0;
  private waiters: Waiter[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  lastReport: RenderReport | undefined;
  /** Every message the webview sent. The E2E tests read it. */
  readonly received: WebviewMessage[] = [];

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    readonly host: 'editor' | 'preview',
  ) {
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
    };
    webview.html = this.html(webview);
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'glyph-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'glyph-dark.svg'),
    };
    webview.onDidReceiveMessage((m: WebviewMessage) => this.handle(m), null, this.disposables);
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document === this.doc && e.contentChanges.length) this.scheduleUpdate();
    }, null, this.disposables);
    vscode.window.onDidChangeTextEditorSelection((e) => this.onEditorSelection(e), null, this.disposables);
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('betterJsonl') || e.affectsConfiguration('editor.wordWrap')) this.post({ type: 'config', config: readConfig(this.doc) });
    }, null, this.disposables);
  }

  get document(): vscode.TextDocument | undefined {
    return this.doc;
  }

  bind(doc: vscode.TextDocument): void {
    if (this.doc === doc) return;
    this.doc = doc;
    this.lastReport = undefined;
    if (this.host === 'preview') this.panel.title = `Better JSONL · ${path.basename(doc.uri.path)}`;
    if (this.ready) this.sendInit();
  }

  post(msg: HostMessage): void {
    if (!this.disposed && this.ready) void this.panel.webview.postMessage(msg);
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
    clearTimeout(this.updateTimer);
    this.disposables.forEach((d) => d.dispose());
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }

  private sendInit(): void {
    const doc = this.doc;
    if (!doc) return;
    clearTimeout(this.updateTimer);
    this.post({
      type: 'init',
      doc: {
        uri: doc.uri.toString(),
        fileName: path.basename(doc.uri.path),
        languageId: doc.languageId,
        isJsonl: isJsonlDocument(doc),
        host: this.host,
      },
      text: doc.getText(),
      version: doc.version,
      config: readConfig(doc),
    });
    const editor = this.visibleEditor();
    if (editor) this.sendSelection(editor.selections);
  }

  private scheduleUpdate(): void {
    clearTimeout(this.updateTimer);
    const size = this.doc?.getText().length ?? 0;
    this.updateTimer = setTimeout(() => {
      const doc = this.doc;
      if (doc) this.post({ type: 'update', text: doc.getText(), version: doc.version });
    }, size > 5_000_000 ? 400 : 120);
  }

  private visibleEditor(): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document === this.doc);
  }

  private onEditorSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (e.textEditor.document !== this.doc) return;
    if (Date.now() < this.muteSelectionUntil) return;
    this.sendSelection(e.selections);
  }

  private sendSelection(selections: readonly vscode.Selection[]): void {
    if (!this.doc || !isJsonlDocument(this.doc) || !readConfig().syncSelection) return;
    const lines = new Set<number>();
    for (const s of selections) {
      let end = s.end.line;
      if (end > s.start.line && s.end.character === 0) end--;
      for (let l = s.start.line; l <= end && lines.size < 500; l++) lines.add(l);
    }
    this.post({ type: 'selection', lines: [...lines], active: selections[0].active.line });
  }

  /** Handles one message from the webview. Public so the E2E tests can drive it. */
  async handle(m: WebviewMessage): Promise<void> {
    this.received.push(m);
    if (this.received.length > 500) this.received.splice(0, 250);
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          this.sendInit();
          break;
        case 'select':
          this.revealLine(m.line);
          break;
        case 'reveal':
          await this.revealPath(m.line, m.path);
          break;
        case 'editLine':
          await this.editLine(m.line, m.original, m.text);
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(m.text);
          vscode.window.setStatusBarMessage('Better JSONL: copied to clipboard', 2000);
          break;
        case 'openAsText':
          await this.openAsText();
          break;
        case 'setSetting':
          await this.setSetting(m.key, m.value);
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:andy.better-jsonl');
          break;
        case 'export':
          await this.exportFile(m.format, m.data, m.name);
          break;
        case 'report':
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

  private revealLine(line: number): void {
    const editor = this.visibleEditor();
    if (!editor || !readConfig().syncSelection || line >= editor.document.lineCount) return;
    this.muteSelectionUntil = Date.now() + 400;
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async revealPath(line: number, jsonPath: JsonPath): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    let range: vscode.Range;
    if (isJsonlDocument(doc)) {
      if (line >= doc.lineCount) return;
      const text = doc.lineAt(line).text;
      const span = locatePath(text, jsonPath) ?? { offset: 0, length: text.length };
      range = new vscode.Range(line, span.offset, line, span.offset + span.length);
    } else {
      const text = doc.getText();
      const span = locatePath(text, jsonPath) ?? { offset: 0, length: 0 };
      range = new vscode.Range(doc.positionAt(span.offset), doc.positionAt(span.offset + span.length));
    }
    const existing = this.visibleEditor();
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: existing?.viewColumn ?? (this.host === 'preview' ? vscode.ViewColumn.One : vscode.ViewColumn.Beside),
      preserveFocus: false,
      preview: false,
    });
    this.muteSelectionUntil = Date.now() + 400;
    editor.selection = new vscode.Selection(range.start, range.end);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async editLine(line: number, original: string, text: string): Promise<void> {
    const doc = this.doc;
    const fail = (message: string) => this.post({ type: 'editResult', ok: false, message });
    if (!doc) return fail('No document.');
    if (line >= doc.lineCount || doc.lineAt(line).text !== original) {
      return fail(`Line ${line + 1} changed after the edit started. Nothing was written.`);
    }
    try {
      JSON.parse(text);
    } catch (e) {
      return fail(errorMessage(e));
    }
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, doc.lineAt(line).range, minifyJson(text));
    const ok = await vscode.workspace.applyEdit(edit);
    this.post(ok ? { type: 'editResult', ok: true } : { type: 'editResult', ok: false, message: 'VS Code rejected the edit.' });
  }

  async openAsText(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    if (this.host === 'editor') {
      await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default', this.panel.viewColumn);
      this.panel.dispose();
      return;
    }
    const existing = this.visibleEditor();
    await vscode.window.showTextDocument(doc, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One, preview: false });
  }

  /** Writes one Better JSONL setting to the user settings. Other sessions get it through the config event. */
  private async setSetting(key: string, value: unknown): Promise<void> {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown setting: ${key}`);
    await vscode.workspace.getConfiguration('betterJsonl').update(key, value, vscode.ConfigurationTarget.Global);
  }

  private async exportFile(format: 'svg' | 'png', data: string, name: string): Promise<void> {
    const doc = this.doc;
    const dir = doc && doc.uri.scheme === 'file' ? vscode.Uri.joinPath(doc.uri, '..') : undefined;
    const target = await vscode.window.showSaveDialog({
      defaultUri: dir ? vscode.Uri.joinPath(dir, `${name}.${format}`) : undefined,
      filters: format === 'svg' ? { 'SVG image': ['svg'] } : { 'PNG image': ['png'] },
    });
    if (!target) return;
    const bytes = format === 'svg' ? Buffer.from(data, 'utf8') : Buffer.from(data.replace(/^data:image\/png;base64,/, ''), 'base64');
    await vscode.workspace.fs.writeFile(target, bytes);
    vscode.window.setStatusBarMessage(`Better JSONL: saved ${path.basename(target.path)}`, 3000);
  }

  private html(webview: vscode.Webview): string {
    const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css'));
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
