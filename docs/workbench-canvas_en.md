English | [简体中文](workbench-canvas.md)

# Workbench canvases

Open a project from My Projects to see its canvas list and choose a canvas. Workbench upgrades legacy projects on first open, keeps their name and identifier, and places their original cards, layout, and prompts in the first canvas. It retains a recoverable copy of the prior record. Flow node settings appear below the selected card. Drag from a Flow Next port to schedule the next node, or link text cards to pass text into other media cards.

Migration backs up the complete original, fences the legacy file against old writers, then commits the new project. Interrupted commits appear as “恢复迁移” in the project list and resume on the original machine. A changed source or backup digest stops recovery and preserves both records.

```text
projects/<projectId>/
  project.json
  canvases/<canvasId>/
    canvas.json
    materials/
  .canvas-index/
```

Each canvas has its own revision and CAS. Editing another canvas does not update the project revision. A conflict preserves unsaved edits for the user to resolve. A committed canvas is saved even if updating its derived summary or thumbnail fails; a pending marker lets the service read the committed version, and maintainers can rebuild the index.

The canvas list is a responsive grid ordered by recent updates and supports name searches. A tile shows its media cover when available. Other visible tiles load node and connection geometry for the requested revision from the thumbnail endpoint. On first opening an older project, the server builds a local pagination index from its summaries. The shared directory keeps at most 64 recent summary updates for other computers to apply. If the project changes during pagination, the interface retains the current cards and asks the user to reload.

Copying a canvas folder includes its definition and private materials. Copy/register operations allocate new identities and remap internal graph references. Junctions, escaping paths and broken references are rejected. Shared models, external assets, machine bindings and templates remain explicit dependencies. Copies do not inherit running processes or execution claims.

## Editing and execution

The graph supports command, agent, human, generate and asset nodes, control edges, variables and group contracts. When a canvas contains media, the media editor shares its revision and stores its draft as a referenced material.

Drag a card's bottom-right handle to resize its preview, or focus the handle and use the arrow keys. The canvas saves the size and updates its connections and minimap.

Flow Next defines execution order. Material ports connect declared outputs to downstream inputs. A node can accept multiple sources. Select it to see, locate, or remove its sources below the card. Nodes and incoming links reflect the live run state.

Control edges use success or completed, with AND joins. Mandatory gate failures stop further dispatch; ordinary failures remain visible in the run result. Default concurrency is one. The unified API accepts explicit concurrency from 1 to 16 and serializes nodes with the same resourceKey.

Saving, exporting and selecting another node apply the current parameter draft. Invalid JSON displays an error and preserves the edits. Save the canvas before running it. Exports include current variables and node positions, and edits made during a save remain unsaved for the next save.

Canvas and run-history pages append to the current list. Logs load 100 entries per request and retain the latest 500 loaded entries in the page. Use the continue-reading control to advance or the restart control to return to the beginning.

Configure trusted machine-local tools and roots in the video component's `workbench-bindings.json`. See the JSON example in the [Chinese guide](workbench-canvas.md). projectsRoot may point to shared storage; without it, the original project root is used. Legacy records stay in their original location until explicit migration. The runtime root must be local. The implicit canvas root resolves to the current canvas folder, allowing references such as `{ "root": "canvas", "path": "materials/brief.txt" }`.

Commands use toolKey, an argv string array, optional timeoutMs and validationOnly. Environment variables are referenced from trusted machine configuration. Processes use the existing ProcessLeaseRegistry with shell disabled and hidden windows. A working directory is not an OS sandbox.

In an Agent node, select a local CLI and then a model it offers. Open **Agent settings** to detect local installations or open official installation instructions. The Manager owns local CLI execution and checks the structured result and declared artifacts.

To use an existing session, configure the exact target (agentAdapter and threadId), source (sourceAgentType and sourceThreadId), and briefRef. The original adapter owns delivery. Formal result JSON contains `status=succeeded` or `status=failed` and a reason. `independentFromNodeId` can require a reviewer task distinct from the author. If the connector confirms that the task has yet to be sent, the run waits for the Agent. After the connection is restored, checking the run can retry that delivery with its original ID and brief. If the outcome is uncertain, checking reads the original receipt.

Generate nodes submit through the original media owner or reference an existing jobId, then await that owner's terminal receipt. Human completion includes the original attemptId, reviewer identity and evidence. All use the same artifact validator.

Drag an output port to another node’s input to connect them; cycles and invalid ports are rejected. Stage layout, basic parameter forms and advanced JSON edit the same graph data.

## Artifacts and recovery

Requirements declare key, root, relative path, type=file, required, minCount and freshness. Only single-level filename wildcards are supported. Every required declaration must pass. Produced artifacts are compared with stable pre-execution hashes; old files, empty directories and missing required results fail. Identical rewrites need attempt-specific write evidence. Validation-only commands bind validated receipts to input hashes.

Runs freeze graphs, variables, resolved templates, bindings and external input hashes. Resume creates a new run and rechecks configuration, inputs and artifact hashes. A changed predecessor invalidates affected descendants. Cancellation waits for confirmed process exit; an unconfirmed stop remains pending after three seconds. Recovery retains resource locks when original execution liveness is unknown.

Versioned project APIs use `/api/video/v2/projects`; run APIs use `/api/video/v2/runs`. They retain Manager authentication and unified discovery. Logs use incremental sequence cursors. Artifact reads require the owning run and opaque artifact ID, then recheck ownership, canonical roots and hashes. Active content is downloaded.

## Material bundles and edition triggers

Import accepts either a plain workflow definition or a bundle `{source,materials}`. Each material has a canvas-relative path, base64 payload and optional sha256. The owner checks size, digest, duplicate paths and ownership before publishing. Reusing an import ID with different content returns 409.

Nodes retain parameterSchema and parameterValues. Typed ordinary parameters become argv; check overrides require a trusted per-machine parameterDocuments binding to the original configuration. Unbound checks remain read-only. Explicit default flags already present in the source argv are preserved.

Trusted root bindings may expand date variables, while argv and briefs use `{root:name}` references. Agent nodes can select exact frozen target/source bindings with agentBindingKey. contextProjection supplies declared fields from upstream structured input. Accepted Agent requests are observed automatically and resume the graph only after formal completion.

Existing schedulers and event callers share `POST /api/video/v2/projects/:projectId/canvases/:canvasId/trigger`, with a stable id, a Hong Kong edition date and optional label. Each template/date creates its own canvas; retrying the same request returns the original run. Query uncertain results through `GET .../canvases/:canvasId/triggers/:id` instead of changing the request identity. The existing automation system retains scheduling ownership.

Use untilSourceNodeId on a trigger, or untilNodeId on run creation, to execute the selected boundary and its complete dependency closure without later production/publication. Template edits leave existing editions unchanged. Production scheduler cutover requires explicit execution ownership handover.

## Acceptance scope

Tests cover independent CAS, interrupted migration, material copies, 5000-summary pagination, graph/parameter rejection, real Node command artifacts, failure propagation, resume, idempotency, cancellation and original Agent receipt queries. Templates, concurrency and the media-owner bridge have matching tests.

The real 15-node collection workflow and three Agents, production, review, publication, cross-machine handover, installed runtime and scheduled entry points require separate acceptance. The legacy news workflow remains authoritative. Import only converts data and reports unresolved contracts. The edition trigger API is implemented; production scheduler cutover still requires acceptance.
