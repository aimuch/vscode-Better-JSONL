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
}

export interface DocInfo {
  uri: string;
  fileName: string;
  languageId: string;
  isJsonl: boolean;
  /** 'editor' = custom editor (replaces the text editor). 'preview' = side panel. */
  host: 'editor' | 'preview';
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
  grid?: { rows: number; columns: string[]; openCells: number };
  graph?: { nodes: number; edges: number; truncated: boolean; selectedPath?: string };
  matches: number;
  filterOnly: boolean;
  wrap: boolean;
  /** The theme in use: 'vscode' when the VS Code theme applies. */
  theme: 'vscode' | 'light' | 'dark';
  settingsOpen: boolean;
  lang: Lang;
  version: number;
}

export type HostMessage =
  | { type: 'init'; doc: DocInfo; text: string; version: number; config: ViewerConfig }
  | { type: 'update'; text: string; version: number }
  | { type: 'selection'; lines: number[]; active: number }
  | { type: 'config'; config: ViewerConfig }
  | { type: 'setView'; view: ViewKind }
  | { type: 'toggleExpandMode' }
  | { type: 'toggleWrap' }
  | { type: 'editResult'; ok: boolean; message?: string }
  | { type: 'notice'; message: string };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'select'; line: number }
  | { type: 'reveal'; line: number; path: JsonPath }
  | { type: 'editLine'; line: number; original: string; text: string }
  | { type: 'copy'; text: string }
  | { type: 'openAsText' }
  | { type: 'export'; format: 'svg' | 'png'; data: string; name: string }
  | { type: 'setSetting'; key: SettingKey; value: unknown }
  | { type: 'openSettings' }
  | { type: 'report'; report: RenderReport };
