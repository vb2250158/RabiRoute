import { createInkView, configNavigatorHost } from '/ink/index.js';
import { createSimulatorHost } from './host.js';

const $ = id => document.getElementById(id);
let view;
let host;
let token;
let config;
let files;
let loading = false;
let mountedMode = 'text';
const report = (group, action, detail = '') => {
  const line = document.createElement('p');
  line.textContent = `${new Date().toLocaleTimeString()} [${group}] ${action}${detail ? ` · ${detail}` : ''}`;
  $('events').append(line);
  while ($('events').childElementCount > 100) $('events').firstChild.remove();
  $('events').scrollTop = $('events').scrollHeight;
};
// Surface the unchanged bundle's diagnostic outcomes, not inferred host success.
for (const level of ['info', 'warn', 'error', 'log']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    original(...args);
    const message = args.filter(value => typeof value === 'string').join(' ');
    const match = message.match(/\[RabiLink AIUI\] (SpeechAudioPlayer playback (?:requested|ended)|TTS playback failed:[^\r\n]*|transcription-asr:error[^\r\n]*)/);
    if (!match) return;
    report('page', match[1].split('color:')[0].trim());
    if (match[1].includes('playback ended')) $('status').textContent = '播放器报告播放结束；请确认是否听见';
    else if (match[1].includes('failed') || match[1].includes('asr:error')) $('status').textContent = '页面报告异常，请查看调用记录';
  };
}
const showError = error => { $('status').textContent = error.message; report('error', error.message); };
const action = operation => async event => { event?.preventDefault(); try { await operation(); } catch (error) { showError(error); } };
function setControls(enabled) {
  for (const id of ['wake', 'enter', 'stop', 'send']) $(id).disabled = !enabled;
  $('speech-start').disabled = !enabled || mountedMode !== 'text';
}

async function stop() {
  setControls(false);
  view?.setInteractive(false);
  view?.destroy();
  view = null;
  await host?.dispose();
  host = null;
  $('status').textContent = '已停止，麦克风与任务已释放';
}

async function mount() {
  if (loading) return;
  loading = true;
  $('reload').disabled = true;
  try {
    await stop();
    mountedMode = $('input-mode').value;
    host = createSimulatorHost({ mode: mountedMode, config, token, report, emit(type, detail) {
      view?.getHostCapabilitiesTarget().dispatchEvent(new CustomEvent(type, { detail }));
    } });
    configNavigatorHost('LOCAL-AIUI-SIMULATOR', 'Browser simulator', 'wasm', ['zh-CN'], 'CN');
    view = await createInkView({ width: 480, height: 352, scaleFactor: 1, canvas: $('ink'), hostCapabilities: host.capabilities });
    view.openBundle({ appId: 'rabilink-aiui-local-simulator', files, hostOptions: { initialTarget: '_blank' }, query: { mode: 'transcription', ttsSubtitles: 'none', ttsAudioFormat: 'pcm' } });
    view.dispatchConnectivityState({ online: navigator.onLine, type: 'unknown' });
    view.bindDomEvents();
    view.startRendering();
    view.setOnCloseRequested(() => { void stop().catch(showError); });
    setControls(true);
    $('status').textContent = config.configured ? '页面已加载，可开始测试' : '页面已加载；请先配置对话 API';
    report('runtime', '页面已加载', `Ink 0.19.1 / ${mountedMode === 'text' ? '模拟文字' : '真实麦克风'}`);
  } finally { loading = false; $('reload').disabled = false; }
}

function wake() {
  if (!view) throw new Error('请先重新加载页面');
  view.setInteractive(true);
  view.dispatchVoiceWakeup('clickAiAssist', Date.now());
  report('input', '已发出触摸唤醒');
}
$('wake').onclick = action(wake);
$('speech-start').onclick = action(() => {
  if (!host.injectSpeechStart()) throw new Error('请先唤醒并等待识别就绪');
});
$('enter').onclick = action(() => {
  view.setInteractive(true);
  view.dispatchInput('keydown', 'Enter', Date.now());
  view.dispatchInput('keyup', 'Enter', Date.now());
  report('input', '已发出镜腿确认键');
});
$('stop').onclick = action(stop);
$('reload').onclick = action(mount);
$('input-mode').onchange = action(mount);
$('text-form').onsubmit = action(() => {
  if (mountedMode !== 'text') throw new Error('模拟文字输入前请选择对应来源');
  const text = $('utterance').value.trim();
  if (!text) throw new Error('请输入测试话');
  view.setInteractive(true);
  view.notifyUserInteraction();
  if (!host.injectText(text)) wake();
  $('utterance').value = '';
});
$('config-form').onsubmit = action(async () => {
  $('apply').disabled = true;
  try {
    await stop();
    const input = Object.fromEntries(new FormData($('config-form')));
    const response = await fetch('/api/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-simulator-token': token }, body: JSON.stringify(input) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    config = result;
    $('apiKey').value = '';
    $('apiKey').placeholder = config.hasApiKey ? 'Key 已在本机内存中；留空保留' : '未配置 Key';
    $('config-result').textContent = '已应用到本次测试；尚未验证 API 连通性';
    await mount();
  } finally { $('apply').disabled = false; }
});
window.addEventListener('beforeunload', () => { view?.destroy(); void host?.dispose(); });
for (const eventName of ['online', 'offline']) window.addEventListener(eventName, () => view?.dispatchConnectivityState({ online: navigator.onLine, type: 'unknown' }));
window.addEventListener('error', event => { if (event.message) report('runtime', '运行时错误', event.message); });
window.addEventListener('unhandledrejection', event => report('runtime', '异步错误', String(event.reason?.message || event.reason)));

try {
  const bootstrap = await (await fetch('/bootstrap')).json();
  token = bootstrap.token;
  config = bootstrap.config;
  for (const key of ['baseUrl', 'model', 'asrModel', 'ttsModel', 'voice']) $(key).value = config[key];
  if (config.hasApiKey) $('apiKey').placeholder = 'Key 已在本机内存中；留空保留';
  const encoded = await (await fetch('/bundle')).json();
  files = Object.fromEntries(Object.entries(encoded).map(([name, base64]) => [name, Uint8Array.from(atob(base64), char => char.charCodeAt(0))]));
  await mount();
} catch (error) { showError(error); }
