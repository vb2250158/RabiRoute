import { writeField, stableComputerRows, type ComputerTarget } from "./computerControlPresentation";
export type ComputerSettingsSnapshot = { settings: Record<string, unknown>; etag: string; schema: Record<string, unknown>; [key: string]: unknown };
export type ComputerDraft = { saved: ComputerSettingsSnapshot; value: Record<string, unknown>; changes: Map<string, unknown>; saving: boolean; error: string; conflict: boolean; revision: number; readbackUnconfirmed?:boolean; application?:{revision:string;state:string;issue?:string;readbackIssue?:string} };
export type ComputerDirectorySnapshot = {computers:ComputerTarget[];sourceErrors?:Array<{ownerDeviceId:string;message:string}>};
export type ComputerControlViewState = { rows: ComputerTarget[]; loading: boolean; error: string; expanded: Set<string>; drafts: Map<string, ComputerDraft> };
/** One ephemeral draft per stable computer. Refreshes never replace dirty fields. */
export function createComputerControlState(observe: (value: ComputerControlViewState) => ComputerControlViewState = value => value) {
  let disposed = false; let readSequence = 0; let controller: AbortController | undefined;
  const state = observe({ rows: [] as ComputerTarget[], loading: false, error: "", expanded: new Set<string>(), drafts: new Map<string, ComputerDraft>() });
  return { state,
    async refresh(load: (signal: AbortSignal) => Promise<ComputerTarget[] | ComputerDirectorySnapshot>) {
      const sequence = ++readSequence; controller?.abort(); controller = new AbortController(); state.loading = true; state.error = "";
      try { const result = await load(controller.signal); if (!disposed && sequence === readSequence) {
        const directory = Array.isArray(result) ? {computers:result,sourceErrors:[]} : result; const fresh = new Map(directory.computers.map(row=>[row.id,row]));
        const errors = new Map((directory.sourceErrors || []).map(value=>[value.ownerDeviceId,value.message]));
        for (const previous of state.rows) if (!fresh.has(previous.id) && errors.has(previous.ownerDeviceId || "")) fresh.set(previous.id,{...previous,status:"unknown",issue:errors.get(previous.ownerDeviceId || "")});
        state.rows = stableComputerRows(state.rows,[...fresh.values()]);
      } }
      catch (error) { if (!disposed && sequence === readSequence) { state.error = error instanceof Error ? error.message : String(error); state.rows = state.rows.map(row=>({...row,status:"unknown",issue:state.error})); } }
      finally { if (!disposed && sequence === readSequence) state.loading = false; }
    },
    acceptSettings(id: string, snapshot: ComputerSettingsSnapshot) {
      if (disposed) return;
      const draft = state.drafts.get(id);
      if (draft) { draft.saved = snapshot; let value = structuredClone(snapshot.settings); for (const [path, change] of draft.changes) value = writeField(value, path.split("."), change); draft.value = value; }
      else state.drafts.set(id, { saved: snapshot, value: structuredClone(snapshot.settings), changes: new Map(), saving: false, error: "", conflict: false, revision: 0 });
    },
    async save(id: string, patch: Record<string, unknown>, send: (patch: Record<string, unknown>, etag: string) => Promise<ComputerSettingsSnapshot>) {
      const draft = state.drafts.get(id); if (!draft || draft.saving || disposed) return;
      const submitted = new Map(draft.changes); draft.saving = true; draft.error = ""; draft.conflict = false;
      try { const snapshot = await send(patch, draft.saved.etag); if (disposed) return; draft.saved = snapshot;
        if(typeof snapshot.execution === "string" || snapshot.readbackIssue) draft.application = {revision:String(snapshot.executionRevision || snapshot.revision || snapshot.etag),state:typeof snapshot.execution === "string" ? snapshot.execution : "unconfirmed",...(typeof snapshot.executionIssue === "string"?{issue:snapshot.executionIssue}:{}),...(typeof snapshot.readbackIssue === "string"?{readbackIssue:snapshot.readbackIssue}:{})};
        draft.readbackUnconfirmed=snapshot.readbackMismatch === true;
        if(!draft.readbackUnconfirmed)for (const [key, value] of submitted) if (Object.is(draft.changes.get(key), value)) draft.changes.delete(key);
        let value = structuredClone(snapshot.settings); for (const [path, change] of draft.changes) value = writeField(value, path.split("."), change); draft.value = value;
      } catch (error) { if (!disposed) { draft.error = error instanceof Error ? error.message : String(error); draft.conflict = (error as { status?: number })?.status === 412 || (error as { status?: number })?.status === 409; } }
      finally { if (!disposed) draft.saving = false; }
    },
    dispose() { disposed = true; ++readSequence; controller?.abort(); }
  };
}
