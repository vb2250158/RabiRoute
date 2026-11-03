import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { adoptColdRelease } from './lib/cold-release-adoption.mjs';

if (process.platform !== 'darwin') throw Error('Cold recovery CLI is limited to macOS');
if (process.argv.length !== 3) throw Error('Usage: recover-release.mjs <frozen-request.json>');
const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const root = path.dirname(fs.realpathSync(request.configPath));
const assertOwnerAbsent = () => {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000 }).split('\n');
  for (const row of rows) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(row); if (!match || Number(match[1]) === process.pid) continue;
    if (request.originalPids?.includes(Number(match[1])) || match[2].includes(root) && /rabi-agent(?:-launcher)?\.mjs/.test(match[2])) throw Error('Original Agent owner or another release worker is still present');
  }
};
console.log(JSON.stringify(await adoptColdRelease({ ...request, assertOwnerAbsent })));
