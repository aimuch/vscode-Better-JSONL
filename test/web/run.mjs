// Webview E2E: drives the real webview bundle in Chrome through the harness page.
// Output: test-results/web/*.png, test-results/web-e2e.json, test-results/report.html
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const outDir = `${root}test-results/web`;
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));

if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(2);
}

await mkdir(outDir, { recursive: true });
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/test/web/harness.html`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const results = [];

class Check {
  constructor() {
    this.items = [];
  }
  eq(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    this.items.push({ label, ok, actual, expected });
    return ok;
  }
  ok(label, cond, actual) {
    this.items.push({ label, ok: !!cond, actual });
    return !!cond;
  }
}

async function scenario(id, name, modes, fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const check = new Check();
  const shots = [];
  const shot = async (label) => {
    const file = `${id}-${shots.length + 1}.png`;
    await page.screenshot({ path: `${outDir}/${file}` });
    shots.push({ file, label });
  };
  const t0 = Date.now();
  let crash;
  try {
    await fn({ page, check, shot });
  } catch (e) {
    crash = String(e && e.stack ? e.stack : e);
  }
  check.ok('no page errors', errors.length === 0, errors);
  const pass = !crash && check.items.every((c) => c.ok);
  results.push({ id, name, modes, pass, ms: Date.now() - t0, crash, checks: check.items, shots });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${name}${crash ? `\n  ${crash}` : ''}`);
  for (const c of check.items) if (!c.ok) console.log(`  ✗ ${c.label}: got ${JSON.stringify(c.actual)?.slice(0, 300)} want ${JSON.stringify(c.expected)}`);
  await context.close();
}

// ---------- helpers ----------

async function open(page, file, opts = {}) {
  await page.goto(`${base}?theme=${opts.theme ?? 'dark'}`);
  await page.waitForFunction(() => window.harness && window.__posted.some((m) => m.type === 'ready'));
  await page.evaluate(([f, o]) => window.harness.load(f, o), [file, { text: opts.text, config: opts.config }]);
  return report(page, (r) => r.version === 1);
}

/** Waits for a report that matches `pred` (a function run in Node on each new report). */
async function report(page, pred = () => true, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await page.evaluate(() => window.harness.lastReport());
    if (last && pred(last)) return last;
    await page.waitForTimeout(40);
  }
  throw new Error(`report timeout; last=${JSON.stringify(last)}`);
}

async function complete(page) {
  return report(page, (r) => r.stats.parsed >= r.stats.lines);
}

const posted = (page, type) => page.evaluate((t) => window.harness.posted(t), type);
const send = (page, msg) => page.evaluate((m) => window.harness.send(m), msg);
const rowLocator = (page, r) => page.locator(`.formatted .row.first[data-r="${r}"]`);
const tabBtn = (page, view) => page.locator(`.toolbar [data-view="${view}"]`);

// ---------- scenarios ----------

await scenario('W01', 'JSONL opens in Formatted · Focus; bad lines are marked, others render', ['F1', 'F4'], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  const r = await complete(page);
  check.eq('view', r.view, 'formatted');
  check.eq('mode', r.expandMode, 'focus');
  check.eq('lines', r.stats.lines, 21);
  check.eq('valid', r.stats.valid, 18);
  check.eq('errors', r.stats.errors, 2);
  check.eq('blank lines are not errors', r.stats.blank, 1);
  check.eq('only the active record is expanded', r.formatted.expandedRecords, 1);
  const errRows = await page.locator('.formatted .row.err.first').count();
  check.eq('two error rows', errRows, 2);
  const msg = await page.locator('.formatted .err-msg').first().textContent();
  check.ok('error message names line and column', /line 6, col \d+/.test(msg), msg);
  const line7 = await rowLocator(page, 6).textContent();
  check.ok('line after the bad line renders', line7.includes('"id":1007'), line7);
  await shot('Focus mode: line 1 expanded, lines 6 and 21 marked invalid');
});

await scenario('W02', 'Click a line: it expands, the previous one collapses, the host gets "select"', ['F2'], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await rowLocator(page, 2).click({ position: { x: 300, y: 5 } });
  const r = await report(page, (x) => x.active === 2);
  check.eq('selected', r.selected, [2]);
  check.eq('expanded records', r.formatted.expandedRecords, 1);
  const sel = await posted(page, 'select');
  check.eq('host told to move the cursor', sel.at(-1), { type: 'select', line: 2 });
  const text = await page.locator('.formatted .rows').textContent();
  check.ok('big integer shown exactly (9007199254740993)', text.includes('9007199254740993'), text.match(/"trace": \S+/)?.[0]);
  await shot('Line 3 expanded after a click');
});

await scenario('W03', 'Shift-click selects a range; every selected line expands', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await rowLocator(page, 2).click({ position: { x: 300, y: 5 } });
  await report(page, (x) => x.active === 2);
  await rowLocator(page, 4).click({ position: { x: 300, y: 5 }, modifiers: ['Shift'] });
  const r = await report(page, (x) => x.active === 4);
  check.eq('selected range', r.selected, [2, 3, 4]);
  check.eq('three records expanded', r.formatted.expandedRecords, 3);
  await shot('Lines 3–5 selected and expanded');
});

await scenario('W04', 'Editor cursor sync: a "selection" message expands those lines and scrolls', ['F12'], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  const before = (await posted(page, 'select')).length;
  await send(page, { type: 'selection', lines: [16, 17], active: 17 });
  const r = await report(page, (x) => x.active === 17);
  check.eq('selected from editor', r.selected, [16, 17]);
  check.eq('two expanded', r.formatted.expandedRecords, 2);
  const after = (await posted(page, 'select')).length;
  check.eq('no echo back to the editor (no loop)', after, before);
  await send(page, { type: 'selection', lines: [16, 17], active: 17 });
  await page.waitForTimeout(200);
  check.eq('same selection again is a no-op', (await posted(page, 'select')).length, before);
  await shot('Lines 17–18 expanded from the editor selection');
});

await scenario('W05', 'Expand all; fold a node; Focus again', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await page.locator('.toolbar [data-mode="all"]').click();
  let r = await report(page, (x) => x.expandMode === 'all');
  check.eq('every valid record expanded', r.formatted.expandedRecords, 18);
  const rowsAll = r.formatted.totalRows;
  await shot('Expand all');
  await page.locator('.formatted .row[data-r="0"] .fold[data-k]').nth(1).click();
  r = await report(page, (x) => x.formatted.totalRows < rowsAll);
  check.ok('folding "user" removes rows', r.formatted.totalRows === rowsAll - 3, [rowsAll, r.formatted.totalRows]);
  check.ok('folded placeholder shown', (await page.locator('.formatted .ph').count()) === 1);
  await page.locator('.toolbar [data-mode="focus"]').click();
  r = await report(page, (x) => x.expandMode === 'focus');
  check.eq('focus again: one expanded', r.formatted.expandedRecords, 1);
});

await scenario('W06', 'Search, match stepping, filter, and path queries', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await page.fill('.search input', 'Ada');
  let r = await report(page, (x) => x.matches === 4);
  check.eq('text matches', r.matches, 4);
  check.ok('marks drawn', (await page.locator('.formatted mark').count()) > 0);
  await page.locator('.filter-btn').click();
  r = await report(page, (x) => x.filterOnly === true);
  check.eq('filter shows only the 4 matching lines', await page.locator('.formatted .row.first').count(), 4);
  await shot('Search "Ada" with filter on');
  await page.fill('.search input', 'level=warn');
  r = await report(page, (x) => x.matches === 3);
  check.eq('path query level=warn', r.matches, 3);
  await page.fill('.search input', 'ms>100');
  r = await report(page, (x) => x.matches === 1);
  check.eq('numeric query ms>100', r.matches, 1);
  await page.fill('.search input', 'user.name:kai');
  r = await report(page, (x) => x.matches === 3);
  check.eq('nested path contains', r.matches, 3);
});

await scenario('W07', 'Edit a record: pretty text in, compact edit out; invalid JSON is refused', ['F3', 'F13'], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await rowLocator(page, 2).click({ position: { x: 300, y: 5 } });
  await report(page, (x) => x.active === 2);
  await page.keyboard.press('Enter');
  const ta = page.locator('.editpanel textarea');
  await ta.waitFor();
  const text = await ta.inputValue();
  check.ok('editor shows pretty JSON', text.startsWith('{\n  "id": 1003,'), text.slice(0, 40));
  check.ok('editor keeps the big integer text', text.includes('9007199254740993'));
  await shot('Record editor');
  await ta.fill('{"broken": }');
  await page.locator('.ep-apply').click();
  check.ok('invalid JSON shows an error', ((await page.locator('.ep-err').textContent()) || '').length > 5);
  check.eq('nothing sent for invalid JSON', (await posted(page, 'editLine')).length, 0);
  await ta.fill(text.replace('"slow query"', '"slow query (edited)"'));
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await page.waitForFunction(() => window.harness.posted('editLine').length === 1);
  const sent = (await posted(page, 'editLine'))[0];
  check.eq('edit targets line 3', sent.line, 2);
  check.ok('original line sent for conflict check', sent.original.startsWith('{"id":1003'));
  await send(page, { type: 'editResult', ok: false, message: 'Line 3 changed after the edit started. Nothing was written.' });
  await page.waitForTimeout(100);
  check.ok('conflict message shown', ((await page.locator('.ep-err').textContent()) || '').includes('changed'));
  await send(page, { type: 'editResult', ok: true });
  await page.waitForTimeout(100);
  check.ok('panel closes on success', await page.locator('.editpanel').isHidden());
});

await scenario('W08', 'Grid: columns from all keys, nested sub-grid, sort', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await tabBtn(page, 'grid').click();
  let r = await report(page, (x) => x.view === 'grid');
  check.eq('rows (blank line skipped)', r.grid.rows, 20);
  check.ok('columns are the key union', ['id', 'ts', 'level', 'user', 'msg', 'ms', 'tags', 'trace'].every((c) => r.grid.columns.includes(c)), r.grid.columns);
  check.ok('non-object records get a (value) column', r.grid.columns.includes('(value)'));
  await page.locator('.grow[data-id="2"] .vchip').first().click();
  r = await report(page, (x) => x.grid.openCells === 1);
  check.ok('sub-grid shows user keys', ((await page.locator('.gdetail').textContent()) || '').includes('roles'));
  await page.locator('.gdetail .vchip').first().click();
  r = await report(page, (x) => x.grid.openCells === 2);
  check.ok('nested array opens inside the sub-grid', ((await page.locator('.gdetail').textContent()) || '').includes('admin'));
  await shot('Grid with user → roles opened');
  await page.locator('.gh[data-col="ms"]').click();
  await page.locator('.gh[data-col="ms"]').click();
  await page.waitForTimeout(100);
  const firstId = await page.locator('.grows .grow').first().getAttribute('data-id');
  check.eq('sort ms descending puts line 3 first', firstId, '2');
  await page.locator('.grow[data-id="7"] .gc').nth(2).click();
  r = await report(page, (x) => x.active === 7);
  check.eq('row click selects the record', r.selected, [7]);
});

