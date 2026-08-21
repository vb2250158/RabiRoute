import { RabiCordisHost } from "./cordisHost.js";

export type GatewayCordisInitializer<T> = (host: RabiCordisHost) => Promise<T>;

export type GatewayCordisRoot = {
  readonly host: RabiCordisHost;
  readonly disposed: boolean;
  ensure<T>(key: string, initialize: GatewayCordisInitializer<T>): Promise<T>;
  dispose(): Promise<void>;
};

class DefaultGatewayCordisRoot implements GatewayCordisRoot {
  readonly host = new RabiCordisHost();
  private readonly initializers = new Map<string, Promise<unknown>>();
  private state: "active" | "disposing" | "disposed" = "active";
  private disposePromise: Promise<void> | undefined;

  get disposed(): boolean {
    return this.state === "disposed";
  }

  ensure<T>(key: string, initialize: GatewayCordisInitializer<T>): Promise<T> {
    const runtimeKey = key.trim();
    if (!runtimeKey) {
      return Promise.reject(new Error("Gateway Cordis runtime key is required."));
    }
    if (this.state !== "active") {
      return Promise.reject(new Error(`Gateway Cordis root is ${this.state}.`));
    }

    const existing = this.initializers.get(runtimeKey);
    if (existing) return existing as Promise<T>;

    const initializing = Promise.resolve().then(() => initialize(this.host));
    this.initializers.set(runtimeKey, initializing);
    void initializing.catch(() => {
      if (this.initializers.get(runtimeKey) === initializing) {
        this.initializers.delete(runtimeKey);
      }
    });
    return initializing;
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.state = "disposing";
      this.disposePromise = (async () => {
        const pending = [...this.initializers.values()];
        await Promise.allSettled(pending);
        try {
          await this.host.dispose();
        } finally {
          this.initializers.clear();
          this.state = "disposed";
        }
      })();
    }
    return this.disposePromise;
  }
}

export function createGatewayCordisRoot(): GatewayCordisRoot {
  return new DefaultGatewayCordisRoot();
}

let builtinGatewayCordisRoot: GatewayCordisRoot | undefined;

export function getBuiltinGatewayCordisRoot(): GatewayCordisRoot {
  if (!builtinGatewayCordisRoot || builtinGatewayCordisRoot.disposed) {
    builtinGatewayCordisRoot = createGatewayCordisRoot();
  }
  return builtinGatewayCordisRoot;
}
