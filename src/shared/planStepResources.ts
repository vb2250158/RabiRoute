/** Agent-reported file changes retained on their owning plan step. */
export type PlanStepResourceRecord = {
  id: string;
  sessionId: string;
  time: string;
  resources: Array<{ path: string; change: "added" | "modified" | "deleted"; summary: string; sha256?: string; attribution: "agent-reported" | "tool-observed" }>;
};

/** Validate persisted or API-supplied resource records without changing step prose. */
export function normalizePlanStepResources(value: unknown): PlanStepResourceRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Step resource records must be an array.");
  const ids = new Set<string>();
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("Invalid step resource record.");
    const record = entry as Record<string, unknown>;
    if (!text(record.id) || ids.has(record.id) || !text(record.sessionId) || !text(record.time) || !Number.isFinite(Date.parse(record.time)) || !Array.isArray(record.resources)) throw new Error("Invalid step resource identity.");
    ids.add(record.id);
    const resources = record.resources.map((entry: unknown) => {
      if (!entry || typeof entry !== "object") throw new Error("Invalid changed resource.");
      const resource = entry as Record<string, unknown>;
      if (!text(resource.path) || !text(resource.summary) || !["added", "modified", "deleted"].includes(String(resource.change)) || !["agent-reported", "tool-observed"].includes(String(resource.attribution))) throw new Error("Invalid changed resource fields.");
      if (resource.sha256 !== undefined && (typeof resource.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(resource.sha256))) throw new Error("Invalid resource digest.");
      return { path: resource.path, change: resource.change as "added" | "modified" | "deleted", summary: resource.summary, attribution: resource.attribution as "agent-reported" | "tool-observed", ...(resource.sha256 ? { sha256: resource.sha256 as string } : {}) };
    });
    return { id: record.id, sessionId: record.sessionId, time: record.time, resources };
  });
}
