English | [简体中文](workbench-canvas.md)

# Workbench canvases

Workbench plugin 0.2.2 separates project metadata from independently saved canvas folders. Existing media projects remain readable. Explicit migration creates a recoverable original and publishes the new directory; reads do not migrate data.

Migration backs up the complete original, fences the legacy file against old writers, then commits the new project. Interrupted commits appear as “恢复迁移” in the project list and resume on the original machine. A changed source or backup digest stops recovery and preserves both records.

```text
projects/<projectId>/
  project.json
  canvases/<canvasId>/
    canvas.json
    materials/
  .canvas-index/
```

Each canvas has its own revision and CAS. Editing another canvas does not update the project revision. A conflict preserves unsaved edits. Lists show 50 summaries per page with server-side search and cursors; graph bodies load when opened.

Copying a canvas folder includes its definition and private materials. Copy/register operations allocate new identities and remap internal graph references. Junctions, escaping paths and broken references are rejected. Shared models, external assets, machine bindings and templates remain explicit dependencies. Copies do not inherit running processes or execution claims.

## Editing and execution

The graph supports command, agent, human, generate and asset nodes, control edges, variables and group contracts. The original media editor shares the canvas revision and stores its draft as a referenced material.

Control edges use success or completed, with AND joins. Mandatory gate failures stop further dispatch; ordinary failures remain visible in the run result. Default concurrency is one. The unified API accepts explicit concurrency from 1 to 16 and serializes nodes with the same resourceKey.

Saving, exporting and selecting another node apply the current parameter draft. Invalid JSON displays an error and preserves the edits. Save the canvas before running it. Exports include current variables and node positions, and edits made during a save remain unsaved for the next save.

Canvas and run-history pages append to the current list. Logs load 100 entries per request and retain the latest 500 loaded entries in the page. Use the continue-reading control to advance or the restart control to return to the beginning.

Configure trusted machine-local tools and roots in the video component's `workbench-bindings.json`. See the JSON example in the [Chinese guide](workbench-canvas.md). projectsRoot may point to shared storage; without it, the original project root is used. Legacy records stay in their original location until explicit migration. The runtime root must be local. The implicit canvas root resolves to the current canvas folder, allowing references such as `{ "root": "canvas", "path": "materials/brief.txt" }`.

Commands use toolKey, an argv string array, optional timeoutMs and validationOnly. Environment variables are referenced from trusted machine configuration. Processes use the existing ProcessLeaseRegistry with shell disabled and hidden windows. A working directory is not an OS sandbox.

Agent nodes require an exact target (agentAdapter and threadId), source (sourceAgentType and sourceThreadId) and briefRef. Existing adapters own execution. Uncertain delivery queries the original ID. Formal result JSON must contain status=succeeded or status=failed and a reason. Acceptance is not completion. independentFromNodeId can require a reviewer task distinct from the author.

Generate nodes submit through the original media owner or reference an existing jobId, then await that owner's terminal receipt. Human completion includes the original attemptId, reviewer identity and evidence. All use the same artifact validator.

## Artifacts and recovery

Requirements declare key, root, relative path, type=file, required, minCount and freshness. Only single-level filename wildcards are supported. Every required declaration must pass. Produced artifacts are compared with stable pre-execution hashes; old files, empty directories and missing required results fail. Identical rewrites need attempt-specific write evidence. Validation-only commands bind validated receipts to input hashes.

Runs freeze graphs, variables, resolved templates, bindings and external input hashes. Resume creates a new run and rechecks configuration, inputs and artifact hashes. A changed predecessor invalidates affected descendants. Cancellation waits for confirmed process exit; an unconfirmed stop remains pending after three seconds. Recovery retains resource locks when original execution liveness is unknown.

Versioned project APIs use `/api/video/v2/projects`; run APIs use `/api/video/v2/runs`. They retain Manager authentication and unified discovery. Logs use incremental sequence cursors. Artifact reads require the owning run and opaque artifact ID, then recheck ownership, canonical roots and hashes. Active content is downloaded.

## Acceptance scope

Tests cover independent CAS, interrupted migration, material copies, 5000-summary pagination, graph/parameter rejection, real Node command artifacts, failure propagation, resume, idempotency, cancellation and original Agent receipt queries. Templates, concurrency and the media-owner bridge have matching tests.

The real 15-node collection workflow and three Agents, production, review, publication, cross-machine handover, installed runtime and scheduled entry points require separate acceptance. The legacy news workflow remains authoritative. Import only converts data and reports unresolved contracts. Scheduled/event canvas execution is not connected yet.
