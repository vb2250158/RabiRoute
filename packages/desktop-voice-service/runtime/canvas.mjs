import {paintVisualCanvas} from '../../assistant-runtime/src/visual-canvas.js';
let document;
const canvas=globalThis.document.getElementById('drawing');
const render=()=>{if(document)paintVisualCanvas(canvas.getContext('2d'),document)};
window.audioDevice.onCommand(message=>{
 if(message.method!=='canvas')return;
 document=message.params.document;
 globalThis.document.getElementById('title').textContent=document?.title||'助手图表';
 globalThis.document.getElementById('dock').textContent=message.params.docked?'取消吸附':'吸附字幕';
 globalThis.document.body.dataset.docked=String(message.params.docked);
 globalThis.document.getElementById('description').textContent=document?.description||'';
 try{render()}catch{globalThis.document.getElementById('description').textContent='图表绘制失败，请查看助手执行详情。'}
});
for(const button of globalThis.document.querySelectorAll('[data-action]'))button.addEventListener('click',()=>window.audioDevice.send({action:button.dataset.action}));
