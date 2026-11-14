import { createRequire } from 'node:module';
import { mkdir, copyFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { build } = require(process.env.ASSISTANT_ESBUILD_PATH || 'esbuild');
await mkdir('public', { recursive: true });
await build({ entryPoints: ['ui/app.jsx'], bundle: true, outfile: 'public/app.js', platform: 'browser', format: 'esm', target: 'chrome120', jsx: 'automatic',
  ...(process.env.ASSISTANT_BUILD_MODULES ? { nodePaths: [process.env.ASSISTANT_BUILD_MODULES] } : {}),
  ...(process.env.ASSISTANT_PANEL_SOURCE ? { alias: { '@rabilink/assistant-runtime/ui': process.env.ASSISTANT_PANEL_SOURCE } } : {}) });
await copyFile('ui/index.html', 'public/index.html');
const service = process.env.ASSISTANT_SERVICE_SOURCE || require.resolve('@rabilink/desktop-voice-service/node');
await copyFile(new URL('../runtime/voice.png', new URL('file:///' + service.replaceAll('\\', '/'))), 'public/voice.png');