await scenario('W09', 'Graph: nodes and edges for the active line, inspector, reveal', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await send(page, { type: 'selection', lines: [2], active: 2 });
  await report(page, (x) => x.active === 2);
  await tabBtn(page, 'graph').click();
  let r = await report(page, (x) => x.view === 'graph' && x.graph);
  check.eq('nodes: line, user, roles, tags', r.graph.nodes, 4);
  check.eq('edges', r.graph.edges, 3);
  const userNode = page.locator('.gn').nth(1);
  const box = await userNode.boundingBox();
  await page.mouse.click(box.x + 20, box.y + 40);
  r = await report(page, (x) => x.graph.selectedPath === '$.user');
  check.eq('inspector path', r.graph.selectedPath, '$.user');
  await shot('Graph of line 3 with the user node selected');
  await page.locator('.inspector [data-i="reveal"]').click();
  await page.waitForFunction(() => window.harness.posted('reveal').length > 0);
  check.eq('reveal message', (await posted(page, 'reveal')).at(-1), { type: 'reveal', line: 2, path: ['user'] });
  await page.locator('.linesel [data-line="1"]').click();
  r = await report(page, (x) => x.active === 3);
  check.eq('line selector moves to line 4', r.graph.nodes, 2);
  await send(page, { type: 'selection', lines: [2, 3], active: 3 });
  r = await report(page, (x) => x.selected.length === 2 && x.graph);
  check.eq('two selected lines share a virtual root', r.graph.nodes, 1 + 4 + 2);
  await shot('Graph comparing lines 3 and 4');
});

await scenario('W10', 'Graph stops at graph.maxNodes', ['F9'], async ({ page, check }) => {
  const wide = JSON.stringify({ items: Array.from({ length: 60 }, (_, i) => ({ a: { x: i }, b: { x: i }, c: { x: i }, d: { x: i }, e: { x: i } })) });
  await open(page, 'wide.jsonl', { text: wide + '\n', config: { graphMaxNodes: 300, defaultView: 'graph' } });
  const r = await report(page, (x) => x.view === 'graph' && x.graph);
  check.ok('node count capped', r.graph.nodes <= 300, r.graph.nodes);
  check.eq('truncated flag', r.graph.truncated, true);
  check.ok('note shown', await page.locator('.gnote').isVisible());
});

await scenario('W11', 'JSON file: formatted with folding, exact big integer, collapse all', ['F2'], async ({ page, check, shot }) => {
  await open(page, 'sample.json');
  let r = await complete(page);
  check.eq('not JSONL', r.isJsonl, false);
  const all = r.formatted.totalRows;
  check.ok('all lines shown', all > 30, all);
  const text = await page.locator('.formatted .rows').textContent();
  check.ok('big integer exact', text.includes('9007199254740993'));
  await shot('sample.json formatted');
  await page.locator('.toolbar [data-fold="collapse"]').click();
  r = await report(page, (x) => x.formatted.totalRows < all);
  check.eq('collapse all leaves root members', r.formatted.totalRows, 9);
  await page.locator('.toolbar [data-fold="expand"]').click();
  r = await report(page, (x) => x.formatted.totalRows === all);
  check.eq('expand all restores', r.formatted.totalRows, all);
});

await scenario('W12', 'JSONC fallback and .json that holds JSON Lines', ['F10'], async ({ page, check, shot }) => {
  await open(page, 'comments.json');
  let r = await complete(page);
  check.eq('jsonc flag', r.stats.jsonc, true);
  check.ok('banner explains JSONC', ((await page.locator('.banner').textContent()) || '').includes('Comments'));
  await shot('comments.json parsed as JSONC');
  await open(page, 'lines.json');
  r = await complete(page);
  check.eq('detected as JSONL', r.isJsonl, true);
  check.eq('three records', r.stats.valid, 3);
});

await scenario('W13', 'Root scalar and mixed root array in all three views', ['F16'], async ({ page, check, shot }) => {
  await open(page, 'scalar.json');
  let r = await complete(page);
  check.eq('scalar rows', r.formatted.totalRows, 1);
  await tabBtn(page, 'grid').click();
  r = await report(page, (x) => x.view === 'grid');
  check.eq('scalar grid', r.grid.rows, 1);
  await tabBtn(page, 'graph').click();
  r = await report(page, (x) => x.view === 'graph');
  check.eq('scalar graph', r.graph.nodes, 1);
  await open(page, 'array-mixed.json');
  await tabBtn(page, 'grid').click();
  r = await report(page, (x) => x.view === 'grid');
  check.eq('array rows', r.grid.rows, 6);
  check.ok('(value) column for non-objects', r.grid.columns.includes('(value)'), r.grid.columns);
  await shot('Mixed root array in the grid');
});

await scenario('W14', 'A 2 MB single line stays responsive (truncated preview)', ['F7'], async ({ page, check }) => {
  const long = JSON.stringify({ blob: 'x'.repeat(2_000_000) });
  const t0 = Date.now();
  await open(page, 'long.jsonl', { text: `{"a":1}\n${long}\n{"b":2}\n` });
  await complete(page);
  check.ok('rendered in under 3 s', Date.now() - t0 < 3000, Date.now() - t0);
  const t = await rowLocator(page, 1).textContent();
  check.ok('preview truncated with a note', t.includes('more chars') && t.length < 5000, t.length);
});

await scenario('W15', 'Nesting 3000 levels deep does not overflow the stack', ['F8'], async ({ page, check }) => {
  let deep = '1';
  for (let i = 0; i < 3000; i++) deep = i % 2 ? `[${deep}]` : `{"k":${deep}}`;
  await open(page, 'deep.jsonl', { text: deep + '\n' });
  const r = await complete(page);
  check.eq('parsed', r.stats.valid, 1);
  check.ok('expanded rows', r.formatted.totalRows > 6000, r.formatted.totalRows);
  await tabBtn(page, 'graph').click();
  const g = await report(page, (x) => x.view === 'graph' && x.graph);
  check.ok('graph built', g.graph.nodes > 0, g.graph.nodes);
});

await scenario('W16', '50 000 lines: open, background parse, jump to the end', [], async ({ page, check, shot }) => {
  const lines = [];
  for (let i = 0; i < 50_000; i++) lines.push(JSON.stringify({ i, name: `user_${i}`, tags: ['a', 'b'], score: i * 1.5, nested: { ok: i % 2 === 0 } }));
  const t0 = Date.now();
  await open(page, 'big.jsonl', { text: lines.join('\n') + '\n' });
  const first = Date.now() - t0;
  const r = await complete(page);
  check.ok('first render under 2 s', first < 2000, first);
  check.eq('all parsed', r.stats.valid, 50_000);
  await send(page, { type: 'selection', lines: [49_999], active: 49_999 });
  await report(page, (x) => x.active === 49_999);
  check.ok('last line on screen', await rowLocator(page, 49_999).isVisible());
  await page.locator('.toolbar [data-mode="all"]').click();
  const all = await report(page, (x) => x.expandMode === 'all');
  check.ok('expand all on 50k lines', all.formatted.totalRows > 400_000, all.formatted.totalRows);
  await shot('Last line of a 50 000-line file');
});

await scenario('W17', 'Keys with dots, spaces and quotes give correct JSONPath', ['F17'], async ({ page, check }) => {
  await open(page, 'special-keys.jsonl');
  await complete(page);
  const row = page.locator('.formatted .row[data-r="0"]').filter({ hasText: '"c d"' });
  await row.dblclick({ position: { x: 200, y: 5 } });
  await page.waitForFunction(() => window.harness.posted('reveal').length > 0);
  check.eq('reveal path', (await posted(page, 'reveal')).at(-1).path, ['a.b', 'c d']);
  await tabBtn(page, 'graph').click();
  await report(page, (x) => x.view === 'graph');
  const node = page.locator('.gn').filter({ has: page.locator('.gtitle', { hasText: 'say' }) }).first();
  const box = await node.boundingBox();
  await page.mouse.click(box.x + 20, box.y + 10);
  const r = await report(page, (x) => x.graph.selectedPath);
  check.eq('JSONPath escapes keys', r.graph.selectedPath, '$["a.b"]["say \\"hi\\""]');
});

await scenario('W18', 'Document update keeps view, mode and selection', ['F11'], async ({ page, check }) => {
  const text = await readFile(`${root}test/fixtures/events.jsonl`, 'utf8');
  await open(page, 'events.jsonl', { text });
  await complete(page);
  await send(page, { type: 'selection', lines: [4], active: 4 });
  await report(page, (x) => x.active === 4);
  await tabBtn(page, 'grid').click();
  await report(page, (x) => x.view === 'grid');
  await send(page, { type: 'update', text: text + '{"id":2000,"level":"info"}\n', version: 2 });
  const r = await report(page, (x) => x.version === 2 && x.stats.parsed === x.stats.lines);
  check.eq('lines grew', r.stats.lines, 22);
  check.eq('view kept', r.view, 'grid');
  check.eq('selection kept', r.selected, [4]);
});

await scenario('W19', 'CRLF line ends and a UTF-8 BOM', ['F5', 'F6'], async ({ page, check }) => {
  await open(page, 'crlf.jsonl');
  let r = await complete(page);
  check.eq('crlf valid', r.stats.valid, 3);
  check.eq('crlf no errors', r.stats.errors, 0);
  const t = await rowLocator(page, 1).textContent();
  check.ok('no \\r in the text', !t.includes('\r'));
  await open(page, 'bom.jsonl');
  r = await complete(page);
  check.eq('bom valid', r.stats.valid, 2);
  check.eq('bom no errors', r.stats.errors, 0);
});

await scenario('W20', 'Light theme', ['F14'], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl', { theme: 'light' });
  await complete(page);
  await send(page, { type: 'selection', lines: [2], active: 2 });
  await report(page, (x) => x.active === 2);
  await shot('Formatted, light theme');
  await tabBtn(page, 'grid').click();
  await report(page, (x) => x.view === 'grid');
  await shot('Grid, light theme');
  await tabBtn(page, 'graph').click();
  await report(page, (x) => x.view === 'graph');
  await shot('Graph, light theme');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check.eq('editor background from theme', bg, 'rgb(255, 255, 255)');
});

