import { peerManagerPath } from "../../../../../ribiwebgui/src/peerManagerTarget";
import type { ComputerTarget } from "./computerControlPresentation";
type Source = Pick<EventSource,"addEventListener" | "removeEventListener" | "close">;
type Listener = () => void;
/** One existing Manager event stream per visible owner; events only invalidate metadata snapshots. */
export function createComputerControlEvents(open:(path:string)=>Source) {
 const owners=new Map<string,{source:Source;listeners:Map<string,Set<Listener>>;changed:EventListener;opened:EventListener}>();
 function subscribe(target:Pick<ComputerTarget,"ownerDeviceId"|"instanceId">,listener:Listener) {
  const owner=target.ownerDeviceId || "";let entry=owners.get(owner);
  if(!entry){const source=open(peerManagerPath(owner,"/api/events"));const listeners=new Map<string,Set<Listener>>();
   const changed:EventListener=raw=>{if(owners.get(owner)?.source!==source)return;let value;try{value=JSON.parse((raw as MessageEvent).data);}catch{return;}if(typeof value?.instanceId!=="string")return;for(const callback of listeners.get(value.instanceId)||[])callback();};
   const opened:EventListener=()=>{if(owners.get(owner)?.source!==source)return;for(const group of listeners.values())for(const callback of group)callback();};
   entry={source,listeners,changed,opened};owners.set(owner,entry);source.addEventListener("computer_control_changed",changed);source.addEventListener("open",opened);
  }
  let group=entry.listeners.get(target.instanceId);if(!group){group=new Set();entry.listeners.set(target.instanceId,group);}group.add(listener);let closed=false;
  return ()=>{if(closed)return;closed=true;group!.delete(listener);if(!group!.size)entry!.listeners.delete(target.instanceId);if(!entry!.listeners.size){entry!.source.removeEventListener("computer_control_changed",entry!.changed);entry!.source.removeEventListener("open",entry!.opened);entry!.source.close();if(owners.get(owner)===entry)owners.delete(owner);}};
 }
 return {subscribe,dispose(){for(const entry of owners.values()){entry.source.removeEventListener("computer_control_changed",entry.changed);entry.source.removeEventListener("open",entry.opened);entry.source.close();}owners.clear();}};
}
export type ComputerControlEvents=ReturnType<typeof createComputerControlEvents>;
