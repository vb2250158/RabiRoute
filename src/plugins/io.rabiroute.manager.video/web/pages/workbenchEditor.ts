// Presentation geometry and form metadata. Persistence and DAG rules stay with the original owner.
// @ts-ignore Shared pure graph contract, also used by the storage/run owners.
import { validateGraph, resolveLinkedText } from "../../workbenchGraph.mjs";
import type { NodeLayout } from "./useVideoCanvas";
export type Point = { x:number; y:number };
export type TextPreview = { attemptId:string; text:string };
export type FlowNode = { id:string; kind:string; title?:string; enabled?:boolean; gate?:boolean; optional?:boolean; config:Record<string,any>; textPreview?:TextPreview; layout?:NodeLayout; inputs?:any[]; requirements?:any[]; [key:string]:unknown };
export type FlowEdge = { id:string; from:string; to:string; fromPort:string; toPort:string; condition:string; allowSkip?:boolean };
export type FlowGroup = { id:string; name?:string; nodeIds:string[]; kind?:string; [key:string]:unknown };
export type FlowGraph = { nodes:FlowNode[]; edges:FlowEdge[]; groups:FlowGroup[] };
export type MediaLink = { from: string; to: string };
export type WorkflowInputLink = MediaLink & { sourceTitle: string; artifactKeys: string[] };
export type WorkbenchCanvas = { mediaLinks?: MediaLink[]; version:number; id:string; name:string; revision:number; workspaceBindingKey:string; variables:unknown[]; graph:FlowGraph; [key:string]:unknown };
export type WorkbenchDefinition = { capabilities:Record<string,{label:string;ports:{in:string[];out:string[]}}>; edgeConditions:string[]; nodeStates:Record<string,{label:string}>; runStates?:Record<string,{label:string}>; [key:string]:unknown };
export function initialFlowNodeConfig(kind: string): Record<string, unknown> {
  switch (kind) {
    case "command": return { toolKey: "", argv: [] };
    case "agent": return { textPrompt: "", textOutput: true };
    case "generate": return { command: {} };
    case "asset": return { mediaKind: "text", ref: { root: "canvas", path: "" } };
    default: return {};
  }
}
export type CanvasPreview = { kind?: "image" | "video"; assetId?: string; jobId?: string };
export type CanvasCover = { kind: "image" | "video"; url: string };
export type CanvasSummary = { id: string; name: string; revision: number; nodeCount: number; preview?: CanvasPreview };

