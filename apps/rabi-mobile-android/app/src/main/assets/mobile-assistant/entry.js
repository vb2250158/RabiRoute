import { createAiuiAssistantRuntime } from './sdk/aiui-runtime.js';
import { createVoiceInteraction } from './sdk/voice-interaction.js';
import { createPhoneCapture } from './capture.js';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const native = globalThis.RabiMobile;
let enabled = native.voiceEnabled();
let muted = false;
let visible = true;
let running = false;
let profile = null;
let connection = null;
let generation = 0;
let refreshSerial = 0;
const submitted = new Map();
let messages = [];
const pending = new Map();
const rows = new Map();
let playingCue = null;
const bars = Array.from({ length: 26 }, () => ui.waveform.appendChild(document.createElement('i')));
const label = { MOBILE_COMPUTER_REQUIRED: '请返回消息页，选择一台已连接的电脑。',
  MOBILE_COMPUTER_CHANGED: '已切换电脑。请重新打开语音助手。',
  MOBILE_COMPUTER_UNAVAILABLE: '选中的电脑未在线。', MOBILE_COMPUTER_REQUEST_FAILED: '连接电脑失败，请检查 RabiLink 后重试。',
  MOBILE_MICROPHONE_IN_USE: '手机正在录音或通话。结束后再开始实时语音。',
  MOBILE_ASR_BACKLOG: '识别服务处理较慢，语音已暂停。',
  ASSISTANT_VOICE_DISABLED: '所选电脑的语音助手已关闭。',
  ASSISTANT_CONTEXT_CHANGED: '电脑端已切换对话，请刷新连接。',
  MOBILE_REPLY_TIMEOUT: '这条消息仍在处理中。请稍后刷新查看结果。',
  NotAllowedError: '请允许麦克风权限，再点击开始实时语音。',
  NotReadableError: '系统暂时无法使用麦克风。' };

function request(operation, body = {}, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const stop = () => {
      pending.delete(id);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', stop, { once: true });
    pending.set(id, (ok, text) => {
      signal?.removeEventListener('abort', stop);
      try {
        if (!ok) throw new Error(text);
        resolve(operation === 'tts' ? text : JSON.parse(text));
      } catch (error) { reject(error); }
    });
    native.send(id, operation, JSON.stringify(body));
  });
}
window.mobileReply = (id, success, body) => {
  const deliver = pending.get(id);
  pending.delete(id);
  deliver?.(success, body);
};

function report(error) {
  const code = error?.message || '';
  const friendly = label[code] || label[error?.name];
  ui.issue.textContent = friendly || '操作未完成，请刷新连接后查看。';
  ui.issue.hidden = false;
}
function phase(value) { ui.status.textContent = value; }
function encode(bytes) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 4096) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 4096)));
  return btoa(chunks.join(''));
}

function observationOf(result) {
  const fields = result?.additions ?? result?.observation ?? result;
  const value = {};
  for (const key of ['emotion', 'gender', 'age', 'language', 'confidence']) {
    const entry = fields?.[key];
    if (key === 'age' || key === 'confidence') {
      const number = typeof entry === 'string' && /^[+-]?\d+(?:\.\d+)?$/.test(entry.trim()) ? Number(entry) : entry;
      if (typeof number === 'number' && Number.isFinite(number)) value[key] = number;
    } else if (typeof entry === 'string' && entry.trim() && entry.length <= 80) value[key] = entry;
  }
  return Object.keys(value).length ? value : undefined;
}

const levels = new Float32Array(bars.length);
function waveform(value) {
  if (!running) return;
  levels.copyWithin(0, 1);
  levels[levels.length - 1] = value;
  bars.forEach((bar, index) => { bar.style.setProperty('--level', Math.min(1, levels[index] * 8)); });
}

