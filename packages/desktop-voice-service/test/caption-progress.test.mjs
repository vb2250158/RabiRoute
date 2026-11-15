import test from 'node:test';import assert from 'node:assert/strict';
import {createPlaybackCueTracker} from '../src/playback-cues.mjs';import {createTextTimingMapper} from '../src/speech-timing.mjs';import {projectCaptionText,projectCaptionPlayback} from '../src/caption-progress.mjs';
import {openVolcanoTts} from '../src/volcano-tts.mjs';import {decodeFrame} from '../src/volcano-codec.mjs';
import {openOpenAiTts} from '../src/openai-tts.mjs';
test('word timing maps repeated sentences in submitted text and rejects guessed or invalid alignment',()=>{
 const map=createTextTimingMapper(()=>'你好。你好。3个苹果。');
 assert.deepEqual(map({words:[{word:'你好。',startTime:0,endTime:1}]}).map(v=>v.charIndex),[0]);
 assert.deepEqual(map({words:[{word:'你好。',startTime:1,endTime:2}]}).map(v=>v.charIndex),[3]);
 assert.deepEqual(map({words:[{word:'三',startTime:2,endTime:3},{word:'苹果。',startTime:3,endTime:4}]}).map(v=>v.charIndex),[8]);
 assert.deepEqual(map({words:[{word:'。',startTime:NaN,endTime:1}]}),[]);
});
test('synthesis cues wait for actual playback; late metadata catches up but cancelled audio never advances',()=>{
 const seen=[],tracker=createPlaybackCueTracker(cue=>seen.push(cue));
 tracker.add([{charIndex:0,charLength:1,startTime:0,endTime:.2,mode:'word'},{charIndex:1,charLength:1,startTime:.5,endTime:.7,mode:'word'}]);assert.equal(seen.length,0);
 tracker.advance(.1);assert.equal(seen.length,1);tracker.advance(.2);assert.equal(seen.length,1);
 tracker.advance(.6);assert.equal(seen.length,2);
 tracker.add([{charIndex:2,charLength:1,startTime:.55,endTime:.8,mode:'word'}]);assert.equal(seen.length,3);
 tracker.advance(.3);assert.equal(seen.length,3);tracker.dispose();tracker.add([{charIndex:3,charLength:1,startTime:.7,endTime:1,mode:'word'}]);tracker.advance(2);assert.equal(seen.length,3);
});
test('response-scoped captions retain stopped highlights when model text continues and ignore stale cues',()=>{
 let p=projectCaptionText({}, {responseId:'a',text:'你好，世界。'});
 p=projectCaptionPlayback(p,{type:'cue',responseId:'a',cue:{charIndex:0,charLength:2,mode:'word'}});assert.equal(p.spokenEnd,2);
 p=projectCaptionPlayback(p,{type:'cancelled',responseId:'a'});p=projectCaptionText(p,{responseId:'a',text:'你好，世界。文字继续。'});assert.equal(p.spokenEnd,2);
 assert.equal(projectCaptionPlayback(p,{type:'cue',responseId:'a',cue:{charIndex:2,charLength:2,mode:'word'}}),p);
 p=projectCaptionText(p,{responseId:'b',text:'下一轮。'});assert.equal(p.spokenEnd,0);assert.equal(p.timingMode,null);
 assert.equal(projectCaptionPlayback(p,{type:'cue',responseId:'a',cue:{charIndex:0,charLength:2,mode:'word'}}),p);
});

test('post-tool audio resumes the same message and late events from the opening segment cannot stop its highlighting',()=>{
 let p=projectCaptionText({},{responseId:'reply',text:'先查。查到了。'});
 p=projectCaptionPlayback(p,{type:'synthesizing',responseId:'reply',id:1});p=projectCaptionPlayback(p,{type:'cue',responseId:'reply',id:1,cue:{charIndex:0,charLength:3,mode:'word'}});p=projectCaptionPlayback(p,{type:'ended',responseId:'reply',id:1});assert.equal(p.spokenEnd,3);
 p=projectCaptionPlayback(p,{type:'synthesizing',responseId:'reply',id:2});p=projectCaptionPlayback(p,{type:'cue',responseId:'reply',id:2,cue:{charIndex:3,charLength:1,mode:'word'}});assert.equal(p.spokenEnd,4);
 const current=p;assert.equal(projectCaptionPlayback(p,{type:'ended',responseId:'reply',id:1}),current);assert.equal(projectCaptionPlayback(p,{type:'cue',responseId:'reply',id:1,cue:{charIndex:5,charLength:1,mode:'word'}}),current);
});
const integer=value=>{const b=Buffer.alloc(4);b.writeInt32BE(value);return b};
const response=(event,id,data)=>{const bytes=Buffer.from(JSON.stringify(data));return Buffer.concat([Buffer.from([0x11,0x94,0x10,0]),integer(event),integer(Buffer.byteLength(id)),Buffer.from(id),integer(bytes.length),bytes])};
test('Volcano subtitle event is timing metadata and never itself a played cue',async()=>{
 let receive,session;const cues=[];
 const stream=await openVolcanoTts({voice:'fixture',onAudio(){},onTiming:values=>cues.push(...values),connect:async({onMessage})=>{receive=onMessage;return{close:async()=>{},send:async bytes=>{const frame=decodeFrame(bytes,{tts:true});if(frame.event===100)session=frame.id;const expected=({1:50,100:150,101:151,2:52})[frame.event];if(expected)queueMicrotask(()=>receive(response(expected,frame.id||'connection',{})))}}}});
 await stream.append('你好。');await receive(response(364,session,{text:'你好。',words:[{word:'你',startTime:0,endTime:.2},{word:'好。',startTime:.2,endTime:.8}]}));
 assert.equal(cues.length,2);assert.deepEqual(cues.map(v=>v.charIndex),[0,1]);await stream.close();
});
test('OpenAI reports sentence ranges from real PCM duration without inventing word times',async()=>{
 const cues=[];const stream=openOpenAiTts({endpoint:'https://example.test',model:'fixture',voice:'voice',onAudio(){},onTiming:values=>cues.push(...values),fetcher:async()=>new Response(new Uint8Array(4800))});
 await stream.append('你好。 你好。');await stream.finish();await stream.finished;
 assert.deepEqual(cues.map(c=>[c.charIndex,c.charLength,c.mode]),[[0,3,'sentence'],[4,3,'sentence']]);assert.equal(cues[0].endTime,.1);assert.equal(cues[1].startTime,.1);await stream.close();
});