await scenario('W21', 'Word wrap (Alt+Z): long lines wrap, no sideways scroll, hanging indent', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await send(page, { type: 'selection', lines: [8], active: 8 });
  await report(page, (x) => x.active === 8);
  const rh = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rh')));
  const h17 = () => page.evaluate(() => document.querySelector('.formatted .row.first[data-r="16"]')?.getBoundingClientRect().height ?? 0);
  check.eq('long line is one row before wrap', Math.round(await h17()), rh);
  await send(page, { type: 'toggleWrap' });
  let r = await report(page, (x) => x.wrap === true);
  await page.waitForTimeout(150);
  check.ok('long line wraps onto more rows', (await h17()) >= rh * 2, [await h17(), rh]);
  const overflow = await page.evaluate(() => {
    const s = document.querySelector('.formatted .scroller');
    return s.scrollWidth - s.clientWidth;
  });
  check.ok('no sideways scrolling', overflow <= 1, overflow);
  const indent = await page.evaluate(() => document.querySelector('.formatted .row[data-r="8"][data-j="2"] .code-text')?.getAttribute('style') ?? '');
  check.ok('hanging indent on pretty lines', indent.includes('padding-left'), indent);
  check.ok('toolbar wrap button is pressed', (await page.getAttribute('.wrap-btn', 'aria-pressed')) === 'true');
  await shot('Word wrap on (Alt+Z): lines 17–19 wrap, line 9 expanded');
  await send(page, { type: 'toggleWrap' });
  r = await report(page, (x) => x.wrap === false);
  await page.waitForTimeout(100);
  check.eq('one row again after Alt+Z', Math.round(await h17()), rh);
  check.eq('report', r.wrap, false);
});

await scenario('W22', 'Word wrap on 50 000 long lines: jump to the end, rows do not overlap', [], async ({ page, check, shot }) => {
  const lines = [];
  for (let i = 0; i < 50_000; i++) lines.push(JSON.stringify({ i, text: `第${i}条 ` + 'lorem ipsum dolor sit amet '.repeat(1 + (i % 7)) }));
  await open(page, 'longlines.jsonl', { text: lines.join('\n') + '\n', config: { wrap: true } });
  await complete(page);
  await send(page, { type: 'selection', lines: [49_999], active: 49_999 });
  await report(page, (x) => x.active === 49_999);
  await page.waitForTimeout(300);
  check.ok('last line on screen', await rowLocator(page, 49_999).isVisible());
  const overlaps = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.formatted .row')].map((e) => e.getBoundingClientRect());
    let bad = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].top < rows[i - 1].bottom - 0.5) bad++;
    return bad;
  });
  check.eq('rows do not overlap', overlaps, 0);
  await page.evaluate(() => (document.querySelector('.formatted .scroller').scrollTop = 0));
  await page.waitForTimeout(300);
  check.ok('top of the file renders after scrolling back', await rowLocator(page, 0).isVisible());
  await shot('Word wrap on a 50 000-line file');
});

await scenario('W23', 'Theme setting: light, dark and follow system override the VS Code theme', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl', { theme: 'dark' });
  await complete(page);
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const cfg = async (theme) => {
    const base = await page.evaluate(() => window.__lastConfig);
    await send(page, { type: 'config', config: { ...base, theme } });
  };
  await page.evaluate(() => {
    window.__lastConfig = { defaultView: 'formatted', expandMode: 'focus', indent: 2, graphMaxNodes: 1500, syncSelection: true, theme: 'vscode', wordWrap: 'followEditor', wrap: false, formatDocument: false, expandReminder: true, language: 'auto', lang: 'en', vscodeLanguage: 'en', reports: true };
  });
  await cfg('light');
  let r = await report(page, (x) => x.theme === 'light');
  check.eq('light background', await bg(), 'rgb(255, 255, 255)');
  await send(page, { type: 'selection', lines: [2], active: 2 });
  await shot('Theme "Light" while VS Code is dark');
  await cfg('dark');
  r = await report(page, (x) => x.theme === 'dark');
  check.eq('dark background', await bg(), 'rgb(31, 31, 31)');
  await page.emulateMedia({ colorScheme: 'light' });
  await cfg('system');
  r = await report(page, (x) => x.theme === 'light');
  check.eq('follow system: light OS', r.theme, 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  r = await report(page, (x) => x.theme === 'dark');
  check.eq('follow system: OS switches to dark at once', r.theme, 'dark');
  await cfg('vscode');
  r = await report(page, (x) => x.theme === 'vscode');
  check.eq('follow VS Code removes the override', await page.evaluate(() => document.body.dataset.theme ?? null), null);
});

await scenario('W24', 'Settings panel: gear opens it, every control writes a setting, Esc closes it', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await page.click('.gear-btn');
  let r = await report(page, (x) => x.settingsOpen === true);
  const shown = await page.locator('.settings.active').waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  check.ok('panel visible', shown);
  await page.waitForTimeout(250);
  await shot('Settings panel');
  const pick = (key, value) => page.click(`.settings-seg[data-key="${key}"] .seg-btn[data-value="${value}"]`);
  await pick('theme', 'dark');
  await pick('wordWrap', 'on');
  await pick('indent', '4');
  await pick('defaultView', 'grid');
  await pick('jsonl.expandMode', 'all');
  await page.fill('.settings-num', '800');
  await page.press('.settings-num', 'Tab');
  await page.click('.settings-check input[data-key="preview.followActiveEditor"]');
  await page.click('.settings-check input[data-key="formatDocument.enabled"]');
  await page.click('.settings-check input[data-key="expandLines.showReminder"]');
  const sent = (await posted(page, 'setSetting')).map((m) => [m.key, m.value]);
  check.eq('settings sent to VS Code', sent, [
    ['theme', 'dark'],
    ['wordWrap', 'on'],
    ['indent', 4],
    ['defaultView', 'grid'],
    ['jsonl.expandMode', 'all'],
    ['graph.maxNodes', 800],
    ['preview.followActiveEditor', false],
    ['formatDocument.enabled', true],
    ['expandLines.showReminder', false],
  ]);
  check.eq('theme applies at once', await page.evaluate(() => document.body.dataset.theme), 'dark');
  await page.click('.settings-link');
  check.eq('link opens VS Code settings', (await posted(page, 'openSettings')).length, 1);
  await page.keyboard.press('Escape');
  r = await report(page, (x) => x.settingsOpen === false);
  check.eq('Esc closes the panel', r.settingsOpen, false);
});

await scenario('W25', 'Grid: a nested value opens under its own column', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await tabBtn(page, 'grid').click();
  await report(page, (x) => x.view === 'grid');
  await page.locator('.grow[data-id="2"] .vchip').nth(1).click();
  await report(page, (x) => x.grid.openCells === 1);
  const pos = await page.evaluate(() => ({
    sub: document.querySelector('.gsub')?.getBoundingClientRect().left,
    col: document.querySelector('.gh[data-col="tags"]')?.getBoundingClientRect().left,
  }));
  check.ok('sub-grid starts under the tags column', Math.abs(pos.sub - pos.col) <= 1, pos);
  await page.locator('.grow[data-id="2"] .vchip').first().click();
  await report(page, (x) => x.grid.openCells === 2);
  const both = await page.evaluate(() => [...document.querySelectorAll('.gsub')].map((e) => Math.round(e.getBoundingClientRect().left)));
  const cols = await page.evaluate(() => ['user', 'tags'].map((c) => Math.round(document.querySelector(`.gh[data-col="${c}"]`).getBoundingClientRect().left)));
  check.eq('two open cells: each under its column', both, cols);
  await page.evaluate(() => (document.querySelector('.gscroll').scrollLeft = 300));
  await page.waitForTimeout(100);
  await shot('Grid: user and tags open under their columns');
  await page.locator('.gh[data-col="user"] .rz').hover();
  const box = await page.locator('.gh[data-col="user"] .rz').boundingBox();
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 5);
  await page.mouse.up();
  const after = await page.evaluate(() => ({
    sub: Math.round([...document.querySelectorAll('.gsub')][1].getBoundingClientRect().left),
    col: Math.round(document.querySelector('.gh[data-col="tags"]').getBoundingClientRect().left),
  }));
  check.ok('still aligned after a column resize', Math.abs(after.sub - after.col) <= 1, after);
});

await scenario('W26', 'Language: Simplified Chinese UI, switch in the settings panel, state is kept', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl', { config: { language: 'auto', lang: 'zh-cn', vscodeLanguage: 'zh-cn' } });
  await complete(page);
  await send(page, { type: 'selection', lines: [2], active: 2 });
  let r = await report(page, (x) => x.active === 2 && x.lang === 'zh-cn');
  const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent?.trim() ?? '', sel);
  check.eq('view tab in Chinese', await text('[data-view="formatted"]'), '格式化');
  check.eq('mode button in Chinese', await text('[data-mode="all"]'), '全部展开');
  check.ok('status bar in Chinese', (await text('.status')).includes('第 3 行'), await text('.status'));
  check.ok('line count in Chinese', (await text('.stats')).includes('21 行'), await text('.stats'));
  check.ok('error chip in Chinese', (await text('.err-chip')).includes('2 个错误'), await text('.err-chip'));
  check.ok('record buttons in Chinese', (await text('.formatted .row.first[data-r="2"] .acts')).includes('编辑'));
  await shot('Chinese UI (VS Code display language zh-cn)');
  await page.click('.gear-btn');
  await page.locator('.settings.active').waitFor({ state: 'visible', timeout: 3000 });
  check.ok('settings panel in Chinese', (await text('.settings-head h2')) === '设置');
  check.ok('language row shows the VS Code language', (await text('.settings-seg[data-key="language"] .seg-btn[data-value="auto"]')).includes('简体中文'));
  await page.waitForTimeout(250);
  await shot('Settings panel in Chinese with the language section');
  await page.click('.settings-seg[data-key="language"] .seg-btn[data-value="en"]');
  check.eq('language sent to VS Code', (await posted(page, 'setSetting')).at(-1), { type: 'setSetting', key: 'language', value: 'en' });
  // The host answers with a config message; the UI switches without losing the state.
  const base = { defaultView: 'formatted', expandMode: 'focus', indent: 2, graphMaxNodes: 1500, syncSelection: true, theme: 'vscode', wordWrap: 'followEditor', wrap: false, formatDocument: false, expandReminder: true, reports: true };
  await send(page, { type: 'config', config: { ...base, language: 'en', lang: 'en', vscodeLanguage: 'zh-cn' } });
  r = await report(page, (x) => x.lang === 'en');
  check.eq('view tab in English', await text('[data-view="formatted"]'), 'Formatted');
  check.eq('active line kept', r.active, 2);
  check.eq('settings panel stays open', r.settingsOpen, true);
  check.eq('settings panel in English', await text('.settings-head h2'), 'Settings');
});

