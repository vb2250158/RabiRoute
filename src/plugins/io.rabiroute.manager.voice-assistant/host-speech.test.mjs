import test from 'node:test';import assert from 'node:assert/strict';
import {hostSpeechDefaultModel,hostSpeechExpressionPolicy,hostSpeechCommand,hostSpeechModelSummary} from './src/host-speech.mjs';

test('host defaults retain the configured ready model rather than the first catalog row',()=>{
 const models=[{id:'native/disabled',capability:'asr',enabled:false,available:true},{id:'native/tiny',capability:'asr',enabled:true,available:true},{id:'native/small',capability:'asr',enabled:true,available:true}];
 assert.equal(hostSpeechDefaultModel('asr',models,{defaults:{asr:'native'},providers:{asr:[{id:'native',model:'small'}]}}),'native/small');
 assert.equal(hostSpeechDefaultModel('asr',models,{}),'native/tiny');assert.equal(hostSpeechDefaultModel('tts',models,{}),undefined);
});
test('a persona preferred model wins only while installed and available',()=>{
 const onnx={id:'local-tts/onnx-vits',capability:'tts',enabled:true,available:true};
 const qwen={id:'local-tts/qwen',capability:'tts',enabled:true,available:false};
 const status={defaults:{tts:'local-tts'},providers:{tts:[{id:'local-tts',model:'onnx-vits'}]}};
 assert.equal(hostSpeechDefaultModel('tts',[onnx,qwen],status,qwen.id),onnx.id);
 assert.equal(hostSpeechDefaultModel('tts',[onnx,{...qwen,available:true}],status,qwen.id),qwen.id);
 assert.equal(hostSpeechDefaultModel('tts',[{...qwen,available:true,enabled:false}],status,qwen.id),undefined);
});
test('native expression maps only actual Manager-supported model fields and preserves persona voice without local playback',()=>{
 const model={id:'native',features:['instructions','emotion_vector'],request:{properties:{speed:{minimum:.5,maximum:2},instructions:{type:'string'},emotion_vector:{type:'array'}}}};
 const policy=hostSpeechExpressionPolicy(model,{ttsDynamicExpression:true});assert.deepEqual(policy.fields.map(x=>x.id),['style','rate']);assert.equal(policy.enabled,true);
 const command=hostSpeechCommand({model,persona:{id:'persona',speed:1.2,instructions:'default'},text:'hello',expression:{style:'calm',rate:1.25,emotion_vector:[1]},sessionId:'session'});
 assert.equal(command.voice,'persona');assert.equal(command.play,false);assert.equal(command.speed,1.5);assert.equal(command.instructions,'calm');assert.equal(command.emotion_vector,undefined);
 assert.equal(hostSpeechExpressionPolicy({id:'unknown'},{ttsDynamicExpression:true}).enabled,false);assert.equal(hostSpeechModelSummary(model).requestFields.length,3);
});

test('a generic instructions field does not advertise expression ignored by a fixed-speaker model',()=>{
 const properties={speed:{minimum:.25,maximum:4},instructions:{type:'string'}};
 const model={id:'local-tts/onnx-vits',features:['fixed_speakers','low_latency'],request:{properties}};
 assert.deepEqual(hostSpeechExpressionPolicy(model,{ttsDynamicExpression:true}).fields.map(field=>field.id),['rate']);
 const command=hostSpeechCommand({model,persona:{id:'Ilias',speed:1.1,instructions:'persona style'},text:'hello',expression:{style:'happy',rate:1.2}});
 assert.equal(command.instructions,null);assert.equal(command.speed,1.32);
 assert.equal(hostSpeechExpressionPolicy({request:{properties:{instructions:{}}}},{ttsDynamicExpression:true}).enabled,false);
});

test('an adapted emotion-control model accepts style instructions while retaining persona defaults',()=>{
 const model={id:'local-tts/indextts2',features:['emotion_control'],request:{properties:{instructions:{type:'string'}}}};
 assert.deepEqual(hostSpeechExpressionPolicy(model,{ttsDynamicExpression:true}).fields.map(field=>field.id),['style']);
 assert.equal(hostSpeechCommand({model,persona:{id:'Ilias',instructions:'calm'},text:'hello'}).instructions,'calm');
 assert.equal(hostSpeechCommand({model,persona:{id:'Ilias',instructions:'calm'},text:'hello',expression:{style:'happy'}}).instructions,'happy');
});
