import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = path.dirname(fileURLToPath(import.meta.url));
const [destination, zipWriter] = process.argv.slice(2);
if (!destination || !zipWriter) throw new Error('Usage: node build.mjs <new-local-output-directory> <Write-DeterministicZip.mjs>');
const output = path.resolve(destination);
if (output.startsWith('\\\\') || output.startsWith('//') || /^Z:/i.test(output)) throw new Error('Build output must be local, not NAS.');
if (fs.existsSync(output)) throw new Error('Output already exists; choose a new build directory.');
const studio = path.join(output, 'aiui-studio');
fs.mkdirSync(path.join(studio, 'pages/ping'), { recursive: true });
const ink = fs.readFileSync(path.join(source, 'pages/ping/index.ink'), 'utf8');
for (const [tag, extension] of [['script def', 'json'], ['script setup', 'js'], ['page', 'wxml'], ['style', 'wxss']]) {
  const match = ink.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag.split(' ')[0] + '>'));
  if (!match) throw new Error('Missing Ink block: ' + tag);
  if (extension === 'json') JSON.parse(match[1]);
  fs.writeFileSync(path.join(studio, 'pages/ping/index.' + extension), match[1].trim() + '\n');
}
for (const name of ['app.json', 'app.js', 'AGENTS.md']) fs.copyFileSync(path.join(source, name), path.join(studio, name));
fs.writeFileSync(path.join(studio, 'VERSION'), 'rabi-ble-ping-0.3\n');
for (const args of [['--check', path.join(studio, 'pages/ping/index.js')], [path.resolve(zipWriter), studio, path.join(output, 'rabi-ble-ping-0.3.aix')]]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Build validation/package failed');
}
console.log(studio);
