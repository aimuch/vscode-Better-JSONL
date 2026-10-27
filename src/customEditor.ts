import * as vscode from 'vscode';
import { ViewerSession } from './session';

export const VIEWER_VIEW_TYPE = 'betterJsonl.viewer';

/** "Open With… → Better JSONL". The text document stays the model, so save and undo work. */
export class ViewerEditorProvider implements vscode.CustomTextEditorProvider {
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onSession: (s: ViewerSession) => void,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new ViewerSession(panel, this.extensionUri, 'editor');
    session.bind(document);
    this.onSession(session);
  }
}
