// Extension-host E2E tests. They run in a real VS Code with the extension loaded.
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BetterJsonlApi } from '../../src/extension';
import type { ViewerSession } from '../../src/session';
import { minifyJson, prettyJson } from '../../src/shared/jsonText';
import type { RenderReport } from '../../src/shared/protocol';

const FIXTURES = process.env.BETTER_JSONL_FIXTURES as string;
const uri = (name: string) => vscode.Uri.file(path.join(FIXTURES, name));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const parsed = (r: RenderReport) => r.stats.parsed >= r.stats.lines;

async function waitFor<T>(fn: () => T | undefined | false, label: string, timeout = 10000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await settle(50);
  }
  throw new Error(`Timed out: ${label}`);
}

let api: BetterJsonlApi;

async function openEditor(name: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri(name));
  return vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
}

async function previewFor(name: string): Promise<ViewerSession> {
  const editor = await openEditor(name);
  await vscode.commands.executeCommand('betterJsonl.openPreviewToSide');
  const s = await waitFor(() => {
    const p = api.preview();
    return p && p.document === editor.document ? p : undefined;
  }, 'preview session');
  await s.waitForReport((r) => parsed(r) && r.fileName === name && r.version === editor.document.version);
  return s;
}

async function customEditorFor(name: string): Promise<ViewerSession> {
  await vscode.commands.executeCommand('vscode.openWith', uri(name), 'betterJsonl.viewer');
  const s = await waitFor(
    () => api.sessions().find((x) => x.host === 'editor' && x.document?.uri.fsPath === uri(name).fsPath),
    `custom editor for ${name}`,
  );
  await s.waitForReport((r) => parsed(r) && r.fileName === name);
  return s;
}

before(async () => {
  const ext = vscode.extensions.getExtension<BetterJsonlApi>('andy.better-jsonl');
  assert.ok(ext, 'extension is installed');
  api = await ext.activate();
});

afterEach(async () => {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue;
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
});

