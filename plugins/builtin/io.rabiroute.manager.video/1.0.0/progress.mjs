/** Provider progress is per node, never a percentage of the whole video. */
export function readProgressEvent(job, workflow, stages, type, data) {
  if (type !== "executing" && type !== "progress") return null;
  const node = data?.node == null ? (type === "progress" ? job.progressNode : undefined) : String(data.node);
  if (!node || !workflow[node]) return null;
  const stage = stages?.[workflow[node].class_type] || { label: "处理素材" };
  const patch = { progressNode: node, progressStage: stage.label, progressUnit: stage.unit || "", progress: 0, progressValue: null, progressMax: null };
  if (type === "executing") return node === job.progressNode ? null : patch;
  if (!Number.isFinite(data.value) || !Number.isFinite(data.max) || data.max <= 0 || data.value < 0) return null;
  return { ...patch, progress: Math.min(1, data.value / data.max), progressValue: Math.min(data.value, data.max), progressMax: data.max };
}
