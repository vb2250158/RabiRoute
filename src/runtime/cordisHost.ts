import * as cordis from "cordis";

export type RabiCordisFiber = {
  await(): Promise<RabiCordisFiber>;
  dispose(): Promise<void>;
};

export type RabiCordisDisposer = () => void | Promise<void>;

export type RabiCordisEffect = RabiCordisDisposer & PromiseLike<RabiCordisDisposer>;

export type RabiCordisContext = {
  fiber: RabiCordisFiber;
  plugin(plugin: RabiCordisPlugin): RabiCordisFiber;
  get(name: string, strict?: boolean): unknown;
  provide(name: string, value?: unknown): () => void;
  effect(
    execute: () => RabiCordisDisposer | Promise<RabiCordisDisposer>,
    label?: string
  ): RabiCordisEffect;
};

export type RabiCordisPlugin = {
  name?: string;
  inject?: string[];
  apply(ctx: RabiCordisContext): unknown;
};

type CordisModule = {
  Context: new () => RabiCordisContext;
};

// cordis@4.0.0-rc.8 publishes NodeNext-incompatible extensionless
// declaration re-exports. Keep the compatibility cast inside this wrapper so
// the rest of RabiRoute depends only on the narrow lifecycle surface it uses.
const CordisContext = (cordis as unknown as CordisModule).Context;

export class RabiCordisHost {
  readonly context = new CordisContext();

  async mount(plugin: RabiCordisPlugin): Promise<RabiCordisFiber> {
    const fiber = this.context.plugin(plugin);
    try {
      await fiber.await();
      return fiber;
    } catch (error) {
      await fiber.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.context.fiber.dispose();
  }
}
