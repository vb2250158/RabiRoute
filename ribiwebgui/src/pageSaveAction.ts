import { computed, effectScope, ref, watch, type Ref } from "vue";

export type PageSaveAction = {
  dirty: Ref<boolean>;
  ready: Ref<boolean>;
  saving: Ref<boolean>;
  save: () => Promise<void>;
};

type BackgroundSave = { action: PageSaveAction; failure: Ref<string>; flush: () => Promise<void> };
const registeredActions = new Set<BackgroundSave>();
const actionRevision = ref(0);

export const pageSaveAction = computed<PageSaveAction | null>(() => {
  void actionRevision.value;
  const entries = [...registeredActions];
  if (!entries.length) return null;
  return {
    dirty: computed(() => entries.some(({ action }) => action.dirty.value)),
    ready: computed(() => entries.every(({ action }) => action.ready.value)),
    saving: computed(() => entries.some(({ action }) => action.saving.value)),
    save: async () => {
      for (const entry of entries) await entry.flush();
    }
  };
});

export const pageSaveFailure = computed(() => {
  void actionRevision.value;
  return [...registeredActions].find(entry => entry.failure.value);
});

export function registerPageSaveAction(action: PageSaveAction, delayMs = 350, changes?: Ref<unknown>): (() => void) & BackgroundSave {
  const failure = ref("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let active = true;
  const scope = effectScope(true);
  const entry = { action, failure, flush };
  registeredActions.add(entry);
  actionRevision.value += 1;

  function schedule(): void {
    clearTimeout(timer);
    if (flight) return;
    if (!active && (!action.dirty.value || !action.ready.value)) { remove(); return; }
    if (failure.value || !action.dirty.value || !action.ready.value || action.saving.value) return;
    if (!active || delayMs === 0) void flush();
    else timer = setTimeout(() => { void flush(); }, delayMs);
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    if (flight) return flight;
    if (!action.dirty.value || !action.ready.value || action.saving.value) return Promise.resolve();
    failure.value = "";
    flight = Promise.resolve().then(async () => {
      while (action.dirty.value && action.ready.value && !action.saving.value) {
        const submitted = changes?.value;
        await action.save();
        if (changes && action.dirty.value && action.ready.value && submitted === changes.value) {
          throw new Error("保存后仍有未同步的修改。");
        }
      }
    }).catch(error => {
      failure.value = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      flight = undefined;
      schedule();
    });
    return flight;
  }

  scope.run(() => watch([action.dirty, action.ready, action.saving, () => changes?.value], (current, previous) => {
    if (current[3] !== previous?.[3] || !current[0]) failure.value = "";
    schedule();
  }, { immediate: true }));

  function remove(): void {
    scope.stop();
    if (registeredActions.delete(entry)) actionRevision.value += 1;
  }

  function unregister(): void {
    if (!active) return;
    active = false;
    schedule();
  }
  return Object.assign(unregister, entry);
}