await scenario('W27', 'Grid: header filters (value list, search, cascade, clear)', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await tabBtn(page, 'grid').click();
  let r = await report(page, (x) => x.view === 'grid');
  check.eq('no filters at first', r.grid.filters, {});
  const items = () =>
    page.evaluate(() => [...document.querySelectorAll('.gfilter .gf-list .gf-item')].map((e) => [e.querySelector('.gf-v').textContent, e.querySelector('.gf-n').textContent, e.querySelector('input').checked]));
  await page.hover('.gh[data-col="level"]');
  await page.click('.gh[data-col="level"] .gh-f');
  await page.locator('.gfilter').waitFor({ state: 'visible', timeout: 3000 });
  check.eq('value list with counts, missing last', await items(), [
    ['debug', '3', true],
    ['info', '10', true],
    ['warn', '3', true],
    ['(missing)', '4', true],
  ]);
  check.ok('search box has focus', await page.evaluate(() => document.activeElement?.matches('.gfilter input[type="search"]')));
  await page.click('.gfilter .gf-all');
  r = await report(page, (x) => x.grid.rows === 0);
  check.eq('untick all hides every row', r.grid.filters.level, { text: '', exclude: 4 });
  await page.locator('.gfilter .gf-item', { hasText: 'warn' }).click();
  r = await report(page, (x) => x.grid.rows === 3);
  check.eq('only warn rows', r.grid.unfiltered, 20);
  check.ok('select all is indeterminate', await page.evaluate(() => document.querySelector('.gfilter [data-fall]').indeterminate));
  check.ok('header marked as filtered', await page.locator('.gh[data-col="level"].filtered .gh-f.on').count() === 1);
  check.ok('status bar shows the filtered count', ((await page.locator('.status').textContent()) || '').includes('3 of 20 rows'));
  await shot('Level filter: only warn');
  await page.keyboard.press('Escape');
  check.ok('Escape closes the popup', await page.locator('.gfilter').isHidden());
  // A second column: search text, and the value list of the first column follows it.
  await page.click('.gh[data-col="level"] .gh-f');
  await page.click('.gfilter .gf-clear');
  r = await report(page, (x) => x.grid.rows === 20);
  check.eq('clear filter', r.grid.filters, {});
  await page.click('.gh[data-col="msg"] .gh-f');
  await page.fill('.gfilter input[type="search"]', 'get');
  r = await report(page, (x) => x.grid.rows === 3);
  check.eq('search is a case-insensitive contains filter', r.grid.filters.msg, { text: 'get', exclude: 0 });
  check.eq('list narrows to matching values', (await items()).map((x) => x[0]), ['GET /api/cart', 'GET /api/me', 'GET /api/orders']);
  await page.click('.gfilter [data-fsort="-1"]');
  await page.waitForTimeout(100);
  check.ok('sort from the popup closes it', await page.locator('.gfilter').isHidden());
  check.eq('sorted descending by msg', await page.locator('.grows .grow').first().getAttribute('data-id'), '1');
  await page.click('.gh[data-col="level"] .gh-f');
  check.eq('other filters narrow the value list', await items(), [['debug', '3', true]]);
  await page.click('.gfilter .gf-item:has-text("debug")');
  r = await report(page, (x) => x.grid.rows === 0);
  await page.mouse.click(600, 500);
  check.ok('click outside closes the popup', await page.locator('.gfilter').isHidden());
  await shot('No rows left: clear all filters');
  await page.click('[data-clear-filters]');
  r = await report(page, (x) => x.grid.rows === 20);
  check.eq('clear all filters', r.grid.filters, {});
  check.eq('header click still sorts', r.view, 'grid');
});


// ---------- large files, limits and state ----------

async function openBlank(page) {
  await page.goto(`${base}?theme=dark`);
  await page.waitForFunction(() => window.harness && window.__posted.some((m) => m.type === 'ready'));
}

const statusText = (page) => page.locator('.status').innerText();

await scenario('W28', 'Large file: bytes arrive in chunks, lines are decoded on demand, the view is read-only', ['F5', 'F6', 'F15'], async ({ page, check, shot }) => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(`{"id":${i},"name":"名字-${i}-ünï","tags":["a","b"],"n":9007199254740993}`);
  lines[10] = '{"bad": }';
  lines[20] = '';
  // A BOM, CRLF line ends, and 1000-byte chunks that cut lines and multi-byte characters.
  const text = '﻿' + lines.join('\r\n') + '\r\n';
  await openBlank(page);
  await page.evaluate((t) => window.harness.loadLarge('big.jsonl', new TextEncoder().encode(t), { chunk: 1000 }), text);
  let r = await report(page, (x) => x.large && !x.loading && x.stats.parsed >= x.stats.lines);
  check.eq('lines', r.stats.lines, 3000);
  check.eq('valid', r.stats.valid, 2998);
  check.eq('errors', r.stats.errors, 1);
  check.eq('blank', r.stats.blank, 1);
  check.eq('the webview says it shows JSON Lines', (await posted(page, 'docMode')).at(-1), { type: 'docMode', isJsonl: true });
  const first = (await rowLocator(page, 0).locator('xpath=..').innerText()) || '';
  check.ok('the first line is decoded (BOM skipped, UTF-8, big integer)', first.includes('"名字-0-ünï"') && first.includes('9007199254740993'), first.slice(0, 200));
  check.eq('no Edit button on a read-only file', await page.locator('.a-edit').count(), 0);
  check.ok('status bar says read-only', (await statusText(page)).includes('Read-only'));
  check.eq('the invalid line has two rows', await page.locator('.formatted .row.err[data-r="10"]').count(), 2);
  await send(page, { type: 'selection', lines: [2999], active: 2999 });
  r = await report(page, (x) => x.active === 2999);
  const last = await page.locator('.formatted .row[data-r="2999"]').allInnerTexts();
  check.ok('the last line expands with its own text and no carriage return', last.join('\n').includes('"名字-2999-ünï"') && !last.join('').includes('\r'), last.slice(0, 3));
  await page.fill('.search input', '名字-2500-');
  r = await report(page, (x) => x.matches === 1 && !x.searching);
  check.eq('search reads the bytes', r.matches, 1);
  await page.fill('.search input', '');
  await report(page, (x) => x.matches === 0);
  await tabBtn(page, 'grid').click();
  r = await report(page, (x) => x.view === 'grid');
  check.eq('grid rows (blank line skipped)', r.grid.rows, 2999);
  check.eq('grid columns', r.grid.columns, ['id', 'name', 'tags', 'n']);
  await shot('Large file (bytes) in the grid');
  await page.keyboard.press('Enter');
  check.eq('Enter does not open the record editor', await page.locator('.editpanel:not([hidden])').count(), 0);
});

await scenario('W29', 'Large .json: JSON Lines are detected while loading; one big JSON value opens folded', ['F15', 'F16'], async ({ page, check, shot }) => {
  await openBlank(page);
  await page.evaluate(() => window.harness.loadLarge('lines.json', new TextEncoder().encode('{"k":1,"v":"one"}\n{"k":2,"v":"two"}\n{"k":3,"v":"three"}\n'), { chunk: 7 }));
  let r = await report(page, (x) => x.large && !x.loading && x.stats.parsed >= x.stats.lines);
  check.eq('.json with one value per line is JSON Lines', [r.isJsonl, r.stats.lines, r.stats.valid], [true, 3, 3]);
  check.eq('the host is told', (await posted(page, 'docMode')).at(-1), { type: 'docMode', isJsonl: true });
  // One JSON value of about 10 MB: it needs the whole file, and opens with the second level folded.
  await openBlank(page);
  await page.evaluate(() => {
    const rows = Array.from({ length: 200000 }, (_, i) => ({ id: i, name: 'n' + i, pos: { x: i, y: -i } }));
    return window.harness.loadLarge('doc.json', new TextEncoder().encode(JSON.stringify({ rows, meta: { n: 1 } }, null, 1)), { chunk: 1 << 20 });
  });
  r = await report(page, (x) => x.large && x.fileName === 'doc.json' && x.formatted, 20000);
  check.eq('one JSON value', [r.isJsonl, r.stats.valid], [false, 1]);
  check.eq('the root is open, its members are folded', r.formatted.totalRows, 4);
  await shot('A 10 MB JSON value opens folded');
  await page.locator('.formatted .ph').first().click();
  r = await report(page, (x) => x.formatted.totalRows > 4);
  check.eq('opening "rows" lists the items, each one folded', r.formatted.totalRows, 200000 + 5);
  await page.locator('.toolbar [data-fold="collapse"]').click();
  r = await report(page, (x) => x.formatted.totalRows === 4);
  check.eq('Collapse all', r.formatted.totalRows, 4);
  await tabBtn(page, 'grid').click();
  r = await report(page, (x) => x.view === 'grid');
  check.eq('grid of the root object', [r.grid.rows, r.grid.columns], [2, ['key', 'value']]);
});

await scenario('W30', 'Grid: keys named "#" and "(value)" are ordinary columns', [], async ({ page, check, shot }) => {
  await open(page, 'x.jsonl', { text: '{"#":"hello","(value)":"v1","a":1}\n{"#":"world","(value)":"v2","a":2}\n[1,2]\n', config: { defaultView: 'grid' } });
  const r = await report(page, (x) => x.view === 'grid' && x.stats.parsed >= 3);
  check.eq('columns: the built-in value column, then the three keys', r.grid.columns, ['(value)', '#', '(value)', 'a']);
  const cells = await page.$$eval('.grow', (els) => els.map((e) => [...e.querySelectorAll('.gcells > .gc')].map((c) => c.textContent)));
  check.eq('the "#" and "(value)" keys show their own values', cells.slice(0, 2), [['1', '', 'hello', 'v1', '1'], ['2', '', 'world', 'v2', '2']]);
  check.ok('the array record shows in the built-in value column', cells[2][1].includes('[2]'), cells[2]);
  await page.locator('.gh[data-col="#"]').click();
  await page.locator('.gh[data-col="#"]').click();
  await page.waitForTimeout(100);
  check.eq('sorting by the "#" key sorts its values (descending)', await page.locator('.grows .grow').first().getAttribute('data-id'), '1');
  await shot('Keys "#" and "(value)" beside the built-in columns');
});

