/** Inject the host's React instance and public component primitives. No browser audio owner is created. */
export function createAssistantPanel(React: typeof import('react'), components: {
  Button?: import('react').ElementType; Input?: import('react').ElementType; Modal?: import('react').ElementType;
}): import('react').ComponentType<{ adapter: {
  read(): Promise<any>;
  command(request: Record<string, unknown>): Promise<any>;
  subscribeConversation(sessionId: string, onMessages: (messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; notice?: boolean }>) => void,
    onError: (error: Error) => void): () => void;
} }>;
