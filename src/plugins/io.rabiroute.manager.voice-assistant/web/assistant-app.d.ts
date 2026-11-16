/** Mount the shared assistant UI; cleanup releases only this view's subscriptions. */
export declare function mountAssistantPanel(element: HTMLElement, options?: { fetcher?: typeof fetch; resolveAvatarUrl?: (url: string) => string }): () => void;
