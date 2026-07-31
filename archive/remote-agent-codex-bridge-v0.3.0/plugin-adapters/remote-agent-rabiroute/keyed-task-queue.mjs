export class KeyedTaskQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, operation) {
    const normalizedKey = String(key || "");
    if (!normalizedKey) return Promise.reject(new Error("KeyedTaskQueue requires a non-empty key."));
    if (typeof operation !== "function") return Promise.reject(new Error("KeyedTaskQueue requires an operation."));
    const previous = this.tails.get(normalizedKey) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined).finally(() => {
      if (this.tails.get(normalizedKey) === tail) this.tails.delete(normalizedKey);
    });
    this.tails.set(normalizedKey, tail);
    return current;
  }
}
