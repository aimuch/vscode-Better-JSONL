import * as vscode from 'vscode';
import { ViewerSession, type SessionEnv } from './session';

export const VIEWER_VIEW_TYPE = 'betterJsonl.viewer';
/** Compressed JSON and JSON Lines files (.jsonl.gz, .json.gz). VS Code has no text view for them. */
export const COMPRESSED_VIEW_TYPE = 'betterJsonl.compressed';

/** "Open With… → Better JSONL". The text document stays the model, so save and undo work. */
export class ViewerEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly env: SessionEnv,
    private readonly onSession: (s: ViewerSession) => void,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new ViewerSession(panel, this.env, 'editor');
    session.bind({ doc: document });
    this.onSession(session);
  }
}

/** Opens a compressed file read-only: the host decompresses it and streams it to the view. */
export class CompressedEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly env: SessionEnv,
    private readonly onSession: (s: ViewerSession) => void,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const session = new ViewerSession(panel, this.env, 'editor');
    const bytes = (await vscode.workspace.fs.stat(document.uri)).size;
    session.bind({ uri: document.uri, bytes, gzip: true });
    this.onSession(session);
  }
}
