import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readQqSettings } from "./qqReadSettings.js";

test("QQ quotas are optional, resource scheduling settings remain explicit and malformed settings fail visibly", () => {
  const defaults = readQqSettings({});
  assert.equal(defaults.mediaBytes, bufferConstants.MAX_LENGTH);
  assert.equal(defaults.jsonBytes, bufferConstants.MAX_LENGTH);
  assert.equal(readQqSettings({ RABIROUTE_QQ_JSON_MAX_BYTES: "123" }).jsonBytes, 123);
  assert.equal(defaults.previewBytes, bufferConstants.MAX_LENGTH);
  assert.equal(defaults.readConcurrency, 2);
  const configured = readQqSettings({ RABIROUTE_QQ_MEDIA_MAX_BYTES: "16", RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES: "32",
    RABIROUTE_QQ_READ_TIMEOUT_MS: "12000", RABIROUTE_QQ_MEDIA_TIMEOUT_MS: "90000", RABIROUTE_QQ_READ_CONCURRENCY: "3" });
  assert.equal(configured.mediaBytes, 16); assert.equal(configured.previewBytes, 32);
  assert.equal(configured.mediaTimeoutMs, 90000); assert.equal(configured.readTimeoutMs, 12000); assert.equal(configured.readConcurrency, 3);
  assert.equal(readQqSettings({ RABIROUTE_QQ_MEDIA_MAX_BYTES: "0" }).mediaBytes, defaults.mediaBytes);
  for (const value of ["-1", "NaN", "1.5"]) assert.throws(() => readQqSettings({ RABIROUTE_QQ_MEDIA_MAX_BYTES: value }), /RABIROUTE_QQ_MEDIA_MAX_BYTES/);
});

test("explicit attachment quota rejects streamed bytes and removing it restores the same read", () => {
  const program = `
    import assert from 'node:assert/strict';
    import { readQqMedia } from './src/manager/qqMessageMedia.ts';
    let calls=0;
    const result=readQqMedia({httpUrl:'http://localhost:1234',accessToken:''},{kind:'video',name:'video',file:'id'},AbortSignal.timeout(1000),async()=>++calls===1?Response.json({status:'ok',retcode:0,data:{url:'https://cdn.example/video'}}):new Response('sixteen bytes!!!'));
    if(process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES==='4') await assert.rejects(result,/RABIROUTE_QQ_MEDIA_MAX_BYTES/);
    else assert.equal((await result).toString(),'sixteen bytes!!!');
  `;
  for (const value of ["4", "0"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
      cwd: process.cwd(), env: { ...process.env, RABIROUTE_QQ_MEDIA_MAX_BYTES: value }, encoding: "utf8", windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("preview byte quota and deadline expose the configured cause; clearing quota restores the preview", () => {
  const program = `
    import assert from 'node:assert/strict';
    import {createQqStickerOperations} from './src/manager/qqStickerRoutes.ts';
    const id='0123456789abcdef0123456789abcdef';
    const definition={id:'test',enabled:true,messageAdapters:['napcat'],napcatInstances:[{id:'selected',enabled:true,httpUrl:'http://localhost:1234'}]};
    const [list,preview]=createQqStickerOperations({local:()=>true,route:()=>definition,json:()=>{},transport:async(url,init)=>{
      if(String(url).includes('fetch_custom_face'))return Response.json({status:'ok',retcode:0,data:[{md5:id,url:'https://cdn.example/image'}]});
      if(process.env.RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS==='5')return new Promise((resolve,reject)=>{const timer=setTimeout(()=>resolve(new Response('late')),100);init.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(init.signal.reason)},{once:true});});
      return new Response('fixture image',{headers:{'content-type':'image/png'}});
    }});
    const result=await preview.handler({request:{method:'GET',headers:{},socket:{}},url:new URL('http://localhost/api/agent/qq/stickers/'+id+'/preview?routeId=test'),path:{stickerId:id}});
    if(process.env.RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES==='4'){assert.equal(result.status,503);assert.match(result.body.message,/RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES/);}
    else if(process.env.RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS==='5'){assert.equal(result.status,503);assert.match(result.body.message,/RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS=5/);}
    else{assert.equal(result.status,200);assert.equal(result.body.toString(),'fixture image');}
  `;
  for (const overrides of [{ RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES: "4" }, { RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES: "0" },
    { RABIROUTE_QQ_STICKER_PREVIEW_MAX_BYTES: "0", RABIROUTE_QQ_STICKER_PREVIEW_TIMEOUT_MS: "5" }]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
      cwd: process.cwd(), env: { ...process.env, ...overrides }, encoding: "utf8", windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
  }
});


test("upstream JSON quota defaults to no hidden 1 MiB cap and explicit quota reports its setting", () => {
  const program = [
    "import assert from 'node:assert/strict';",
    "import {readNapCatStickers} from './src/napcatStickers.ts';",
    "const desc='x'.repeat(1100000);",
    "const result=readNapCatStickers({httpUrl:'http://localhost:1234'},1,async()=>Response.json({status:'ok',retcode:0,data:[{md5:'0123456789abcdef0123456789abcdef',url:'https://cdn.example/image',desc}]}));",
    "if(process.env.RABIROUTE_QQ_JSON_MAX_BYTES==='4')await assert.rejects(result,/RABIROUTE_QQ_JSON_MAX_BYTES/);else assert.equal((await result)[0].description.length,desc.length);"
  ].join('\n');
  for (const value of ["4", "0"]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", program], {
      cwd: process.cwd(), env: { ...process.env, RABIROUTE_QQ_JSON_MAX_BYTES: value }, encoding: "utf8", windowsHide: true, timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr);
  }
});
