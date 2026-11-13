import * as vscode from 'vscode';
import { ViewerSession, type SessionEnv } from './session';

export const VIEWER_VIEW_TYPE = 'betterJsonl.viewer';

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
