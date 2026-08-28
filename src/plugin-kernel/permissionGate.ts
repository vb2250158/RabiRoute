function normalizedPermission(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9._:-]*$/.test(normalized)) throw new Error(`Plugin permission is invalid: ${value}.`);
  return normalized;
}

export class GrantedPermissions {
  readonly #granted: ReadonlySet<string>;
  constructor(requested: readonly string[], granted: readonly string[]) {
    const allowed = new Set(granted.map(normalizedPermission));
    const normalizedRequested = requested.map(normalizedPermission);
    const denied = normalizedRequested.filter(permission => !allowed.has(permission));
    if (denied.length) throw new Error(`Plugin permissions were not granted: ${denied.join(", ")}.`);
    this.#granted = new Set(normalizedRequested);
  }
  has(permission: string): boolean { return this.#granted.has(normalizedPermission(permission)); }
  require(permission: string): void {
    const normalized = normalizedPermission(permission);
    if (!this.#granted.has(normalized)) throw new Error(`Plugin permission is required: ${normalized}.`);
  }
  list(): readonly string[] { return Object.freeze([...this.#granted].sort()); }
}