const asr = createPhoneCapture({
  transcribe: (bytes, signal) => request('asr', { model: profile.asrModel, audio: encode(bytes) }, signal),
  waveform, phase, mayRecord: () => native.microphoneAvailable(),
});
const tts = {
  adapterId: 'rabi-mobile-audio',
  supportsSynthesize: true,
  async synthesize(text, { signal, onCue, expression = {} } = {}) {
    const audioBytes = await request('tts', { model: profile.ttsModel, voice: profile.personaId, input: text,
      sessionId: 'mobile.' + crypto.randomUUID(),
      ...(typeof expression.instructions === 'string' ? { instructions: expression.instructions } : {}),
      ...(typeof expression.speed === 'number' ? { speed: expression.speed } : {}) }, signal);
    signal?.throwIfAborted();
    const blob = new Blob([Uint8Array.from(atob(audioBytes), char => char.charCodeAt(0))], { type: 'audio/wav' });
    const source = URL.createObjectURL(blob);
    const audio = new Audio(source);
    let retired = false;
    let ended;
    let failed;
    const stop = () => {
      if (retired) return;
      retired = true;
      audio.onended = audio.onerror = audio.onplaying = audio.ontimeupdate = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(source);
    };
    const cue = () => {
      const progress = audio.duration > 0 ? Math.min(1, audio.currentTime / audio.duration) : 0;
      onCue?.({ charIndex: Math.min(text.length - 1, Math.floor(progress * text.length)) });
    };
    audio.onplaying = audio.ontimeupdate = cue;
    audio.onended = () => { stop(); ended?.(); };
    audio.onerror = () => { stop(); failed?.(new Error('MOBILE_TTS_PLAYBACK_FAILED')); };
    return { task: { abort: stop }, player: {
      audioPlayer: { onEnded: callback => { ended = callback; }, onError: callback => { failed = callback; } },
      play: () => audio.play(), stop, destroy: stop,
    } };
  },
};

const runtime = createAiuiAssistantRuntime({ asr, tts });
const voice = createVoiceInteraction({
  runtime, outputEnabled: false,
  onInput: ({ text, result }) => { void sendSpeech(text, result); },
  onEvent: event => {
    if (event.type === 'playback') {
      const status = event.event;
      if (status.type === 'cue') {
        playingCue = { responseId: status.responseId, segment: status.text, offset: status.textOffset, index: status.cue.charIndex };
        ui.playing.hidden = false;
        drawReply(status.responseId);
      } else if (['idle','ended','cancelled','error'].includes(status.type)) {
        const previous = playingCue?.responseId;
        playingCue = null;
        ui.playing.hidden = true;
        if (previous) drawReply(previous);
        if (status.type === 'error' && running) report(status.error);
      }
    }
    if (event.type === 'input') phase('正在聆听');
  },
  onError: error => {
    if (!running) return;
    if (error?.name === 'NotAllowedError' || error?.name === 'NotReadableError' || error?.message === 'MOBILE_MICROPHONE_IN_USE') stopVoice();
    report(error);
  },
});

const supported = state => state?.capabilities?.mobileVoiceSubmit === true
  && state.hostSettings?.asrSource === 'host' && state.hostSettings?.ttsSource === 'host'
  && state.hostSettings?.asrModel && state.hostSettings?.ttsModel && state.hostSettings?.voiceReady
  && !state.hostSettings.asrIssue && !state.hostSettings.ttsIssue;

function renderControls() {
  ui.enabled.checked = enabled;
  ui.start.disabled = !enabled || !visible || !profile;
  ui.start.textContent = running ? '结束实时语音' : '开始实时语音';
  ui.mute.disabled = !running;
  ui.mute.textContent = muted ? '恢复播报' : '播报静音';
  ui.waveform.hidden = !running;
  if (!running) ui.playing.hidden = true;
}

function stopVoice() {
  running = false;
  generation++;
  submitted.forEach(turn => turn.token?.finish({ speak: false }));
  voice.setOutputEnabled(false);
  voice.suspend();
  levels.fill(0);
  ui.tool.hidden = true;
  phase(enabled ? '实时语音已结束' : '语音已关闭');
  renderControls();
}