await scenario('W31', 'Limits that hide data are named in the status bar', [], async ({ page, check, shot }) => {
  const wide = {};
  for (let i = 0; i < 400; i++) wide['k' + i] = i;
  const lines = [JSON.stringify(wide)];
  for (let i = 0; i < 2500; i++) lines.push(JSON.stringify({ id: i }));
  await open(page, 'wide.jsonl', { text: lines.join('\n') + '\n', config: { defaultView: 'grid' } });
  let r = await report(page, (x) => x.view === 'grid' && x.stats.parsed >= x.stats.lines);
  check.eq('grid shows 300 columns', r.grid.columns.length, 300);
  check.eq('and says so', r.notes, ['Showing the first 300 columns']);
  check.ok('in the status bar', (await statusText(page)).includes('Showing the first 300 columns'));
  await shot('Status bar names the column limit');
  await send(page, { type: 'selection', lines: Array.from({ length: 12 }, (_, i) => i + 1), active: 1 });
  await tabBtn(page, 'graph').click();
  r = await report(page, (x) => x.view === 'graph' && x.selected.length === 12);
  check.eq('graph: only 10 of 12 selected lines', r.notes, ['The graph shows the first 10 of 12 selected lines']);
  await tabBtn(page, 'formatted').click();
  await report(page, (x) => x.view === 'formatted');
  // The range starts at line 2501 (the editor cursor) and is extended up to line 2 with Shift-click.
  await send(page, { type: 'selection', lines: [2500], active: 2500 });
  await report(page, (x) => x.active === 2500);
  await page.evaluate(() => document.querySelector('.formatted .scroller').scrollTo(0, 0));
  await page.waitForTimeout(100);
  await rowLocator(page, 1).click({ modifiers: ['Shift'] });
  r = await report(page, (x) => x.selected.length === 2000);
  check.eq('a Shift range stops at 2 000 lines, counted from where it started', [r.selected[0], r.selected.at(-1)], [501, 2500]);
  check.eq('and says so', r.notes, ['The selection stops at 2,000 lines']);
});

await scenario('W32', 'Graph export keeps the box of the selected node', [], async ({ page, check }) => {
  await open(page, 'g.jsonl', { text: '{"a":{"b":1},"c":[1,2]}\n', config: { defaultView: 'graph' } });
  await report(page, (x) => x.view === 'graph' && x.graph && x.graph.nodes === 3);
  const box = await page.locator('.gsvg [data-n="0"] .gn-bg').boundingBox();
  await page.mouse.click(box.x + 20, box.y + 40);
  await report(page, (x) => x.graph && x.graph.selectedPath === '$');
  await page.click('[data-export="svg"]');
  await page.waitForFunction(() => window.harness.posted('export').length > 0);
  const svg = (await posted(page, 'export'))[0].data;
  check.ok('the selected node is in the export', /class="gn sel/.test(svg));
  // A file must be well-formed XML. Path keys hold control characters: none may reach the file.
  const xml = await page.evaluate((s) => new DOMParser().parseFromString(s, 'image/svg+xml').querySelector('parsererror')?.textContent ?? 'well-formed', svg);
  check.eq('the SVG file is well-formed XML', xml, 'well-formed');
  check.ok('nothing for scripts or the keyboard is in the file', !/data-|tabindex|aria-|gtoggle/.test(svg), svg.match(/data-\w+|tabindex|aria-\w+|gtoggle/)?.[0]);
  await page.click('[data-export="png"]');
  const png = await page.waitForFunction(() => window.harness.posted('export')[1], null, { timeout: 5000 }).then((h) => h.jsonValue(), () => undefined);
  check.ok('PNG export gives an image', png?.format === 'png' && png.data.startsWith('data:image/png;base64,') && png.data.length > 2000, png?.data?.slice(0, 40));
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  check.eq('every node box is drawn', await page.$$eval('.gn-bg', (els) => els.map((e) => getComputedStyle(e).display)), ['inline', 'inline', 'inline']);
});

await scenario('W33', 'A document update keeps folds, open sub-grids and the selection, also when lines move', ['F11'], async ({ page, check }) => {
  const text = await open(page, 'events.jsonl').then(() => page.evaluate(async () => (await fetch('/test/fixtures/events.jsonl')).text()));
  await complete(page);
  await rowLocator(page, 2).click();
  let r = await report(page, (x) => x.active === 2);
  await page.locator('.formatted .row[data-r="2"] .fold[data-k]').nth(1).click();
  r = await report(page, (x) => x.formatted.totalRows < r.formatted.totalRows);
  const folded = r.formatted.totalRows;
  await tabBtn(page, 'grid').click();
  await report(page, (x) => x.view === 'grid');
  await page.locator('.grow[data-id="2"] .vchip').first().click();
  await report(page, (x) => x.grid.openCells === 1);
  // A new first line: every record moves down by one.
  await send(page, { type: 'update', text: '{"id":0,"level":"new"}\n' + text, version: 2 });
  r = await report(page, (x) => x.version === 2 && x.stats.parsed >= x.stats.lines);
  check.eq('lines', r.stats.lines, 22);
  check.eq('the selection follows its record', [r.active, r.selected], [3, [3]]);
  check.eq('the open sub-grid follows its record', [r.grid.openCells, await page.locator('.grow[data-id="3"] .gdetail').count()], [1, 1]);
  await tabBtn(page, 'formatted').click();
  r = await report(page, (x) => x.view === 'formatted');
  check.eq('the folded node is still folded', r.formatted.totalRows, folded + 1);
  // The record itself changes: its state is dropped, nothing else.
  const lines = ('{"id":0,"level":"new"}\n' + text).split('\n');
  lines[3] = '{"id":3,"changed":true}';
  await send(page, { type: 'update', text: lines.join('\n'), version: 3 });
  r = await report(page, (x) => x.version === 3 && x.stats.parsed >= x.stats.lines);
  check.eq('valid count after the edit', r.stats.valid, 19);
  check.eq('the edited record is still the active one', r.active, 3);
});

await scenario('W34', '200 000 lines: the first paint does not wait for the scan; late errors get their second row', ['F1', 'F7'], async ({ page, check }) => {
  await openBlank(page);
  const ms = await page.evaluate(() => {
    const rows = [];
    for (let i = 0; i < 200000; i++) rows.push(JSON.stringify({ id: i, level: i % 7 ? 'info' : 'warn', msg: 'request finished ' + i, user: { name: 'ada', roles: ['a', 'b'] }, ms: i % 900 }));
    rows[199990] = '{"id": oops}';
    const data = { type: 'init', doc: { uri: 'file:///big.jsonl', fileName: 'big.jsonl', languageId: 'jsonl', isJsonl: true, host: 'preview' }, text: rows.join('\n') + '\n', version: 1, config: window.harness.config() };
    const t0 = performance.now();
    window.dispatchEvent(new MessageEvent('message', { data }));
    return performance.now() - t0;
  });
  check.ok('init returns before the whole file is parsed (under 400 ms)', ms < 400, Math.round(ms));
  const first = await page.waitForFunction(() => window.harness.posted('report')[0]?.report).then((h) => h.jsonValue());
  check.ok('the first report is sent while the scan is still running', first.stats.parsed < first.stats.lines, first.stats);
  let r = await complete(page);
  check.eq('the scan finds the one invalid line', [r.stats.lines, r.stats.errors], [200000, 1]);
  await send(page, { type: 'selection', lines: [199995], active: 199995 });
  r = await report(page, (x) => x.active === 199995);
  check.eq('the invalid line has its two rows', await page.locator('.formatted .row.err[data-r="199990"]').count(), 2);
  await page.fill('.search input', 'level=warn');
  r = await report(page, (x) => !x.searching && x.matches > 0, 20000);
  // Line 199 990 was a "warn" line before it became invalid.
  check.eq('a path query over 21 MB runs in slices and finds every 7th line', r.matches, Math.ceil(200000 / 7) - 1);
});

await scenario('W35', 'A read error while a large file loads is shown; replaced views leave no listeners behind', [], async ({ page, check }) => {
  await openBlank(page);
  await page.evaluate(() =>
    window.harness.send({
      type: 'init',
      doc: { uri: 'file:///fixtures/gone.jsonl', fileName: 'gone.jsonl', languageId: 'jsonl', isJsonl: true, host: 'preview', large: { bytes: 80 * 1024 * 1024 }, readOnly: true },
      text: '',
      version: 7,
      config: window.harness.config(),
    }),
  );
  await page.waitForFunction(() => document.querySelector('.boot')?.textContent.includes('Loading'));
  await send(page, { type: 'notice', message: 'Better JSONL could not read the file: ENOENT' });
  await page.waitForTimeout(100);
  check.eq('the message takes the place of the progress text', await page.locator('.boot').innerText(), 'Better JSONL could not read the file: ENOENT');
  // Every "init" builds new views (the preview follows the active editor). The old ones must let go of the window.
  const cdp = await page.context().newCDPSession(page);
  const listeners = async () => {
    const out = {};
    for (const target of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression: target });
      out[target] = (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.length;
    }
    return out;
  };
  await page.evaluate(() => window.harness.load('events.jsonl'));
  await report(page, (x) => x.fileName === 'events.jsonl' && x.stats.parsed >= x.stats.lines);
  const once = await listeners();
  for (const file of ['sample.json', 'events.jsonl', 'special-keys.jsonl', 'events.jsonl']) {
    await page.evaluate((f) => window.harness.load(f), file);
    await report(page, (x) => x.fileName === file && x.stats.parsed >= x.stats.lines);
  }
  check.eq('window and document listeners after four more files', await listeners(), once);
});

