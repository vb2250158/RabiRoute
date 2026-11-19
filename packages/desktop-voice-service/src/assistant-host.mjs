import { randomUUID } from 'node:crypto'
import { resolveElectronExecutable } from './device-executable.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { createResidentInteraction } from '@rabilink/assistant-runtime/resident'
import { createSpeechPlayback } from '@rabilink/assistant-runtime/playback'
import { openDesktopVoiceServices } from './services.mjs'
import { createHttpSpeechProviders } from './providers.mjs'
import { captionSettings } from './presenter-settings.mjs'
import { listProviderModels } from './model-providers.mjs'
import { volcanoCatalog,recognitionFeedback } from './speech-catalog.mjs'
import {openaiCatalog,speechExpressionPolicy} from './tts-expression.mjs'
import {asrMessageDetails} from './speech-details.mjs'
import {projectCaptionText,projectCaptionPlayback} from './caption-progress.mjs'

/** Native Host owns audio. Client and pet only issue commands and present state. */
export function createResidentHost({ conversation, observeOutput, settings, saveSettings, previewSettings, saveSettingsBatch, credentials, openSettings = () => {}, deviceFactory, speech = () => undefined, pet, createProviders, supportsDynamicExpression=false, listModels=listProviderModels, onCaptureActivity, onCaptureStopped }) {
  if (typeof deviceFactory !== 'function') throw Error('ASSISTANT_DEVICE_FACTORY_REQUIRED')
  let device, closed = false, diagnostic, diagnosticAbort, presentationTimer, error = null, revision = 0
  let inputPreview = null, levels=[],levelUpdatedAt=0
  let borrowedCapture, localCaptureFallback, wakeBackground
  let recognizing = 0
  let failedDiagnostic
  let deviceOpening, deviceOpeningAbort, deviceClosing, deviceUsers=0, presenterQueue=Promise.resolve(), captionTestTimer
  let caption = {status:'hidden',lastTestAt:null}
  let playback = { completed: 0, lastCompletedAt: null }
  const speechProgress=new Map()
  const failedPresenters = new WeakSet()
  let presentation = { statusText: '语音已停止', text: '', outputEnabled: settings().outputEnabled, capturePaused: true }
  const changed = () => { revision++; pet?.present(settings(), presentation); publishPresentation() }
  const report = value => { error = /^[A-Z][A-Z0-9_]{1,100}$/.test(value?.message) ? value.message : 'ASSISTANT_OPERATION_FAILED'; changed() }
  const trackRecognition = recognize => async (audio, signal) => {
    recognizing++
    try { return await recognize(audio, signal) }
    finally { recognizing-- }
  }
  const native = conversation({ onError: report })
  let latestRecognitionText='',recognitionSession=native.getSessionId?.()
  const recognitionContext=()=>{if(typeof native.recognitionContext==='function'){const values=native.recognitionContext();return Array.isArray(values)?values:[];}return native.getSessionId?.()===recognitionSession&&latestRecognitionText?[{role:'assistant',text:latestRecognitionText}]:[]}
  const providers = config => createProviders ? createProviders(config,{recognitionContext}) : createHttpSpeechProviders({
    ...(config.asrMode === 'compatible' ? { asr: { endpoint: config.asrEndpoint, model: config.asrModel, credentialRef: 'asr' } } : {}),
    tts: { endpoint: config.ttsEndpoint, model: config.ttsModel, voice: config.ttsVoice, credentialRef: 'tts' },
    resolveCredential: kind => credentials.resolve(kind, config[kind + 'Endpoint'], kind === 'asr' ? config.asrMode : config.ttsProvider || 'compatible'),
  })
  const newDevice = async (config, signal) => deviceFactory({
    electronExecutable: await resolveElectronExecutable(config.electronExecutable),
    inputDeviceId: config.inputDeviceId, outputDeviceId: config.outputDeviceId, maxDurationMs: 30000, signal, onEvent: deviceEvent,
  })
  async function ensureDesktopDevice(config) {
    await deviceClosing
    if(closed)throw Error('ASSISTANT_CLOSED')
    if(failedDiagnostic)throw Error('ASSISTANT_DEVICE_CLEANUP_UNCONFIRMED')
    if(device)return device
    if(deviceOpening)return deviceOpening
    deviceOpeningAbort=new AbortController()
    deviceOpening=(async()=>{
      const opened=await newDevice(config,deviceOpeningAbort.signal)
      if(closed){await opened.close();throw Error('ASSISTANT_CLOSED')}
      device=opened;return opened
    })()
    try{return await deviceOpening}finally{deviceOpening=undefined;deviceOpeningAbort=undefined}
  }
  async function releaseUnusedDevice() {
    if(deviceUsers||!closed&&(settings().captionsEnabled||native.canvasState?.().visible))return
    await deviceOpening?.catch(()=>{})
    if(deviceUsers||!closed&&(settings().captionsEnabled||native.canvasState?.().visible))return
    if(deviceClosing)return deviceClosing
    const target=device;if(!target)return
    device=undefined
    deviceClosing=target.close().catch(failure=>{failedDiagnostic=target;throw failure})
    try{await deviceClosing}finally{deviceClosing=undefined}
  }
  /** Audio and captions borrow one process; only idle, unwanted devices are closed. */
  async function leaseDevice(config,signal) {
    deviceUsers++
    try{
      signal?.throwIfAborted()
      const opened=await ensureDesktopDevice(config)
      signal?.throwIfAborted()
      let release
      return {...opened,close(){if(!release){deviceUsers--;release=releaseUnusedDevice()}return release}}
    }catch(failure){deviceUsers--;await releaseUnusedDevice();throw failure}
  }
  function synchronizePresenter() {
    const operation=presenterQueue.then(async()=>{
      if(closed)return
      clearTimeout(captionTestTimer)
      const config=settings()
      if(!config.captionsEnabled&&!device){caption={...caption,status:'hidden'};return}
      if(config.captionsEnabled&&!device){caption={...caption,status:'opening'};changed()}
      const target=await leaseDevice(config)
      try{
        const result=await target.configurePresenter(captionSettings(settings()))
        if(settings().captionsEnabled&&result?.visible===false)throw Error('CAPTION_WINDOW_NOT_VISIBLE')
        if(device)failedPresenters.delete(device)
        caption={...caption,status:settings().captionsEnabled?'visible':'hidden',locked:Boolean(settings().captionLocked),movable:result?.movable,resizable:result?.resizable,...(result?.bounds?{bounds:result.bounds}:{})}
        await target.present(presentation);changed()
      }finally{await target.close()}
    }).catch(failure=>{caption={...caption,status:'failed'};report(failure);throw failure})
    presenterQueue=operation.catch(()=>{})
    return operation
  }
  async function deviceEvent(event) {
    if (closed) return
    if(event.event==='capture.level'){const now=Date.now();if(now-levelUpdatedAt>=50){levels=[...levels.slice(-47),event.level];levelUpdatedAt=now}return}
    if (event.type === 'playback-ended') {
      playback = { completed: playback.completed + 1, lastCompletedAt: new Date().toISOString() }
      changed(); return
    }
    if (event.type === 'playback-error') { report(Error('DEVICE_PLAYBACK_FAILED')); return }
    if (event.type === 'device-error' || event.type === 'cleanup-error') { report(Error(event.error)); return }
    if (event.event === 'presenter.bounds') {
      const b = event.bounds
      if (b && ['x','y','width','height'].every(key => Number.isFinite(b[key]))) {
        await saveSettings({ captionHasBounds: true, captionX: b.x, captionY: b.y, captionWidth: b.width, captionHeight: b.height })
      }
      return
    }
    if (event.event !== 'presenter.action') return
    try {
      const config = settings()
      switch (event.action) {
        case 'open-settings': await openSettings(); break
        case 'toggle-capture': await command({ action: voice.getState().capture === 'listening' ? 'pause' : 'resume' }); break
        case 'toggle-output': await command({ action: 'mute', enabled: !voice.getState().outputEnabled }); break
        case 'toggle-caption-lock': await command({ action: 'settings', patch: { captionLocked: !config.captionLocked } }); break
        case 'toggle-captions': await command({ action: 'settings', patch: { captionsEnabled: !config.captionsEnabled } }); break
        case 'captions-hide': await command({ action: 'settings', patch: { captionsEnabled: false } }); break
        case 'canvas-close': await command({action:'canvas-close'});break
        case 'stop': await command({ action: 'stop' }); break
      }
    } catch (failure) { report(failure) }
  }
  function publishPresentation() {
    if (!device || failedPresenters.has(device) || closed || presentationTimer) return
    presentationTimer = setTimeout(() => {
      presentationTimer = undefined
      const target = device
      if (target) void target.present(presentation).catch(error => {
        if (device !== target || closed) return
        failedPresenters.add(target);if(settings().captionsEnabled)caption={...caption,status:'failed'};report(error)
      })
    }, 50)
  }
  const voice = createResidentInteraction({ outputEnabled: settings().outputEnabled,
    async openServices({ signal }) {
      if (failedDiagnostic) throw Error('ASSISTANT_DEVICE_CLEANUP_UNCONFIRMED')
      if (diagnostic) throw Error('ASSISTANT_DEVICE_TEST_BUSY')
      const config = settings(), http = providers(config)
      if (!config.ttsModel || !config.ttsVoice) throw Error('SPEECH_TTS_MODEL_REQUIRED')
      if (config.asrMode !== 'native' && !config.asrModel) throw Error('SPEECH_ASR_MODEL_REQUIRED')
      let catalog, nativeSpeech
      if (config.asrMode === 'native') {
        nativeSpeech = speech()
        if (!nativeSpeech) throw Error('SPEECH_NATIVE_UNAVAILABLE')
        catalog = await nativeSpeech.catalog()
      }
      await native.open(); signal.throwIfAborted()
      // Services borrow the shared process and drain audio before releasing it.
      const opened = await leaseDevice(config,signal)
      if (signal.aborted) { await opened.close(); signal.throwIfAborted() }
      try {
        await opened.configurePresenter(captionSettings(config))
        const fallbackCapture = localCaptureFallback && {
          ...localCaptureFallback, recognize: trackRecognition(localCaptureFallback.recognize),
        }
        const services = await openDesktopVoiceServices({ openDevice: async () => opened, createRecording: borrowedCapture, fallbackCapture, signal, settings: { ...config, maxDurationMs: 30000 },
          synthesize: http.synthesize,
          createAsr: http.createAsr, openSpeechStream: http.openSpeechStream,streamSampleRate:http.streamSampleRate,
          recognize: trackRecognition(config.asrMode !== 'native' ? http.recognize : (audio, signal) => {
            if (audio.byteLength > catalog.maxAudioBytes) throw Error('SPEECH_AUDIO_LIMIT')
            if (speech() !== nativeSpeech) throw Error('SPEECH_NATIVE_UNAVAILABLE')
            return nativeSpeech.transcribe({ audioBase64: Buffer.from(audio).toString('base64'),
              ...(config.asrProviderId ? { providerId: config.asrProviderId } : {}) }, signal)
          }), onError: report,onSpeechRequest:event=>native.recordSpeechDetails?.(event.responseId,{type:'request',...event}),
        })
        return { runtime: services.runtime, async dispose() {
          await services.dispose()
        } }
      } catch (failure) { await opened.close(); throw failure }
    },
    async onInput(input) {
      const preview=inputPreview;
      const recentSpeech = input.source === 'speech' ? wakeBackground : undefined;
      if (recentSpeech !== undefined) wakeBackground = undefined;
      const receipt=await native.submit(input.text,randomUUID(),{source:input.source,...(input.source==='speech'?{details:asrMessageDetails(settings(),input.result),recentSpeech}:{})});
      if(inputPreview===preview){inputPreview=null;changed()}
      return receipt;
    },
    onError: report,
    onEvent(event) {
      if (event.type === 'state') {
        const s = event.state
        if (['stopped','failed','disposed'].includes(s.phase)) onCaptureStopped?.()
        presentation = { ...presentation, outputEnabled: s.outputEnabled, capturePaused: s.capture !== 'listening',
          statusText: s.phase === 'failed' ? '语音故障' : s.phase === 'starting' ? '正在准备' : s.phase === 'stopped' ? '语音已停止' : s.capture === 'listening' ? '正在聆听' : '麦克风已暂停' }
      } else {
        const e = event.event
        if(e.type==='playback'){
          const prior=speechProgress.get(e.event.responseId)
          if(prior){const next=projectCaptionPlayback(prior,e.event);speechProgress.set(e.event.responseId,next);if(presentation.responseId===e.event.responseId)presentation={...presentation,...next}}
        }
        if(e.type==='playback'&&e.event?.responseId)native.recordSpeechDetails?.(e.event.responseId,{type:'playback',status:e.event.type,...(e.event.error?{error:'SPEECH_PLAYBACK_FAILED'}:{})})
        if ((e.type === 'transcript' && e.text?.trim()) || (e.type === 'input' && e.input?.text?.trim())) onCaptureActivity?.(true)
        if (e.type === 'speech-started') onCaptureActivity?.(false)
        if (e.type === 'speech-started') inputPreview = {text:'',final:false}
        if(e.type==='transcript'&&e.text?.trim()&&!inputPreview?.text)native.beginVisualInput?.()
        if (e.type === 'transcript') inputPreview = {text:e.text,final:false}
        if (e.type === 'input') inputPreview = {text:e.input.text,final:true,corrected:Boolean(inputPreview&&!inputPreview.final&&inputPreview.text&&inputPreview.text!==e.input.text)}
        if (e.type === 'transcript') presentation = projectCaptionText(presentation,{text:e.text,responseId:null})
        if (e.type === 'input') presentation = projectCaptionText(presentation,{text:e.input.text,statusText:'正在处理',responseId:null})
      }
      changed()
    },
  })
  const unobserve = observeOutput({ conversation: native, voice, onError: report,
    onCanvas(value){
      presentation={...presentation,canvas:value};changed()
      presenterQueue=presenterQueue.then(async()=>{
        if(closed)return
        if(value.visible){const target=await leaseDevice(settings());try{await target.configurePresenter(captionSettings(settings()));await target.present(presentation)}finally{await target.close()}}
        else{if(device)await device.present(presentation);await releaseUnusedDevice()}
      }).catch(failure=>report(failure))
    },
    onText(value) {
      recognitionSession=native.getSessionId?.();latestRecognitionText=value.responseId?String(value.text||'').slice(0,2048):''
      if(!value.responseId)speechProgress.clear()
      const next=projectCaptionText(speechProgress.get(value.responseId)||{},value)
      if(value.responseId){speechProgress.set(value.responseId,next);while(speechProgress.size>16)speechProgress.delete(speechProgress.keys().next().value)}
      presentation={...presentation,...next};changed()
    },
  })
  async function testDevice(action) {
    if (failedDiagnostic) throw Error('ASSISTANT_DEVICE_CLEANUP_UNCONFIRMED')
    if (diagnostic || voice.getState().phase === 'starting') throw Error('ASSISTANT_DEVICE_TEST_BUSY')
    if (device && action === 'devices') return device.enumerateDevices()
    if (deviceUsers) throw Error('ASSISTANT_STOP_VOICE_BEFORE_TEST')
    diagnosticAbort = new AbortController()
    const signal = diagnosticAbort.signal
    diagnostic = (async () => {
      const opened = await leaseDevice(settings(), signal)
      try {
        if (action === 'devices') return await opened.enumerateDevices()
        if (action === 'test-microphone') {
          const recording = opened.createRecording(); let peak = 0, failure
          try {
            await recording.start(err => { failure = err })
            for (let i = 0; i < 30; i++) { await delay(100, undefined, { signal }); peak = Math.max(peak, recording.amplitude()); if (failure) throw failure }
            const audio = await recording.take()
            return { bytes: audio.byteLength, peak, audible: peak > .001, message: peak > .001 ? '检测到输入信号' : '输入为静音，请检查设备选择和系统麦克风音量' }
          } finally { await recording.dispose() }
        }
        if (action === 'test-playback') {
          const provider = providers(settings())
          const services = await openDesktopVoiceServices({openDevice:async()=>opened,signal,settings:settings(),
            synthesize:provider.synthesize,recognize:provider.recognize,openSpeechStream:provider.openSpeechStream,streamSampleRate:provider.streamSampleRate,onError:report})
          let playback
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(Error('SPEECH_PLAYBACK_TIMEOUT')), 20000)
              const done = error => { clearTimeout(timer); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
              const aborted = () => done(Error('SPEECH_TEST_CANCELLED'))
              signal.addEventListener('abort', aborted, { once: true })
              playback=createSpeechPlayback({tts:services.runtime.tts,releaseSpeech:services.runtime.releaseSpeech,onCleanupError:report,
                onEvent:event=>{if(event.type==='ended')done();if(event.type==='error')done(event.error)}})
              if(services.runtime.tts.openStream){const input=playback.beginStream();input.append('你好，语音助手已准备好。');input.finish()}
              else playback.speak('你好，语音助手已准备好。')
              if(signal.aborted)aborted()
            })
            return { played: true, message: '播放已结束，请确认扬声器是否有声音' }
          } finally { playback?.dispose();await services.dispose() }
        }
        throw Error('ASSISTANT_ACTION_INVALID')
      } finally { try { await opened.close() } catch (error) { failedDiagnostic ||= opened; throw error } }
    })().finally(() => { diagnostic = undefined; diagnosticAbort = undefined })
    return diagnostic
  }
  async function command(request) {
    if (closed) throw Error('ASSISTANT_CLOSED')
    if(request.action!=='message-details')error = null
    switch (request.action) {
      case 'canvas-close': if(!native.closeCanvas)throw Error('ASSISTANT_CANVAS_UNAVAILABLE');return native.closeCanvas()
      case 'preview-settings': {
        validateDraftPatches(request.patches)
        if (!previewSettings || !saveSettingsBatch) throw Error('ASSISTANT_DRAFT_UNAVAILABLE')
        const config = await previewSettings(request.patches)
        const described = {}
        for (const kind of ['asr','tts',...(config.llmProvider?['llm']:[])]) {
          try { described[kind] = await credentials.describe(kind,config[kind+'Endpoint'],kind==='asr'?config.asrMode:kind==='tts'?config.ttsProvider:config.llmProvider) }
          catch { described[kind] = {configured:false} }
        }
        return { settings: config, credentials: described }
      }
      case 'prepare': return { sessionId: await native.open() }
      case 'message-details': {
        if(typeof request.messageId!=='string'||request.messageId.length>160||typeof native.messageDetails!=='function')throw Error('ASSISTANT_MESSAGE_DETAILS_UNAVAILABLE')
        return native.messageDetails(request.messageId)
      }
      case 'text': return native.submit(request.text, request.requestId)
      case 'start': await startVoice(); return state()
      case 'stop': diagnosticAbort?.abort(); await diagnostic?.catch(() => {}); await voice.stop(); inputPreview=null; return state()
      case 'interrupt-speech': voice.interruptSpeech('manual'); changed(); return state()
      case 'pause': voice.pauseCapture(); inputPreview=null; return state()
      case 'resume': await voice.resumeCapture(); return state()
      case 'mute': await saveSettings({ outputEnabled: Boolean(request.enabled) }); voice.setOutputEnabled(Boolean(request.enabled)); return state()
      case 'test-captions': {
        if(!settings().captionsEnabled)throw Error('ASSISTANT_CAPTIONS_DISABLED')
        await synchronizePresenter()
        const target=await leaseDevice(settings())
        try{
          clearTimeout(presentationTimer);presentationTimer=undefined
          await target.present({...presentation,statusText:'字幕测试',text:'这是一条测试字幕。'})
          caption={...caption,lastTestAt:new Date().toISOString()}
          captionTestTimer=setTimeout(publishPresentation,3000)
        }finally{await target.close()}
        return state()
      }
      case 'settings': {
        const batch = request.patches
        if (batch !== undefined) { validateDraftPatches(batch); if(request.patch !== undefined) throw Error('ASSISTANT_SETTINGS_INVALID') }
        if (batch !== undefined && (!previewSettings || !saveSettingsBatch)) throw Error('ASSISTANT_DRAFT_UNAVAILABLE')
        if (batch !== undefined) await previewSettings(batch)
        const patch = batch !== undefined ? Object.assign({}, ...batch) : request.patch
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('ASSISTANT_SETTINGS_INVALID')
        const audioKeys = ['asrMode','asrProviderId','asrEndpoint','asrModel','asrResourceId','ttsProvider','ttsEndpoint','ttsModel','ttsVoice','ttsResourceId','inputDeviceId','outputDeviceId','electronExecutable']
        if (audioKeys.some(key => key in patch)||Object.keys(patch).some(key=>key.startsWith('asr')||key.startsWith('tts'))) { diagnosticAbort?.abort(); await diagnostic?.catch(() => {}); await voice.stop() }
        // Device selections are fixed at process acquisition, unlike synthesis settings.
        const reopenDevice=['inputDeviceId','outputDeviceId','electronExecutable'].some(key=>key in patch&&patch[key]!==settings()[key])
        if(reopenDevice){
          await presenterQueue;await deviceOpening?.catch(()=>{})
          if(device){const target=device;device=undefined;try{await target.close()}catch(failure){failedDiagnostic=target;throw failure}}
        }
        if (batch !== undefined) await saveSettingsBatch(batch)
        else await saveSettings(patch)
        native.configure?.()
        voice.setOutputEnabled(settings().outputEnabled)
        await synchronizePresenter()
        changed()
        return state()
      }
      case 'credential': {
        const config = settings(), kind = request.kind
        const provider = kind === 'asr' ? config.asrMode : kind === 'tts' ? config.ttsProvider || 'compatible' : config.llmProvider||'compatible'
        if (!['asr','tts','llm'].includes(kind) || request.provider !== provider || request.endpoint !== config[kind + 'Endpoint']) throw Error('SPEECH_CREDENTIAL_TARGET_CHANGED')
        return credentials.set(kind, request.endpoint, request.key, provider)
      }
      case 'models': {
        const config=settings(),kind=request.kind,provider=kind==='asr'?config.asrMode:kind==='tts'?config.ttsProvider||'compatible':config.llmProvider||'compatible'
        if(!['llm','asr','tts'].includes(kind)||request.endpoint!==config[kind+'Endpoint']||request.provider!==provider)throw Error('SPEECH_CREDENTIAL_TARGET_CHANGED')
        return listModels({kind,provider,endpoint:request.endpoint,resolveCredential:()=>credentials.resolve(kind,request.endpoint,provider)})
      }
      case 'devices': case 'test-microphone': case 'test-playback': return testDevice(request.action)
      case 'test-asr': {
        if (settings().asrMode !== 'native') throw Error('SPEECH_USE_MICROPHONE_TEST_FOR_COMPATIBLE_ASR')
        const service = speech()
        if (!service) throw Error('SPEECH_NATIVE_UNAVAILABLE')
        const catalog = await service.catalog()
        return { available: true, catalog }
      }
      default: throw Error('ASSISTANT_ACTION_INVALID')
    }
  }
  async function state() {
    const config = settings()
    const describe = async kind => {
      try { return await credentials.describe(kind, config[kind + 'Endpoint'], kind === 'asr' ? config.asrMode : config.ttsProvider || 'compatible') }
      catch { return { configured: false, writable: false, error: 'SPEECH_ENDPOINT_INVALID' } }
    }
    return { revision, sessionId: native.getSessionId() ?? null, canvas:native.canvasState?.(),voice: voice.getState(), interaction: voice.getPresentationState(), inputPreview, waveform:{samples:levels,updatedAt:levelUpdatedAt},asrFeedback:recognitionFeedback(config), presentation, caption, playback, error, settings: config, settingsDraft:Boolean(previewSettings&&saveSettingsBatch),
      speechProgress:[...speechProgress.values()].map(({responseId,spokenEnd,timingMode,speechStatus})=>({responseId,spokenEnd,timingMode,speechStatus})),
      speechCatalogs:{volcengine:volcanoCatalog,compatible:openaiCatalog},
      speechExpression:{...speechExpressionPolicy(config),available:supportsDynamicExpression},
      credentials: { asr: await describe('asr'), tts: await describe('tts') },
      pet: pet?.state() ?? { available: false, reason: '未安装兼容桌宠', repository: 'https://github.com/vb2250158/dsh-pet', pets: [] } }
  }
  async function startVoice(createRecording, {fallback, recentSpeech} = {}) {
    const phase = voice.getState().phase
    if (phase === 'running' || phase === 'starting') {
      if (createRecording) throw Error('ASSISTANT_CAPTURE_ALREADY_ACTIVE')
    } else {
      borrowedCapture = createRecording
      localCaptureFallback = fallback
      wakeBackground = recentSpeech
    }
    await voice.start()
  }
  function captureHasWork() {
    const activity = voice.getPresentationState()
    return recognizing > 0 || Boolean(activity?.inputPending || activity?.outputActive || activity?.outputQueued)
  }
  return { state, command, startWithRecording: startVoice, captureState: () => voice.getState(), captureHasWork, initialize:()=>synchronizePresenter().catch(()=>{}), openSettings(url) {
    if (!device) throw Error('ASSISTANT_DEVICE_UNAVAILABLE')
    return device.request('presenter.open-settings', { url })
  }, async dispose() {
    if (closed) return; closed = true; clearTimeout(presentationTimer); clearTimeout(captionTestTimer); deviceOpeningAbort?.abort(); diagnosticAbort?.abort()
    unobserve(); native.close(); await diagnostic?.catch(() => {})
    const results = await Promise.allSettled([voice.dispose(), pet?.dispose(), failedDiagnostic?.close()])
    await Promise.allSettled([deviceOpening,presenterQueue])
    results.push(...await Promise.allSettled([releaseUnusedDevice()]))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, 'ASSISTANT_CLEANUP_UNCONFIRMED')
  } }
}

function validateDraftPatches(patches) {
  if(!Array.isArray(patches)||patches.length>64||patches.some(patch=>!patch||typeof patch!=='object'||Array.isArray(patch)||'speechProfiles' in patch||'llmProfiles' in patch))throw Error('ASSISTANT_SETTINGS_INVALID')
}
