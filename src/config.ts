import * as vscode from 'vscode';
import type { ViewerConfig, WrapSetting } from './shared/protocol';

/** Settings for a viewer. `doc` scopes "editor.wordWrap" to the document's language. */
export function readConfig(doc?: vscode.TextDocument): ViewerConfig {
  const c = vscode.workspace.getConfiguration('betterJsonl');
  const wordWrap = c.get<WrapSetting>('wordWrap', 'followEditor');
  const editorWrap = vscode.workspace.getConfiguration('editor', doc).get<string>('wordWrap', 'off');
  return {
    defaultView: c.get('defaultView', 'formatted'),
    expandMode: c.get('jsonl.expandMode', 'focus'),
    indent: c.get('indent', 2),
    graphMaxNodes: c.get('graph.maxNodes', 1500),
    syncSelection: c.get('syncSelection', true),
    theme: c.get('theme', 'vscode'),
    wordWrap,
    wrap: wordWrap === 'on' || (wordWrap === 'followEditor' && editorWrap !== 'off'),
    formatDocument: c.get('formatDocument.enabled', false),
    expandReminder: c.get('expandLines.showReminder', true),
  };
}

/** Off by default: Format Document must not change JSONL files unless the user asks for it. */
export function formatDocumentEnabled(): boolean {
  return vscode.workspace.getConfiguration('betterJsonl').get('formatDocument.enabled', false);
}

export function previewFollowsActiveEditor(): boolean {
  return vscode.workspace.getConfiguration('betterJsonl').get('preview.followActiveEditor', true);
}

const JSONL_EXT = /\.(jsonl|ndjson|jsonlines)$/i;

export function isJsonlDocument(doc: vscode.TextDocument): boolean {
  return doc.languageId === 'jsonl' || JSONL_EXT.test(doc.uri.path);
}

export function isSupportedDocument(doc: vscode.TextDocument): boolean {
  return isJsonlDocument(doc) || doc.languageId === 'json' || doc.languageId === 'jsonc' || /\.json$/i.test(doc.uri.path);
}
