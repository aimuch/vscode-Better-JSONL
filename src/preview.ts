import * as vscode from 'vscode';
import { isSupportedDocument, LARGE_FILE_BYTES, previewFollowsActiveEditor } from './config';
import { isGzipPath } from './largeFile';
import { ViewerSession, type SessionEnv, type Target } from './session';

export const PREVIEW_VIEW_TYPE = 'betterJsonl.preview';

/**
 * What to show for a file. A file above the VS Code limit for extensions (or one VS Code
 * cannot open as text) is a large file: Better JSONL reads it from disk itself.
 */
export async function resolveTarget(uri: vscode.Uri): Promise<Target> {
  if (isGzipPath(uri.path)) return { uri, bytes: (await vscode.workspace.fs.stat(uri)).size, gzip: true };
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key && !d.isClosed);
  if (open) return { doc: open };
  let bytes = 0;
  try {
    bytes = (await vscode.workspace.fs.stat(uri)).size;
  } catch {
    // Not a file on disk (for example an untitled document): open it as a text document.
  }
  if (bytes > LARGE_FILE_BYTES) return { uri, bytes };
  try {
    return { doc: await vscode.workspace.openTextDocument(uri) };
  } catch (e) {
    if (bytes > 0) return { uri, bytes };
    throw e;
  }
}

/**
 * The previews. One side preview follows the active JSON/JSONL editor, like the Markdown
 * preview. Each large file has its own panel: reading it again is not free, and no text
 * editor of an extension can stand for it.
 */
export class PreviewManager implements vscode.Disposable, vscode.WebviewPanelSerializer {
  private session: ViewerSession | undefined;
  private readonly large = new Map<string, ViewerSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly env: SessionEnv,
    private readonly onSession: (s: ViewerSession) => void,
  ) {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !this.session || !previewFollowsActiveEditor()) return;
      if (isSupportedDocument(editor.document)) this.session.bind({ doc: editor.document });
    }, null, this.disposables);
  }

  /** The preview that follows the active editor. */
  get current(): ViewerSession | undefined {
    return this.session;
  }

  /** The panels of large files. */
  get largeSessions(): ViewerSession[] {
    return [...this.large.values()];
  }

  show(target: Target, toSide: boolean): ViewerSession {
    const column = toSide ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
    const existing = 'doc' in target ? this.session : this.large.get(target.uri.toString());
    if (existing) {
      if ('doc' in target) existing.bind(target);
      // An open panel stays in its column: "Beside" would move it each time.
      existing.panel.reveal(existing.panel.viewColumn ?? column, toSide);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      'Better JSONL',
      { viewColumn: column, preserveFocus: toSide },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return this.adopt(panel, target);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const uri = (state as { uri?: string } | undefined)?.uri;
    if (!uri) {
      panel.dispose();
      return;
    }
    try {
      this.adopt(panel, await resolveTarget(vscode.Uri.parse(uri)));
    } catch {
      panel.dispose();
    }
  }

  dispose(): void {
    this.session?.panel.dispose();
    for (const s of this.largeSessions) s.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }

  private adopt(panel: vscode.WebviewPanel, target: Target): ViewerSession {
    const session = new ViewerSession(panel, this.env, 'preview');
    if ('doc' in target) {
      this.session?.panel.dispose();
      session.onDidDispose(() => {
        if (this.session === session) this.session = undefined;
      });
      this.session = session;
    } else {
      const key = target.uri.toString();
      this.large.get(key)?.panel.dispose();
      session.onDidDispose(() => {
        if (this.large.get(key) === session) this.large.delete(key);
      });
      this.large.set(key, session);
    }
    session.bind(target);
    this.onSession(session);
    return session;
  }
}