await scenario('W37', 'One JSON document: search finds what is inside folded nodes and opens only the way to it', [], async ({ page, check, shot }) => {
  await openBlank(page);
  // About 10 MB: it opens with the second level folded, so no match is on screen at first.
  await page.evaluate(() => {
    const rows = Array.from({ length: 200000 }, (_, i) => ({ id: i, name: 'n' + i, pos: { x: i, y: -i } }));
    return window.harness.load('doc.json', { text: JSON.stringify({ rows, meta: { owner: 'needle-in-meta' } }) });
  });
  let r = await report(page, (x) => x.fileName === 'doc.json' && x.formatted);
  check.eq('opens folded', r.formatted.totalRows, 4);
  await page.fill('.search input', 'n199999');
  r = await report(page, (x) => x.matches === 1);
  check.eq('the counter shows the match before anything is opened', [await page.locator('.search .count').innerText(), r.formatted.totalRows], ['– / 1', 4]);
  await page.press('.search input', 'Enter');
  r = await report(page, (x) => x.formatted.totalRows > 4);
  const hit = page.locator('.formatted .row.hit');
  check.eq('Enter goes to the match', [await hit.count(), (await hit.innerText()).includes('"n199999"'), await page.locator('.search .count').innerText()], [1, true, '1 / 1']);
  // "rows" and the one item are open; the other 199 999 items stay folded.
  check.eq('only the way to the match is opened', r.formatted.totalRows, 200000 + 5 + 4);
  check.ok('the text is marked', (await page.locator('.formatted .row.hit mark').count()) === 1);
  await shot('Search inside a folded 10 MB JSON document');
  await page.fill('.search input', 'needle');
  // The search before also had one match: wait for the counter of the new one (no match in focus yet).
  await page.waitForFunction(() => document.querySelector('.search .count').textContent === '– / 1');
  await page.press('.search input', 'Enter');
  await page.waitForFunction(() => document.querySelector('.formatted .row.hit')?.textContent.includes('needle-in-meta'));
  check.ok('a second search goes to its own match', true);
  await page.fill('.search input', '"id": ');
  r = await report(page, (x) => x.matches === 1000);
  check.eq('many matches: the counter stops at 1 000 and says there are more', await page.locator('.search .count').innerText(), '– / 1,000+');
  await page.press('.search input', 'Enter');
  await page.press('.search input', 'Enter');
  await page.press('.search input', 'Shift+Enter');
  await page.waitForFunction(() => document.querySelector('.search .count').textContent.startsWith('1 /'));
  check.ok('Enter and Shift+Enter step through the matches', (await hit.innerText()).includes('"id": 0'), await hit.innerText());
});

await scenario('W38', 'Settings panel: an indent from settings.json that is not 2 or 4 is offered too', [], async ({ page, check }) => {
  await open(page, 'events.jsonl', { config: { indent: 3 } });
  await complete(page);
  await page.click('.gear-btn');
  await report(page, (x) => x.settingsOpen === true);
  const options = await page.$$eval('.settings-seg[data-key="indent"] .seg-btn', (els) => els.map((e) => [e.dataset.value, e.classList.contains('on')]));
  check.eq('2, the value in use, and 4', options, [['2', false], ['3', true], ['4', false]]);
});

await scenario('W39', 'JSON Lines edits arrive as changes: the lines are patched, the state follows, a mismatch asks for the whole text', ['F11'], async ({ page, check }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  const text = await page.evaluate(async () => (await (await fetch('/test/fixtures/events.jsonl')).text()));
  const lines = text.split('\n');
  await rowLocator(page, 2).click();
  let r = await report(page, (x) => x.active === 2);
  const edit = (base, version, changes, now) => send(page, { type: 'edit', base, version, lineCount: now.length, chars: now.join('\n').length, eol: 1, changes });
  // 1. A new first line.
  let now = ['{"id":0,"level":"new"}', ...lines];
  await edit(1, 2, [{ sl: 0, sc: 0, el: 0, ec: 0, text: '{"id":0,"level":"new"}\n' }], now);
  r = await report(page, (x) => x.version === 2 && x.stats.parsed >= x.stats.lines);
  check.eq('one more line, the selection follows its record', [r.stats.lines, r.stats.valid, r.active, r.activeText], [22, 19, 3, lines[2]]);
  // 2. Two changes in one message: inside the active line, and two lines joined further down.
  const at = now[3].indexOf('slow query');
  const joined = now.slice();
  joined[3] = now[3].replace('slow query', 'slow 查询');
  joined.splice(8, 2, now[8] + now[9]);
  await edit(2, 3, [{ sl: 8, sc: now[8].length, el: 9, ec: 0, text: '' }, { sl: 3, sc: at, el: 3, ec: at + 10, text: 'slow 查询' }], joined);
  r = await report(page, (x) => x.version === 3 && x.stats.parsed >= x.stats.lines);
  now = joined;
  check.eq('the edited line shows the new text', r.activeText, now[3]);
  check.eq('two lines joined: one line less, and it is not valid JSON', [r.stats.lines, r.stats.errors], [21, 3]);
  check.eq('nothing asked for the whole text so far', (await posted(page, 'resync')).length, 0);
  // 3. The last line feed goes away: the same records, no empty last line.
  const last = now.length - 1;
  await edit(3, 4, [{ sl: last - 1, sc: now[last - 1].length, el: last, ec: 0, text: '' }], now.slice(0, -1));
  r = await report(page, (x) => x.version === 4);
  check.eq('records stay the same without the last line feed', r.stats.lines, 21);
  // 4. Changes that do not fit (a wrong base version, then a wrong size): the webview asks for the text.
  await edit(9, 10, [{ sl: 0, sc: 0, el: 0, ec: 0, text: 'x' }], now);
  await page.waitForFunction(() => window.harness.posted('resync').length === 1);
  await send(page, { type: 'edit', base: 4, version: 5, lineCount: 99, chars: 1, eol: 1, changes: [{ sl: 0, sc: 0, el: 0, ec: 0, text: 'x' }] });
  await page.waitForFunction(() => window.harness.posted('resync').length === 2);
  r = await report(page);
  check.eq('the view is unchanged after a mismatch', [r.version, r.stats.lines], [4, 21]);
  await send(page, { type: 'update', text, version: 6 });
  r = await report(page, (x) => x.version === 6 && x.stats.parsed >= x.stats.lines);
  check.eq('the whole text puts both sides in step again', [r.stats.lines, r.stats.valid, r.stats.errors], [21, 18, 2]);
});

await scenario('W40', 'Keyboard: fold arrows, toolbar buttons, grid headers and graph nodes work without a mouse', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await rowLocator(page, 2).click();
  let r = await report(page, (x) => x.active === 2);
  const rows = r.formatted.totalRows;
  const focusInfo = () => page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a.tagName.toLowerCase(), cls: a.getAttribute('class'), expanded: a.getAttribute('aria-expanded'), row: a.closest('.row')?.dataset.j ?? null };
  });
  // The fold arrow of "user" (the second arrow of the record) is a button.
  await page.locator('.formatted .row[data-r="2"] .fold[data-k]').nth(1).focus();
  const before = await focusInfo();
  check.eq('a fold arrow is a button that says it is open', [before.tag, before.expanded], ['button', 'true']);
  await page.keyboard.press('Enter');
  r = await report(page, (x) => x.formatted.totalRows < rows);
  let now = await focusInfo();
  check.eq('Enter folds the node; the focus stays on its arrow', [now.cls, now.expanded, now.row], ['fold closed', 'false', before.row]);
  check.eq('Enter on a button does not open the record editor', await page.locator('.editpanel:not([hidden])').count(), 0);
  await page.keyboard.press('Space');
  r = await report(page, (x) => x.formatted.totalRows === rows);
  now = await focusInfo();
  check.eq('Space unfolds it again', [now.cls, now.expanded], ['fold', 'true']);
  // Toolbar: Enter on the Grid tab switches the view.
  await tabBtn(page, 'grid').focus();
  await page.keyboard.press('Enter');
  r = await report(page, (x) => x.view === 'grid');
  check.eq('Enter on a toolbar button presses it', [r.view, await page.locator('.editpanel:not([hidden])').count()], ['grid', 0]);
  // Grid: Enter on a header sorts, twice for descending.
  await page.locator('.gh[data-col="ms"]').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  check.eq('Enter on a header sorts by it', [await page.locator('.grows .grow').first().getAttribute('data-id'), await page.locator('.gh[data-col="ms"]').getAttribute('aria-sort')], ['2', 'descending']);
  check.eq('the header keeps the focus', (await focusInfo()).cls.includes('gh'), true);
  // Graph: nodes take the focus; Enter selects, Left folds, Right unfolds.
  await tabBtn(page, 'graph').click();
  r = await report(page, (x) => x.view === 'graph' && x.graph);
  const nodes = r.graph.nodes;
  const user = page.locator('.gn').filter({ has: page.locator('.gtitle', { hasText: 'user' }) }).first();
  await user.focus();
  await page.keyboard.press('Enter');
  r = await report(page, (x) => x.graph.selectedPath === '$.user');
  check.eq('Enter selects the node', r.graph.selectedPath, '$.user');
  await page.keyboard.press('ArrowLeft');
  r = await report(page, (x) => x.graph.nodes < nodes);
  const folded = await page.evaluate(() => [document.activeElement.getAttribute('class')?.includes('gn'), document.activeElement.getAttribute('aria-expanded')]);
  check.eq('Left folds it (its child nodes go away); the focus stays on the node', folded, [true, 'false']);
  await shot('Graph: a node folded with the keyboard, focus ring on it');
  await page.keyboard.press('ArrowRight');
  r = await report(page, (x) => x.graph.nodes === nodes);
  check.eq('Right unfolds it', r.graph.nodes, nodes);
});

await scenario('W41', 'Search with jq and JSONPath: JSON Lines records, results in one document, errors', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  const count = () => page.locator('.search .count').innerText();
  await page.fill('.search input', '.level == "warn"');
  let r = await report(page, (x) => x.matches === 3);
  check.ok('jq matches records, and says it is jq', (await count()).startsWith('jq · '), await count());
  await page.fill('.search input', 'select(.ms > 100) | .user.name');
  r = await report(page, (x) => x.matches === 1);
  check.eq('select and a pipe', r.matches, 1);
  await page.fill('.search input', '$[?@.ms > 10]');
  r = await report(page, (x) => x.matches === 3);
  check.ok('JSONPath filter on each record', (await count()).startsWith('JSONPath · '), await count());
  await page.fill('.search input', '$..roles[?@ == "admin"]');
  r = await report(page, (x) => x.matches === 1);
  check.eq('JSONPath descendants', r.matches, 1);
  await page.fill('.search input', '.level ==');
  r = await report(page, (x) => x.notes.some((n) => n.startsWith('jq: ')));
  check.ok('an invalid query is searched as text and says why', r.notes.some((n) => n.startsWith('jq: ')), r.notes);
  await shot('jq error in the status bar');
  // One JSON document: results are places in it.
  await open(page, 'doc.json', { text: JSON.stringify({ rows: [{ id: 1, tags: ['x'] }, { id: 2, tags: [] }], meta: { n: 2 } }, null, 2) });
  await page.fill('.search input', '.rows[] | select(.id == 2) | .tags');
  r = await report(page, (x) => x.matches === 1);
  await page.press('.search input', 'Enter');
  await page.waitForFunction(() => document.querySelector('.formatted .row.hit')?.textContent.includes('"tags": []'));
  check.eq('Enter goes to the result', await count(), 'jq · 1 / 1');
  await page.fill('.search input', '.rows | length');
  r = await report(page, (x) => x.notes.includes('Result: 2'));
  check.ok('a computed value shows in the status bar', r.notes.includes('Result: 2'), r.notes);
  await page.fill('.search input', '$..id');
  r = await report(page, (x) => x.matches === 2);
  check.eq('JSONPath in one document', r.matches, 2);
});

