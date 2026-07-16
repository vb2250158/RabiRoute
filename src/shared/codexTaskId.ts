const codexTaskIdPattern = /^(?:urn:uuid:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Codex task IDs are system-owned UUID values, never user-entered names. */
export function isCodexTaskId(value: unknown): value is string {
  return typeof value === "string" && codexTaskIdPattern.test(value.trim());
}
