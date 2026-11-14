import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { buildPackageStaging } from '../scripts/Build-RabiLinkAiuiPackage.mjs';

const root = import.meta.dirname;
const maxBodyBytes = 4 * 1024 * 1024;
const mimeTypes = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.wasm': 'application/wasm' };

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validateConfig(input) {
  const config = {};
  for (const key of ['baseUrl', 'apiKey', 'model', 'asrModel', 'ttsModel', 'voice']) {
    config[key] = typeof input[key] === 'string' ? input[key].trim() : '';
    if (config[key].length > 2048) throw new RequestError(400, '配置字段过长');
  }
  if (config.baseUrl) {
    let url;
    try { url = new URL(config.baseUrl); } catch { throw new RequestError(400, 'Base URL 无效'); }
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new RequestError(400, 'Base URL 须为 HTTPS 或本机 HTTP，不得包含凭据、查询参数');
    }
    config.baseUrl = url.href.replace(/\/+$/, '');
  }
  return Object.freeze(config);
}

function publicConfig(config) {
  const { apiKey, ...visible } = config;
  return { ...visible, hasApiKey: Boolean(apiKey), configured: Boolean(config.baseUrl && config.model) };
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new RequestError(413, '请求过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString()); } catch { throw new RequestError(400, 'JSON 无效'); }
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function collectFiles(directory, relative = '') {
  return Object.fromEntries(fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(entry => {
    const name = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? Object.entries(collectFiles(directory, name)) : [[name, fs.readFileSync(path.join(directory, name)).toString('base64')]];
  }));
}

export async function startSimulator({ port = 0, initialConfig = {}, bundleFiles } = {}) {
  let config = validateConfig(initialConfig);
  const token = randomBytes(32).toString('hex');
  let staging;
  if (!bundleFiles) {
    staging = fs.mkdtempSync(path.join(os.tmpdir(), 'rabilink-simulator-'));
    await buildPackageStaging(staging, { relayBaseUrl: '' });
    bundleFiles = collectFiles(staging);
  }
  const controllers = new Set();
  let origin;
  const server = http.createServer(async (request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-frame-options', 'DENY');
    try {
      if (request.headers.host !== new URL(origin).host) throw new RequestError(403, 'Host 被拒绝');
      if (request.headers.origin && request.headers.origin !== origin) throw new RequestError(403, '仅接受本页请求');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '拒绝跨站请求');
      const url = new URL(request.url, origin);
      if (request.method === 'GET' && url.pathname === '/bootstrap') {
        return json(response, 200, { token, config: publicConfig(config), inkVersion: '0.19.1' });
      }
      if (url.pathname.startsWith('/api/')) {
        if (request.headers['x-simulator-token'] !== token) throw new RequestError(403, '测试台会话无效，请刷新页面');
        if (request.method !== 'POST') throw new RequestError(405, '只支持 POST');
        const body = await readBody(request);
        if (url.pathname === '/api/config') {
          if (controllers.size) throw new RequestError(409, '请等当前请求结束后再配置');
          const input = parseJson(body);
          const next = validateConfig(input);
          // A credential belongs to its configured provider, never a newly typed URL.
          config = validateConfig({ ...next, apiKey: next.apiKey || (next.baseUrl === config.baseUrl ? config.apiKey : '') });
          return json(response, 200, publicConfig(config));
        }
        if (!config.baseUrl) throw new RequestError(409, '尚未配置 API Base URL');
        const controller = new AbortController();
        controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 60000);
        const cancel = () => { if (!response.writableFinished) controller.abort(); };
        response.on('close', cancel);
        try {
          const headers = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
          let endpoint;
          let upstreamBody;
          if (url.pathname === '/api/chat') {
            if (!config.model) throw new RequestError(409, '尚未配置对话模型');
            const input = parseJson(body);
            if (!Array.isArray(input.messages)) throw new RequestError(400, '缺少 messages');
            endpoint = 'chat/completions';
            headers['content-type'] = 'application/json';
            upstreamBody = JSON.stringify({ ...input, model: config.model, stream: true });
          } else if (url.pathname === '/api/speech') {
            if (!config.ttsModel || !config.voice) throw new RequestError(409, '尚未配置 TTS 模型和音色');
            const input = parseJson(body);
            if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4096) throw new RequestError(400, '播报文本无效');
            endpoint = 'audio/speech';
            headers['content-type'] = 'application/json';
            upstreamBody = JSON.stringify({ model: config.ttsModel, voice: config.voice, input: input.text, response_format: 'pcm' });
          } else if (url.pathname === '/api/transcribe') {
            if (!config.asrModel) throw new RequestError(409, '尚未配置 ASR 模型');
            if (body.length < 44 || body.toString('ascii', 0, 4) !== 'RIFF') throw new RequestError(400, '需要 WAV 音频');
            endpoint = 'audio/transcriptions';
            upstreamBody = new FormData();
            upstreamBody.set('model', config.asrModel);
            upstreamBody.set('file', new Blob([body], { type: 'audio/wav' }), 'speech.wav');
            upstreamBody.set('response_format', 'json');
          } else throw new RequestError(404, '接口不存在');
          const upstream = await fetch(`${config.baseUrl}/${endpoint}`, { method: 'POST', headers, body: upstreamBody, signal: controller.signal, redirect: 'error' });
          if (!upstream.ok) {
            await upstream.body?.cancel();
            throw new RequestError(502, `上游 ${endpoint} 返回 HTTP ${upstream.status}`);
          }
          const type = upstream.headers.get('content-type') || '';
          if (endpoint === 'chat/completions' && !type.includes('text/event-stream')) {
            await upstream.body?.cancel();
            throw new RequestError(502, '模型未返回 SSE 流，请检查 API 兼容性');
          }
          if (endpoint === 'audio/speech' && !/^(audio\/|application\/octet-stream)/i.test(type)) {
            await upstream.body?.cancel();
            throw new RequestError(502, '语音接口未返回音频');
          }
          response.writeHead(200, { 'content-type': type || 'application/octet-stream' });
          let received = 0;
          for await (const chunk of upstream.body) {
            received += chunk.length;
            if (received > 16 * 1024 * 1024) throw new RequestError(502, '上游响应过大');
            if (!response.write(chunk)) await once(response, 'drain', { signal: controller.signal });
          }
          response.end();
        } finally {
          clearTimeout(timer);
          response.off('close', cancel);
          controllers.delete(controller);
        }
        return;
      }
      if (request.method !== 'GET') throw new RequestError(405, '只支持 GET');
      if (url.pathname === '/bundle') return json(response, 200, bundleFiles);
      let file;
      if (url.pathname.startsWith('/ink/')) {
        const sdkRoot = path.join(root, '../node_modules/@yodaos-pkg/ink');
        file = path.resolve(sdkRoot, decodeURIComponent(url.pathname.slice(5)));
        const relative = path.relative(sdkRoot, file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new RequestError(403, '路径被拒绝');
      } else {
        const allowed = new Map([['/', 'index.html'], ['/client.js', 'client.js'], ['/host.js', 'host.js']]);
        if (!allowed.has(url.pathname)) throw new RequestError(404, '文件不存在');
        file = path.join(root, allowed.get(url.pathname));
      }
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new RequestError(404, '文件不存在');
      response.writeHead(200, { 'content-type': mimeTypes[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else json(response, error.status || 502, { error: error instanceof RequestError ? error.message : '请求失败或超时，请检查服务地址与网络' });
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] === import.meta.filename) {
  const app = await startSimulator({ port: Number(process.env.AIUI_SIMULATOR_PORT || 0), initialConfig: {
    baseUrl: process.env.AIUI_API_BASE_URL, apiKey: process.env.AIUI_API_KEY, model: process.env.AIUI_MODEL,
    asrModel: process.env.AIUI_ASR_MODEL, ttsModel: process.env.AIUI_TTS_MODEL, voice: process.env.AIUI_TTS_VOICE
  } });
  console.log(`AIUI_SIMULATOR_READY ${app.origin}`);
  process.once('SIGINT', async () => { await app.close(); process.exit(0); });
  process.once('SIGTERM', async () => { await app.close(); process.exit(0); });
}
