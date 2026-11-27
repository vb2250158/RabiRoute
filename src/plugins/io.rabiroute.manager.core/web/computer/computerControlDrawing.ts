export type DrawingPoint = {x:number;y:number};
export type DrawingObject = {id:string;type:string;bounds?:{x:number;y:number;width:number;height:number};points?:DrawingPoint[];text?:string;style?:Record<string,unknown>};
export function drawingPoint(clientX:number,clientY:number,rect:{left:number;top:number;width:number;height:number},width:number,height:number): DrawingPoint {
 return {x:Math.max(0,Math.min(width,(clientX-rect.left)*width/rect.width)),y:Math.max(0,Math.min(height,(clientY-rect.top)*height/rect.height))};
}
export function drawingObject(id:string,type:string,points:DrawingPoint[],text:string,style:Record<string,unknown>):DrawingObject {
 const first=points[0]!;const last=points.at(-1)!;
 return {id,type,...(["path","arrow"].includes(type)?{points:type==="arrow"?[first,last]:points}:{bounds:{x:Math.min(first.x,last.x),y:Math.min(first.y,last.y),width:Math.abs(last.x-first.x),height:Math.abs(last.y-first.y)}}),...(type==="text"?{text}:{}),...(Object.keys(style).length?{style}:{} )};
}

type WindowPreviewPointer = { id: string; label: string; color: string; x: number; y: number; labelOffset: number };
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Match the same top-level window, process and client receiver before projecting raw points. */
export function windowPreviewPointers(image: Record<string, unknown>, points: unknown): WindowPreviewPointer[] {
  const source = record(image.source);
  const client = record(source?.previewClient);
  if (source?.captureMethod !== "window-print" || !client || !Array.isArray(points)) return [];
  const { x: offsetX, y: offsetY, width, height, frameWidth, frameHeight, receiverId, revision } = client;
  if (typeof offsetX !== "number" || !Number.isFinite(offsetX) || typeof offsetY !== "number" || !Number.isFinite(offsetY) ||
      typeof width !== "number" || !Number.isFinite(width) || width <= 0 ||
      typeof height !== "number" || !Number.isFinite(height) || height <= 0 ||
      typeof frameWidth !== "number" || !Number.isFinite(frameWidth) || frameWidth <= 0 ||
      typeof frameHeight !== "number" || !Number.isFinite(frameHeight) || frameHeight <= 0 ||
      typeof receiverId !== "string" || typeof revision !== "string") return [];
  const result: WindowPreviewPointer[] = [];
  for (const value of points) {
    const point = record(value);
    if (!point || point.space !== "window-client" || point.windowId !== source.windowId || point.pid !== source.pid ||
        point.receiverId !== receiverId || point.clientRevision !== revision) continue;
    const { id, label, color, x, y } = point;
    if (typeof id !== "string" || typeof label !== "string" || typeof x !== "number" || !Number.isFinite(x) || x < 0 || x >= width ||
        typeof y !== "number" || !Number.isFinite(y) || y < 0 || y >= height) continue;
    const frameX = x + offsetX, frameY = y + offsetY;
    if (frameX < 0 || frameX >= frameWidth || frameY < 0 || frameY >= frameHeight) continue;
    const xPercent = frameX / frameWidth * 100, yPercent = frameY / frameHeight * 100;
    const labelOffset = result.filter(other => Math.abs(other.x - xPercent) < 10 && Math.abs(other.y - yPercent) < 6).length;
    result.push({ id, label, color: typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? color : "#3de0cf", x: xPercent, y: yPercent, labelOffset });
  }
  return result;
}
