import type { MessageEndpointType } from "./messageEndpointTypes.js";
import type { ScanDiagnostic } from "../manager/scanController.js";
import type { AdapterOperationalHealth } from "../manager/messageAdapterHealth.js";

export type MessageAdapterMaturity = "verified" | "experimental" | "stub";

export type MessageAdapterRequirement = {
  id: string;
  label: string;
  required?: boolean;
  ok?: boolean;
  detail?: string;
  actionLabel?: string;
  url?: string;
  path?: string;
};

export type MessageAdapterEndpoint = {
  label: string;
  url: string;
  healthy?: boolean;
};

export type MessageAdapterScanResult = {
  type: MessageEndpointType;
  label: string;
  maturity: MessageAdapterMaturity;
  installed: boolean;
  installCandidates?: Array<{ label: string; path?: string; url?: string }>;
  endpoints?: MessageAdapterEndpoint[];
  requirements?: MessageAdapterRequirement[];
  warnings?: string[];
  scan?: ScanDiagnostic;
  health?: AdapterOperationalHealth;
};

export type MessageAdapterScanProvider = {
  type: MessageEndpointType;
  label: string;
  maturity: MessageAdapterMaturity;
  mode?: "bounded" | "immediate";
  scan(): MessageAdapterScanResult | Promise<MessageAdapterScanResult>;
  fallback?(diagnostic: ScanDiagnostic): MessageAdapterScanResult;
};

export class MessageAdapterScanProviderRegistry {
  private readonly providers = new Map<MessageEndpointType, MessageAdapterScanProvider>();

  /** Candidate registrations remain invisible until their own activation publishes. */
  prepare(provider: MessageAdapterScanProvider) {
    let previous: MessageAdapterScanProvider | undefined;
    let published = false;
    return {
      publication: {
        publish: () => { previous = this.providers.get(provider.type); this.providers.set(provider.type, provider); published = true; },
        rollback: () => {
          if (published && this.providers.get(provider.type) === provider) {
            if (previous) this.providers.set(provider.type, previous); else this.providers.delete(provider.type);
          }
          published = false;
        }
      },
      dispose: () => { if (this.providers.get(provider.type) === provider) this.providers.delete(provider.type); }
    };
  }

  register(provider: MessageAdapterScanProvider): () => void {
    if (this.providers.has(provider.type)) {
      throw new Error(`Message adapter scan provider already registered: ${provider.type}`);
    }
    this.providers.set(provider.type, provider);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.providers.get(provider.type) === provider) this.providers.delete(provider.type);
    };
  }

  registerMany(providers: readonly MessageAdapterScanProvider[]): () => void {
    const disposers: Array<() => void> = [];
    try {
      for (const provider of providers) disposers.push(this.register(provider));
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      for (const dispose of disposers.reverse()) dispose();
    };
  }

  snapshot(): MessageAdapterScanProvider[] {
    return [...this.providers.values()];
  }

}
