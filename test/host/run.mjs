// Starts VS Code with the extension and runs test/host/tests.ts.
// Uses the installed VS Code when found (set VSCODE_PATH to override); otherwise downloads one.
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const root = fileURLToPath(new URL('../../', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'better-jsonl-e2e-'));
const fixtures = join(work, 'fixtures');
await cp(join(root, 'test/fixtures'), fixtures, { recursive: true });
await mkdir(join(root, 'test-results'), { recursive: true });

const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
// VSCODE_DOWNLOAD=1 always downloads a VS Code (CI does this, so runs do not depend on the machine).
let vscodeExecutablePath = process.env.VSCODE_PATH || (process.env.VSCODE_DOWNLOAD !== '1' && existsSync(installed) ? installed : undefined);
if (!vscodeExecutablePath) {
  // CI machines have no VS Code: download one. On macOS, VS Code now names its binary
  // "Code", while @vscode/test-electron 2.x still returns ".../MacOS/Electron".
  const downloaded = await downloadAndUnzipVSCode('stable');
  vscodeExecutablePath = existsSync(downloaded) ? downloaded : downloaded.replace(/\/Electron$/, '/Code');
}

try {
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'dist-test/host/suite.js'),
    launchArgs: [
      fixtures,
      '--disable-extensions',
      `--user-data-dir=${join(work, 'user-data')}`,
      `--extensions-dir=${join(work, 'extensions')}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--new-window',
    ],
    extensionTestsEnv: {
      BETTER_JSONL_FIXTURES: fixtures,
      BETTER_JSONL_RESULTS: process.env.MOCHA_GREP ? join(work, 'partial.json') : join(root, 'test-results/host-e2e.json'),
      MOCHA_GREP: process.env.MOCHA_GREP ?? '',
    },
  });
  console.log('Host E2E passed. Results: test-results/host-e2e.json');
} catch (e) {
  console.error('Host E2E failed:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