await scenario('W42', 'Follow mode: new lines at the end show at once (a large file, and a text document)', [], async ({ page, check }) => {
  await openBlank(page);
  const version = await page.evaluate(() => window.harness.loadLarge('big.jsonl', new TextEncoder().encode('{"id":1}\n{"id":2}\n{"id":3'), { readOnly: false }));
  let r = await report(page, (x) => x.large && !x.loading && x.stats.parsed >= x.stats.lines);
  check.eq('three lines; the last one has no line end yet and is cut off', [r.stats.lines, r.stats.valid, r.stats.errors], [3, 2, 1]);
  await page.click('.follow-btn');
  r = await report(page, (x) => x.active === 2);
  check.eq('follow on: the host is told, the last line is the current one', [(await posted(page, 'follow')).at(-1), r.active], [{ type: 'follow', on: true }, 2]);
  check.eq('following does not move the editor cursor', (await posted(page, 'select')).length, 0);
  await send(page, { type: 'append', version, data: new TextEncoder().encode(',"more":true}\n{"id":4}\n{"id":5}\n') });
  r = await report(page, (x) => x.stats.lines === 5 && x.stats.parsed >= 5);
  check.eq('the open last line goes on; new lines follow; the view stays at the end', [r.stats.valid, r.active, r.activeText], [5, 4, '{"id":5}']);
  check.ok('the line that went on is read again', (await page.evaluate(() => window.harness.lastReport().stats.errors)) === 0);
  await send(page, { type: 'notice', message: 'New lines were added to the file.', action: 'append' });
  await page.click('.banner .banner-act');
  check.eq('without follow: a button loads the new lines', (await posted(page, 'loadAppended')).length, 1);
  // A text document: an edit that adds a line at the end.
  await open(page, 'events.jsonl');
  await complete(page);
  await page.click('.follow-btn');
  r = await report(page, (x) => x.active === 20);
  const text = await page.evaluate(async () => (await (await fetch('/test/fixtures/events.jsonl')).text()));
  await send(page, { type: 'update', text: text + '{"id":9999}\n', version: 2 });
  r = await report(page, (x) => x.version === 2 && x.active === 21);
  check.eq('a text document in follow mode goes to the new last line', r.activeText, '{"id":9999}');
});

await scenario('W43', 'Export: rows as CSV or JSON Lines, sent in pieces when the host is ready', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  await page.click('.export-btn');
  const items = await page.$$eval('.export-menu .menu-item', (els) => els.map((e) => e.dataset.export));
  check.eq('menu: all rows, and the selected line', items, ['rows:jsonl', 'rows:csv', 'selected:jsonl', 'selected:csv']);
  await shot('Export menu');
  await page.click('[data-export="rows:csv"]');
  const start = (await posted(page, 'exportStart')).at(-1);
  check.eq('the host is asked where to save (20 lines with text; the blank line is left out)', [start.format, start.rows, start.name], ['csv', 20, 'events-rows']);
  await send(page, { type: 'exportReady', id: start.id, ok: true });
  await page.waitForFunction(() => window.harness.posted('exportData').length === 1);
  const piece = (await posted(page, 'exportData'))[0];
  const lines = piece.data.split('\n');
  check.eq('a CSV header with a byte order mark', lines[0].slice(0, 20), '﻿(value),id,ts,level');
  check.ok('nested values are compact JSON, quoted', lines[3].includes('"{""id"":""u_17"",""name"":""Ada"",""roles"":[""admin"",""ops""]}"'), lines[3]);
  check.eq('a header and 20 rows (an invalid line keeps its text in the first column)', lines.length, 1 + 20 + 1);
  await send(page, { type: 'exportReady', id: start.id, ok: true });
  await page.waitForFunction(() => window.harness.posted('exportData').length === 2);
  check.eq('then the last, empty piece', (await posted(page, 'exportData'))[1], { type: 'exportData', id: start.id, data: '', done: true });
  // Search narrows the rows; JSON Lines are the raw lines.
  await page.fill('.search input', 'level=warn');
  await report(page, (x) => x.matches === 3);
  await page.click('.export-btn');
  await page.click('[data-export="rows:jsonl"]');
  const s2 = (await posted(page, 'exportStart')).at(-1);
  await send(page, { type: 'exportReady', id: s2.id, ok: true });
  await page.waitForFunction((id) => window.harness.posted('exportData').some((m) => m.id === id), s2.id);
  const jl = (await posted(page, 'exportData')).find((m) => m.id === s2.id).data;
  check.eq('three raw lines', jl.trim().split('\n').length, 3);
  check.ok('lines exactly as in the file', jl.includes('"trace":9007199254740993'), jl.slice(0, 120));
});
await scenario('W44', 'Grid: column statistics in the filter popup; a large file sorts and filters after reading its columns', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl', { config: { defaultView: 'grid' } });
  await complete(page);
  await page.hover('.gh[data-col="ms"]');
  await page.click('.gh[data-col="ms"] .gh-f');
  const stats = await page.locator('.gf-stats').innerText();
  check.ok('types, distinct values, min, max, mean', /number \d+/.test(stats) && /\(missing\) \d+/.test(stats) && /distinct/.test(stats) && /min 8 · max 1,?840/.test(stats), stats);
  await shot('Column statistics');
  await page.keyboard.press('Escape');
  // 250 000 lines of a large file: records are not all kept, so the column is read first.
  await openBlank(page);
  await page.evaluate(() => {
    const rows = [];
    for (let i = 0; i < 250000; i++) rows.push(`{"id":${i},"v":${(i * 7919) % 1000}}`);
    return window.harness.loadLarge('big.jsonl', new TextEncoder().encode(rows.join('\n') + '\n'), { chunk: 1 << 20, config: { defaultView: 'grid' } });
  });
  await report(page, (x) => x.large && !x.loading && x.stats.parsed >= x.stats.lines && x.view === 'grid', 30000);
  await page.click('.gh[data-col="v"]');
  await page.click('.gh[data-col="v"]');
  let r = await report(page, (x) => x.notes.length === 0 && x.grid.rows === 250000, 30000);
  await page.waitForTimeout(100);
  check.eq('sorted descending: the first row has v = 999 (record 321)', await page.locator('.grows .grow').first().getAttribute('data-id'), '321');
  await page.click('.gh[data-col="v"] .gh-f');
  await page.waitForFunction(() => document.querySelectorAll('.gf-list .gf-item').length > 0, null, { timeout: 30000 });
  check.ok('the value list of a 250 000-row column', (await page.locator('.gf-stats').innerText()).includes('1,000 distinct'));
  await page.fill('.gf-search input', '999');
  r = await report(page, (x) => x.grid.rows === 250, 30000);
  check.eq('a text filter on the column', r.grid.rows, 250);
});

await scenario('W45', 'Grid: edit a cell (JSON Lines: the line with only that value changed; a JSON document: the value at its path)', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl', { config: { defaultView: 'grid' } });
  await complete(page);
  const line0 = await page.evaluate(async () => (await (await fetch('/test/fixtures/events.jsonl')).text()).split('\n')[0]);
  await page.locator('.grow[data-id="0"] .gc').filter({ hasText: 'login ok' }).dblclick();
  const input = page.locator('.gedit');
  check.eq('the editor holds the text of the string', await input.inputValue(), 'login ok');
  await shot('Editing a cell');
  await input.fill('signed in "now"');
  await input.press('Enter');
  const sent = (await posted(page, 'editLine')).at(-1);
  check.eq('the line is sent with only that value changed', sent, { type: 'editLine', line: 0, original: line0, text: line0.replace('"login ok"', '"signed in \\"now\\""'), exact: true });
  await send(page, { type: 'editResult', ok: false, message: 'Line 1 changed after the edit started. Nothing was written.' });
  await page.waitForFunction(() => document.querySelector('.banner:not([hidden])')?.textContent.includes('changed after'));
  check.ok('a refused edit shows in the banner', true);
  // A number cell takes JSON; text that is not JSON is refused there.
  await page.locator('.grow[data-id="1"] .gc.tn').filter({ hasText: '42' }).dblclick();
  await input.fill('forty');
  await input.press('Enter');
  check.eq('not JSON in a number cell: marked, not sent', [await input.getAttribute('class'), (await posted(page, 'editLine')).length], ['gedit bad', 1]);
  await input.fill('43');
  await input.press('Enter');
  check.ok('a number is written as a number', (await posted(page, 'editLine')).at(-1).text.includes('"ms":43'));
  // One JSON document: the value at its path.
  await open(page, 'doc.json', { text: '{"a": 1, "b": "x", "c": {"d": true}}', config: { defaultView: 'grid' } });
  await page.locator('.grow[data-id="1"] .gc').nth(1).dblclick();
  await input.fill('y');
  await input.press('Enter');
  check.eq('a JSON document sends the path and its version', (await posted(page, 'editValue')).at(-1), { type: 'editValue', path: ['b'], version: 1, text: '"y"' });
  await page.locator('.grow[data-id="2"] .vchip').dblclick();
  check.eq('objects are not edited in a cell', await page.locator('.gedit').count(), 0);
});

await scenario('W46', 'Compare two lines: the differences, field by field, and the diff editor', [], async ({ page, check, shot }) => {
  await open(page, 'events.jsonl');
  await complete(page);
  check.ok('no compare button for one line', await page.locator('.compare-btn').isHidden());
  await send(page, { type: 'selection', lines: [2, 3], active: 3 });
  await report(page, (x) => x.selected.length === 2);
  await page.click('.compare-btn');
  const panel = page.locator('.comparepanel');
  await panel.waitFor({ state: 'visible' });
  const rows = await panel.locator('tr').allInnerTexts();
  check.ok('changed, removed and added members', rows.some((t) => t.startsWith('$.id')) && rows.some((t) => t.startsWith('$.trace')) && rows.some((t) => t.startsWith('$.job')), rows);
  check.ok('the count of differences', /\d+ differences/.test(await panel.locator('.ep-head').innerText()));
  await shot('Comparing lines 3 and 4');
  await panel.locator('.cmp-diff').click();
  const diff = (await posted(page, 'diff')).at(-1);
  check.eq('the diff editor gets both records, pretty-printed', [diff.left.title, diff.right.title, diff.left.text.startsWith('{\n  "id": 1003')], ['events.jsonl line 3', 'events.jsonl line 4', true]);
  await page.keyboard.press('Escape');
  check.ok('Esc closes the panel', await panel.isHidden());
});

