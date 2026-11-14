export type DrawingPoint = {x:number;y:number};
export type DrawingObject = {id:string;type:string;bounds?:{x:number;y:number;width:number;height:number};points?:DrawingPoint[];text?:string;style?:Record<string,unknown>};
export function drawingPoint(clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number},width:number,height:number): DrawingPoint {
 return {x:Math.max(0,Math.min(width,(clientX-rect.left)*width/rect.width)),y:Math.max(0,Math.min(height,(clientY-rect.top)*height/rect.height))};
}
export function drawingObject(id:string,type:string,points:DrawingPoint[],text:string,style:Record<string,unknown>):DrawingObject {
 const first=points[0]!;const last=points.at(-1)!;
 return {id,type,...(["path","arrow"].includes(type)?{points:type==="arrow"?[first,last]:points}:{bounds:{x:Math.min(first.x,last.x),y:Math.min(first.y,last.y),width:Math.abs(last.x-first.x),height:Math.abs(last.y-first.y)}}),...(type==="text"?{text}:{}),...(Object.keys(style).length?{style}:{} )};
}
