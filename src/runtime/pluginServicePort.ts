/** A stable reference to the currently published native service, without provider state. */
export function createPluginServicePort<T extends object>(resolve: () => T): T {
  return new Proxy({} as T, {
    get(_target, key) {
      // This is an ordinary service reference, never a thenable or iterator.
      // Runtime result inspection must not resolve an optional provider during startup.
      if (key === "then" || key === Symbol.iterator || key === Symbol.asyncIterator) return undefined;
      if (key === Symbol.toStringTag) return "PluginServicePort";
      const owner = resolve();
      const value = Reflect.get(owner, key, owner);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const current = resolve();
        const method = Reflect.get(current, key, current);
        if (typeof method !== "function") throw new TypeError(`Published service member is not callable: ${String(key)}`);
        return Reflect.apply(method, current, args);
      };
    }
  });
}
