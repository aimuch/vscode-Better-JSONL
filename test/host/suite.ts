// Mocha runner inside the VS Code extension host. Writes test-results/host-e2e.json.
import { mkdirSync, writeFileSync } from 'fs';
import Mocha from 'mocha';
import * as path from 'path';

interface Row {
  title: string;
  state: 'passed' | 'failed';
  duration?: number;
  error?: string;
  modes?: string;
}

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 30000, color: true, grep: process.env.MOCHA_GREP || undefined });
  mocha.addFile(path.join(__dirname, 'tests.js'));
  const rows: Row[] = [];
  const modes = (title: string) => (title.match(/\[(F\d+(?:, ?F\d+)*)\]/)?.[1] ?? '');
  return new Promise((resolve, reject) => {
    const runner = mocha.run((failures) => {
      const out = process.env.BETTER_JSONL_RESULTS;
      if (out) {
        mkdirSync(path.dirname(out), { recursive: true });
        const passed = rows.filter((r) => r.state === 'passed').length;
        writeFileSync(out, JSON.stringify({ suite: 'host-e2e', when: new Date().toISOString(), passed, failed: rows.length - passed, tests: rows }, null, 2));
      }
      if (failures) reject(new Error(`${failures} host test(s) failed.`));
      else resolve();
    });
    runner.on('pass', (t) => rows.push({ title: t.fullTitle(), state: 'passed', duration: t.duration, modes: modes(t.title) }));
    runner.on('fail', (t, err: Error) => rows.push({ title: t.fullTitle(), state: 'failed', duration: t.duration, error: err.message, modes: modes(t.title) }));
  });
}