export const NODE_WIDTH=320, NODE_HEIGHT=144, LIST_LIMIT=300;
export const linkedText: (cards: readonly { id:string; kind:string; text:string; generated?:boolean }[], links: readonly MediaLink[], target:string) => string = resolveLinkedText;
export function workflowInputLinks(nodes: readonly FlowNode[]) {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const linksByTarget = new Map<string, WorkflowInputLink[]>();
  for (const target of nodes) {
    const keysBySource = new Map<string, Set<string>>();
    for (const input of target.inputs ?? []) {
      const sourceId = input?.producerNodeId;
      if (sourceId === target.id || !nodesById.has(sourceId) || typeof input.artifactKey !== "string") continue;
      const keys = keysBySource.get(sourceId) ?? new Set<string>();
      keys.add(input.artifactKey);
      keysBySource.set(sourceId, keys);
    }
    if (!keysBySource.size) continue;
    linksByTarget.set(target.id, Array.from(keysBySource, ([from, keys]) => ({
      from,
      to: target.id,
      sourceTitle: nodesById.get(from)?.title || "上游节点",
      artifactKeys: [...keys]
    })));
  }
  return linksByTarget;
}
export function workflowArtifactKeys(node?: FlowNode) {
  return [...new Set((node?.requirements ?? []).map(item => item?.key).filter((key): key is string => typeof key === "string" && key.length > 0))];
}
export function connectWorkflowInput(graph: FlowGraph, definition: WorkbenchDefinition, from: string, to: string, artifactKey: string) {
  const source = graph.nodes.find(node => node.id === from);
  const target = graph.nodes.find(node => node.id === to);
  if (!target || !workflowArtifactKeys(source).includes(artifactKey)) throw new Error("找不到要连接的节点或产物。");
  if (target.inputs?.some(input => input.producerNodeId === from && input.artifactKey === artifactKey)) return graph;
  const changed = { ...target, inputs: [...(target.inputs ?? []), { producerNodeId: from, artifactKey }] };
  const connected = { ...graph, nodes: graph.nodes.map(node => node.id === to ? changed : node) };
  validateGraph(connected, definition);
  return connected;
}
export function rebaseWorkflowInputs<T>(draft: T[], before: T[], after: T[]) {
  const identity = (input: T) => JSON.stringify(input);
  const oldKeys = new Set(before.map(identity));
  const newKeys = new Set(after.map(identity));
  const retained = draft.filter(input => !oldKeys.has(identity(input)) || newKeys.has(identity(input)));
  const retainedKeys = new Set(retained.map(identity));
  return [...retained, ...after.filter(input => !oldKeys.has(identity(input)) && !retainedKeys.has(identity(input)))];
}
export function connectGraph(graph:FlowGraph,definition:WorkbenchDefinition,edge:FlowEdge) {
  if(graph.edges.some(row=>row.from===edge.from&&row.to===edge.to&&row.fromPort===edge.fromPort&&row.toPort===edge.toPort))throw new Error("这两个端口已经连接。");
  validateGraph({...graph,edges:[...graph.edges,edge]},definition);
  return edge;
}
export function stageLayout(graph:FlowGraph,definition:WorkbenchDefinition,columns=3) {
  const {order}=validateGraph(graph,definition),rank=new Map<string,number>(order.map((id:string,index:number)=>[id,index]));
  const assigned=new Set<string>(),positions:Record<string,Point>=Object.create(null);let top=80;
  const stages=[...graph.groups,{id:"ungrouped",nodeIds:graph.nodes.map(node=>node.id)}];
  for(const stage of stages){
    const ids=[...new Set(stage.nodeIds)].filter(id=>rank.has(id)&&!assigned.has(id)).sort((a,b)=>rank.get(a)!-rank.get(b)!);
    ids.forEach((id,index)=>{assigned.add(id);positions[id]={x:64+(index%columns)*(NODE_WIDTH+88),y:top+Math.floor(index/columns)*(NODE_HEIGHT+64)};});
    if(ids.length)top+=Math.ceil(ids.length/columns)*(NODE_HEIGHT+64)+100;
  }
  return positions;
}
export function groupBounds(group:FlowGroup,positions:Record<string,Point>) {
  const points=group.nodeIds.map(id=>positions[id]).filter((point):point is Point=>!!point);
  if(!points.length)return undefined;
  const x=Math.min(...points.map(p=>p.x))-28,y=Math.min(...points.map(p=>p.y))-56;
  return {x,y,width:Math.max(...points.map(p=>p.x))+NODE_WIDTH+28-x,height:Math.max(...points.map(p=>p.y))+NODE_HEIGHT+28-y};
}
export function wirePath(from:Point,to:Point) {const bend=Math.max(70,Math.abs(to.x-from.x)*.45);return `M ${from.x} ${from.y} C ${from.x+bend} ${from.y}, ${to.x-bend} ${to.y}, ${to.x} ${to.y}`;}
export function canvasGraphThumbnail(canvas: WorkbenchCanvas) {
  const visibleNodes = canvas.graph.nodes.slice(0, 120);
  if (!visibleNodes.length) return;
  const nodes = visibleNodes.map((node, index) => ({
    id: node.id,
    x: node.layout?.x ?? 416 * (index % 4),
    y: node.layout?.y ?? 224 * Math.floor(index / 4),
    width: node.layout?.width ?? 380,
    height: node.layout?.height ?? (node.config.legacyCardId || node.config.textOutput ? 214 : 76),
    enabled: node.enabled !== false
  }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of visibleNodes) {
    if (typeof node.config.legacyCardId === "string") byId.set(node.config.legacyCardId, byId.get(node.id)!);
  }
  const edges = [...canvas.graph.edges, ...(canvas.mediaLinks ?? []), ...Array.from(workflowInputLinks(visibleNodes).values()).flat()];
  const wires = edges.slice(0, 240).flatMap(edge => {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) return [];
    return [wirePath({ x: from.x + from.width, y: from.y + from.height / 2 }, { x: to.x, y: to.y + to.height / 2 })];
  });
  const left = Math.min(...nodes.map(node => node.x));
  const top = Math.min(...nodes.map(node => node.y));
  const right = Math.max(...nodes.map(node => node.x + node.width));
  const bottom = Math.max(...nodes.map(node => node.y + node.height));
  return { viewBox: `${left - 80} ${top - 80} ${right - left + 160} ${bottom - top + 160}`, nodes, wires };
}
export function mergePage<T extends {id:string}>(current:T[],incoming:T[],limit=LIST_LIMIT){const all=[...new Map([...current,...incoming].map(row=>[row.id,row])).values()];return {rows:all.slice(-limit),removed:Math.max(0,all.length-limit)};}
export function visibleList(length:number,scrollTop:number,height:number,rowHeight=80){const offset=Math.max(0,Math.min(scrollTop,Math.max(0,length*rowHeight-height))),start=Math.max(0,Math.floor(offset/rowHeight)-3),end=Math.min(length,Math.ceil((offset+height)/rowHeight)+3);return {start,end,top:start*rowHeight,bottom:Math.max(0,(length-end)*rowHeight)};}
export type ConfigField={path:string;label:string;type?:"number"|"boolean"|"lines"|"textarea"|"select";options?:string[]};
const roots=["canvas","materials","output","runtime"];
export const configFields:Record<string,ConfigField[]>={
  command:[{path:"toolKey",label:"命令工具"},{path:"argv",label:"命令参数（每行一项）",type:"lines"},{path:"timeoutMs",label:"超时（毫秒）",type:"number"},{path:"validationOnly",label:"仅校验输入",type:"boolean"}],
  agent:[{path:"agentBindingKey",label:"Agent 绑定"},{path:"target.agentAdapter",label:"目标适配器"},{path:"target.threadId",label:"目标对话"},{path:"source.sourceAgentType",label:"发起适配器"},{path:"source.sourceThreadId",label:"发起对话"},{path:"briefRef.root",label:"任务书位置",type:"select",options:roots},{path:"briefRef.path",label:"任务书相对路径"},{path:"independentFromNodeId",label:"独立核验的原作者节点"},{path:"contextProjection.ref.root",label:"结构化上下文位置",type:"select",options:roots},{path:"contextProjection.ref.path",label:"结构化上下文相对路径"},{path:"contextProjection.list",label:"上下文列表字段"},{path:"contextProjection.fields",label:"传递字段（每行一项）",type:"lines"}],
  asset:[{path:"mediaKind",label:"材料类型",type:"select",options:["text","image","video","audio"]},{path:"ref.root",label:"材料位置",type:"select",options:roots},{path:"ref.path",label:"材料相对路径"},{path:"artifactKey",label:"产物名称"}],
  human:[{path:"instructions",label:"检查内容",type:"textarea"}],
  generate:[{path:"command.model",label:"模型"},{path:"command.prompt",label:"生成提示词",type:"textarea"},{path:"command.width",label:"宽度",type:"number"},{path:"command.height",label:"高度",type:"number"},{path:"command.frames",label:"帧数",type:"number"},{path:"command.seed",label:"种子",type:"number"},{path:"deviceId",label:"生成设备"}]
};
export function configValue(config:Record<string,any>,path:string):any{return path.split(".").reduce((value,key)=>value&&typeof value==="object"?value[key]:undefined,config);}
export function changeConfig(config:Record<string,any>,field:ConfigField,value:string|boolean){
  const result=JSON.parse(JSON.stringify(config)),parts=field.path.split(".");let target=result;
  for(const key of parts.slice(0,-1)){if(!target[key]||typeof target[key]!=="object"||Array.isArray(target[key]))target[key]={};target=target[key];}
  const key=parts.at(-1)!;
  if(field.type==="number"){if(value==="")delete target[key];else {const number=Number(value);if(!Number.isFinite(number))throw new Error(`${field.label}需要数字。`);target[key]=number;}}
  else target[key]=field.type==="lines"?(value===""?[]:String(value).split("\n")):value;
  return result;
}
