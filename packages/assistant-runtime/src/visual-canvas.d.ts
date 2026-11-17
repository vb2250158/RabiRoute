export interface CanvasBounds {x:number;y:number;width:number;height:number;title?:string}
export type VisualCanvasNode = CanvasBounds & (
 | {kind:'text';text:string;fontSize?:number}
 | {kind:'rect'|'ellipse';text?:string}
 | {kind:'arrow';text?:string;direction?:'right'|'left'|'up'|'down'}
 | {kind:'line'}
 | {kind:'polyline';points:[number,number][]}
 | {kind:'chart';chartType:'line'|'area'|'bar'|'scatter'|'pie';labels:string[];series:{name:string;values:(number|null)[]}[];unit?:string}
 | {kind:'table';columns:string[];rows:string[][]}
);
export interface VisualCanvasDocument {title:string;description?:string;nodes:VisualCanvasNode[];sources?:{label:string;url:string}[]}
export interface VisualCanvasState {revision:number;visible:boolean;persistent:boolean;document:VisualCanvasDocument|null;responseId:string|null}
export interface VisualCanvas {
 snapshot():VisualCanvasState;
 beginInput():number;
 reset():VisualCanvasState;
 show(document:VisualCanvasDocument,options?:{persistent?:boolean;responseId?:string|null;inputEpoch?:number}):VisualCanvasState;
 close(options?:{inputEpoch?:number}):VisualCanvasState;
 observation():{revision:number;visible:boolean;persistent:boolean;document?:VisualCanvasDocument|null};
}
export const visualCanvasSize:Readonly<{width:960;height:540}>;
export function validateVisualCanvas(input:unknown):VisualCanvasDocument;
export function createVisualCanvas(options?:{initial?:VisualCanvasState;onSave?:(state:VisualCanvasState)=>void;onChange?:(state:VisualCanvasState)=>void}):VisualCanvas;
export function paintVisualCanvas(ctx:CanvasRenderingContext2D & {flush?:()=>void},input:VisualCanvasDocument,options?:{width?:number;height?:number;color?:string;background?:string}):void;
export function createVisualCanvasTools(canvas:VisualCanvas,options?:{owner?:()=>{inputEpoch?:number;responseId?:string|null}}):import('./assistant-session.js').ToolAdapter;
export function withVisualCanvasProtocol<T extends import('./decision-protocol.js').AgentProtocol>(protocol:T,canvas:VisualCanvas):T;
