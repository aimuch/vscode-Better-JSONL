// Messages between the extension host and the Better JSONL webview.
import type { Lang, LanguageSetting } from './i18n';

export type ViewKind = 'formatted' | 'grid' | 'graph';
export type ExpandMode = 'focus' | 'all';
export type JsonPath = (string | number)[];
/** 'vscode' follows the VS Code color theme; 'system' follows the operating system. */
export type ThemeMode = 'vscode' | 'light' | 'dark' | 'system';
export type WrapSetting = 'followEditor' | 'on' | 'off';

/** Settings the webview may change (keys under "betterJsonl."). */
export const SETTING_KEYS = [
  'theme',
  'wordWrap',
  'indent',
  'defaultView',
  'jsonl.expandMode',
  'graph.maxNodes',
  'syncSelection',
  'preview.followActiveEditor',
  'formatDocument.enabled',
  'expandLines.showReminder',
  'language',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface ViewerConfig {
  defaultView: ViewKind;
  expandMode: ExpandMode;
  indent: number;
  graphMaxNodes: number;
  syncSelection: boolean;
  /** The side preview switches to the JSON/JSONL editor that becomes active. */
  followActiveEditor: boolean;
  theme: ThemeMode;
  wordWrap: WrapSetting;
  /** Word wrap resolved for this document (wordWrap, or editor.wordWrap when it is 'followEditor'). */
  wrap: boolean;
  formatDocument: boolean;
  expandReminder: boolean;
  /** The language setting, the language in use, and the VS Code display language. */
  language: LanguageSetting;
  lang: Lang;
  vscodeLanguage: string;
  /** The webview sends a "report" after each render. Only the tests turn this on. */
  reports: boolean;
}

/**
 * One change of a text document: the range it replaces (line and character, in the text
 * before the change) and the new text.
 */
export interface TextChange {
  sl: number;
  sc: number;
  el: number;
  ec: number;
  text: string;
}

export interface DocInfo {
  uri: string;
  fileName: string;
  languageId: string;
  isJsonl: boolean;
  /** 'editor' = custom editor (replaces the text editor). 'preview' = side panel. */
  host: 'editor' | 'preview';
  /**
   * The file is too large for VS Code to give to an extension. The host reads it from disk
   * and sends it as "chunk" messages (UTF-8 bytes). `bytes` is the file size.
   */
  large?: { bytes: number };
  /** The view cannot write to the file (large files). */
  readOnly?: boolean;
}

/** A summary the webview reports after each render. The E2E tests read it. */
export interface RenderReport {
  fileName: string;
  view: ViewKind;
  expandMode: ExpandMode;
  isJsonl: boolean;
  active: number;
  selected: number[];
  stats: { lines: number; valid: number; errors: number; blank: number; parsed: number; jsonc: boolean };
  formatted?: { totalRows: number; expandedRecords: number; renderedRows: number; firstRecord: number };
  /** JSON Lines: the start of the raw text of the active line. */
  activeText?: string;
  /** `unfiltered`: rows before the column filters. `filters`: the active column filters (text, unticked value count). */
  grid?: { rows: number; columns: string[]; openCells: number; unfiltered: number; filters: Record<string, { text: string; exclude: number }> };
  graph?: { nodes: number; edges: number; truncated: boolean; selectedPath?: string };
  matches: number;
  filterOnly: boolean;
  wrap: boolean;
  /** The theme in use: 'vscode' when the VS Code theme applies. */
  theme: 'vscode' | 'light' | 'dark';
  /** The file arrives as bytes; `loading` while chunks are still on the way. */
  large: boolean;
  loading: boolean;
  /** A search over a large file is still running. */
  searching: boolean;
  /** Limits that hide data right now (also shown in the status bar). */
  notes: string[];
  settingsOpen: boolean;
  lang: Lang;
  version: number;
}

export type HostMessage =
  | { type: 'init'; doc: DocInfo; text: string; version: number; config: ViewerConfig; bytes?: number }
  | { type: 'update'; text: string; version: number; bytes?: number }
  /**
   * The changes since the text the webview has (version `base`), for JSON Lines documents.
   * They apply in order. `lineCount` and `chars` describe the document after them: when the
   * webview gets something else, it asks for the whole text ("resync").
   */
  | { type: 'edit'; base: number; version: number; lineCount: number; chars: number; eol: 1 | 2; changes: TextChange[] }
  /** A piece of a large file. `version` is the version of the "init" it belongs to. */
  | { type: 'chunk'; version: number; data: Uint8Array; done: boolean }
  | { type: 'selection'; lines: number[]; active: number; truncated?: boolean }
  | { type: 'config'; config: ViewerConfig }
  | { type: 'setView'; view: ViewKind }
  | { type: 'toggleExpandMode' }
  | { type: 'toggleWrap' }
  | { type: 'editResult'; ok: boolean; message?: string }
  | { type: 'notice'; message: string; action?: 'reload' };

export type WebviewMessage =
  | { type: 'ready' }
  /** What the webview shows the document as. A .json file with one value per line is JSON Lines. */
  | { type: 'docMode'; isJsonl: boolean }
  /** The changes did not fit: send the whole text again. */
  | { type: 'resync' }
  /** Read the large file from disk again. */
  | { type: 'reload' }
  | { type: 'select'; line: number }
  | { type: 'reveal'; line: number; path: JsonPath }
  | { type: 'editLine'; line: number; original: string; text: string }
  | { type: 'copy'; text: string }
  | { type: 'openAsText' }
  | { type: 'export'; format: 'svg' | 'png'; data: string; name: string }
  | { type: 'setSetting'; key: SettingKey; value: unknown }
  | { type: 'openSettings' }
  | { type: 'report'; report: RenderReport };
