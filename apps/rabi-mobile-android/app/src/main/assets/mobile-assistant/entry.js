import { createAiuiAssistantRuntime } from './sdk/aiui-runtime.js';
import { createVoiceInteraction } from './sdk/voice-interaction.js';
import { snapshotRecentSpeech } from './sdk/speech-observation.js';
import { createPhoneCapture } from './capture.js';
import { createStreamingRecognition, matchWakeWord } from './asr-stream.js';
import { createLocalWakeRecognition } from './wake-stream.js';

const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(node => [node.id, node]));
const native = globalThis.RabiMobile;
let enabled = native.voiceEnabled();
let muted = false;
let startMode = native.startMode?.() ?? 'manual';
let backgroundTranscription = native.backgroundTranscription?.() === true;
let capturing = false;
let wakeArmed = false;
let fallback = false;
let idleTimer;
let pendingWakeContext;
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
  MOBILE_ASR_FAILED: '转写失败，请检查电脑端识别设置。',
  MOBILE_LOCAL_ASR_UNAVAILABLE: '电脑上的本机识别暂不可用。',
  MOBILE_STREAM_BACKLOG: '实时识别连接处理较慢，请重新开启。',
  MOBILE_STREAM_UNAVAILABLE: '当前电脑的实时识别连接不可用。',
  MOBILE_STREAM_SAMPLE_RATE_UNAVAILABLE: '此设备无法以 16 kHz 采集。',
  MOBILE_WAKE_UNAVAILABLE: '手机暂时无法检测唤醒词。请刷新连接或开启电脑转写。',
  MOBILE_WAKE_ENGINE_FAILED: '手机唤醒模型启动失败。请重新开启关键词监听。',
  MOBILE_WAKE_BACKLOG: '手机唤醒处理延迟，请重新开启关键词监听。',
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
  if (!capturing || ui.waveform.hidden) return;
  levels.copyWithin(0, 1);
  levels[levels.length - 1] = value;
  bars.forEach((bar, index) => { bar.style.setProperty('--level', Math.min(1, levels[index] * 8)); });
}

const recognition = createStreamingRecognition(native);
window.mobileRecognitionEvent = recognition.receive;
const localWake = createLocalWakeRecognition(native);
window.mobileWakeEvent = localWake.receive;
const asr = createPhoneCapture({
  transcribe: (bytes, signal, policy) => request('asr', { sessionId:connection,
    source:policy.kind === 'wake' || policy.local ? 'local' : 'active', audio:encode(bytes) }, signal),
  waveform, phase, mayRecord: () => native.microphoneAvailable(),
  getPolicy: () => running ? activePolicy() : wakePolicy(),
  openStream: events => recognition.open(connection, events),
  openWake: (config, count, events) => localWake.open(config, count, events),
  matchWake: matchWakeWord,
  onWake: (_alias, recentSpeech) => {
    if (!capturing || running || !wakeArmed) return null;
    enterRealtime();
    pendingWakeContext = recentSpeech;
    return activePolicy();
  },
  onFallback() {
    fallback = true;
    ui.transcript.hidden = true;
    ui.issue.textContent = '实时识别已断开，正在使用本机整句识别。';
    ui.issue.hidden = false;
    renderControls();
  },
  onWakeFallback() {
    ui.issue.textContent = '手机唤醒遇到问题，正在使用已开启的电脑转写。';
    ui.issue.hidden = false;
  },
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
      async play() {
        await asr.beforePlayback();
        if (!retired) await audio.play();
      },
      stop, destroy: stop,
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
    if (event.type === 'transcript') {
      ui.transcript.textContent = event.text;
      ui.transcript.hidden = !event.text;
    }
    if (event.type === 'input') {
      ui.transcript.hidden = true;
      phase('正在聆听');
      renewIdle();
    }
  },
  onError: error => {
    if (!capturing) return;
    if (error?.name === 'NotAllowedError' || error?.name === 'NotReadableError' || error?.message === 'MOBILE_MICROPHONE_IN_USE'
      || error?.message?.startsWith('MOBILE_WAKE_')) stopVoice();
    report(error);
  },
});

const streaming = host => host?.mobileAudio?.recognition === 'streaming' && host.mobileAudio.sampleRate === 16000;
const supported = state => {
  const host = state?.hostSettings;
  return state?.capabilities?.mobileVoiceSubmit === true && host?.ttsSource === 'host' && host.ttsModel && host.voiceReady
    && !host.asrIssue && !host.ttsIssue && (streaming(host) || host.asrModel || state.settings?.asrModel);
};
const passiveModel = host => typeof host?.mobileAudio?.passiveModel === 'string' && host.mobileAudio.passiveModel || undefined;
function edgeWakeConfig(host) {
  const config = host?.mobileAudio?.kws;
  if (typeof config?.model !== 'string' || typeof config.keywords !== 'string' || typeof config.tokensSha256 !== 'string') return;
  if (native.wakeSupported?.(config.model, config.tokensSha256)) return config;
}
const wakeAvailable = host => Array.isArray(host?.mobileAudio?.wakeAliases) && host.mobileAudio.wakeAliases.length > 0
  && Boolean(edgeWakeConfig(host) || backgroundTranscription && passiveModel(host));

function activePolicy() {
  if (!streaming(profile)) return { kind:'utterance' };
  return { kind:'streaming', fallbackModel:profile.mobileAudio.passiveModel };
}

function wakePolicy() {
  return { kind:'wake', model:backgroundTranscription ? passiveModel(profile) : undefined,
    aliases:profile?.mobileAudio?.wakeAliases ?? [], kws:edgeWakeConfig(profile) };
}

