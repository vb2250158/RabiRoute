import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {VideoError} from './service.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stableId=value=>{const hex=hash(value).slice(0,32);return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20);};
/** Scheduled and event callers use this same durable, idempotent entry; scheduling stays with the existing automation owner. */
export async function triggerWorkbench(runs,projectId,templateId,body,access) {
 access?.beforeMutation();runs.projects.id(body?.id);
 const date=body.date;if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new VideoError('触发需要有效期次日期。');
 const intent=hash({projectId,templateId,body}),file=path.join(runs.root,'triggers',body.id+'.json');
 return runs.projects.locked('trigger:'+body.id,access,async()=>{
  let record;try{record=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(record&&record.intent!==intent)throw new VideoError('触发身份已用于不同参数。',409);
  const canvasId=stableId({projectId,templateId,date});
  if(!record){record={id:body.id,intent,projectId,templateId,canvasId,date,phase:'prepared'};await runs.atomic(file,record);}
  if(record.phase==='accepted')return {trigger:record,run:await runs.read(record.runId)};
  const copied=await runs.projects.copyCanvas(projectId,{id:canvasId,requestId:canvasId,sourceCanvasId:templateId,name:date+' '+(body.label||'工作流')},access);
  if(!copied.variables.some(row=>row.name==='date'&&row.value===date)) {
   copied.variables=[...copied.variables.filter(row=>row.name!=='date'),{name:'date',type:'date',value:date}];
   await runs.projects.saveCanvas(projectId,canvasId,copied,access);
  }
  const canvas=await runs.projects.readCanvas(projectId,canvasId,access),runId=stableId({triggerId:body.id});
  const until=body.untilSourceNodeId?canvas.graph.nodes.find(node=>node.config.importedNodeId===body.untilSourceNodeId)?.id:undefined;
  if(body.untilSourceNodeId&&!until)throw new VideoError('触发边界节点不存在。',400);
  const run=await runs.start(projectId,canvasId,{id:runId,revision:canvas.revision,...(until?{untilNodeId:until}:{}),...(body.resumeRunId?{resumeRunId:body.resumeRunId}:{}),...(body.concurrency?{concurrency:body.concurrency}:{})},access);
  record={...record,phase:'accepted',runId,acceptedAt:new Date().toISOString()};await runs.atomic(file,record);return {trigger:record,run};
 });
}
