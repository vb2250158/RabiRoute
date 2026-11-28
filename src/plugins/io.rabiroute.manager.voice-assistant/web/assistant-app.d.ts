import type AssistantModelPicker from './AssistantModelPicker.vue';

/** Mount the shared assistant UI; cleanup releases only this view's subscriptions. */
export declare function mountAssistantPanel(element: HTMLElement, options?: {
  fetcher?: typeof fetch;
  resolveAvatarUrl?: (url: string) => string;
  setModelPicker?: (id: string, target: HTMLElement | null, props?: InstanceType<typeof AssistantModelPicker>['$props']) => void;
}): () => void;