function renderControls() {
  ui.enabled.checked = enabled;
  ui.start.disabled = !enabled || !visible || !profile;
  ui.start.textContent = running ? '结束实时语音' : '开始实时语音';
  ui.mute.disabled = !running;
  ui.mute.textContent = muted ? '恢复播报' : '播报静音';
  ui.mode.value = startMode;
  ui.mode.disabled = capturing;
  ui.wake.disabled = !enabled || !visible || !profile || !wakeAvailable(profile) || running;
  ui.wake.hidden = startMode !== 'keyword';
  ui.wake.textContent = wakeArmed ? '停止关键词监听' : '开启关键词监听';
  ui.aliases.hidden = startMode !== 'keyword';
  const aliases = Array.isArray(profile?.mobileAudio?.wakeAliases) ? profile.mobileAudio.wakeAliases : [];
  const local = edgeWakeConfig(profile);
  ui.aliases.textContent = aliases.length === 0 ? '请在电脑上的人格设置中添加唤醒词。' : wakeAvailable(profile)
    ? `${local ? '手机检测' : '电脑转写'} · ${aliases.join('、')}`
    : passiveModel(profile) ? '当前无法用手机检测唤醒词。打开电脑转写后可继续使用。' : '当前没有可用的关键词识别。';
  ui['background-row'].hidden = startMode !== 'keyword' || !passiveModel(profile);
  ui.background.checked = backgroundTranscription;
  ui.background.disabled = capturing;
  ui.waveform.hidden = !running || streaming(profile) && !fallback;
  if (!running) ui.playing.hidden = true;
}

function clearIdle() { clearTimeout(idleTimer); }

function renewIdle() {
  clearIdle();
  if (!wakeArmed || !running) return;
  idleTimer = setTimeout(() => {
    if (submitted.size || voice.getState().inputPending || voice.getState().playback.active) renewIdle();
    else returnToWake();
  }, 45000);
}

function enterRealtime() {
  generation++;
  pendingWakeContext = undefined;
  running = true;
  fallback = false;
  voice.setOutputEnabled(!muted);
  renewIdle();
  renderControls();
}

function returnToWake() {
  if (!wakeArmed) { stopVoice(); return; }
  clearIdle();
  running = false;
  generation++;
  pendingWakeContext = undefined;
  voice.setOutputEnabled(false);
  asr.setPolicy(wakePolicy());
  ui.transcript.hidden = true;
  ui.tool.hidden = true;
  renderControls();
}

function stopVoice() {
  clearIdle();
  pendingWakeContext = undefined;
  capturing = false;
  wakeArmed = false;
  fallback = false;
  running = false;
  generation++;
  submitted.forEach(turn => turn.token?.finish({ speak: false }));
  voice.setOutputEnabled(false);
  voice.suspend();
  levels.fill(0);
  ui.tool.hidden = true;
  ui.transcript.hidden = true;
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
    ui.source.textContent = profile ? [profile.personaLabel, streaming(profile) ? '流式识别' : '整句识别', '手机播放'].filter(Boolean).join(' · ') : 'RabiLink';
    if (!profile) {
      ui.issue.textContent = state.settings?.voiceEnabled === false ? label.ASSISTANT_VOICE_DISABLED
        : state.capabilities?.mobileVoiceSubmit !== true ? '请更新所选电脑的语音助手插件。'
        : '请在所选电脑的语音助手中选择人格、受支持的识别服务和本机播报。';
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
  const now = Date.now();
  const context = pendingWakeContext;
  pendingWakeContext = undefined;
  const recentSpeech = snapshotRecentSpeech(context?.map(item => ({
    text:item.text, ageMs:Math.max(0, now - item.capturedAt),
  })).filter(item => item.ageMs <= 90_000 && item.text !== text.trim()));
  const turn = { generation, spoken: '', at: now };
  submitted.set(requestId, turn);
  try {
    const response = await request('submit', { action: 'mobile-voice-submit', text, requestId,
      sessionId: connection, observation: observationOf(result), recentSpeech });
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
function canCapture() {
  if (!profile || !enabled || !visible) return false;
  if (native.microphoneAvailable()) return true;
  report(new Error('MOBILE_MICROPHONE_IN_USE'));
  return false;
}

function startCapture() {
  capturing = true;
  phase('正在打开麦克风');
  voice.activate({ continuous: true, interimResults: streaming(profile) });
  renderControls();
}

ui.mode.addEventListener('change', () => {
  startMode = ui.mode.value;
  native.setStartMode?.(startMode);
  renderControls();
});

ui.background.addEventListener('change', () => {
  backgroundTranscription = ui.background.checked;
  native.setBackgroundTranscription?.(backgroundTranscription);
  renderControls();
});

ui.wake.addEventListener('click', () => {
  if (wakeArmed) { stopVoice(); return; }
  if (!canCapture() || !wakeAvailable(profile)) return;
  wakeArmed = true;
  ui.issue.hidden = true;
  startCapture();
});

ui.start.addEventListener('click', () => {
  if (running) { returnToWake(); return; }
  if (!canCapture()) return;
  ui.issue.hidden = true;
  enterRealtime();
  if (capturing) asr.setPolicy(activePolicy());
  else startCapture();
});
ui.mute.addEventListener('click', () => {
  muted = !muted;
  voice.setOutputEnabled(running && !muted);
  renderControls();
});
ui.refresh.addEventListener('click', () => {
  if (capturing) stopVoice();
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
