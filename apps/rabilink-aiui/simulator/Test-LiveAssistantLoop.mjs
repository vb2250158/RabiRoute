import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { createAssistantSession } from '../../../packages/assistant-runtime/src/assistant-session.js';
import { createAgentProtocol } from '../../../packages/assistant-runtime/src/decision-protocol.js';

// Opt-in only: this uses the configured provider through the local credential proxy.
// No key is read by this test, and no product/PC tools or user data are sent.
if (!process.argv.includes('--execute')) {
  console.log('Live provider test is disabled. Run with --execute and optionally --origin http://127.0.0.1:12281.');
  process.exit(0);
}
const args = process.argv.slice(2), originIndex = args.indexOf('--origin');
const url = new URL(originIndex < 0 ? 'http://127.0.0.1:12281' : args[originIndex + 1]);
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'A local simulator origin is required.');
const origin = url.origin;
const bootstrapResponse = await fetch(origin + '/bootstrap', { signal: AbortSignal.timeout(5000), redirect: 'error' });
assert.equal(bootstrapResponse.status, 200);
const { token, config } = await bootstrapResponse.json();
assert.ok(config?.configured && config?.hasApiKey && typeof token === 'string');
assert.equal(new URL(config.baseUrl).hostname, 'api.openai.com', 'This opt-in check is scoped to the configured OpenAI test provider.');

