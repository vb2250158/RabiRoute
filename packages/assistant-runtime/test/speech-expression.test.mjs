import test from 'node:test';import assert from 'node:assert/strict';
import {createSpeechExpressionDecoder,normalizeSpeechExpression} from '../src/speech-expression.js';
const policy={enabled:true,fields:[{id:'style',label:'风格',type:'text',maxLength:512},{id:'rate',label:'速度',type:'number',min:.75,max:1.4},{id:'emotion',label:'情绪',type:'enum',values:['happy','sad']}]};
test('chunked expression metadata is separated before prose streams and unsupported fields cannot escape',()=>{
 const decoder=createSpeechExpressionDecoder(policy);let text='';let expression;
 for(const chunk of ['<vo','ice style="温柔 &quot;自然&quot;" rate="1.2" emotion="happy" voice="other"/>','\n你','好。']){const value=decoder.push(chunk);text+=value.delta;expression=value.expression||expression}
 assert.equal(text,'你好。');assert.equal(decoder.finish().text,'你好。');assert.deepEqual(expression,{style:'温柔 "自然"',rate:1.2,emotion:'happy'});
});
test('plain prose has no whole-response buffering, and disabled expression never leaks a stale control header',()=>{
 const plain=createSpeechExpressionDecoder(policy);assert.equal(plain.push('你好').delta,'你好');assert.equal(plain.push('呀').delta,'呀');
 const disabled=createSpeechExpressionDecoder({enabled:false,fields:policy.fields});assert.deepEqual(disabled.push('<voice style="旧语气"/>正文').expression,{});assert.equal(disabled.finish().text,'正文');
 assert.deepEqual(normalizeSpeechExpression({rate:100,emotion:'unknown',endpoint:'https://other.test'},policy),{});
 assert.deepEqual(normalizeSpeechExpression({rate:'',emotion:123},policy),{});
});
test('malformed or truncated control headers are hidden and never become spoken text',()=>{
 const malformed=createSpeechExpressionDecoder(policy);const value=malformed.push('<voice style=invalid/>正文');assert.equal(value.delta,'正文');assert.equal(value.warning,'SPEECH_EXPRESSION_HEADER_INVALID');
 const partial=createSpeechExpressionDecoder(policy);partial.push('<voice style="未结束');assert.equal(partial.finish().text,'');assert.equal(partial.getState().warning,'SPEECH_EXPRESSION_HEADER_INVALID');
 const prefix=createSpeechExpressionDecoder(policy);prefix.push('<vo');assert.equal(prefix.finish().text,'');
});
