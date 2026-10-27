// UI language for the webview and the extension host messages.
// The English text is the key; ZH holds the Simplified Chinese text. A missing entry falls back to English.

export type Lang = 'en' | 'zh-cn';
export type LanguageSetting = 'auto' | Lang;

let current: Lang = 'en';

export function setLang(lang: Lang): void {
  current = lang;
}

export function getLang(): Lang {
  return current;
}

/** 'auto' follows the VS Code display language (zh-cn, zh-sg and zh-hans* map to Simplified Chinese). */
export function resolveLang(setting: string | undefined, vscodeLanguage: string): Lang {
  if (setting === 'en' || setting === 'zh-cn') return setting;
  return /^zh(-(cn|sg|hans.*))?$/i.test(vscodeLanguage) ? 'zh-cn' : 'en';
}

/** Name of a VS Code display language, for "Follow VS Code (current: …)". */
export function languageName(vscodeLanguage: string): string {
  if (/^zh(-(cn|sg|hans.*))?$/i.test(vscodeLanguage)) return '简体中文';
  if (/^en\b/i.test(vscodeLanguage)) return 'English';
  return vscodeLanguage;
}

export function t(text: string, ...args: (string | number)[]): string {
  const s = current === 'zh-cn' ? (ZH[text] ?? text) : text;
  return args.length ? s.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])) : s;
}

