import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as delay} from 'node:timers/promises'
import {createAsrStartupFallback} from '../src/asr-startup-fallback.mjs'

function engine(start) {
  let handler, stops = 0
  return {
    get callbacks(){return handler},
    get stops(){return stops},
    createRound(callbacks){handler=callbacks;return {}},
    start(){return start(handler)},
    stop(){stops++},
  }
}

test('failed primary connection releases capture before local replay and fences stale finals',async()=>{
  const steps=[], finals=[]
  const primary=engine(async()=>{throw Error('fixture network failure')})
  const local=engine(async callbacks=>{
    steps.push('local')
    callbacks.onStart()
    callbacks.onFinal({text:'我刚说的首句'})
  })
  const asr=createAsrStartupFallback(primary,()=>local,{releasePrimary:()=>steps.push('release')})
  const round=asr.createRound({onFinal:item=>finals.push(item.text)})
  await asr.start(round)
  await delay(0)
  primary.callbacks.onFinal({text:'迟到的旧事件'})
  assert.deepEqual(steps,['release','local'])
  assert.deepEqual(finals,['我刚说的首句'])
  await asr.stop(round)
  assert.equal(primary.stops,1)
  assert.equal(local.stops,1)
})

test('partial text followed by an unfinished stream falls back once',async()=>{
  const finals=[], partials=[]
  const primary=engine(async cb=>cb.onStart())
  const local=engine(async cb=>{cb.onStart();cb.onFinal({text:'本地完整句'})})
  const asr=createAsrStartupFallback(primary,()=>local)
  const round=asr.createRound({onInterim:value=>partials.push(value.text),onFinal:value=>finals.push(value.text)})
  await asr.start(round)
  primary.callbacks.onInterim({text:'临时'})
  primary.callbacks.onEnd()
  primary.callbacks.onFinal({text:'迟到'})
  await delay(0)
  assert.deepEqual(partials,['临时'])
  assert.deepEqual(finals,['本地完整句'])
  await asr.stop(round)
})

test('empty result after audible speech triggers the bounded fallback',async()=>{
  const causes=[]
  const primary=engine(async cb=>cb.onStart())
  const local=engine(async cb=>cb.onStart())
  const asr=createAsrStartupFallback(primary,()=>local,{recognitionMs:10,onFallback:reason=>causes.push(reason)})
  const round=asr.createRound({})
  await asr.start(round)
  primary.callbacks.onSpeechStart()
  primary.callbacks.onFinal({text:'  '})
  await delay(50)
  assert.deepEqual(causes,['ASSISTANT_REALTIME_NO_TEXT'])
  await asr.stop(round)
})

test('a final remote sentence wins, so late failure does not replay it',async()=>{
  const finals=[], errors=[]
  const primary=engine(async cb=>cb.onStart())
  const local=engine(async()=>assert.fail('unexpected replay'))
  const asr=createAsrStartupFallback(primary,()=>local)
  const round=asr.createRound({onFinal:value=>finals.push(value.text),onError:error=>errors.push(error.message)})
  await asr.start(round)
  primary.callbacks.onFinal({text:'实时结果'})
  primary.callbacks.onError(Error('连接结束'))
  await delay(0)
  assert.deepEqual(finals,['实时结果'])
  assert.deepEqual(errors,['连接结束'])
  assert.equal(local.callbacks,undefined)
  await asr.stop(round)
})

test('after a final, a disconnect replays only the unfinished audio and fences the old provider', async () => {
  const finals=[], checkpoints=[]
  const primary=engine(async cb=>cb.onStart())
  const local=engine(async cb=>{cb.onStart();cb.onFinal({text:'第二句完整'})})
  const asr=createAsrStartupFallback(primary,cursor=>{checkpoints.push(cursor);return local},{
    replayCursor: offset => ({captureId:'capture-fixture',sample:9200+offset}),
  })
  const round=asr.createRound({onFinal:value=>finals.push(value.text)})
  await asr.start(round)
  primary.callbacks.onFinal({text:'第一句',endSample:1600})
  primary.callbacks.onSpeechEnd()
  primary.callbacks.onInterim({text:'第二'})
  primary.callbacks.onError(Error('provider disconnected'))
  primary.callbacks.onFinal({text:'第二句旧回执',endSample:3200})
  await delay(0)
  assert.deepEqual(checkpoints,[{captureId:'capture-fixture',sample:10800}])
  assert.deepEqual(finals,['第一句','第二句完整'])
  await asr.stop(round)
})

test('an unpositioned later final invalidates the previous replay boundary', async () => {
  const finals=[], errors=[]
  const primary=engine(async cb=>cb.onStart())
  const asr=createAsrStartupFallback(primary,()=>assert.fail('would repeat a completed sentence'),{
    replayCursor: offset => ({captureId:'capture-fixture',sample:offset}),
  })
  const round=asr.createRound({onFinal:value=>finals.push(value.text),onError:error=>errors.push(error.message)})
  await asr.start(round)
  primary.callbacks.onFinal({text:'第一句',endSample:1600})
  primary.callbacks.onFinal({text:'第二句'})
  primary.callbacks.onError(Error('provider disconnected'))
  assert.deepEqual(finals,['第一句','第二句'])
  assert.deepEqual(errors,['provider disconnected'])
  await asr.stop(round)
})
