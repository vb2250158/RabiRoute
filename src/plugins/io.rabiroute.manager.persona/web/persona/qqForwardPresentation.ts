import { qqDisplayParts, qqMessageUrl, type QqSelection, type QqHistoryMessage, type QqMessagePart } from '../../../../../ribiwebgui/src/qqMessagePresentation';
import type { MessageContextAttachment } from '../../../../messageContextStore';

/** The forward card is plugin-owned presentation; stored and public Host parts stay unchanged. */
export type QqForwardDisplayPart=QqMessagePart|{kind:'forward';index:number};
export function qqForwardDisplayParts(text:string,structured:QqMessagePart[]|undefined,attachments:MessageContextAttachment[]=[]):QqForwardDisplayPart[]{
  let index=0;
  return qqDisplayParts(text,structured,attachments).map(part=>part.kind==='label'&&part.text==='合并转发'?{kind:'forward',index:index++}:part);
}

/** Forward references stay scoped to the original selected message, including nested media. */
export type QqForwardReference = { messageId: string | number; path: string; nodeIndex: number };
export type QqForwardNode = QqHistoryMessage & { nodeIndex: number };
export type QqForwardPage = { routeId: string; instanceId: string; messageId: string; forwardPath: string; entries: QqForwardNode[]; total: number; truncated: boolean; offset:number; nextOffset:number|null; skippedCount:number };
const forwardPathPattern = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))*$/;
const validForwardPath=(path:string)=>forwardPathPattern.test(path)&&path.split('.').every(value=>Number.isSafeInteger(Number(value)));
export function qqForwardPath(index: number, node?: QqForwardReference): string | undefined {
  if (!Number.isSafeInteger(index) || index < 0) return;
  const path = node ? `${node.path}.${node.nodeIndex}.${index}` : String(index);
  return validForwardPath(path) ? path : undefined;
}
export function qqForwardUrl(selection: QqSelection, messageId: string | number, path: string): string | undefined {
  const original = qqMessageUrl(selection, messageId);
  if (!original || !validForwardPath(path)) return;
  return original.replace('?', `/forwards/${path}?`);
}
export function qqForwardNodeUrl(selection: QqSelection, node: QqForwardReference): string | undefined {
  const forward = qqForwardUrl(selection, node.messageId, node.path);
  if (!forward || !Number.isSafeInteger(node.nodeIndex) || node.nodeIndex < 0) return;
  return forward.replace('?', `/nodes/${node.nodeIndex}?`);
}
