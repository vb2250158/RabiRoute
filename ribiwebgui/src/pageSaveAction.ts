import { computed, ref, type Ref } from "vue";

export type PageSaveAction = {
  dirty: Ref<boolean>;
  ready: Ref<boolean>;
  saving: Ref<boolean>;
  save: () => Promise<void>;
};

const registeredActions = new Set<PageSaveAction>();
const actionRevision = ref(0);

export const pageSaveAction = computed<PageSaveAction | null>(() => {
  void actionRevision.value;
  const actions = [...registeredActions];
  if (!actions.length) return null;
  return {
    dirty: computed(() => actions.some(action => action.dirty.value)),
    ready: computed(() => actions.every(action => action.ready.value)),
    saving: computed(() => actions.some(action => action.saving.value)),
    save: async () => {
      for (const action of actions) await action.save();
    }
  };
});

export function registerPageSaveAction(action: PageSaveAction): () => void {
  registeredActions.add(action);
  actionRevision.value += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (registeredActions.delete(action)) actionRevision.value += 1;
  };
}
