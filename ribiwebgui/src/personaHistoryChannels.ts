import type { MessageHistoryChannelCatalog } from '@shared/personaHistoryChannels';
import type { MessageEndpointCatalogEntry } from './messageEndpoints/messageEndpointCatalog';

export type HistoryChannel = { id: string; label: string; icon:string; adapter?: string; category?:'agent'|'panel'|'replies' };
export function historyChannels(catalog: MessageHistoryChannelCatalog, endpoints:readonly MessageEndpointCatalogEntry[]=[]): HistoryChannel[] {
  const channels:HistoryChannel[] = [
    {id:'chat:agent',label:'Agent 间投递',icon:'mdi-send-outline',category:'agent'},
    {id:'chat:panel',label:'角色面板',icon:'mdi-account-box-outline',category:'panel'},
    {id:'chat:replies',label:'任务回复',icon:'mdi-reply',category:'replies'},
    {id:'endpoint:system',label:'系统消息',icon:'mdi-cog-outline',adapter:'system'}
  ];
  for (const adapter of new Set(catalog.adapters)) {
    if (!adapter || adapter === 'disabled' || adapter === 'system') continue;
    const presentation=endpoints.find(endpoint=>endpoint.type===adapter);
    channels.push({ id:`endpoint:${adapter}`, adapter, label:presentation?.title??adapter,icon:presentation?.icon??'mdi-puzzle-outline' });
  }
  return channels;
}
