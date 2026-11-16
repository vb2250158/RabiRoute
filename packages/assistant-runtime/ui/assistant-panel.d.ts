/** Inject the host's React instance and public component primitives. No browser audio owner is created. */
export function createAssistantPanel(React: typeof import('react'), components: {
  Button?: import('react').ElementType; Input?: import('react').ElementType; Modal?: import('react').ElementType; HostSettings?: import('react').ElementType; settingsPresentation?:'modal'|'page';
}): import('react').ComponentType<{ adapter: {
  read(): Promise<any>;
  command(request: Record<string, unknown>): Promise<any>;
  /** Resolve host-owned images with the host's existing prefix and authentication. */
  resolveAvatarUrl?(url:string):string;
  subscribeConversation(sessionId: string, onMessages: (messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; notice?: boolean;source?:string;hasDetails?:boolean;createdAt?:string }>) => void,
    onError: (error: Error) => void): () => void;
} }>;

export function assistantParticipants(state:any):Record<'assistant'|'user'|'system',{name:string;avatarUrl:string}>;
export function messageTimeLabel(message:{createdAt?:string},previous?:{createdAt?:string}):string;

export function recognitionRows(details:any):Array<{key:string;label:string;value:string;returned:boolean}>;
export function speechParameterRows(parameters?:Record<string,unknown>,catalog?:any):Array<{key:string;label:string;value:string}>;
export function createMessageDetailsView(React:typeof import('react')):import('react').ComponentType<{data?:any;loading?:boolean;error?:string;onBack():void;onRetry():void;catalogs?:any}>;
