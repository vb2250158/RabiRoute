import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readQqMedia} from './qqMessageMedia.js';
const bytes=Buffer.from([0xff,0xd8,0xff,0xe1,1,2,3,4]);
const endpoint={httpUrl:'http://127.0.0.1:12345',accessToken:randomUUID()};
const envelope=(data:unknown)=>Response.json({status:'ok',retcode:0,data});

test('native image URL-only resources skip metadata resolution and never carry the OneBot token',async()=>{
 const urls:string[]=[];const signal=new AbortController().signal;
 const result=await readQqMedia(endpoint,{kind:'image',name:'image.jpg',url:'https://media.example/selected-image'},signal,async(url,options)=>{
  urls.push(String(url));assert.equal(options?.signal,signal);assert.equal(new Headers(options?.headers).get('authorization'),null);return new Response(bytes);
 });
 assert.deepEqual(urls,['https://media.example/selected-image']);assert.deepEqual(result,bytes);
});

test('native image URL redirects remain credential-free with no resolver round trip',async t=>{
 const requests:string[]=[];const server=http.createServer((request,response)=>{
  requests.push(request.url!);assert.equal(request.headers.authorization,undefined);
  if(request.url==='/redirect'){response.writeHead(302,{location:'/image'}).end();}else response.writeHead(200).end(bytes);
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
 const native=`http://127.0.0.1:${(server.address() as {port:number}).port}/redirect`;
 const result=await readQqMedia(endpoint,{kind:'image',name:'image.jpg',file:'selected-image-reference',url:native},AbortSignal.timeout(3000));
 assert.deepEqual(result,bytes);assert.deepEqual(requests,['/redirect','/image']);
});

test('images missing native URLs use get_image file semantics and preserve resolved URL/local-file reads',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'rabi-image-media-'));assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const local=path.join(directory,'image.jpg');await fs.writeFile(local,bytes);
 for(const result of [{url:'https://media.example/resolved-image'},{file:local,file_size:bytes.length}]){
  const calls:string[]=[];
  const value=await readQqMedia(endpoint,{kind:'image',name:'image.jpg',file:'selected-image-reference'},AbortSignal.timeout(1000),async(url,options)=>{
   calls.push(String(url));if(calls.length===1){assert.equal(String(url),endpoint.httpUrl+'/get_image');assert.deepEqual(JSON.parse(String(options?.body)),{file:'selected-image-reference'});assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+endpoint.accessToken);return envelope(result);}
   assert.equal(String(url),'https://media.example/resolved-image');assert.equal(new Headers(options?.headers).get('authorization'),null);return new Response(bytes);
  });assert.deepEqual(value,bytes);assert.equal(calls.some(url=>url.endsWith('/get_file')),false);
 }
});

test('video, voice and files keep get_file instead of silently changing their resolver',async()=>{
 for(const kind of ['video','record','file']){
  const calls:string[]=[];const value=await readQqMedia(endpoint,{kind,name:'media',file:'selected-file-reference'},AbortSignal.timeout(1000),async(url,options)=>{
   calls.push(String(url));if(calls.length===1){assert.equal(String(url),endpoint.httpUrl+'/get_file');assert.deepEqual(JSON.parse(String(options?.body)),{file_id:'selected-file-reference'});return envelope({url:'https://media.example/resolved-file'});}return new Response(bytes);
  });assert.deepEqual(value,bytes);assert.equal(calls.length,2);
 }
});

test('native image URLs still reject unsafe schemes/userinfo and surface empty or failing reads without resolver retries',async()=>{
 for(const url of ['file:///private/image','https://user:password@media.example/image']){
  let calls=0;await assert.rejects(readQqMedia(endpoint,{kind:'image',name:'image',url},new AbortController().signal,async()=>{calls++;return new Response(bytes);}),/QQ_MEDIA_URL_UNSUPPORTED/);assert.equal(calls,0);
 }
 for(const response of [new Response(null,{status:404}),new Response(new Uint8Array())]){
  let calls=0;await assert.rejects(readQqMedia(endpoint,{kind:'image',name:'image',url:'https://media.example/image'},new AbortController().signal,async()=>{calls++;return response;}),/QQ_UPSTREAM_UNAVAILABLE|QQ_MEDIA_EMPTY/);assert.equal(calls,1);
 }
});

test('native images keep header/chunk byte limits and cancel their reader',async t=>{
 const before=process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES;process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES='4';t.after(()=>{if(before===undefined)delete process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES;else process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES=before;});
 for(const headers of [{'content-length':'8'},{}]){let cancelled=false;const body=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,3));controller.enqueue(bytes.subarray(3));},cancel(){cancelled=true;}});
  await assert.rejects(readQqMedia(endpoint,{kind:'image',name:'image',url:'https://media.example/image'},new AbortController().signal,async()=>new Response(body,{headers})),/QQ_RESPONSE_TOO_LARGE/);assert.equal(cancelled,true);
 }
});

test('native image body reads preserve the request AbortSignal',async()=>{
 const controller=new AbortController();let release!:()=>void;
 const pending=readQqMedia(endpoint,{kind:'image',name:'image',url:'https://media.example/image'},controller.signal,async(_url,options)=>{
  assert.equal(options?.signal,controller.signal);const body=new ReadableStream({start(reader){controller.signal.addEventListener('abort',()=>reader.error(controller.signal.reason),{once:true});release=()=>controller.abort();}});return new Response(body);
 });await new Promise(resolve=>setImmediate(resolve));release();await assert.rejects(pending,/AbortError|aborted/);
});
