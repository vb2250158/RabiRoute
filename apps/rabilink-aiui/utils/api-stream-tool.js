import { requestManagerStream, openManagerWebSocket } from './rabilink-api.js';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function encodeToolBytes(input){const bytes=new Uint8Array(input);let result='';for(let i=0;i<bytes.length;i+=3){const value=(bytes[i]<<16)|((bytes[i+1]||0)<<8)|(bytes[i+2]||0);result+=alphabet[(value>>>18)&63]+alphabet[(value>>>12)&63]+(i+1<bytes.length?alphabet[(value>>>6)&63]:'=')+(i+2<bytes.length?alphabet[value&63]:'=');}return result;}
export function decodeToolBytes(value){if(typeof value!=='string'||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('TOOL_BINARY_INVALID');const result=[];for(let i=0;i<value.length;i+=4){const number=(alphabet.indexOf(value[i])<<18)|(alphabet.indexOf(value[i+1])<<12)|((alphabet.indexOf(value[i+2])&63)<<6)|(alphabet.indexOf(value[i+3])&63);result.push((number>>>16)&255);if(value[i+2]!=='=')result.push((number>>>8)&255);if(value[i+3]!=='=')result.push(number&255);}return new Uint8Array(result);}
export async function callApiStreamTool(config,packet,current=()=>true){
  const {targetDeviceId,mode,maxBytes,maxMessages,maxMs,messages,protocols,...request}=packet;
  const mutation=(mode==='websocket'&&messages.length>0)||!['GET','HEAD','OPTIONS'].includes(request.method);
  if(mode==='stream'){
    if(typeof AbortController!=='function')throw Error('TOOL_STREAM_RUNTIME_UNAVAILABLE');const controller=new AbortController();const chunks=[];let total=0,head=null,limited=false;const timer=setTimeout(()=>{limited=true;controller.abort();},maxMs);
    const body=request.bodyBase64!==undefined?decodeToolBytes(request.bodyBase64):request.body!==undefined&&typeof request.body==='object'?JSON.stringify(request.body):request.body;
    try{await requestManagerStream(config,{targetDeviceId,request:{...request,body}},{signal:controller.signal,onHead:value=>{head=value;},onData:value=>{if(!current())throw Error('API_SCOPE_CHANGED');const bytes=new Uint8Array(value);const remaining=maxBytes-total;const slice=bytes.slice(0,remaining);chunks.push(encodeToolBytes(slice));total+=slice.length;if(total>=maxBytes){limited=true;controller.abort();}}});}catch(error){if(!limited)throw error;}finally{clearTimeout(timer);}
    return{structuredContent:{ok:Boolean(head&&head.statusCode>=200&&head.statusCode<300),uncertain:mutation&&limited,operationId:request.operationId,statusCode:head?.statusCode,headers:head?.headers,data:{mode:'stream',chunksBase64:chunks,bytes:total,complete:!limited,stopReason:limited?'observation_limit':'end'}}};
  }
  if(mode!=='websocket')throw Error('TOOL_MODE_INVALID');
  const socket=await openManagerWebSocket(config,{targetDeviceId,request,protocols});
  return new Promise((resolve,reject)=>{
    let settled=false,opened=false,total=0,stopReason='close';const received=[];
    const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);runCatchingClose();if(error){reject(error);return;}resolve({structuredContent:{ok:opened,uncertain:mutation,operationId:request.operationId,statusCode:opened?101:0,data:{mode:'websocket',messages:received,bytes:total,stopReason,businessReceiptConfirmed:false}}});};
    const runCatchingClose=()=>{try{socket.close();}catch{}};
    const timer=setTimeout(()=>{stopReason='observation_limit';finish();},maxMs);
    socket.onOpen(()=>{opened=true;if(!current())return finish(Error('API_SCOPE_CHANGED'));try{for(const message of messages){const data=typeof message==='string'?message:decodeToolBytes(message.bodyBase64).buffer;socket.send(data);}}catch{finish(Error('TOOL_WEBSOCKET_SEND_UNCONFIRMED'));}});
    socket.onMessage(event=>{if(!current())return finish(Error('API_SCOPE_CHANGED'));const value=event.data;const remaining=maxBytes-total;if(typeof value==='string'){const encoded=encodeURIComponent(value.slice(0,remaining));const bytes=[];for(let i=0;i<encoded.length;i++){if(encoded[i]==='%'){bytes.push(parseInt(encoded.slice(i+1,i+3),16));i+=2;}else bytes.push(encoded.charCodeAt(i));}const bounded=new Uint8Array(bytes).slice(0,remaining);total+=bounded.length;received.push(bytes.length<=remaining?{text:value}:{bodyBase64:encodeToolBytes(bounded)});}else{const bytes=new Uint8Array(value).slice(0,remaining);total+=bytes.length;received.push({bodyBase64:encodeToolBytes(bytes)});}if(total>=maxBytes||received.length>=maxMessages){stopReason='observation_limit';finish();}});
    socket.onError(()=>finish(Error('TOOL_WEBSOCKET_UNCONFIRMED')));socket.onClose(()=>finish());
  });
}
