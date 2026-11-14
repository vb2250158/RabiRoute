import { EventEmitter } from "node:events";
import { sameDesktopResourceReference } from "./desktop-resource-reference.mjs";

const fault = (code, message) => Object.assign(new Error(message), { code });

/** Version only the desktop worker. Files, terminals and receipt storage retain their original owners. */
export class DesktopNativeSlot extends EventEmitter {
  constructor({ initial, create, resolve, restore, commit, retire, resume = () => {} }) {
    super();
    Object.assign(this, { create, resolve, restore, commit, retire, resume });
    this.initialized = !restore;
    this.revision = 0;
    this.selected = initial;
    this.prepared = new Set();
    this.preparing = new Set();
    this.owner = this.makeOwner(initial);
    this.changing = false;
    this.stopping = false;
  }
  ready() {
    if (this.restoration) return this.restoration;
    if (this.initialized) return this.failure ? Promise.reject(this.failure) : Promise.resolve();
    if (this.stopping) return Promise.reject(fault("COMPUTER_STOPPED", "The desktop worker is stopping."));
    const flight = Promise.resolve().then(async () => {
      try {
        const selected = await this.restore();
        this.revision = selected.revision;
        // Selection facts are known even if that resource is currently damaged.
        // A replacement can still be prepared using this exact original CAS.
        const hasSelection = Boolean(selected.reference || selected.qtPackageRef);
        if (hasSelection) this.selected = { version: selected.version ?? (selected.reference ? "selected" : "builtin"), ...(selected.reference ? { digest: selected.reference } : {}), ...(selected.qtPackageRef ? { qtPackageRef: selected.qtPackageRef } : {}) };
        this.initialized = true;
        const reference = selected.qtPackageRef ? { digest: selected.reference ?? null, qtPackageRef: selected.qtPackageRef } : selected.reference;
        const release = hasSelection ? await this.resolve(reference, this.selected, { restoring: true }) : this.selected;
        if (this.stopping) throw fault("COMPUTER_STOPPED", "Desktop selection restoration was stopped.");
        if (hasSelection) {
          await this.owner.native.close();
          if (this.stopping) throw fault("COMPUTER_STOPPED", "Desktop selection restoration was stopped before worker construction.");
          this.detach(this.owner); this.owner = this.makeOwner(release); this.selected = release;
          try { await this.probe(this.owner, { restoring: true }); this.assertPreparedAlive(this.owner); this.selected = this.owner.release; }
          catch (error) { await this.owner.native.close(); throw error; }
          if (this.stopping) throw fault("COMPUTER_STOPPED", "Desktop selection restoration was stopped during its protocol handshake.");
        }
        this.failure = undefined;
      } catch (error) { this.failure = error; throw error; }
      finally { if (this.restoration === flight) this.restoration = undefined; }
    });
    this.restoration = flight;
    return flight;
  }
  async commitCandidate(release) {
    if (!this.commit) return undefined;
    try { return await this.commit(release, this.revision); }
    catch (error) {
      if (!this.restore) throw error;
      let current;
      try { current = await this.restore(); }
      catch (readback) { throw Object.assign(new AggregateError([error, readback], "The original desktop selection commit remains unconfirmed; query the same adoption."), { uncertain: true, code: "COMPUTER_DESKTOP_SELECTION_UNCONFIRMED" }); }
      const readback = { digest: current.reference ?? null, qtPackageRef: current.qtPackageRef };
      if (sameDesktopResourceReference(readback, release) && (current.revision === this.revision + 1 || current.revision === this.revision)) return current;
      if (current.revision === this.revision && sameDesktopResourceReference(readback, this.selected)) throw error;
      throw Object.assign(new Error("The desktop selection changed while adoption was being confirmed.", { cause: error }), { uncertain: true, code: "COMPUTER_DESKTOP_SELECTION_UNCONFIRMED" });
    }
  }
  ownsChild(child) {
    return [this.owner, ...[...this.prepared].map(item => item.candidate)].some(owner => owner.native.child === child || owner.native.qt?.child === child);
  }
  makeOwner(release) {
    const owner = { release, native: undefined };
    owner.native = this.create(release);
    owner.listeners = ["closed", "retired", "presentation", "control-ended", "tracking", "annotation-ended", "annotation-source", "annotation-static", "diagnostic"].map(event => {
      const listener = (...args) => { if (this.owner === owner) this.emit(event, ...args); };
      owner.native.on?.(event, listener);
      return [event, listener];
    });
    return owner;
  }
  detach(owner) { for (const [event, listener] of owner.listeners) owner.native.removeListener?.(event, listener); }
  async probe(owner, { restoring = false } = {}) {
    const capabilities = await owner.native.request("capabilities");
    if (capabilities?.protocolVersion !== 2) throw fault("COMPUTER_NATIVE_ABI_UNSUPPORTED", "The selected desktop worker does not implement protocol 2.");
    owner.capabilities = Object.freeze({ ...capabilities });
    if (owner.release.qtPackageRef && !owner.release.presentationIssue) {
      try { await owner.native.preparePresentation?.(); }
      catch (error) {
        if (!restoring || !owner.native.markPresentationUnavailable) throw error;
        const issue = await owner.native.markPresentationUnavailable({ code: "COMPUTER_PRESENTATION_UNAVAILABLE", message: `The selected Qt presentation could not start: ${error.message}` });
        owner.release = Object.freeze({ ...owner.release, presentationIssue: issue, nativeOptions: Object.freeze({ ...owner.release.nativeOptions, qtPresentation: null, presentationIssue: issue }) });
      }
    }
    await owner.native.setPresentationTheme?.(this.theme);
  }
  assertPreparedAlive(owner) {
    if (("child" in owner.native && !owner.native.child) || owner.native.stopping) {
      throw fault("COMPUTER_DESKTOP_CANDIDATE_EXITED", "The prepared desktop worker exited; the selected release has not changed.");
    }
    if (owner.release.qtPackageRef && !owner.release.presentationIssue && "qt" in owner.native && !owner.native.qt?.child) throw fault("COMPUTER_DESKTOP_CANDIDATE_EXITED", "The prepared Qt presentation process exited; its resource has not been adopted.");
  }
  get child() { return this.owner.native.child; }
  get qt() { return this.owner.native.qt; }
  get capabilities() { return this.owner.capabilities; }
  status() {
    return Object.freeze({ revision: this.revision, release: this.initialized ? Object.freeze({ version: this.selected.version, ...(this.selected.digest ? { digest: this.selected.digest } : {}), ...(this.selected.qtPackageRef ? { qtPackageRef: this.selected.qtPackageRef } : {}) }) : null,
      state: this.stopping ? "stopping" : this.changing ? "updating" : this.failure ? "unconfirmed" : !this.initialized ? "initializing" : this.selected.presentationIssue ? "degraded" : "ready",
      ...(this.selected.presentationIssue ? { presentationIssue: this.selected.presentationIssue } : {}),
      ...(this.failure ? { error: Object.freeze({ code: this.failure.code ?? "COMPUTER_DESKTOP_UNAVAILABLE", message: this.failure.message }) } : {}) });
  }
  async request(action, body, options) {
    await this.ready();
    if (this.changing) return Promise.reject(fault("COMPUTER_DESKTOP_UPDATING", "The desktop worker is updating; original receipts, files and terminals remain available."));
    if (this.stopping) return Promise.reject(fault("COMPUTER_STOPPED", "The desktop worker is stopping."));
    return this.owner.native.request(action, body, options);
  }
  setPresentationTheme(snapshot) {
    this.theme = snapshot;
    return this.owner.native.setPresentationTheme?.(snapshot) ?? Promise.resolve();
  }
  prepare(reference) {
    const flight = this.prepareOwned(reference);
    this.preparing.add(flight);
    void flight.then(() => this.preparing.delete(flight), () => this.preparing.delete(flight));
    return flight;
  }
  async prepareOwned(reference) {
    if (this.stopping) throw fault("COMPUTER_STOPPED", "The desktop worker is stopping.");
    // The existing release owner resolves a verified immutable package; this slot does not rehash it per RPC.
    try { await this.ready(); } catch (error) { if (!this.initialized) throw error; }
    const release = await this.resolve(reference, this.selected);
    if (this.stopping) throw fault("COMPUTER_STOPPED", "The desktop worker stopped while resolving a candidate.");
    const candidate = this.makeOwner(release);
    const prepared = { candidate, state: "preparing" };
    this.prepared.add(prepared);
    try {
      await this.probe(candidate);
      if (this.stopping) throw fault("COMPUTER_STOPPED", "The desktop worker stopped while preparing a candidate.");
      prepared.state = "prepared";
      return prepared;
    } catch (error) {
      try { await this.discard(prepared); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Desktop candidate preparation and cleanup failed; its owner is retained."); }
      throw error;
    }
  }
  async discard(prepared) {
    if (!this.prepared.has(prepared)) return;
    if (prepared.state === "activating") throw fault("COMPUTER_DESKTOP_UPDATING", "The desktop candidate is being activated.");
    await prepared.candidate.native.close();
    this.detach(prepared.candidate);
    prepared.state = "retired";
    this.prepared.delete(prepared);
  }
  activate(prepared, expectedRevision) {
    if (this.changing || this.stopping) return Promise.reject(fault("COMPUTER_DESKTOP_UPDATING", "The desktop worker already has an update or shutdown in progress."));
    if (expectedRevision !== this.revision) return Promise.reject(fault("COMPUTER_DESKTOP_REVISION_CONFLICT", "The selected desktop worker changed; read its current revision."));
    if (!this.prepared.has(prepared) || prepared.state !== "prepared") return Promise.reject(fault("COMPUTER_DESKTOP_CANDIDATE_UNAVAILABLE", "The desktop candidate has not completed preparation."));
    this.changing = true;
    prepared.state = "activating";
    const previous = this.owner;
    let previousRetired = false;
    let retirementStarted = false;
    const flight = (async () => {
      try {
        // The control owner cancels and joins only old desktop work, and waits for native/Qt close.
        this.assertPreparedAlive(prepared.candidate);
        retirementStarted = true;
        await this.retire(previous.native);
        previousRetired = true;
        this.assertPreparedAlive(prepared.candidate);
        const committed = await this.commitCandidate(prepared.candidate.release);
        this.detach(previous);
        this.owner = prepared.candidate;
        this.failure = undefined;
        this.selected = prepared.candidate.release;
        this.prepared.delete(prepared);
        prepared.state = "active";
        this.revision = committed?.revision ?? (this.revision + 1);
        this.resume();
        return Object.freeze({ ...this.status(), state: this.stopping ? "stopping" : "ready" });
      } catch (error) {
        this.failure = retirementStarted ? error : undefined;
        prepared.state = "prepared";
        // Retain the exact candidate when selection readback is unknown; do not
        // claim an unverified rollback. Independent I/O and original receipts continue.
        if (error.uncertain) throw error;
        try { await this.discard(prepared); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Desktop adoption and candidate cleanup remain unconfirmed."); }
        if (previousRetired && !this.stopping) {
          // A closed NativeComputerClient is never reset. Restore with a new worker
          // from the original verified release, after candidate exit was confirmed.
          const restored = this.makeOwner(previous.release);
          const recovery = { candidate: restored, state: "preparing" };
          this.prepared.add(recovery);
          try {
            await this.probe(restored);
            this.detach(previous); this.owner = restored; this.prepared.delete(recovery);
            this.failure = undefined; this.resume();
          } catch (rollback) {
            try { await this.discard(recovery); }
            catch (cleanup) { throw new AggregateError([error, rollback, cleanup], "Desktop update, rollback and worker cleanup failed."); }
            throw new AggregateError([error, rollback], "Desktop update and rollback failed; independent I/O remains available.");
          }
        }
        throw error;
      } finally {
        this.changing = false;
        if (this.activation === flight) this.activation = undefined;
      }
    })();
    this.activation = flight;
    return flight;
  }
  close() {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.closing = (async () => {
      if (this.activation) await this.activation.catch(() => {});
      const cleanup = [this.owner.native.close(), ...[...this.prepared].map(item => this.discard(item))];
      const results = await Promise.allSettled(cleanup);
      // Resolver calls are also owned work. They cannot launch after close has
      // returned, even when they did not yet allocate a native process.
      await Promise.allSettled([...this.preparing, ...(this.restoration ? [this.restoration] : [])]);
      const failures = results.filter(item => item.status === "rejected").map(item => item.reason);
      if (failures.length) throw new AggregateError(failures, "Desktop workers have not all confirmed exit.");
      this.detach(this.owner);
    })();
    return this.closing;
  }
}
