import * as vscode from 'vscode';
import { formatDocumentEnabled, isSupportedDocument, isSupportedPath, setTestMode, uiLanguage } from './config';
import { setLang, t } from './shared/i18n';
import { randomBytes } from 'crypto';
import { COMPRESSED_VIEW_TYPE, CompressedEditorProvider, ViewerEditorProvider, VIEWER_VIEW_TYPE } from './customEditor';
import { compactLines, convertFormat, expandLines, formatJsonl } from './lineCommands';
import { isGzipPath, readMergedJsonl } from './largeFile';
import { PREVIEW_VIEW_TYPE, PreviewManager, resolveTarget } from './preview';
import { ViewerSession, type SessionEnv, type SessionStateSnapshot, type Target } from './session';
import type { HostMessage } from './shared/protocol';

export interface BetterJsonlApi {
  sessions(): ViewerSession[];
  preview(): ViewerSession | undefined;
  inspect(): SessionStateSnapshot[];
}

export function activate(context: vscode.ExtensionContext): BetterJsonlApi {
  setLang(uiLanguage());
  const testMode = context.extensionMode === vscode.ExtensionMode.Test;
  setTestMode(testMode);
  // Two records side by side: the diff editor reads them from this content provider.
  const DIFF_SCHEME = 'better-jsonl-diff';
  const diffTexts = new Map<string, string>();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, { provideTextDocumentContent: (uri) => diffTexts.get(uri.path) ?? '' }),
  );
  const showDiff: SessionEnv['showDiff'] = async (left, right) => {
    const id = randomBytes(4).toString('hex');
    const uriOf = (side: string, title: string) => vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${id}/${side}/${title.replace(/[\\/]/g, '_')}.json` });
    const l = uriOf('a', left.title);
    const r = uriOf('b', right.title);
    diffTexts.set(l.path, left.text);
    diffTexts.set(r.path, right.text);
    // Keep the texts of the last few comparisons only.
    while (diffTexts.size > 20) diffTexts.delete(diffTexts.keys().next().value as string);
    await vscode.commands.executeCommand('vscode.diff', l, r, `${left.title} ↔ ${right.title}`, { preview: true });
  };
  const env: SessionEnv = { extensionUri: context.extensionUri, extensionId: context.extension.id, testMode, showDiff };
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
    vscode.window.registerCustomEditorProvider(COMPRESSED_VIEW_TYPE, new CompressedEditorProvider(env, track), {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // The JSONL formatter exists only while betterJsonl.formatDocument.enabled is on.
  let formatter: vscode.Disposable | undefined;
  const syncFormatter = () => {
    if (formatDocumentEnabled() && !formatter) {
      formatter = vscode.languages.registerDocumentFormattingEditProvider(
        [{ language: 'jsonl' }, { pattern: '**/*.{jsonl,ndjson,jsonlines}' }],
        { provideDocumentFormattingEdits: formatJsonl },
      );
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
      if (uri instanceof vscode.Uri) {
        if (/\.(gz|br|zst)$/i.test(uri.path) && !isGzipPath(uri.path)) {
          void vscode.window.showWarningMessage(
            t('Better JSONL opens compressed files named .json.gz, .jsonl.gz, .ndjson.gz, .jsonlines.gz, .json.br, .jsonl.br, .ndjson.br, .jsonlines.br, .json.zst, .jsonl.zst, .ndjson.zst or .jsonlines.zst.'),
          );
          return undefined;
        }
        return await resolveTarget(uri);
      }
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        if (isSupportedDocument(editor.document)) return { doc: editor.document };
      } else {
        // VS Code shows a file above 50 MB in a tab, but extensions get no text editor for it.
        const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (tab instanceof vscode.TabInputText || tab instanceof vscode.TabInputCustom) {
          if (isSupportedPath(tab.uri.path) || isGzipPath(tab.uri.path)) return await resolveTarget(tab.uri);
        }
        const cur = activeSession();
        if (cur?.resource) return await resolveTarget(cur.resource);
      }
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
    else if (what.gzip) await vscode.commands.executeCommand('vscode.openWith', what.uri, COMPRESSED_VIEW_TYPE);
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
  reg('betterJsonl.convertFormat', async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor) return convertFormat(editor);
    return false;
  });
  reg('betterJsonl.compareFiles', async (uri?: vscode.Uri) => {
    let s = activeSession();
    if (!s) {
      const what = await target(undefined);
      if (!what) return;
      s = preview.show(what, true);
    }
    const other = uri instanceof vscode.Uri && s.resource?.toString() !== uri.toString() ? uri : undefined;
    await s.compareWithFile(other);
  });
  reg('betterJsonl.mergeFiles', async (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
    let uris: vscode.Uri[] = [];
    if (Array.isArray(selectedUris) && selectedUris.length >= 2) {
      uris = selectedUris.filter((u) => u instanceof vscode.Uri);
    } else if (Array.isArray(uri)) {
      uris = (uri as unknown as vscode.Uri[]).filter((u) => u instanceof vscode.Uri);
    } else {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: t('Merge Open in Better JSONL'),
        filters: { 'JSON / JSON Lines': ['jsonl', 'ndjson', 'jsonlines', 'json', 'gz', 'br', 'zst'] },
      });
      if (picked && picked.length >= 1) uris = picked;
    }
    if (!uris.length) return undefined;
    try {
      const text = await readMergedJsonl(uris);
      const title = `Merged (${uris.length} files).jsonl`;
      const panel = vscode.window.createWebviewPanel(
        PREVIEW_VIEW_TYPE,
        title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      const session = new ViewerSession(panel, env, 'preview');
      session.bindVirtual(title, text);
      track(session);
      return session;
    } catch (e) {
      void vscode.window.showErrorMessage(t('Better JSONL could not read the file: {0}', e instanceof Error ? e.message : String(e)));
      return undefined;
    }
  });

  return {
    sessions: () => [...sessions],
    preview: () => preview.current,
    inspect: () => [...sessions].map((s) => s.snapshot()),
  };
}

export function deactivate(): void {}
