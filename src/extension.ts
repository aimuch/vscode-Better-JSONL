import * as vscode from 'vscode';
import { formatDocumentEnabled, isSupportedDocument, setTestMode, uiLanguage } from './config';
import { setLang, t } from './shared/i18n';
import { ViewerEditorProvider, VIEWER_VIEW_TYPE } from './customEditor';
import { compactLines, expandLines, formatJsonl } from './lineCommands';
import { PREVIEW_VIEW_TYPE, PreviewManager, resolveTarget } from './preview';
import type { SessionEnv, Target, ViewerSession } from './session';
import type { HostMessage } from './shared/protocol';

export interface BetterJsonlApi {
  sessions(): ViewerSession[];
  preview(): ViewerSession | undefined;
}

export function activate(context: vscode.ExtensionContext): BetterJsonlApi {
  setLang(uiLanguage());
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  setTestMode(testMode);
  const env: SessionEnv = { extensionUri: context.extensionUri, extensionId: context.extension.id, testMode };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('betterJsonl.language')) setLang(uiLanguage());
    }),
  );
  const sessions = new Set<ViewerSession>();
  let lastActive: ViewerSession | undefined;

  const track = (s: ViewerSession) => {
    sessions.add(s);
    lastActive = s;
    s.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) lastActive = s;
    });
    s.onDidDispose(() => {
      sessions.delete(s);
      if (lastActive === s) lastActive = undefined;
    });
  };

  const preview = new PreviewManager(env, track);
  context.subscriptions.push(
    preview,
    vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, preview),
    vscode.window.registerCustomEditorProvider(VIEWER_VIEW_TYPE, new ViewerEditorProvider(env, track), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );

  // The JSONL formatter exists only while betterJsonl.formatDocument.enabled is on.
  let formatter: vscode.Disposable | undefined;
  const syncFormatter = () => {
    if (formatDocumentEnabled() && !formatter) {
      formatter = vscode.languages.registerDocumentFormattingEditProvider({ language: 'jsonl' }, { provideDocumentFormattingEdits: formatJsonl });
    } else if (!formatDocumentEnabled() && formatter) {
      formatter.dispose();
      formatter = undefined;
    }
  };
  syncFormatter();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('betterJsonl.formatDocument.enabled')) syncFormatter();
    }),
    { dispose: () => formatter?.dispose() },
  );

  /** The file a command is for: the argument, the active text editor, or the active tab. */
  const target = async (uri?: vscode.Uri): Promise<Target | undefined> => {
    try {
      if (uri instanceof vscode.Uri) return await resolveTarget(uri);
      const editor = vscode.window.activeTextEditor;
      if (editor && isSupportedDocument(editor.document)) return { doc: editor.document };
      // VS Code shows a file above 50 MB in a tab, but extensions get no text editor for it.
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (tab instanceof vscode.TabInputText || tab instanceof vscode.TabInputCustom) return await resolveTarget(tab.uri);
    } catch (e) {
      void vscode.window.showErrorMessage(t('Better JSONL could not read the file: {0}', e instanceof Error ? e.message : String(e)));
      return undefined;
    }
    void vscode.window.showWarningMessage(t('Better JSONL: open a JSON or JSONL file first.'));
    return undefined;
  };

  const activeSession = (): ViewerSession | undefined => {
    for (const s of sessions) if (s.panel.active) return s;
    return lastActive ?? preview.current;
  };

  const sendToActive = (msg: HostMessage) => {
    const s = activeSession();
    if (s) s.post(msg);
    else void vscode.window.showInformationMessage(t('Better JSONL: open a Better JSONL view first.'));
  };

  const reg = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('betterJsonl.openPreviewToSide', async (uri?: vscode.Uri) => {
    const what = await target(uri);
    if (what) preview.show(what, true);
  });
  reg('betterJsonl.openPreview', async (uri?: vscode.Uri) => {
    const what = await target(uri);
    if (what) preview.show(what, false);
  });
  reg('betterJsonl.openInViewer', async (uri?: vscode.Uri) => {
    const what = await target(uri);
    if (!what) return;
    // The custom editor needs a text document. A large file has none: it opens in its own panel.
    if ('doc' in what) await vscode.commands.executeCommand('vscode.openWith', what.doc.uri, VIEWER_VIEW_TYPE);
    else preview.show(what, false);
  });
  reg('betterJsonl.openAsText', async () => {
    const s = activeSession();
    if (s) await s.openAsText();
  });
  reg('betterJsonl.showFormatted', () => sendToActive({ type: 'setView', view: 'formatted' }));
  reg('betterJsonl.showGrid', () => sendToActive({ type: 'setView', view: 'grid' }));
  reg('betterJsonl.showGraph', () => sendToActive({ type: 'setView', view: 'graph' }));
  reg('betterJsonl.toggleExpandMode', () => sendToActive({ type: 'toggleExpandMode' }));
  reg('betterJsonl.toggleWordWrap', () => sendToActive({ type: 'toggleWrap' }));
  reg('betterJsonl.expandLines', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) return expandLines(editor);
    return 0;
  });
  reg('betterJsonl.compactLines', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) return compactLines(editor);
    return false;
  });

  return {
    sessions: () => [...sessions],
    preview: () => preview.current,
  };
}

export function deactivate(): void {}
