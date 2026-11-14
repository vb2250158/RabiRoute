import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../node_modules/playwright-core/index.mjs';
import { startSimulator } from './server.mjs';

// This fixture supplies marked synthetic text/audio. It is not a provider or hearing test.
const calls = [];
let chatCount = 0;
let finishHeldReply;
let heldReplyClosed = false;
const upstream = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  calls.push({ path: request.url, bytes: body.length });
  if (request.url === '/v1/chat/completions') {
    chatCount++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '这是测试夹具回复。' }, finish_reason: null }] })}\n\n`);
    const finish = () => response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    if (chatCount === 3) {
      // Keep reasoning open while the first sentence is playing.
      finishHeldReply = finish;
      response.on('close', () => { heldReplyClosed = true; });
    } else finish();
  } else if (request.url === '/v1/audio/speech') {
    const samples = chatCount === 3 ? 24000 * 8 : 12000;
    const data = Buffer.alloc(samples * 2);
    for (let sample = 0; sample < samples; sample++) data.writeInt16LE(Math.round(Math.sin(sample * 440 * Math.PI * 2 / 24000) * 1000), sample * 2);
    response.writeHead(200, { 'content-type': 'audio/pcm' }); response.end(data);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
let app;
let browser;
const logs = [];
let page;
try {
  app = await startSimulator({ initialConfig: { baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'fixture-model', ttsModel: 'fixture-tts', voice: 'fixture' } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    globalThis.audioTestEvents = [];
    globalThis.audioTestPlayers = [];
    HTMLMediaElement.prototype.play = function(...args) {
      globalThis.audioTestPlayers.push(this);
      for (const type of ['loadedmetadata', 'playing', 'pause', 'ended', 'error', 'abort', 'emptied']) this.addEventListener(type, () => globalThis.audioTestEvents.push({ type, duration: this.duration, time: this.currentTime, error: this.error?.message }));
      return play.apply(this, args);
    };
  });
  page.on('console', message => logs.push(`${message.type()}: ${message.text()}`));
  page.on('response', response => { if (response.status() >= 400) logs.push(`HTTP ${response.status()}: ${new URL(response.url()).pathname}`); });
  page.on('pageerror', error => logs.push(`pageerror: ${error.stack}`));
  await page.goto(app.origin);
  await page.waitForFunction(() => !document.getElementById('send').disabled, null, { timeout: 30000 });
  await page.fill('#utterance', '请用一句话介绍自己。');
  await page.click('#send');
  await page.waitForFunction(() => document.getElementById('events').textContent.includes('音频已交给 Ink 播放器'), null, { timeout: 30000 });
  assert.ok(calls.some(call => call.path === '/v1/chat/completions'));
  assert.ok(calls.some(call => call.path === '/v1/audio/speech'));
  await page.waitForTimeout(1500);
  assert.ok(logs.some(line => line.includes('SpeechAudioPlayer playback ended')), 'Real Ink player must emit ended; synthesis alone is not playback.');
  const events = await page.locator('#events').innerText();
  assert.match(events, /模拟识别结果/);
  assert.doesNotMatch(events, /合成失败|异步错误/);
  assert.equal(logs.some(line => line.includes('TTS playback failed')), false);
  await page.fill('#utterance', '再回复一句。');
  await page.click('#send');
  await page.waitForFunction(() => [...document.querySelectorAll('#events p')].filter(p => p.textContent.includes('playback ended')).length >= 2, null, { timeout: 20000 });
  assert.equal(logs.some(line => line.includes('TTS playback failed')), false);
  await page.fill('#utterance', '请开始可打断的长回复。');
  await page.click('#send');
  await page.waitForFunction(() => globalThis.audioTestPlayers.length >= 3 && !globalThis.audioTestPlayers.at(-1).paused, null, { timeout: 20000 });
  assert.equal(typeof finishHeldReply, 'function');
  assert.equal(heldReplyClosed, false, 'Model stream must still be pending at onset');
  const asrResultsBefore = await page.locator('#events p').filter({ hasText: '模拟识别结果' }).count();
  await page.click('#speech-start');
  await page.waitForFunction(() => globalThis.audioTestPlayers.at(-1).paused, null, { timeout: 3000 });
  assert.equal(await page.locator('#events p').filter({ hasText: '模拟识别结果' }).count(), asrResultsBefore, 'Onset must stop audio before a transcript exists');
  assert.equal(heldReplyClosed, false, 'Stopping speech must not close the active model stream');
  assert.equal(chatCount, 3, 'Onset must not create a new model request');
  assert.doesNotMatch(await page.locator('#events').innerText(), /识别已停止|识别已结束/);
  finishHeldReply();
  await page.fill('#utterance', '打断后继续对话。');
  await page.click('#send');
  await page.waitForFunction(() => [...document.querySelectorAll('#events p')].filter(p => p.textContent.includes('playback ended')).length >= 3, null, { timeout: 20000 });
  assert.equal(chatCount, 4, 'The same recognition session must accept a subsequent turn');
  await page.click('#stop');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已停止'));
  await page.click('#reload');
  await page.waitForFunction(() => !document.getElementById('send').disabled);
  fs.mkdirSync(path.resolve(import.meta.dirname, '../dist'), { recursive: true });
  await page.screenshot({ path: path.resolve(import.meta.dirname, '../dist/simulator-preview.png'), fullPage: true });
  console.log('Ink 0.19.1 simulator: two replies played; host speech onset stopped real Ink playback before text, preserved pending model/capture, and accepted the next turn; stop/reopen passed. Synthetic input/audio only.');
  console.log(logs.filter(line => /tts|speech|Speech|error|Error/i.test(line)).slice(-35).join('\n'));
} catch (error) {
  console.error(await page?.locator('#events').innerText().catch(() => 'unavailable'));
  console.error('Browser audio events:', await page?.evaluate(() => globalThis.audioTestEvents));
  console.error('Simulator browser failure', error.message, '\n', logs.slice(-75).join('\n'));
  throw error;
} finally {
  finishHeldReply?.();
  await browser?.close();
  await app?.close();
  await new Promise(resolve => upstream.close(resolve));
}
