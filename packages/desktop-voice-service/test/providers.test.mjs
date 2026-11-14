import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createHttpSpeechProviders} from '../src/providers.mjs'
const wave=()=>{const bytes=Buffer.alloc(46);bytes.write('RIFF',0);bytes.write('WAVE',8);return bytes}
test('TTS-only adapter posts a fixed WAV request and refuses credential redirects',async()=>{
  const requests=[]
  const server=createServer((request,response)=>{
    requests.push({url:request.url,authorization:request.headers.authorization})
    if(request.url==='/redirect'){response.writeHead(302,{location:'/destination'});response.end();return}
    let body='';request.on('data',part=>{body+=part});request.on('end',()=>{requests.at(-1).body=JSON.parse(body);response.end(wave())})
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url='http://127.0.0.1:'+server.address().port
  try{
    const provider=endpoint=>createHttpSpeechProviders({tts:{endpoint,model:'fixture',voice:'fixture',credentialRef:'owned'},resolveCredential:async()=> 'fixture-not-a-secret'})
    assert.equal((await provider(url+'/speech').synthesize('hello',new AbortController().signal)).length,46)
    assert.deepEqual(requests[0].body,{model:'fixture',voice:'fixture',input:'hello',response_format:'wav'})
    await assert.rejects(provider(url+'/redirect').synthesize('hello',new AbortController().signal))
    assert.equal(requests.some(request=>request.url==='/destination'),false)
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
test('unsupported protocols, external plaintext and non-WAV playback fail explicitly',async()=>{
  const make=endpoint=>createHttpSpeechProviders({tts:{endpoint,model:'fixture',voice:'fixture'},resolveCredential:async()=>undefined,fetcher:async()=>new Response('not wave')})
  assert.throws(()=>make('file:///speech'),/ENDPOINT_INVALID/)
  assert.throws(()=>make('http://speech.example/tts'),/TLS/)
  await assert.rejects(make('https://speech.example/tts').synthesize('hello',new AbortController().signal),/WAV_REQUIRED/)
})
