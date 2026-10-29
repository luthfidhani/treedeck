import { copyFileSync, mkdirSync } from 'fs';
import { build, context } from 'esbuild';

// Codicon font for the webview panel (dev dependency; shipped as a static asset).
mkdirSync('dist', { recursive: true });
for (const f of ['codicon.css', 'codicon.ttf']) copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/${f}`);

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: process.argv.includes('--production') ? false : 'linked',
  minify: process.argv.includes('--production'),
};

if (process.argv.includes('--watch')) {
  await (await context(opts)).watch();
} else {
  await build(opts);
}