const ZH: Record<string, string> = {
  // views and toolbar
  Formatted: '格式化',
  Grid: '表格',
  Graph: '图',
  'Loading…': '加载中…',
  'Better JSONL toolbar': 'Better JSONL 工具栏',
  View: '视图',
  'JSONL format mode': 'JSONL 格式化模式',
  'Only the current or selected lines are pretty-printed': '只展开当前行或选中的行',
  Focus: '聚焦',
  'All lines are pretty-printed': '展开全部行',
  'Expand all': '全部展开',
  Fold: '折叠',
  Unfold: '展开',
  Expand: '展开',
  Collapse: '收起',
  'Expand every node': '展开所有节点',
  'Collapse all': '全部折叠',
  'Collapse every node below the root': '折叠根节点以下的所有节点',
  'Line selector': '行选择器',
  Line: '行',
  'Previous line': '上一行',
  'Line number': '行号',
  'Next line': '下一行',
  'of {0}': '共 {0}',
  Search: '搜索',
  'Search · or path:text, path=value  ({0}F)': '搜索 · 或 path:text、path=value（{0}F）',
  'Previous match': '上一个匹配',
  'Next match': '下一个匹配',
  'Show only matching lines': '只显示匹配的行',
  'Word wrap ({0})': '自动换行（{0}）',
  'Open as text': '以文本打开',
  Settings: '设置',
  'Line {0}': '第 {0} 行',
  '{0} selected': '已选 {0} 行',
  'JSON with Comments': '带注释的 JSON',
  'Focus: selected lines are expanded': '聚焦：展开选中的行',
  'All lines expanded': '已展开全部行',
  'Drag or scroll to pan · {0}+scroll to zoom · click a node to inspect': '拖动或滚动平移 · {0}+滚轮缩放 · 点击节点查看详情',
  'Click a header to sort · drag a header edge to resize': '点击表头排序 · 拖动表头边缘调整列宽',
  '↑/↓ move · Shift extends · Enter edits · double-click jumps to source': '↑/↓ 移动 · Shift 扩展选择 · Enter 编辑 · 双击跳到源码',
  'Click ▸ to fold · double-click jumps to source': '点击 ▸ 折叠 · 双击跳到源码',
  '{0} lines': '{0} 行',
  'parsing {0}%': '解析中 {0}%',
  'Go to the next error': '跳到下一个错误',
  '{0} error': '{0} 个错误',
  '{0} errors': '{0} 个错误',
  'This .json file holds one JSON value per line. It is shown as JSON Lines.': '此 .json 文件每行是一个 JSON 值，按 JSON Lines 显示。',
  'Parsed as JSON with Comments (comments or trailing commas found).': '已按带注释的 JSON 解析（发现注释或尾随逗号）。',

  // record editor
  'Edit record': '编辑记录',
  'Record JSON': '记录 JSON',
  'Edit line {0}': '编辑第 {0} 行',
  Apply: '应用',
  Cancel: '取消',
  'The record is saved back as one compact line.': '记录会保存为一行紧凑的 JSON。',
  'Saving…': '保存中…',
  'The edit failed.': '编辑失败。',

  // formatted view
  'Formatted records': '格式化记录',
  'No line matches the search.': '没有匹配搜索的行。',
  'The file is empty.': '文件为空。',
  'Invalid JSON': '无效的 JSON',
  '{0} · line {1}': '{0} · 第 {1} 行',
  ', col {0}': '，第 {0} 列',
  'Edit this record (Enter)': '编辑这条记录（Enter）',
  Edit: '编辑',
  'Copy the raw line': '复制原始行',
  Copy: '复制',
  'Reveal in the text editor': '在文本编辑器中显示',
  Source: '源码',
  ' … {0} more chars': ' … 还有 {0} 个字符',
  '{0} item': '{0} 项',
  '{0} items': '{0} 项',
  '{0} key': '{0} 个键',
  '{0} keys': '{0} 个键',

  // grid view
  'No row matches the filter.': '没有匹配筛选的行。',
  'No rows.': '没有数据行。',
  '(value)': '（值）',
  key: '键',
  value: '值',
  'line {0} · ': '第 {0} 行 · ',
  '… {0} more': '… 还有 {0} 项',
  object: '对象',
  array: '数组',
  string: '字符串',
  number: '数字',
  boolean: '布尔值',
  null: '空值',

  // graph view
  'Graph canvas': '图画布',
  'Export graph': '导出图',
  Zoom: '缩放',
  'Zoom out': '缩小',
  'Zoom in': '放大',
  'Fit to view': '适应窗口',
  'Node inspector': '节点检查器',
  '{0} selected lines': '已选 {0} 行',
  'line {0}': '第 {0} 行',
  selection: '选择',
  'Line {0} is not valid JSON: {1}': '第 {0} 行不是有效的 JSON：{1}',
  'Nothing to show for this line.': '这一行没有可显示的内容。',
  'The graph stops at {0} nodes (setting betterJsonl.graph.maxNodes). Collapse nodes or pick a smaller record.':
    '图最多显示 {0} 个节点（设置 betterJsonl.graph.maxNodes）。请折叠节点，或选择更小的记录。',
  'Click a node to see its path and value.': '点击节点查看路径和值。',
  Node: '节点',
  PATH: '路径',
  TYPE: '类型',
  VALUE: '值',
  'Copy path': '复制路径',
  'Copy value': '复制值',
  'Reveal in editor': '在编辑器中显示',

  // settings panel
  'Better JSONL settings': 'Better JSONL 设置',
  'Close settings': '关闭设置',
  'Saved to your VS Code user settings.': '保存在 VS Code 用户设置中。',
  'Open in VS Code Settings': '在 VS Code 设置中打开',
  APPEARANCE: '外观',
  Theme: '主题',
  'Follow VS Code': '跟随 VS Code',
  Light: '浅色',
  Dark: '深色',
  'Follow system': '跟随系统',
  'Word wrap': '自动换行',
  'Follow editor': '跟随编辑器',
  On: '开',
  Off: '关',
  '{0} toggles wrap in the open view.': '{0} 切换当前视图的自动换行。',
  Indent: '缩进',
  '{0} spaces': '{0} 个空格',
  'Used by the views and the record editor.': '用于视图和记录编辑器。',
  VIEWS: '视图',
  'Default view': '默认视图',
  'JSON Lines': 'JSON Lines 模式',
  'The mode a new view starts in.': '新视图打开时使用的模式。',
  'Graph nodes': '图节点上限',
  'Graph node limit': '图节点上限',
  'The graph stops adding nodes after this number.': '图节点超过这个数量后不再增加。',
  'TEXT EDITOR': '文本编辑器',
  'Sync the current line with the text editor': '与文本编辑器同步当前行',
  'Moving the cursor expands that line; clicking a line moves the cursor.': '移动光标会展开对应行；点击某行会移动光标。',
  'Format Document compacts JSONL lines': '“格式化文档”压缩 JSONL 的每一行',
  'Off: Format Document does not change .jsonl files.': '关闭时，“格式化文档”不修改 .jsonl 文件。',
  'Remind me after Expand Selected Lines': '“展开选中行”后提醒我',
  'The file is not valid JSON Lines until you compact it.': '压缩之前，文件不是合法的 JSON Lines。',
  LANGUAGE: '界面语言',
  'Follow VS Code (current: {0})': '跟随 VS Code（当前：{0}）',
  'Right-click menus and the VS Code Settings editor always use the VS Code display language.':
    '右键菜单和 VS Code 设置编辑器中的文字始终跟随 VS Code 的显示语言。',

  // extension host messages
  'Better JSONL: copied to clipboard': 'Better JSONL：已复制到剪贴板',
  'Better JSONL: saved {0}': 'Better JSONL：已保存 {0}',
  'No document.': '没有打开的文档。',
  'Line {0} changed after the edit started. Nothing was written.': '第 {0} 行在编辑期间被修改，未写入任何内容。',
  'VS Code rejected the edit.': 'VS Code 拒绝了这次编辑。',
  'SVG image': 'SVG 图片',
  'PNG image': 'PNG 图片',
  'Unknown setting: {0}': '未知的设置项：{0}',
  'Better JSONL: expanded {0} record(s). The file is not valid JSON Lines until you compact it again.':
    'Better JSONL：已展开 {0} 条记录。重新压缩之前，文件不是合法的 JSON Lines。',
  'Compact Lines': '压缩行',
  "Don't Show Again": '不再提示',
  'Better JSONL: line {0} is not valid JSON ({1}). Nothing changed.': 'Better JSONL：第 {0} 行不是有效的 JSON（{1}）。未做任何修改。',
  'Better JSONL: open a JSON or JSONL file first. VS Code does not give extensions files larger than 50 MB.':
    'Better JSONL：请先打开一个 JSON 或 JSONL 文件。VS Code 不会把大于 50 MB 的文件交给扩展。',
  'Better JSONL: open a Better JSONL view first.': 'Better JSONL：请先打开一个 Better JSONL 视图。',
};
