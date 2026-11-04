export type QqConversation = {
  conversationKey: string; gatewayId?: string; instanceId?: string;
  storedConversationKey?:string;
  kind: 'group' | 'private' | 'unknown'; target: string; time: number; preview: string;
  previewFormat?:'plain';
};
export type QqDirectoryContact = { kind: 'group' | 'private'; target: string; name: string; memberCount?: number; time?:number; preview?:string };
export type QqGroupMember = { id: string; name: string; role: string };
export type HistoryQqRoute = { routeId: string; name: string; instanceId?: string };