function drawReply(id) {
  const node = rows.get(id)?.lastChild;
  if (!node) return;
  const text = messages.find(message => message.id === id)?.text || '';
  if (playingCue?.responseId !== id || !playingCue.segment) {
    if (node.querySelector('mark') || node.textContent !== text) node.textContent = text;
    return;
  }
  const start = text.indexOf(playingCue.segment, Math.max(0, playingCue.offset - 2));
  if (start < 0) { node.textContent = text; return; }
  const until = start + Math.min(playingCue.segment.length, Math.max(1, playingCue.index - playingCue.offset + 1));
  const highlighted = document.createElement('mark');
  highlighted.textContent = text.slice(start, until);
  node.replaceChildren(text.slice(0, start), highlighted, text.slice(until));
}

function renderMessages(payload) {
  messages = Array.isArray(payload) ? payload : payload?.messages ?? [];
  const scrollToLatest = ui.messages.scrollHeight - ui.messages.scrollTop - ui.messages.clientHeight < 90;
  const seen = new Set();
  for (const message of messages) {
    if (!message.id || !message.text || message.notice) continue;
    seen.add(message.id);
    let item = rows.get(message.id);
    if (!item) {
      item = document.createElement('li');
      item.className = message.role === 'user' ? 'user' : 'assistant';
      item.append(document.createElement('strong'), document.createElement('p'));
      rows.set(message.id, item);
      ui.history.append(item);
    }
    item.firstChild.textContent = message.role === 'user' ? '我' : profile?.personaLabel || '语音助手';
    drawReply(message.id);
  }
  for (const [id, row] of rows) if (!seen.has(id)) { row.remove(); rows.delete(id); }
  if (scrollToLatest) ui.messages.scrollTop = ui.messages.scrollHeight;
  ui.empty.hidden = rows.size > 0;
}

