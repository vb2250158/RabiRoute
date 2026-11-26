// Run-record views that the canvas reads back: which sessions a run used, what
// changed between two frozen graphs, and whether an issue directory still
// matches the hashes the run recorded.
import type { FlowNode, FlowGraph } from "./workbenchEditor";

export type ThreadBinding = { nodeId: string; title: string; agentAdapter: string; threadId: string; instanceBinding?: unknown };

/**
 * §9-3: a run froze exact targets. Read them off the frozen graph, not the live
 * canvas, because the canvas may have been edited since.
 */
export function runThreadBindings(graph: FlowGraph | undefined): ThreadBinding[] {
  if (!graph) return [];
  const rows: ThreadBinding[] = [];
  for (const node of graph.nodes) {
    const target = (node.config ?? {}).target;
    if (!target || typeof target.agentAdapter !== "string" || !target.agentAdapter
      || typeof target.threadId !== "string" || !target.threadId) continue;
    rows.push({ nodeId: node.id, title: node.title || node.id, agentAdapter: target.agentAdapter,
      threadId: target.threadId, ...(target.instanceBinding ? { instanceBinding: target.instanceBinding } : {}) });
  }
  return rows;
}

export type GraphChange = { id: string; title?: string; change: "added" | "removed" | "modified"; fields?: string[] };

/** Fields that describe where and how a node runs; a change here matters for review. */
const comparedFields = ["kind", "title", "enabled", "config", "inputs", "requirements", "layout", "approval"] as const;

function nodeSignature(node: FlowNode) {
  const source: Record<string, unknown> = {};
  for (const field of comparedFields) source[field] = node[field];
  return JSON.stringify(source);
}

/**
 * §9-4: compare the graph a run froze against the previous version so a reviewer
 * can see exactly which nodes appeared, vanished or changed.
 */
export function graphDiff(previous: FlowGraph | undefined, next: FlowGraph | undefined): GraphChange[] {
  const before = new Map((previous?.nodes ?? []).map(node => [node.id, node]));
  const after = new Map((next?.nodes ?? []).map(node => [node.id, node]));
  const changes: GraphChange[] = [];
  for (const [id, node] of after) {
    const old = before.get(id);
    if (!old) { changes.push({ id, title: node.title, change: "added" }); continue; }
    const fields: string[] = [];
    for (const field of comparedFields) {
      if (JSON.stringify(old[field]) !== JSON.stringify(node[field])) fields.push(field);
    }
    if (fields.length) changes.push({ id, title: node.title, change: "modified", fields });
  }
  for (const [id, node] of before) if (!after.has(id)) changes.push({ id, title: node.title, change: "removed" });
  return changes;
}

export type ArtifactClaim = { key?: string; path: string; sha256?: string; bytes?: number };
export type ArtifactCheck = { path: string; expected?: string; actual?: string; state: "ok" | "mismatch" | "missing" | "unrecorded" };

/**
 * §9-5: given what a run recorded and what is on disk now, report which files
 * disagree. A file the run never recorded is reported, not silently accepted:
 * an unexpected writer is exactly what this check exists to catch.
 */
export function verifyArtifactHashes(recorded: readonly ArtifactClaim[],
  observed: readonly { path: string; sha256?: string }[]): { checks: ArtifactCheck[]; ok: boolean } {
  const onDisk = new Map(observed.map(row => [row.path, row.sha256]));
  const checks: ArtifactCheck[] = [];
  for (const claim of recorded) {
    const actual = onDisk.get(claim.path);
    if (actual === undefined) { checks.push({ path: claim.path, expected: claim.sha256, state: "missing" }); continue; }
    if (typeof claim.sha256 !== "string" || !claim.sha256) { checks.push({ path: claim.path, actual, state: "unrecorded" }); continue; }
    checks.push({ path: claim.path, expected: claim.sha256, actual, state: actual === claim.sha256 ? "ok" : "mismatch" });
  }
  const recordedPaths = new Set(recorded.map(row => row.path));
  for (const row of observed) if (!recordedPaths.has(row.path)) checks.push({ path: row.path, actual: row.sha256, state: "unrecorded" });
  return { checks, ok: checks.every(check => check.state === "ok") };
}

export type DraftBanner = { kind: "draft" | "conflict"; text: string; actions: { id: "restore" | "diff" | "discard"; label: string }[] };

/**
 * §8-2: one line instead of three stacked alerts; the destructive action lives
 * behind the same dropdown so the banner itself never invites a mis-click.
 */
export function draftBanner(input: { dirty: boolean; conflict: boolean; failure?: string }): DraftBanner | undefined {
  if (input.conflict) {
    return { kind: "conflict", text: "此画布已被其他端更新，你的编辑仍在本页。",
      actions: [{ id: "restore", label: "恢复我的编辑" }, { id: "diff", label: "查看改动" }, { id: "discard", label: "丢弃我的编辑" }] };
  }
  if (input.failure) return { kind: "conflict", text: input.failure, actions: [{ id: "diff", label: "查看改动" }, { id: "discard", label: "丢弃我的编辑" }] };
  if (input.dirty) return { kind: "draft", text: "有未保存的修改。", actions: [{ id: "restore", label: "恢复" }, { id: "diff", label: "查看改动" }, { id: "discard", label: "丢弃" }] };
  return undefined;
}