await scenario('W47', 'Graph overview: shows when the graph is larger than the view; a click moves the view', [], async ({ page, check, shot }) => {
  const wide = {};
  for (let i = 0; i < 40; i++) wide['k' + i] = { a: { b: { c: i } } };
  await open(page, 'w.jsonl', { text: JSON.stringify(wide) + '\n', config: { defaultView: 'graph' } });
  await report(page, (x) => x.view === 'graph' && x.graph && x.graph.nodes > 100);
  await page.click('[data-z="in"]');
  await page.click('[data-z="in"]');
  const mini = page.locator('.gmini');
  check.ok('the overview shows when part of the graph is outside the view', await mini.isVisible());
  const before = await page.locator('.gsvg .vp').getAttribute('transform');
  const box = await mini.boundingBox();
  await page.mouse.click(box.x + box.width - 10, box.y + box.height - 10);
  check.ok('a click in the overview moves the view', (await page.locator('.gsvg .vp').getAttribute('transform')) !== before);
  await shot('Graph overview');
  await page.click('[data-z="fit"]');
  check.ok('hidden when the whole graph is in view', await mini.isHidden());
});

await scenario('W48', 'One JSON value read from bytes (as for a file over 512 MB); a compressed file is read-only', [], async ({ page, check }) => {
  await page.addInitScript(() => (window.__betterJsonlByteJsonAt = 1000));
  await openBlank(page);
  const doc = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'n' + i + 'é😀' })), big: 12345678901234567890 };
  const text = JSON.stringify(doc).replace('"big":12345678901234567000', '"big":12345678901234567890');
  await page.evaluate((t) => window.harness.loadLarge('doc.json', new TextEncoder().encode(t), { chunk: 777 }), text);
  let r = await report(page, (x) => x.large && x.fileName === 'doc.json' && x.formatted, 20000);
  check.eq('parsed from the bytes: one value', [r.isJsonl, r.stats.valid, r.formatted.totalRows], [false, 1, 2000 * 4 + 5]);
  await page.fill('.search input', '.big');
  r = await report(page, (x) => x.matches === 1);
  await page.press('.search input', 'Enter');
  await page.waitForFunction(() => document.querySelector('.formatted .row.hit')?.textContent.includes('12345678901234567890'));
  check.ok('a big integer keeps its text', true);
  await openBlank(page);
  await page.evaluate(() => window.harness.loadLarge('bad.json', new TextEncoder().encode('{"a": [1, 2,, 3]}' + ' '.repeat(2000))));
  await page.waitForFunction(() => document.querySelector('.boot')?.textContent.includes('not valid JSON'));
  check.ok('an error says where', (await page.locator('.boot').innerText()).includes('byte 13'), await page.locator('.boot').innerText());
  await openBlank(page);
  await page.evaluate(() => window.harness.loadLarge('logs.jsonl.gz', new TextEncoder().encode('{"a":1}\n{"a":2}\n')));
  r = await report(page, (x) => x.large && !x.loading && x.stats.parsed >= x.stats.lines);
  check.eq('a .jsonl.gz file is JSON Lines', [r.isJsonl, r.stats.valid], [true, 2]);
  check.eq('read-only: no Edit, no Open as Text', [await page.locator('.a-edit').count(), await page.locator('.open-text').isHidden()], [0, true]);
});

await scenario('W36', 'The background scan and search do not wait for timers (a window in the background slows timers down)', [], async ({ page, check }) => {
  await openBlank(page);
  // Every timer takes at least 3 seconds, as in a window the system put to sleep.
  await page.evaluate(() => {
    const real = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => real(fn, Math.max(ms || 0, 3000), ...args);
  });
  await page.evaluate(() => {
    const rows = [];
    // About 24 MB: above the size where a search runs in slices.
    for (let i = 0; i < 200000; i++) rows.push(JSON.stringify({ id: i, level: i % 7 ? 'info' : 'warn', msg: 'request finished ' + i + ' ' + 'x'.repeat(40), ms: i % 900 }));
    return window.harness.load('big.jsonl', { text: rows.join('\n') + '\n' });
  });
  // The report itself comes from a (slow) timer. The scan must be complete when it arrives.
  const first = await page.waitForFunction(() => window.harness.posted('report')[0]?.report, null, { timeout: 15000 }).then((h) => h.jsonValue());
  check.eq('the whole file is scanned by the first report', [first.stats.parsed, first.stats.valid], [200000, 200000]);
  await page.fill('.search input', 'level=warn');
  const r = await report(page, (x) => x.matches > 0 && !x.searching, 20000);
  check.eq('the sliced search finishes too', r.matches, Math.ceil(200000 / 7));
});

await browser.close();
server.close();

// ---------- report ----------

const passed = results.filter((r) => r.pass).length;
const summary = { suite: 'webview-e2e', when: new Date().toISOString(), chrome: CHROME, passed, failed: results.length - passed, results };
await writeFile(`${root}test-results/web-e2e.json`, JSON.stringify(summary, null, 2));

let host;
try {
  host = JSON.parse(await readFile(`${root}test-results/host-e2e.json`, 'utf8'));
} catch {
  host = undefined;
}
let ui;
try {
  ui = JSON.parse(await readFile(`${root}test-results/ui-e2e.json`, 'utf8'));
} catch {
  ui = undefined;
}
await writeFile(`${root}test-results/report.html`, renderReport(summary, host, ui));
console.log(`\n${passed}/${results.length} webview scenarios passed. Report: test-results/report.html`);
process.exit(passed === results.length ? 0 : 1);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderReport(web, host, ui) {
  const hostRows = host
    ? host.tests
        .map((t) => `<tr class="${t.state}"><td>${t.state === 'passed' ? '✓' : '✗'}</td><td>${esc(t.title)}</td><td>${esc(t.modes ?? '')}</td><td>${t.duration ?? ''} ms</td><td>${esc(t.error ?? '')}</td></tr>`)
        .join('')
    : '<tr><td colspan="5">Host E2E results not found (run npm run test:e2e:host).</td></tr>';
  const webRows = web.results
    .map(
      (r) => `<section class="sc ${r.pass ? 'passed' : 'failed'}">
      <h3>${r.pass ? '✓' : '✗'} ${esc(r.id)} · ${esc(r.name)} <small>${esc(r.modes.join(' '))} · ${r.ms} ms</small></h3>
      ${r.crash ? `<pre class="crash">${esc(r.crash)}</pre>` : ''}
      <ul>${r.checks.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}${c.ok ? '' : ` — got <code>${esc(JSON.stringify(c.actual)?.slice(0, 300))}</code>${'expected' in c ? ` want <code>${esc(JSON.stringify(c.expected))}</code>` : ''}`}</li>`).join('')}</ul>
      <div class="shots">${r.shots.map((s) => `<figure><a href="web/${s.file}"><img src="web/${s.file}" alt="${esc(s.label)}" loading="lazy"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join('')}</div>
    </section>`,
    )
    .join('');
  const hostPassed = host ? `${host.passed}/${host.passed + host.failed}` : 'n/a';
  const uiPassed = ui ? `${ui.passed}/${ui.passed + ui.failed}` : 'n/a';
  const uiSection = ui
    ? `<section class="sc ${ui.failed ? 'failed' : 'passed'}"><h3>${ui.failed ? '✗' : '✓'} Packaged ${esc(ui.vsix)} in a real VS Code window, with 12 other title-bar buttons</h3>
      <ul>${ui.results.map((c) => `<li class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'} ${esc(c.label)}${c.ok ? '' : ` — got <code>${esc(JSON.stringify(c.actual)?.slice(0, 300))}</code>`}</li>`).join('')}</ul>
      <div class="shots">${(ui.shots ?? []).map((s) => `<figure><a href="${s.file}"><img src="${s.file}" alt="${esc(s.label)}" loading="lazy"></a><figcaption>${esc(s.label)}</figcaption></figure>`).join('')}</div></section>`
    : '<p>UI results not found (run npm run test:e2e:ui).</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Better JSONL E2E report</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--dim:#5f6368;--card:#fff;--line:#e2e2e2;--ok:#0a7d3e;--bad:#c62828}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e8ea;--dim:#a0a4ad;--card:#1d1e22;--line:#2e3036;--ok:#4cc38a;--bad:#ff6b6b}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:1180px;margin:0 auto}h1{margin:0 0 4px}p.meta{color:var(--dim);margin:0 0 20px}
.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px}.kpi{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;min-width:160px}
.kpi b{display:block;font-size:24px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden;margin-bottom:28px}
td,th{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}tr.failed td{color:var(--bad)}
.sc{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin-bottom:16px}.sc.failed{border-color:var(--bad)}
.sc h3{margin:0 0 6px;font-size:15px}.sc small{color:var(--dim);font-weight:400}.sc ul{margin:0 0 8px;padding-left:18px;columns:2;column-gap:28px}
li.ok{color:var(--fg)}li.bad{color:var(--bad)}code{font-size:12px}.shots{display:flex;flex-wrap:wrap;gap:12px}
figure{margin:0;width:min(100%,540px)}figure img{width:100%;border:1px solid var(--line);border-radius:6px}figcaption{color:var(--dim);font-size:12px}
pre.crash{color:var(--bad);white-space:pre-wrap;font-size:12px}@media (max-width:700px){.sc ul{columns:1}}
</style></head><body><main>
<h1>Better JSONL · E2E report</h1>
<p class="meta">Generated ${esc(web.when)} · rerun with <code>npm run test:e2e</code></p>
<div class="kpis"><div class="kpi">Webview scenarios<b>${web.passed}/${web.passed + web.failed}</b></div><div class="kpi">Extension host tests<b>${hostPassed}</b></div><div class="kpi">VS Code UI checks<b>${uiPassed}</b></div></div>
<h2>Extension host (VS Code)</h2>
<table><tr><th></th><th>Test</th><th>Failure modes</th><th>Time</th><th>Error</th></tr>${hostRows}</table>
<h2>VS Code UI (installed VSIX)</h2>${uiSection}
<h2>Webview (Chrome)</h2>${webRows}
</main></body></html>`;
}
