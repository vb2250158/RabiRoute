import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {appendMessageContextToDir,messageContextFromHistoryRecord} from './messageContextStore.js';
import {refreshMessageHistoryIndex,searchMessageHistoryIndexResult} from './messageHistorySearchIndex.js';
import {handleQqMessageRoutes,type QqMessageRoutesContext} from './manager/qqMessageRoutes.js';
import type {GatewayDefinition} from './shared/gatewayConfigModel.js';

test('real index refresh and query redact long CQ transport fields for both structured and legacy QQ records',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qq-fix-review-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const directory=path.join(root,'role'),index=path.join(root,'search.sqlite');
  const raw=`before [CQ:image,file=${'resource-key-'.repeat(30)},url=https://private.invalid/private-token] after`;
  const now=Math.floor(Date.now()/1000);
  const create=(groupId:string)=>messageContextFromHistoryRecord('group',{
    time:now,groupId,userId:'67890',senderName:'Display name',gatewayId:'review-route',instanceId:'one',
    messageId:groupId,rawMessage:raw,originalRawMessage:raw,
  })!;
  const structured=create('12345'),legacy=create('12346');delete legacy.qqParts;delete legacy.qqSenderId;
  const literal=messageContextFromHistoryRecord('group',{
    time:now,groupId:'12347',userId:'67890',gatewayId:'review-route',instanceId:'one',messageId:'12347',
    rawMessage:'[CQ:image,file=typed-text]',segments:[{type:'text',data:{text:'[CQ:image,file=typed-text]'}}],
  })!;
  for(const record of [structured,legacy,literal])appendMessageContextToDir(directory,record,{archiveCheck:false});
  assert.equal(refreshMessageHistoryIndex(directory,index).records,3);
  const result=searchMessageHistoryIndexResult(directory,{limit:10,includeArchives:true,adapter:'napcat',page:{catalogOnly:true,conversations:true}},index);
  const conversations=result.page?.conversations??[];
  assert.equal(conversations.length,3);
  for(const target of ['12345','12346']){
    const row=conversations.find(row=>row.target===target)!;
    assert.equal(row.preview,'before [图片] after');
    assert.equal(row.previewFormat,'plain');
    assert.doesNotMatch(row.preview,/resource-key|private|https|CQ:/);
  }
  assert.equal(conversations.find(row=>row.target==='12347')?.preview,'[CQ:image,file=typed-text]');
  const entries=searchMessageHistoryIndexResult(directory,{limit:10,includeArchives:true,adapter:'napcat'},index).entries;
  const stored=entries.find(row=>row.target==='12345')!;
  assert.equal(stored.text,raw);
  assert.equal(stored.qqSenderId,'67890');
  assert.deepEqual(stored.qqParts,structured.qqParts);
  assert.equal(entries.find(row=>row.target==='12346')?.text,raw);
});

const reviewSecret=randomUUID();
const definition={id:'review-route',enabled:true,messageAdapters:['napcat'],
  napcatInstances:[{id:'one',enabled:true,httpUrl:'http://127.0.0.1:12345',accessToken:reviewSecret}]} as GatewayDefinition;
const envelope=(data:unknown)=>Response.json({status:'ok',retcode:0,data});

async function withQqRoute(transport:typeof fetch,read:(base:string)=>Promise<void>){
  const context:QqMessageRoutesContext={local:()=>true,route:()=>definition,transport,
    json:(response,status,body)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));}};
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url!,'http://127.0.0.1');
    if(!handleQqMessageRoutes(request,url,response,context,operation=>operation))response.writeHead(404).end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await read(`http://127.0.0.1:${(server.address() as {port:number}).port}`);}
  finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

test('QQ API keeps actionable configured-limit details and masks arbitrary upstream error text',async()=>{
  const previous=process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES;
  process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES='8';
  try{
    const endpoint='/api/agent/qq/messages/123/attachments/0?routeId=review-route&kind=group&target=456';
    await withQqRoute(async url=>String(url).endsWith('/get_msg')?envelope({
      message_id:123,message_type:'group',group_id:'456',user_id:'789',
      message:[{type:'image',data:{file:'resource-key',url:'https://private.invalid/private-token'}}],
    }):envelope({file_size:9}),async base=>{
      const response=await fetch(base+endpoint),body=await response.json();
      assert.equal(response.status,413);
      assert.equal(body.errorCode,'QQ_MEDIA_TOO_LARGE');
      assert.match(body.message,/RABIROUTE_QQ_MEDIA_MAX_BYTES/);
      assert.match(body.message,/8 bytes/);
      assert.doesNotMatch(JSON.stringify(body),/private-token|private\.invalid|resource-key/);
      assert.equal(JSON.stringify(body).includes(reviewSecret),false);
    });
    await withQqRoute(async()=>{throw new Error(`https://private.invalid/private-token ${reviewSecret}`);},async base=>{
      const response=await fetch(base+endpoint),body=await response.json();
      assert.equal(response.status,503);
      assert.equal(body.errorCode,'QQ_UPSTREAM_UNAVAILABLE');
      assert.doesNotMatch(JSON.stringify(body),/private-token|private\.invalid/);
      assert.equal(JSON.stringify(body).includes(reviewSecret),false);
    });
  }finally{if(previous===undefined)delete process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES;else process.env.RABIROUTE_QQ_MEDIA_MAX_BYTES=previous;}
});
