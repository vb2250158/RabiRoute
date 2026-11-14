import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildPackageStaging } from './Build-RabiLinkAiuiPackage.mjs';
import { writeDeterministicZip } from './Write-DeterministicZip.mjs';
import { installToolWaitProbe } from './ToolWaitProbe.mjs';

const target = process.argv[2];
if (!target || !path.isAbsolute(target) || !target.endsWith('-tool-wait-probe.aix')) throw Error('Provide an absolute diagnostic *-tool-wait-probe.aix path');
if (fs.existsSync(target)) throw Error('Diagnostic artifact already exists');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-tool-wait-probe-'));
if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('rabilink-tool-wait-probe-')) throw Error('Unsafe staging root');
try {
  await buildPackageStaging(root, { relayBaseUrl: '' });
  const entry = path.join(root, 'pages/home/index.js');
  const source = fs.readFileSync(entry, 'utf8');
  const exports = [...source.matchAll(/export\s*\{\s*(\w+)\s+as\s+default\s*\};/g)];
  if (exports.length !== 1) throw Error('Expected one compiled Page export');
  fs.writeFileSync(entry, source.replace(exports[0][0], `(${installToolWaitProbe.toString()})(${exports[0][1]});\n${exports[0][0]}`));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  manifest.name = 'RabiLink Tool Wait Probe';
  fs.writeFileSync(path.join(root, 'app.json'), JSON.stringify(manifest, null, 2));
  writeDeterministicZip(root, target);
  const bytes = fs.readFileSync(target);
  console.log(JSON.stringify({ path: target, diagnosticOnly: true, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), version: fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() }));
} finally {
  // root is a freshly created and verified direct child of this machine's Temp.
  fs.rmSync(root, { recursive: true, force: true });
}