async function refresh() {
  const serial = ++refreshSerial;
  ui.refresh.disabled = true;
  ui.issue.hidden = true;
  phase('正在连接电脑');
  try {
    const state = await request('state');
    if (serial !== refreshSerial || !visible) return;
    connection = state.sessionId;
    profile = supported(state) && connection && state.settings?.voiceEnabled !== false ? state.hostSettings : null;
    ui.source.textContent = profile ? [profile.personaLabel, '整句识别', '手机播放'].filter(Boolean).join(' · ') : 'RabiLink';
    if (!profile) {
      ui.issue.textContent = state.settings?.voiceEnabled === false ? label.ASSISTANT_VOICE_DISABLED
        : state.capabilities?.mobileVoiceSubmit !== true ? '请更新所选电脑的语音助手插件。'
        : '请在所选电脑的语音助手中选择人格、本机识别和本机播报服务。';
      ui.issue.hidden = false;
    }
    phase(enabled ? profile ? '可以开始实时语音' : '等待电脑配置' : '语音已关闭');
    const result = await request('messages');
    if (serial === refreshSerial && visible) renderMessages(result);
  } catch (error) {
    if (serial !== refreshSerial || !visible) return;
    profile = null;
    phase('未连接');
    report(error);
  } finally {
    if (serial === refreshSerial) { ui.refresh.disabled = false; renderControls(); }
  }
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let reading = false;
// The current Manager only publishes a request/reply read endpoint. Read only during locally submitted work.
async function readOutstandingTurns() {
  if (reading || !visible) return;
  reading = true;
  let interval = 450;
  try {
    while (submitted.size && visible) {
      const payload = await request('messages');
      if (!visible) break;
      renderMessages(payload);
      if (payload.sessionId && payload.sessionId !== connection) throw new Error('ASSISTANT_CONTEXT_CHANGED');
      let activeTool;
      for (const [id, turn] of submitted) {
        const row = messages.find(item => item.id === 'reply-' + id);
        const input = messages.find(item => item.id === id);
        if (!row && !input && turn.uncertain) {
          if (Date.now() - turn.at > 12000) submitted.delete(id);
          continue;
        }
        if (row && running && turn.generation === generation) {
          turn.token ??= voice.beginResponse({ id: row.id });
          if (row.expression) turn.token.setSpeech({ expression: row.expression });
          if (row.text?.startsWith(turn.spoken)) {
            turn.token.append(row.text.slice(turn.spoken.length));
            turn.spoken = row.text;
          }
          const activity = payload.activity;
          if (row.status === 'generating' && activity?.requestId === id &&
              ['executing-tool','searching'].includes(activity.status)) {
            activeTool = activity.status === 'searching' ? '联网搜索' : activity.tool?.operation || activity.tool?.name || '助手工具';
            const callKey = activity.tool?.callId ?? activeTool;
            if (turn.tool !== callKey) {
              turn.tool = callKey;
              turn.token.finishSpeechSegment?.();
            }
          } else turn.tool = null;
        }
        const terminal = row?.status ?? input?.status;
        if (['completed','failed','interrupted'].includes(terminal) && (row || terminal !== 'completed')) {
          submitted.delete(id);
          turn.token?.finish({ speak: terminal === 'completed' });
          if (terminal === 'failed') report(new Error('MOBILE_ASSISTANT_TURN_FAILED'));
        } else if (Date.now() - turn.at > 120000) {
          submitted.delete(id);
          turn.token?.finish({ speak: false });
          report(new Error('MOBILE_REPLY_TIMEOUT'));
        }
      }
      ui.tool.textContent = activeTool ? '正在使用 · ' + activeTool : '';
      ui.tool.hidden = !activeTool;
      if (submitted.size) await wait(interval);
      interval = Math.min(interval + 100, 1000);
    }
  } catch (error) {
    report(error);
    for (const turn of submitted.values()) turn.token?.finish({ speak: false });
    submitted.clear();
  } finally {
    reading = false;
    ui.tool.hidden = true;
  }
}

async function sendSpeech(text, result) {
  if (!profile || !running || !visible) return;
  const requestId = crypto.randomUUID();
  const turn = { generation, spoken: '', at: Date.now() };
  submitted.set(requestId, turn);
  try {
    const response = await request('submit', { action: 'mobile-voice-submit', text, requestId,
      sessionId: connection, observation: observationOf(result) });
    if (!response?.accepted || response.sessionId !== connection || response.requestId !== requestId) {
      throw new Error('MOBILE_ASSISTANT_RECEIPT_UNCONFIRMED');
    }
  } catch (error) {
    turn.uncertain = true;
    report(error);
  }
  void readOutstandingTurns();
}

ui.enabled.addEventListener('change', () => {
  enabled = ui.enabled.checked;
  native.setVoiceEnabled(enabled);
  if (!enabled) stopVoice();
  else phase(profile ? '可以开始实时语音' : '等待电脑配置');
  renderControls();
});
ui.start.addEventListener('click', () => {
  if (running) { stopVoice(); return; }
  if (!profile || !enabled || !visible) return;
  if (!native.microphoneAvailable()) { report(new Error('MOBILE_MICROPHONE_IN_USE')); return; }
  running = true;
  ui.issue.hidden = true;
  phase('正在打开麦克风');
  voice.setOutputEnabled(!muted);
  voice.activate({ continuous: true, interimResults: false });
  renderControls();
});
ui.mute.addEventListener('click', () => {
  muted = !muted;
  voice.setOutputEnabled(running && !muted);
  renderControls();
});
ui.refresh.addEventListener('click', () => {
  if (running) stopVoice();
  void refresh();
});
ui.back.addEventListener('click', () => { stopVoice(); native.close(); });
window.mobileHidden = () => {
  visible = false;
  stopVoice();
};
window.mobileVisible = () => {
  if (visible) return;
  visible = true;
  renderControls();
  void refresh().then(readOutstandingTurns);
};
window.addEventListener('pagehide', () => { voice.dispose(); runtime.dispose(); });
renderControls();
void refresh();
