import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions[]} */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    // jsonc-parser's UMD build loads files at run time; its ESM build bundles cleanly.
    mainFields: ['module', 'main'],
  },
  {
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'chrome114',
  },
  {
    entryPoints: ['src/webview/style.css'],
    outfile: 'dist/webview.css',
  },
  {
    entryPoints: ['test/host/tests.ts'],
    outfile: 'dist-test/host/tests.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'mocha'],
    mainFields: ['module', 'main'],
  },
  {
    entryPoints: ['test/host/suite.ts'],
    outfile: 'dist-test/host/suite.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode', 'mocha'],
  },
];

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context({ ...common, ...b });
    await ctx.watch();
  }
} else {
  const list = (production ? builds.filter((b) => !b.outfile.startsWith('dist-test')) : builds).filter((b) => existsSync(b.entryPoints[0]));
  await Promise.all(list.map((b) => esbuild.build({ ...common, ...b })));
}
