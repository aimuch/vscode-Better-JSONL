// Makes the three README screenshots (docs/screenshots/*.png) from the real webview bundle.
// Run: npm run screenshots
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from './server.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = `${root}docs/screenshots`;
const CHROME =
  process.env.CHROME_PATH ??
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((p) => existsSync(p));
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.');
  process.exit(2);
}

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/test/web/harness.html?theme=dark`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })).newPage();

const report = (pred) => page.waitForFunction((src) => {
  const r = window.harness.lastReport();
  return r && new Function('r', `return (${src})(r)`)(r);
}, pred.toString());
const send = (msg) => page.evaluate((m) => window.harness.send(m), msg);
const shot = async (name) => {
  await page.mouse.move(640, 790);
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(`docs/screenshots/${name}.png`);
};

await page.goto(base);
await page.waitForFunction(() => window.harness && window.__posted.some((m) => m.type === 'ready'));
await page.evaluate(() => window.harness.load('events.jsonl'));
await report((r) => r.stats.parsed >= r.stats.lines);

// Formatted · Focus: lines 3 to 5 selected in the text editor, an invalid line below them.
await send({ type: 'selection', lines: [2, 3, 4], active: 4 });
await report((r) => r.active === 4 && r.selected.length === 3);
await page.hover('.formatted .row.first[data-r="4"]');
await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/formatted.png` });
console.log('docs/screenshots/formatted.png');

// Grid: the "user" object of line 3 opened under its column, with its "roles" array.
await send({ type: 'selection', lines: [0], active: 0 });
await report((r) => r.active === 0);
await page.click('.toolbar [data-view="grid"]');
await report((r) => r.view === 'grid');
await page.locator('.grow[data-id="2"] .vchip').first().click();
await report((r) => r.grid.openCells === 1);
await page.locator('.gdetail .vchip').first().click();
await report((r) => r.grid.openCells === 2);
await shot('grid');

// Graph: two selected lines compared in one graph.
await send({ type: 'selection', lines: [2, 3], active: 3 });
await report((r) => r.active === 3 && r.selected.length === 2);
await page.click('.toolbar [data-view="graph"]');
await report((r) => r.view === 'graph' && r.graph && r.graph.nodes > 3);
await shot('graph');

await browser.close();
server.close();
