import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { contracts, METHODS } from './webgui-coverage-contract.mjs';
const projectRoot = path.resolve(import.meta.dirname, '..');
export const repoRoot = path.resolve(projectRoot, '../..');
const read = file => fs.readFileSync(file, 'utf8');
function files(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir,e.name)) : /\.(vue|ts|js)$/.test(e.name) ? [path.join(dir,e.name)] : []); }
// Scan template expressions with balanced braces and nested quoted/template strings.
function quoted(source, start) {
  const quote = source[start]; let text = '', i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { text += source.slice(i,i+2); i += 2; continue; }
    if (source[i] === quote) return { text, end: i + 1 };
    if (quote === '`' && source.slice(i,i+2) === '${') {
      const begin = i; i += 2; let depth = 1;
      while (depth && i < source.length) {
        if (['"', "'", '`'].includes(source[i])) { i = quoted(source,i).end; continue; }
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
        i++;
      }
      text += source.slice(begin,i); continue;
    }
    text += source[i++];
  }
  throw new Error('Unterminated endpoint string');
}
export function normalizeEndpoint(raw) {
  let result = '', i = 0;
  while (i < raw.length) {
    if (raw[i] === '?') break;
    if (raw.slice(i,i+2) !== '${') { result += raw[i++]; continue; }
    let depth = 1, start = i + 2; i = start;
    while (depth && i < raw.length) {
      if (['"', "'", '`'].includes(raw[i])) { i = quoted(raw,i).end; continue; }
      if (raw[i] === '{') depth++; if (raw[i] === '}') depth--; i++;
    }
    const expression = raw.slice(start,i-1);
    if (!result && expression.trim() === 'apiBase') continue;
    if (/params\.size|["'`]\?/.test(expression) || (expression.trim() === 'suffix' && result.endsWith('/agents'))) break;
    result += result.endsWith('/') ? ':param' : ':dynamic';
  }
  return result;
}
export function discover(source) {
  const result = [];
  const re = /\bfetch\s*\(\s*([`'"])/g; let match;
  while ((match = re.exec(source))) {
    const value = quoted(source, re.lastIndex - 1); re.lastIndex = value.end;
    let endpoint = normalizeEndpoint(value.text);
    if (endpoint === '/api/rabilink/peer/') endpoint += ':dynamic';
    if (!endpoint.startsWith('/')) continue;
    const tail = source.slice(value.end, source.indexOf('\n', value.end) < 0 ? value.end+250 : value.end+600);
    const method = /^\s*,\s*\{[\s\S]*?\bmethod\s*:\s*['"]([A-Z]+)['"]/.exec(tail)?.[1] || 'GET';
    result.push({endpoint,method});
  }
  return result;
}
export function relayPolicy(source) {
  const start = source.indexOf('function mobileWebguiPathAllowed(');
  const end = source.indexOf('\n}',start);
  if (start < 0 || end < 0) throw new Error('Missing actual Relay permission function');
  return vm.runInNewContext('(' + source.slice(start,end+2) + ')', Object.create(null), {timeout:1000});
}
export function audit(root = repoRoot, policyOverride, extraDiscovered = []) {
  const relay = read(path.join(root,'scripts/rabilink-relay-server.mjs'));
  const allowed = policyOverride || relayPolicy(relay);
  const page = read(path.join(root,'apps/rabilink-aiui/pages/home/index.ink'));
  const found = files(path.join(root,'ribiwebgui/src')).flatMap(file => discover(read(file)).map(e => ({...e,file:path.relative(root,file)})));
  const errors = [];
  for (const item of [...found, ...extraDiscovered]) {
    const candidates = contracts.filter(c => c.endpoint === item.endpoint);
    if (!candidates.length) errors.push(`Unknown discovered endpoint: ${item.endpoint} (${item.file})`);
    // Method extraction is advisory for dynamic helper methods; actual permissions are
    // exhaustively checked below against the explicit method contract.
  }
  for (const c of contracts) {
    const sample = c.endpoint.replaceAll(':param','fixture').replaceAll(':dynamic','/fixture');
    const expected = contracts.filter(row => row.endpoint === c.endpoint && row.classification === 'required').flatMap(row => row.methods);
    for (const method of METHODS) if (allowed(method,sample) !== expected.includes(method)) errors.push(`Relay permission mismatch ${method} ${c.endpoint}`);
    if (c.classification === 'required') {
      const markers = c.endpoint.startsWith('/gateways/') ? ['gatewayActionPath'] : ({'/gateways':['loadWebguiConfigData'],'/manager-config':['loadManagerConfig'],'/open-config-file':['openPcConfigFile'],'/api/scan/agents':['runAgentScan'],'/api/scan/message-adapters':['runMessageScan']})[c.endpoint] || [c.endpoint];
      if (!page.includes(c.endpoint) && !(c.endpoint === '/api/gateways' && page.includes('loadWebguiConfigData')) && !markers.some(m => page.includes(m))) errors.push(`Missing legacy implementation: ${c.endpoint}`);
    }
    if (c.evidence.includes('/')) {
      const file = path.join(root,c.evidence);
      if (!fs.existsSync(file)) errors.push(`Missing dedicated fixture: ${c.evidence}`);
    }
  }
  // Request-helper paths are explicit: fetch(path) cannot expose their URL to literal extraction.
  const skill = read(path.join(root,'ribiwebgui/src/roleSkillClient.ts'));
  if (!skill.includes('export function roleSkillPath') || !skill.includes('/skills${') || !skill.includes('await request(path, { signal })')) errors.push('Skill helper manifest drift');
  const api = read(path.join(root,'apps/rabilink-aiui/utils/rabilink-api.js'));
  for (const c of contracts.filter(c => c.owner === 'Relay' && c.endpoint.startsWith('/api/'))) if (!api.includes(c.endpoint)) errors.push(`Dedicated client missing: ${c.endpoint}`);
  // Additional dedicated/helper endpoint literals must be classified, not silently ignored.
  for (const match of api.matchAll(/requestJson\(config,\s*["'](\/api\/rabilink\/device\/[^"']+)["']/g)) if (!contracts.some(c => c.endpoint === match[1])) errors.push(`Unknown dedicated helper endpoint: ${match[1]}`);
  if (errors.length) throw new Error(errors.join('\n'));
  return { discovered:found.length, contracts:contracts.length, unsupported:contracts.filter(c=>c.classification==='unsupported').length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('AIUI endpoint boundary audit passed', audit());
