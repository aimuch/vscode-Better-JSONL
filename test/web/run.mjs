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
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));

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
    window.__lastConfig = { defaultView: 'formatted', expandMode: 'focus', indent: 2, graphMaxNodes: 1500, syncSelection: true, theme: 'vscode', wordWrap: 'followEditor', wrap: false, formatDocument: false, expandReminder: true, language: 'auto', lang: 'en', vscodeLanguage: 'en' };
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
  const base = { defaultView: 'formatted', expandMode: 'focus', indent: 2, graphMaxNodes: 1500, syncSelection: true, theme: 'vscode', wordWrap: 'followEditor', wrap: false, formatDocument: false, expandReminder: true };
  await send(page, { type: 'config', config: { ...base, language: 'en', lang: 'en', vscodeLanguage: 'zh-cn' } });
  r = await report(page, (x) => x.lang === 'en');
  check.eq('view tab in English', await text('[data-view="formatted"]'), 'Formatted');
  check.eq('active line kept', r.active, 2);
  check.eq('settings panel stays open', r.settingsOpen, true);
  check.eq('settings panel in English', await text('.settings-head h2'), 'Settings');
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
