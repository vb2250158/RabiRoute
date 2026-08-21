import { computed, shallowRef, type Ref } from "vue";

export type PageSaveAction = {
  dirty: Ref<boolean>;
  ready: Ref<boolean>;
  saving: Ref<boolean>;
  save: () => Promise<void>;
};

const activePageSaveAction = shallowRef<PageSaveAction | null>(null);

export const pageSaveAction = computed(() => activePageSaveAction.value);

export function registerPageSaveAction(action: PageSaveAction): () => void {
  activePageSaveAction.value = action;
  return () => {
    if (activePageSaveAction.value === action) activePageSaveAction.value = null;
  };
}
