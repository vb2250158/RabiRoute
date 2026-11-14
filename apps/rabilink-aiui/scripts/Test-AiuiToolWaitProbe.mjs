import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { buildPackageStaging } from './Build-RabiLinkAiuiPackage.mjs';
import { installToolWaitProbe } from './ToolWaitProbe.mjs';
import { createPageAssistantFixture } from './AssistantSessionFixture.mjs';

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-probe-test-'));
if (path.dirname(path.resolve(staging)) !== path.resolve(os.tmpdir()) || !path.basename(staging).startsWith('rabilink-probe-test-')) throw Error('Unsafe test root');
let p;
try {
  await buildPackageStaging(staging, { relayBaseUrl: '' });
  fs.writeFileSync(path.join(staging, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(staging, 'wx.js'), 'const s=new Map();export default {getStorageSync:k=>s.get(k),setStorageSync:(k,v)=>s.set(k,v)};');
  const entry = path.join(staging, 'pages/home/index.js');
  fs.writeFileSync(entry, fs.readFileSync(entry, 'utf8').replace(/from "wx"/g, 'from "../../wx.js"'));
  const definition = (await import(pathToFileURL(entry).href)).default;
  installToolWaitProbe(definition);
  p = { ...definition, data: { ...definition.data },
    setData(value) { Object.assign(this.data, value); }, installCloudConsoleCapture() {}, scheduleDeferredStartup() {},
    appendLog() {}, applyPendingDeviceAgentProfile() {}, applyPendingApiTools() {},
    beginAiuiConversation() { return null; }, finishAiuiConversation() {}, resumeDeviceAgentClaim() {},
    speakText() {}, deviceAgentTurnContext() { return null; } };
  p.onLoad({}); p.pageVisible = true; p.pageReady = true;
  const backend = await p.prepareRabiApiTools();
  p.chatModelAgentTools = backend.tools; p.chatModelApiRuntime = backend.runtime;
  let selectedPath, active = 0, maxActive = 0;
  const frame = (packet, fields) => JSON.stringify({ protocol: packet.protocol, requestId: packet.requestId, ...fields });
  const assistant = createPageAssistantFixture(p, { async prompt(messages) {
    active++; maxActive = Math.max(active, maxActive);
    try {
      const packet = JSON.parse(messages[0].content);
      if (packet.kind === 'independent-input') return frame(packet, { kind: 'interjection', inputId: packet.input.id,
        ...(packet.input.text.includes('六乘') ? { disposition: 'answer', text: '青杉九一：42' } : { disposition: 'defer', text: '青杉九一：该查询需要工具，稍后处理。' }) });
      if (packet.kind === 'user-input') {
        selectedPath = packet.text.includes('/fixture/next') ? '/fixture/next' : '/fixture/slow';
        return frame(packet, { kind: 'tool', name: 'rabi_api_help', arguments: {} });
      }
      const result = packet.observation.outcome.result.structuredContent.data;
      if (result.endpoints) return frame(packet, { kind: 'tool', name: 'rabi_api_call', arguments: { method: 'GET', path: selectedPath } });
      return '青杉九一：' + result.receipt;
    } finally { active--; }
  }, destroy() {} });
  p.ensureChatModel = async () => assistant;
  await p.executeLingzhuAgentPrompt('请查询 /fixture/slow 并报告回执。');
  const deadline = Date.now() + 3000;
  while (!p.data.agentStatus.startsWith('诊断') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(p.data.agentStatus, '诊断通过：原任务与插话独立');
  assert.equal(maxActive, 1);
  const rows = p.inputLedger().snapshot();
  assert.deepEqual(rows.map(row => row.status), ['answered', 'completed']);
  assert.equal(rows[0].answer, '青杉九一：42');
  assert.deepEqual(p.probe.calls, ['/fixture/slow', '/fixture/next']);
  console.log('Tool-wait probe passed against compiled production page and shared SDK; model/tools are fixtures.');
} finally {
  p?.onHide();
  fs.rmSync(staging, { recursive: true, force: true });
}