const count = randomInt(10000, 99999), receiptId = 'fixture-' + randomBytes(6).toString('hex');
const counterPath = '/fixture/' + randomBytes(8).toString('hex') + '/counter';
const requests = [], tools = [], controllers = new Set();
const protocol = createAgentProtocol(), replies = [];
let assistant, modelRequests = 0, lastDecision;
const globalPrompt = '你是本地验证助手。每次最终回复必须把【本地验证】原样放在回复开头；若使用结构化 JSON，必须放在 final.text 字段内容的开头，不能省略。简短报告工具实际返回的计数与完整回执编号。先用 api.find 查接口合同，再用 api.call 读取计数。测试数据不代表任何真实用户或设备。';
const destination = new URL('../dist/live-assistant-loop-report.json', import.meta.url);
const startedAt = new Date().toISOString();
const writeReport = async value => {
  await fs.mkdir(new URL('../dist/', import.meta.url), { recursive: true });
  await fs.writeFile(destination, JSON.stringify({ startedAt, provider: 'OpenAI test middleware', model: config.model, ...value }, null, 2) + '\n');
};
const server = http.createServer((request, response) => {
  requests.push({ method: request.method, path: request.url });
  response.setHeader('content-type', 'application/json');
  if (request.method !== 'GET') { response.writeHead(405); response.end('{}'); return; }
  if (request.url === '/catalog') response.end(JSON.stringify({ status: 'ok', schema: { method: 'GET', path: counterPath, query: {} } }));
  else if (request.url === counterPath) response.end(JSON.stringify({ status: 'ok', count, receiptId, fixture: true }));
  else { response.writeHead(404); response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const fixtureOrigin = 'http://127.0.0.1:' + server.address().port;
async function requestModel(messages) {
  const controller = new AbortController(); controllers.add(controller);
  try {
    modelRequests++;
    const response = await fetch(origin + '/api/chat', { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-simulator-token': token },
      body: JSON.stringify({ messages, max_tokens: 450, temperature: 0 }) });
    if (!response.ok) throw new Error('MODEL_PROXY_HTTP_' + response.status);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = '', text = '', completed = false;
    while (true) {
      const chunk = await reader.read();
      pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 262144) throw Error('MODEL_FRAME_LIMIT');
      const frames = pending.split(/\r?\n\r?\n/); pending = frames.pop();
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') { completed = true; continue; }
        if (!data) continue;
        const event = JSON.parse(data);
        if (event.error) throw Error('MODEL_STREAM_ERROR');
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') text += delta;
        if (text.length > 262144) throw Error('MODEL_RESPONSE_LIMIT');
      }
      if (chunk.done) break;
    }
    assert.ok(completed && text.trim(), 'Provider stream must finish with a nonempty response.');
    return text;
  } finally { controller.abort(); controllers.delete(controller); }
}
try {
  await writeReport({ passed: false, phase: 'running', modelRequests: 0, tools: [] });
  assistant = createAssistantSession({
    protocol,
    profile: { systemPrompt: globalPrompt },
    limits: { maxToolCalls: 4, maxSteps: 6, requestTimeoutMs: 45000, turnTimeoutMs: 120000 },
    discoverTools: async () => ({
      tools: [
        { type: 'function', function: { name: 'api.find', description: '查找本地计数接口的真实合同。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
        { type: 'function', function: { name: 'api.call', description: '只读调用已查到的本地计数接口。', parameters: { type: 'object', properties: { method: { type: 'string', enum: ['GET'] }, path: { type: 'string' } }, required: ['method', 'path'], additionalProperties: false } } }
      ],
      toolPolicy: {
        classify(decision) { assert.ok(decision.name === 'api.find' || (decision.name === 'api.call' && decision.arguments.method === 'GET' && decision.arguments.path === counterPath)); return { mutation: false }; },
        inspectOutcome(result) { return { uncertain: result?.status !== 'ok', failed: result?.status !== 'ok', terminal: false }; }
      },
      executeTool: async event => {
        tools.push(event.functionName);
        const response = await fetch(fixtureOrigin + (event.functionName === 'api.find' ? '/catalog' : counterPath), { signal: AbortSignal.timeout(5000) });
        assert.equal(response.status, 200); return response.json();
      }
    }),
    createModel: async options => {
      const history = [...options.initialPrompts];
      assert.deepEqual(options.tools, []);
      return {
        async prompt(input) {
          history.push(...input);
          const reply = await requestModel(history); replies.push(reply);
          history.push({ role: 'assistant', content: reply });
          lastDecision = protocol.parseDecision(reply, JSON.parse(input[0].content).requestId);
          return reply;
        },
        destroy() { for (const controller of controllers) controller.abort(); }
      };
    }
  });
  const result = await assistant.run('请查询当前测试计数，并给出它的回执编号。');
  const finalText = lastDecision?.kind === 'final' ? lastDecision.text : '';
  const globalPromptObserved = finalText.trimStart().startsWith('【本地验证】');
  const receiptVerified = finalText.includes(String(count)) && finalText.includes(receiptId);
  const report = { verifiedAt: new Date().toISOString(), provider: 'OpenAI test middleware', model: config.model,
    sharedRuntime: 'current source', state: result.state, modelRequests, tools, fixtureHttpRequests: requests,
    globalPromptObserved, receiptVerified, resultText: result.text, finalText, replies,
    limitations: ['Model is OpenAI through the local proxy, not the Rokid host.', 'HTTP data is a synthetic read-only fixture.', 'No glasses, microphone, speaker or Rabi PC tool acceptance.'] };
  await writeReport({ ...report, passed: false, phase: 'validating' });
  assert.equal(result.state, 'completed');
  assert.deepEqual(tools, ['api.find', 'api.call']);
  assert.ok(globalPromptObserved, 'Check the final decision, separately from earlier action narration.');
  assert.ok(receiptVerified);
  assert.deepEqual(requests, [{ method: 'GET', path: '/catalog' }, { method: 'GET', path: counterPath }]);
  await writeReport({ ...report, passed: true, phase: 'finished' });
  console.log(JSON.stringify({ passed: true, modelRequests, tools, globalPromptObserved: true, receiptVerified: true, report: destination.pathname }));
} catch (error) {
  await writeReport({ passed: false, phase: 'failed', errorCode: error.code || 'LIVE_CONTRACT_FAILED',
    modelRequests, tools, fixtureHttpRequests: requests, replies,
    globalPromptObserved: lastDecision?.kind === 'final' && lastDecision.text.trimStart().startsWith('【本地验证】'),
    receiptVerified: lastDecision?.kind === 'final' && lastDecision.text.includes(String(count)) && lastDecision.text.includes(receiptId),
    limitations: ['OpenAI test middleware and synthetic read-only HTTP; not Rokid or device acceptance.'] });
  throw error;
} finally {
  assistant?.dispose();
  await new Promise(resolve => server.close(resolve));
}
