/** ASR ordering is independent of the application's conversational target. */
export function orderedAsrWorkers(workers, priority = []) {
  const eligible = workers.filter(worker => worker.capabilities?.includes("asr"));
  const rank = new Map(priority.map((id, index) => [id, index]));
  return eligible.slice().sort((a, b) =>
    (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id));
}

export function selectAsrWorker(workers, priority = [], excluded = []) {
  return orderedAsrWorkers(workers, priority).find(worker => worker.online && !excluded.includes(worker.id)) || null;
}

export function validateAsrPriority(value, workers) {
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== "string" || !id))
    throw new Error("ASR priority must be a list of worker IDs.");
  if (new Set(value).size !== value.length) throw new Error("ASR priority contains duplicate workers.");
  const allowed = new Set(orderedAsrWorkers(workers).map(worker => worker.id));
  if (value.some(id => !allowed.has(id))) throw new Error("ASR worker is unavailable in this application.");
  return value.slice();
}
