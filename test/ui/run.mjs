// UI E2E: installs the packaged VSIX into an isolated VS Code, together with a "crowd"
// extension that adds 12 always-visible title-bar buttons (VS Code shows at most 9 editor
// title buttons and moves the rest to "More Actions"). It reads the real workbench DOM over
// the Chrome DevTools Protocol.
// Output: test-results/ui/*.png and test-results/ui-e2e.json
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const app = process.env.VSCODE_APP ?? '/Applications/Visual Studio Code.app';
const electron = join(app, 'Contents/MacOS/Code');
const cli = join(app, 'Contents/Resources/app/bin/code');
const outDir = join(root, 'test-results/ui');
const vsix = readdirSync(join(root, 'dist-vsix')).filter((f) => f.endsWith('.vsix')).sort().pop();
if (!existsSync(electron) || !vsix) {
  console.error(`Need ${electron} and a VSIX in dist-vsix/ (run npm run package).`);
  process.exit(2);
}

const results = [];
const shots = [];
const check = (label, ok, actual) => {
  results.push({ label, ok: !!ok, actual });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — got ${JSON.stringify(actual)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await mkdir(outDir, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'better-jsonl-ui-'));
let proc;
let browser;
try {
  const fixtures = join(work, 'fixtures');
  await cp(join(root, 'test/fixtures'), fixtures, { recursive: true });
  const userData = join(work, 'user-data');
  const extDir = join(work, 'extensions');
  await mkdir(join(userData, 'User'), { recursive: true });
  // In-window menus (not native macOS menus), so the "More Actions" menu is in the DOM.
  await writeFile(
    join(userData, 'User/settings.json'),
    JSON.stringify({ 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'security.workspace.trust.enabled': false, 'window.menuStyle': 'custom' }),
  );

  const crowd = join(work, 'crowd');
  await mkdir(crowd, { recursive: true });
  const crowdCommands = Array.from({ length: 12 }, (_, i) => ({ command: `crowd.c${i}`, title: `Aaa crowd ${i}`, icon: '$(circle-filled)' }));
  await writeFile(
    join(crowd, 'package.json'),
    JSON.stringify({
      name: 'crowd',
      publisher: 'test',
      version: '0.0.1',
      engines: { vscode: '^1.80.0' },
      main: './extension.js',
      contributes: { commands: crowdCommands, menus: { 'editor/title': crowdCommands.map((c) => ({ command: c.command, group: 'navigation' })) } },
    }),
  );
  await writeFile(join(crowd, 'extension.js'), 'exports.activate = () => {};');
  await writeFile(join(crowd, 'README.md'), 'Test extension with many title-bar buttons.');
  await writeFile(join(crowd, 'LICENSE'), 'MIT');
  const crowdVsix = join(work, 'crowd.vsix');
  execFileSync(join(root, 'node_modules/.bin/vsce'), ['package', '-o', crowdVsix, '--allow-missing-repository', '--skip-license'], { cwd: crowd, stdio: 'pipe' });
  for (const pkg of [join(root, 'dist-vsix', vsix), crowdVsix]) {
    execFileSync(cli, ['--user-data-dir', userData, '--extensions-dir', extDir, '--install-extension', pkg], { stdio: 'ignore' });
  }

  const port = 9300 + Math.floor(Math.random() * 500);
  proc = spawn(
    electron,
    [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, `--remote-debugging-port=${port}`, '--skip-welcome', '--skip-release-notes', '--new-window', fixtures, join(fixtures, 'events.jsonl')],
    { stdio: 'ignore' },
  );

  const end = Date.now() + 30000;
  while (!browser && Date.now() < end) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(300);
    }
  }
  if (!browser) throw new Error('Could not connect to VS Code over CDP.');
  let page;
  while (!page && Date.now() < end) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('workbench'));
    if (!page) await sleep(300);
  }
  if (!page) throw new Error('No workbench window.');
  await page.waitForSelector('.monaco-workbench .editor-group-container.active .monaco-editor', { timeout: 30000 });
  await sleep(4000);

  const titleButtons = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.editor-group-container.active .editor-actions .action-item .action-label')].map(
        (a) => a.getAttribute('aria-label') ?? a.textContent ?? '',
      ),
    );
  const moreActions = async () => {
    await page.click('.editor-group-container.active .editor-actions .codicon-toolbar-more');
    await page.waitForSelector('.monaco-menu .action-label', { timeout: 5000 }).catch(() => {});
    const items = await page.evaluate(() => [...document.querySelectorAll('.monaco-menu .action-label')].map((a) => a.getAttribute('aria-label') || a.textContent || ''));
    await page.keyboard.press('Escape');
    return items.filter((x) => x.trim());
  };
  const shoot = async (file, label) => {
    const header = await page.$('.editor-group-container.active .title');
    await (header ?? page).screenshot({ path: join(outDir, file) });
    shots.push({ file: `ui/${file}`, label });
  };

  const crowded = await titleButtons();
  check('the crowd extension fills the title bar (some of its buttons overflow)', crowded.filter((x) => x.startsWith('Aaa crowd')).length < 12, crowded);
  check('prism button is the first title-bar button (editor focused)', crowded[0]?.startsWith('Better JSONL: Open Preview to the Side'), crowded);
  const icon = await page.evaluate(async () => {
    const a = document.querySelector('.editor-group-container.active .editor-actions [aria-label^="Better JSONL: Open Preview to the Side"]');
    if (!a) return { found: false };
    const css = getComputedStyle(a);
    const url = (css.backgroundImage.match(/url\("?(.*?)"?\)/) || [])[1];
    const size = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0, error: true });
      img.src = url ?? '';
    });
    return { found: true, box: { w: a.offsetWidth, h: a.offsetHeight }, url, size };
  });
  check('prism icon image loads and has a size (it is visible)', icon.found && icon.size?.w > 0 && icon.size?.h > 0 && icon.box.w > 0, icon);
  await shoot('title-crowded.png', 'Editor title bar with 12 other buttons: the prism button stays first');
  const more = await moreActions();
  check('prism button is not in the More Actions menu', !more.some((x) => x.includes('Better JSONL')), more);

  await page.click('.part.sidebar, .activitybar').catch(() => {});
  await sleep(800);
  const unfocused = await titleButtons();
  check('prism button stays when the editor loses focus', unfocused.some((x) => x.startsWith('Better JSONL: Open Preview to the Side')), unfocused);

  await page.click('.editor-group-container.active .editor-actions [aria-label^="Better JSONL: Open Preview to the Side"]');
  const opened = await page
    .waitForFunction(() => [...document.querySelectorAll('.tab .label-name')].some((t) => t.textContent?.startsWith('Better JSONL · events.jsonl')), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('clicking the prism button opens the preview beside the editor', opened);
  await sleep(1500);
  await page.screenshot({ path: join(outDir, 'preview-opened.png') });
  shots.push({ file: 'ui/preview-opened.png', label: 'After a click on the prism button: the preview opens to the side' });

  // The webview content lives in a nested iframe.
  let frame;
  for (let t = 0; t < 40 && !frame; t++) {
    for (const f of page.frames()) {
      if (await f.$('.toolbar .gear-btn').catch(() => null)) frame = f;
    }
    if (!frame) await sleep(250);
  }
  check('the Better JSONL webview is reachable', !!frame);
  if (frame) {
    const wrapped = () => frame.evaluate(() => document.body.classList.contains('wrap'));
    const before = await wrapped();
    await frame.click('.formatted .row.first[data-r="2"] .code-text', { position: { x: 30, y: 5 } });
    await page.keyboard.press('Alt+KeyZ');
    await sleep(600);
    const after = await wrapped();
    check('Alt+Z (Option+Z) toggles word wrap in the preview', after === !before, { before, after });
    await page.keyboard.press('Alt+KeyZ');
    await sleep(600);
    check('Alt+Z again turns it back', (await wrapped()) === before);

    await frame.click('.toolbar .gear-btn');
    await frame.waitForSelector('.settings.active', { timeout: 5000 });
    await frame.click('.settings-seg[data-key="theme"] .seg-btn[data-value="light"]');
    let saved = '';
    for (let t = 0; t < 20 && !saved.includes('"betterJsonl.theme": "light"'); t++) {
      await sleep(250);
      saved = await readFile(join(userData, 'User/settings.json'), 'utf8').catch(() => '');
    }
    check('the settings panel writes VS Code settings.json', saved.includes('"betterJsonl.theme": "light"'), saved);
    const bodyBg = await frame.evaluate(() => getComputedStyle(document.body).backgroundColor);
    check('the light theme is applied', bodyBg === 'rgb(255, 255, 255)', bodyBg);
    await sleep(400);
    await page.screenshot({ path: join(outDir, 'settings-light.png') });
    shots.push({ file: 'ui/settings-light.png', label: 'Settings panel in VS Code: theme set to Light (VS Code itself stays dark)' });
  }
} catch (e) {
  check('run', false, String(e));
} finally {
  await browser?.close().catch(() => {});
  proc?.kill();
  await sleep(1000);
  await rm(work, { recursive: true, force: true }).catch(() => {});
}

const passed = results.filter((r) => r.ok).length;
await writeFile(
  join(root, 'test-results/ui-e2e.json'),
  JSON.stringify({ suite: 'ui-e2e', when: new Date().toISOString(), vsix, passed, failed: results.length - passed, results, shots }, null, 2),
);
console.log(`${passed}/${results.length} UI checks passed.`);
process.exit(passed === results.length ? 0 : 1);