describe('Better JSONL · extension host', () => {
  it('H01 registers every command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'betterJsonl.openPreviewToSide',
      'betterJsonl.openPreview',
      'betterJsonl.openInViewer',
      'betterJsonl.openAsText',
      'betterJsonl.showFormatted',
      'betterJsonl.showGrid',
      'betterJsonl.showGraph',
      'betterJsonl.toggleExpandMode',
      'betterJsonl.expandLines',
      'betterJsonl.compactLines',
    ]) {
      assert.ok(all.includes(id), id);
    }
  });

  it('H02 preview opens beside the editor and counts lines, errors and blanks [F1, F4]', async () => {
    const s = await previewFor('events.jsonl');
    const r = s.lastReport as RenderReport;
    assert.strictEqual(r.isJsonl, true);
    assert.strictEqual(r.stats.lines, 21);
    assert.strictEqual(r.stats.valid, 18);
    assert.strictEqual(r.stats.errors, 2);
    assert.strictEqual(r.stats.blank, 1);
    assert.strictEqual(r.view, 'formatted');
    assert.strictEqual(r.expandMode, 'focus');
    assert.ok(s.panel.visible, 'panel visible');
    assert.strictEqual(s.panel.viewColumn, vscode.ViewColumn.Two);
  });

  it('H03 editor cursor and selection drive the preview (Focus mode) [F12]', async () => {
    const s = await previewFor('events.jsonl');
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === s.document) as vscode.TextEditor;
    editor.selection = new vscode.Selection(2, 4, 2, 4);
    let r = await s.waitForReport((x) => x.active === 2);
    assert.deepStrictEqual(r.selected, [2]);
    assert.strictEqual(r.formatted?.expandedRecords, 1);
    editor.selection = new vscode.Selection(4, 0, 7, 0);
    r = await s.waitForReport((x) => x.selected.length === 3);
    assert.deepStrictEqual(r.selected, [4, 5, 6], 'a selection that ends at column 0 does not include that line');
    assert.strictEqual(r.formatted?.expandedRecords, 2, 'line 6 is invalid, so two records expand');
  });

  it('H04 a click in the view moves the editor cursor without a feedback loop [F12]', async () => {
    const s = await previewFor('events.jsonl');
    const editor = vscode.window.visibleTextEditors.find((e) => e.document === s.document) as vscode.TextEditor;
    await s.handle({ type: 'select', line: 8 });
    assert.strictEqual(editor.selection.active.line, 8);
    await settle(800);
    assert.strictEqual(editor.selection.active.line, 8, 'cursor stays put');
    assert.strictEqual(editor.selection.isEmpty, true);
  });

  it('H05 reveal selects the member text, also for keys with dots and quotes [F17]', async () => {
    let s = await previewFor('events.jsonl');
    await s.handle({ type: 'reveal', line: 0, path: ['user', 'name'] });
    let ed = vscode.window.activeTextEditor as vscode.TextEditor;
    assert.strictEqual(ed.document.getText(ed.selection), '"name":"Lin"');
    s = await previewFor('special-keys.jsonl');
    await s.handle({ type: 'reveal', line: 1, path: ['a.b', 'say "hi"'] });
    ed = vscode.window.activeTextEditor as vscode.TextEditor;
    assert.strictEqual(ed.selection.start.line, 1);
    assert.strictEqual(ed.document.getText(ed.selection), '"say \\"hi\\"":[30]');
  });

  it('H06 editing a record writes one compact line and keeps big integers exact [F3]', async () => {
    const s = await previewFor('events.jsonl');
    const doc = s.document as vscode.TextDocument;
    const before = doc.lineCount;
    const original = doc.lineAt(2).text;
    const edited = prettyJson(original, 2).replace('"slow query"', '"slow query (edited)"');
    await s.handle({ type: 'editLine', line: 2, original, text: edited });
    await waitFor(() => doc.lineAt(2).text.includes('(edited)'), 'line rewritten');
    assert.strictEqual(doc.lineAt(2).text, minifyJson(edited));
    assert.ok(doc.lineAt(2).text.includes('"trace":9007199254740993'), 'big integer unchanged');
    assert.strictEqual(doc.lineCount, before, 'still one line per record');
    const r = await s.waitForReport((x) => x.version === doc.version && parsed(x));
    assert.strictEqual(r.stats.valid, 18);
    await vscode.commands.executeCommand('undo');
  });

  it('H07 an edit is refused when the line changed meanwhile [F13]', async () => {
    const s = await previewFor('events.jsonl');
    const doc = s.document as vscode.TextDocument;
    const text = doc.getText();
    await s.handle({ type: 'editLine', line: 3, original: '{"stale":true}', text: '{"x":1}' });
    await s.handle({ type: 'editLine', line: 3, original: doc.lineAt(3).text, text: '{"broken": }' });
    await settle(300);
    assert.strictEqual(doc.getText(), text, 'document unchanged');
  });

  it('H08 Format Document leaves JSONL files unchanged unless the setting is on [F3]', async () => {
    const content = [
      '{ "a" : 1,  "big": 12345678901234567890, "s": "x  y" }',
      '{"bad": }',
      '',
      '[ 1, 2, { "n": 1.50 } ]',
      '',
    ].join('\n');
    // A saved file on disk with spaces inside its lines (line 20): Format Document must not touch it.
    const file = await openEditor('events.jsonl');
    const before = file.document.getText();
    await vscode.commands.executeCommand('editor.action.formatDocument');
    await settle(300);
    assert.strictEqual(file.document.getText(), before, 'Format Document does not change the file');
    assert.strictEqual(file.document.isDirty, false, 'the file stays saved');
    const doc = await vscode.workspace.openTextDocument({ language: 'jsonl', content });
    await vscode.window.showTextDocument(doc);
    const format = async () =>
      (await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatDocumentProvider', doc.uri, { tabSize: 2, insertSpaces: true })) ?? [];
    assert.strictEqual((await format()).length, 0, 'no JSONL formatter by default');
    const cfg = vscode.workspace.getConfiguration('betterJsonl');
    await cfg.update('formatDocument.enabled', true, vscode.ConfigurationTarget.Global);
    try {
      let edits: vscode.TextEdit[] = [];
      const end = Date.now() + 5000;
      while (!edits.length && Date.now() < end) {
        edits = await format();
        if (!edits.length) await settle(50);
      }
      assert.ok(edits.length > 0, 'the formatter is registered after the setting turns on');
      const we = new vscode.WorkspaceEdit();
      we.set(doc.uri, edits);
      await vscode.workspace.applyEdit(we);
      assert.strictEqual(doc.getText(), ['{"a":1,"big":12345678901234567890,"s":"x  y"}', '{"bad": }', '', '[1,2,{"n":1.50}]', ''].join('\n'));
    } finally {
      await cfg.update('formatDocument.enabled', undefined, vscode.ConfigurationTarget.Global);
    }
    const other = await vscode.workspace.openTextDocument({ language: 'jsonl', content: '{ "x" : 1 }\n' });
    const off = (await vscode.commands.executeCommand<vscode.TextEdit[] | undefined>('vscode.executeFormatDocumentProvider', other.uri, { tabSize: 2, insertSpaces: true })) ?? [];
    assert.strictEqual(off.length, 0, 'turning the setting off removes the formatter again');
  });

  it('H09 Expand Selected Lines follows the editor indent; Compact Lines restores the file, CRLF kept [F5, F18]', async () => {
    const editor = await openEditor('crlf.jsonl');
    const doc = editor.document;
    const original = doc.getText();
    assert.strictEqual(doc.eol, vscode.EndOfLine.CRLF);
    editor.options = { tabSize: 4, insertSpaces: true };
    editor.selection = new vscode.Selection(0, 0, 1, 3);
    const n = await vscode.commands.executeCommand<number>('betterJsonl.expandLines');
    assert.strictEqual(n, 2);
    assert.ok(doc.getText().startsWith('{\r\n    "a": 1,\r\n    "b": "x"\r\n}\r\n{\r\n'), JSON.stringify(doc.getText().slice(0, 40)));
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    let ok = await vscode.commands.executeCommand<boolean>('betterJsonl.compactLines');
    assert.strictEqual(ok, true);
    assert.strictEqual(doc.getText(), original);
    editor.options = { insertSpaces: false };
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand<number>('betterJsonl.expandLines');
    assert.ok(doc.getText().includes('{\r\n\t"a": 3,\r\n\t"b": "z"\r\n}'), 'tabs when the editor indents with tabs');
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    ok = await vscode.commands.executeCommand<boolean>('betterJsonl.compactLines');
    assert.strictEqual(ok, true);
    assert.strictEqual(doc.getText(), original);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  it('H10 Compact Lines refuses invalid JSON and changes nothing [F18]', async () => {
    const doc = await vscode.workspace.openTextDocument({ language: 'jsonl', content: '{\n  "a": 1\n}\n{"b": \n' });
    const editor = await vscode.window.showTextDocument(doc);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const ok = await vscode.commands.executeCommand<boolean>('betterJsonl.compactLines');
    assert.strictEqual(ok, false);
    assert.strictEqual(doc.getText(), '{\n  "a": 1\n}\n{"b": \n');
  });

  it('H11 Open With → Better JSONL works for .json and detects JSONC [F10, F16]', async () => {
    let s = await customEditorFor('sample.json');
    assert.strictEqual(s.lastReport?.isJsonl, false);
    assert.strictEqual(s.lastReport?.stats.jsonc, false);
    s = await customEditorFor('comments.json');
    assert.strictEqual(s.lastReport?.stats.jsonc, true);
    s = await customEditorFor('lines.json');
    assert.strictEqual(s.lastReport?.isJsonl, true, '.json with one value per line is shown as JSONL');
    s = await customEditorFor('scalar.json');
    assert.strictEqual(s.lastReport?.stats.valid, 1);
  });

  it('H12 view commands reach the active Better JSONL editor', async () => {
    const s = await customEditorFor('events.jsonl');
    await vscode.commands.executeCommand('betterJsonl.showGraph');
    let r = await s.waitForReport((x) => x.view === 'graph');
    assert.ok((r.graph?.nodes ?? 0) >= 1);
    await vscode.commands.executeCommand('betterJsonl.showGrid');
    r = await s.waitForReport((x) => x.view === 'grid');
    assert.strictEqual(r.grid?.rows, 20);
    await vscode.commands.executeCommand('betterJsonl.showFormatted');
    await s.waitForReport((x) => x.view === 'formatted');
    await vscode.commands.executeCommand('betterJsonl.toggleExpandMode');
    r = await s.waitForReport((x) => x.expandMode === 'all');
    assert.strictEqual(r.formatted?.expandedRecords, 18);
    await vscode.commands.executeCommand('betterJsonl.toggleExpandMode');
    await s.waitForReport((x) => x.expandMode === 'focus');
  });

  it('H13 document edits reach the view and keep view and selection [F11]', async () => {
    const s = await customEditorFor('events.jsonl');
    const doc = s.document as vscode.TextDocument;
    await vscode.commands.executeCommand('betterJsonl.showGrid');
    await s.waitForReport((x) => x.view === 'grid');
    const we = new vscode.WorkspaceEdit();
    we.insert(doc.uri, new vscode.Position(doc.lineCount, 0), '{"id":2000,"level":"info"}\n');
    await vscode.workspace.applyEdit(we);
    const r = await s.waitForReport((x) => x.version === doc.version && parsed(x));
    assert.strictEqual(r.stats.lines, 22);
    assert.strictEqual(r.view, 'grid');
    assert.strictEqual(r.grid?.rows, 21);
    await vscode.commands.executeCommand('undo');
  });

  it('H14 Open as Text swaps the Better JSONL editor for the text editor', async () => {
    const s = await customEditorFor('sample.json');
    await vscode.commands.executeCommand('betterJsonl.openAsText');
    await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === uri('sample.json').fsPath, 'text editor active');
    await waitFor(() => !api.sessions().includes(s), 'custom editor closed');
  });

  it('H16 open commands sit at the top level of the right-click menus, with plain conditions', async () => {
    const pkg = vscode.extensions.getExtension('andy.better-jsonl')?.packageJSON;
    const menus = pkg.contributes.menus as Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
    const ids = (menu: string) => (menus[menu] ?? []).map((m) => m.command);
    for (const menu of ['editor/context', 'explorer/context', 'editor/title/context']) {
      assert.ok(ids(menu).includes('betterJsonl.openPreviewToSide'), `${menu}: preview`);
      assert.ok(ids(menu).includes('betterJsonl.openInViewer'), `${menu}: full view`);
      assert.ok(!(menus[menu] ?? []).some((m) => m.submenu), `${menu}: no submenu`);
    }
    const title = (menus['editor/title'] ?? []).find((m) => m.command === 'betterJsonl.openPreviewToSide');
    assert.ok(title, 'editor title button');
    // editorLangId is only visible to the title toolbar while the editor has focus.
    assert.ok(!/editorLangId/.test(title.when ?? '') && /resourceLangId == jsonl/.test(title.when ?? ''), `title button condition: ${title.when}`);
    // VS Code shows at most 9 title buttons; a negative order keeps this one ahead of other extensions.
    assert.ok(/^navigation@-\d+$/.test(title.group ?? ''), `title button group: ${title.group}`);
    const whens = [...Object.values(menus).flat().map((m) => m.when ?? ''), ...pkg.contributes.keybindings.map((k: { when: string }) => k.when)];
    assert.ok(whens.every((w) => !w.includes('=~')), 'no regex conditions');
    // Titles come from package.nls.json ("%command.x%" placeholders) unless VS Code already resolved them.
    const nls = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(vscode.extensions.getExtension('andy.better-jsonl')!.extensionUri, 'package.nls.json'))).toString('utf8'));
    for (const c of pkg.contributes.commands as { title: string }[]) {
      const title = /^%(.+)%$/.test(c.title) ? nls[c.title.slice(1, -1)] : c.title;
      assert.ok(typeof title === 'string' && title.startsWith('Better JSONL: '), c.title);
    }
  });

  it('H18 every packaged icon file is a real, non-empty image', async () => {
    const ext = vscode.extensions.getExtension('andy.better-jsonl') as vscode.Extension<unknown>;
    const pkg = ext.packageJSON;
    const files = new Set<string>([pkg.icon]);
    for (const c of pkg.contributes.commands as { icon?: string | { light: string; dark: string } }[]) {
      if (c.icon && typeof c.icon === 'object') {
        files.add(c.icon.light);
        files.add(c.icon.dark);
      }
    }
    for (const rel of files) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ext.extensionUri, rel));
      assert.ok(bytes.length > 100, `${rel} has ${bytes.length} bytes`);
      if (rel.endsWith('.svg')) assert.ok(Buffer.from(bytes).toString('utf8').includes('<path'), `${rel} draws something`);
    }
  });

  it('H17 the right-click commands open the file passed as an argument', async () => {
    await vscode.commands.executeCommand('betterJsonl.openPreviewToSide', uri('special-keys.jsonl'));
    const p = await waitFor(() => (api.preview()?.document?.uri.fsPath === uri('special-keys.jsonl').fsPath ? api.preview() : undefined), 'preview for the given file');
    await p.waitForReport((r) => r.fileName === 'special-keys.jsonl' && parsed(r));
    await vscode.commands.executeCommand('betterJsonl.openInViewer', uri('crlf.jsonl'));
    const s = await waitFor(() => api.sessions().find((x) => x.host === 'editor' && x.document?.uri.fsPath === uri('crlf.jsonl').fsPath), 'full view');
    const r = await s.waitForReport((x) => x.fileName === 'crlf.jsonl' && parsed(x));
    assert.strictEqual(r.stats.valid, 3);
  });

  it('H19 Toggle Word Wrap (Alt+Z) flips wrapping in the active Better JSONL view', async () => {
    const s = await customEditorFor('events.jsonl');
    const start = (s.lastReport as RenderReport).wrap;
    await vscode.commands.executeCommand('betterJsonl.toggleWordWrap');
    await s.waitForReport((x) => x.wrap === !start);
    await vscode.commands.executeCommand('betterJsonl.toggleWordWrap');
    await s.waitForReport((x) => x.wrap === start);
    const keys = vscode.extensions.getExtension('andy.better-jsonl')?.packageJSON.contributes.keybindings as { command: string; key: string; when: string }[];
    const kb = keys.find((k) => k.command === 'betterJsonl.toggleWordWrap');
    assert.strictEqual(kb?.key, 'alt+z');
    assert.ok(kb?.when.includes("activeWebviewPanelId == 'betterJsonl.preview'") && kb.when.includes("activeCustomEditorId == 'betterJsonl.viewer'"), kb?.when);
  });

  it('H20 the settings panel writes VS Code user settings; unknown keys are refused', async () => {
    const s = await customEditorFor('events.jsonl');
    const cfg = () => vscode.workspace.getConfiguration('betterJsonl');
    try {
      await s.handle({ type: 'setSetting', key: 'theme', value: 'light' });
      assert.strictEqual(cfg().inspect('theme')?.globalValue, 'light');
      let r = await s.waitForReport((x) => x.theme === 'light');
      assert.strictEqual(r.theme, 'light');
      await s.handle({ type: 'setSetting', key: 'graph.maxNodes', value: 700 });
      assert.strictEqual(cfg().get('graph.maxNodes'), 700);
      await s.handle({ type: 'setSetting', key: 'nope' as never, value: 1 });
      assert.strictEqual(cfg().inspect('nope')?.globalValue, undefined);
      await s.handle({ type: 'setSetting', key: 'theme', value: 'vscode' });
      r = await s.waitForReport((x) => x.theme === 'vscode');
      assert.strictEqual(r.theme, 'vscode');
    } finally {
      await cfg().update('theme', undefined, vscode.ConfigurationTarget.Global);
      await cfg().update('graph.maxNodes', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('H21 word wrap follows editor.wordWrap until the setting says on or off', async () => {
    const s = await customEditorFor('events.jsonl');
    const editor = vscode.workspace.getConfiguration('editor');
    const mine = vscode.workspace.getConfiguration('betterJsonl');
    try {
      await editor.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
      await s.waitForReport((x) => x.wrap === true);
      await mine.update('wordWrap', 'off', vscode.ConfigurationTarget.Global);
      await s.waitForReport((x) => x.wrap === false);
      await mine.update('wordWrap', 'on', vscode.ConfigurationTarget.Global);
      await s.waitForReport((x) => x.wrap === true);
      await editor.update('wordWrap', 'off', vscode.ConfigurationTarget.Global);
      await settle(300);
      assert.strictEqual((s.lastReport as RenderReport).wrap, true, 'betterJsonl.wordWrap "on" wins over the editor setting');
    } finally {
      await mine.update('wordWrap', undefined, vscode.ConfigurationTarget.Global);
      await editor.update('wordWrap', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('H22 the language setting switches the view language; menus are localized through package.nls', async () => {
    const s = await customEditorFor('events.jsonl');
    const cfg = vscode.workspace.getConfiguration('betterJsonl');
    try {
      assert.strictEqual((s.lastReport as RenderReport).lang, vscode.env.language.startsWith('zh') ? 'zh-cn' : 'en');
      await s.handle({ type: 'setSetting', key: 'language', value: 'zh-cn' });
      await s.waitForReport((x) => x.lang === 'zh-cn');
      await s.handle({ type: 'setSetting', key: 'language', value: 'en' });
      await s.waitForReport((x) => x.lang === 'en');
    } finally {
      await cfg.update('language', undefined, vscode.ConfigurationTarget.Global);
    }
    const ext = vscode.extensions.getExtension('andy.better-jsonl') as vscode.Extension<unknown>;
    const read = async (name: string) => JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(ext.extensionUri, name))).toString('utf8'));
    const en = await read('package.nls.json');
    const zh = await read('package.nls.zh-cn.json');
    assert.deepStrictEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'every English entry has a Chinese one');
    assert.strictEqual(zh['command.openPreviewToSide'], 'Better JSONL: 在侧边打开预览');
  });

  it('H15 the preview follows the active JSON editor', async () => {
    const s = await previewFor('events.jsonl');
    await openEditor('sample.json');
    const r = await s.waitForReport((x) => x.isJsonl === false && parsed(x));
    assert.strictEqual(s.document?.uri.fsPath, uri('sample.json').fsPath);
    assert.strictEqual(r.formatted?.expandedRecords, 1);
  });
});
