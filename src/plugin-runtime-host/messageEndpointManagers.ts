import type { PluginPublication } from "@rabiroute/plugin-sdk/publication";
import type { GatewayDefinition } from "../shared/gatewayConfigModel.js";

export type MessageEndpointManagerOwner = Readonly<{
  /** Stable platform resources may be handed to a replacement activation. */
  resources?: unknown;
  /** Only this endpoint's relevant binding/configuration fields, including shared uniqueness keys. */
  configurationKey?(routes: readonly GatewayDefinition[]): string;
  validateRoutes?(routes: readonly GatewayDefinition[]): void;
  reconcileRoutes?(routes: readonly GatewayDefinition[]): Promise<void>;
  ready?(): void;
  inspect?(trackProbe: <T>(probe: Promise<T>) => Promise<T>): Promise<unknown>;
}>;

/** Platform owners register their lifecycle hooks; the catalog host never instantiates them. */
export class MessageEndpointManagers {
  private readonly owners = new Map<string, MessageEndpointManagerOwner>();
  private readonly failures = new Map<string, { type: string; stage: string; message: string }>();
  private readonly reporters = new Map<MessageEndpointManagerOwner, (error: unknown) => void>();
  current(type: string): MessageEndpointManagerOwner | undefined { return this.owners.get(type); }
  prepare(type: string, owner: MessageEndpointManagerOwner, fail: (error: unknown) => void): { publication: PluginPublication; dispose(): void } {
    let previous: MessageEndpointManagerOwner | undefined;
    return {
      publication: {
        publish: () => { previous = this.owners.get(type); this.owners.set(type, owner); this.reporters.set(owner, fail); this.failures.delete(type); },
        rollback: () => {
          if (this.owners.get(type) !== owner) return;
          if (previous) this.owners.set(type, previous); else this.owners.delete(type);
        }
      },
      dispose: () => { if (this.owners.get(type) === owner) this.owners.delete(type); this.reporters.delete(owner); }
    };
  }
  validateRoutes(routes: readonly GatewayDefinition[], previous?: readonly GatewayDefinition[]): void {
    for (const owner of this.owners.values()) {
      if (previous && owner.configurationKey && owner.configurationKey(routes) === owner.configurationKey(previous)) continue;
      owner.validateRoutes?.(routes);
    }
  }
  private failed(type: string, stage: string, owner: MessageEndpointManagerOwner, error: unknown): void {
    const failure = { type, stage, message: error instanceof Error ? error.message : String(error) };
    this.failures.set(type, failure);
    try { this.reporters.get(owner)?.(error); }
    catch (reportError) { failure.message += `; lifecycle reporting failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`; }
  }
  async reconcileRoutes(routes: readonly GatewayDefinition[]): Promise<void> {
    // Independent owners always receive their snapshot. A failure is reported to
    // the original plugin lifecycle, which retires that dependency component.
    await Promise.all([...this.owners].map(async ([type, owner]) => {
      try { await owner.reconcileRoutes?.(routes); }
      catch (error) { this.failed(type, "reconcile", owner, error); }
    }));
  }
  ready(): void {
    for (const [type, owner] of [...this.owners]) {
      try { owner.ready?.(); }
      catch (error) { this.failed(type, "ready", owner, error); }
    }
  }
  diagnostics() { return [...this.failures.values()]; }
  inspect(type: string, trackProbe: <T>(probe: Promise<T>) => Promise<T>): Promise<unknown> {
    return this.owners.get(type)?.inspect?.(trackProbe) ?? Promise.resolve({ payload: {}, diagnostics: {}, partial: false, durationMs: 0, deadlineMs: 0 });
  }
}
