import * as vscode from 'vscode';
import { isSupportedDocument, previewFollowsActiveEditor } from './config';
import { ViewerSession } from './session';

export const PREVIEW_VIEW_TYPE = 'betterJsonl.preview';

/** One side preview, like the Markdown preview. It follows the active JSON/JSONL editor. */
export class PreviewManager implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private session: ViewerSession | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSession: (s: ViewerSession) => void,
  ) {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !this.session || !previewFollowsActiveEditor()) return;
      if (isSupportedDocument(editor.document)) this.session.bind(editor.document);
    }, null, this.disposables);
  }

  get current(): ViewerSession | undefined {
    return this.session;
  }

  show(doc: vscode.TextDocument, toSide: boolean): ViewerSession {
    const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    if (this.session) {
      this.session.bind(doc);
      this.session.panel.reveal(column, toSide);
      return this.session;
    }
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      'Better JSONL',
      { viewColumn: column, preserveFocus: toSide },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return this.adopt(panel, doc);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const uri = (state as { uri?: string } | undefined)?.uri;
    if (!uri) {
      panel.dispose();
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
      this.adopt(panel, doc);
    } catch {
      panel.dispose();
    }
  }

  dispose(): void {
    this.session?.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private adopt(panel: vscode.WebviewPanel, doc: vscode.TextDocument): ViewerSession {
    this.session?.panel.dispose();
    const session = new ViewerSession(panel, this.extensionUri, 'preview');
    session.onDidDispose(() => {
      if (this.session === session) this.session = undefined;
    });
    this.session = session;
    session.bind(doc);
    this.onSession(session);
    return session;
  }
}
