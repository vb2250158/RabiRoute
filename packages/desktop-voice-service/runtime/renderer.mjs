import {encodeWave,audioBase64} from './recording.ts'
import {createCaptureRegistry} from './capture.mjs'
import {createStreamPlayers} from './stream-players.mjs'
const players=new Map()
const send=value=>window.audioDevice.send(value)
const MAX_BYTES=16*1024*1024
const capture=createCaptureRegistry({mediaDevices:navigator.mediaDevices,AudioContext,AudioWorkletNode,send})
const streams=createStreamPlayers({AudioContext,send})
function releasePlayer(id){
  const item=players.get(id);if(!item)return
  players.delete(id);item.audio.pause();item.audio.removeAttribute('src');item.audio.load();URL.revokeObjectURL(item.url)
}
async function command(method,p){
  if(method==='devices.list')return (await navigator.mediaDevices.enumerateDevices()).filter(d=>['audioinput','audiooutput'].includes(d.kind)).map(d=>({id:d.deviceId,kind:d.kind,label:d.label}))
  if(typeof p?.id!=='string'||p.id.length>128)throw Error('DEVICE_ID_INVALID')
  if(method==='record.start')return capture.start(p)
  if(method==='record.mark'){capture.mark(p.id);return true}
  if(method==='record.take')return {audio:audioBase64(encodeWave(capture.take(p.id)))}
  if(method==='record.dispose'){await capture.release(p.id);return true}
  if(method==='player.stream.create'){await streams.create(p);return true}
  if(method==='player.stream.append'){
    if(typeof p.audio!=='string'||p.audio.length>350000)throw Error('DEVICE_PCM_INVALID')
    streams.append(p.id,Uint8Array.from(atob(p.audio),c=>c.charCodeAt(0)));return true
  }
  if(method==='player.stream.finish'){streams.finish(p.id);return true}
  if(streams.has(p.id)){
    if(method==='player.play'){await streams.play(p.id);return true}
    if(method==='player.stop'){streams.stop(p.id);return true}
    if(method==='player.dispose'){await streams.dispose(p.id);return true}
  }
  if(method==='player.create'){
    if(players.size>=4||typeof p.audio!=='string'||p.audio.length>Math.ceil(MAX_BYTES/3)*4)throw Error('DEVICE_AUDIO_LIMIT')
    const bytes=Uint8Array.from(atob(p.audio),c=>c.charCodeAt(0))
    const url=URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})),audio=new Audio(url)
    try{if(p.outputDeviceId)await audio.setSinkId(p.outputDeviceId)}catch(error){URL.revokeObjectURL(url);throw error}
    audio.onended=()=>send({event:'player.ended',id:p.id});audio.onerror=()=>send({event:'player.error',id:p.id})
    players.set(p.id,{audio,url});return true
  }
  if(method==='player.play'){const item=players.get(p.id);if(!item)throw Error('DEVICE_PLAYER_MISSING');await item.audio.play();return true}
  if(method==='player.stop'){players.get(p.id)?.audio.pause();return true}
  if(method==='player.dispose'){releasePlayer(p.id);return true}
  throw Error('DEVICE_METHOD_INVALID')
}
window.audioDevice.onCommand(async request=>{
  try{send({id:request.id,ok:true,value:await command(request.method,request.params)})}
  catch(error){send({id:request.id,ok:false,error:error instanceof Error?error.message:'DEVICE_ERROR'})}
})
send({event:'ready'})
