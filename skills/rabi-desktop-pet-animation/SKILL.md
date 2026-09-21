---
name: rabi-desktop-pet-animation
description: Locate, inspect, design, repair, package, and activate Rabi or RabiRoute desktop-pet animations. Use for “桌宠动画在哪”, “Rabi 里实装的”, active-pack or workflow lookup, idle/click/drag/work/sleep actions, random idle behavior, playback or trigger defects, and Rabi desktop-pet pack/runtime updates. Use MiniMax H3 only when the media itself must change.
---

# Rabi Desktop Pet Animation

This skill owns Rabi-specific desktop-pet semantics, source locations, resource packs, Manager contracts, and runtime acceptance. It does not assume that every animation request needs new media.

Resolve disagreements by owner: Manager binding and runtime DTOs answer what is enabled now; the matching `pet-pack.json` answers pack content and behavior; accepted guards and review evidence answer visual identity; code answers trigger/playback behavior. README text, directory recency, runtime cache, screenshots, old logs, and prior chat claims are discovery clues rather than authority for current state.

## Route the Request

Read [the Rabi desktop-pet standard](references/rabi-desktop-pet-standard.md), then choose one mode:

- **Locate or inspect:** questions such as “动画在哪”, “当前实装哪个”, “以前的工作流在哪”, or “这个动作有多少帧” are read-only. Resolve the shared source, authoring intermediate, active Manager binding, and local runtime separately. Do not generate, export, copy, bind, restart, or scan Downloads.
- **Behavior or trigger repair:** click, drag, work-state mapping, random scheduling, wake/sleep timing, cache, or playback latency normally changes Desktop/Manager code or configuration. Do not regenerate art unless evidence shows the media is defective.
- **Recut or re-export:** timing, frame selection, loop seam, transparency, or runtime-size defects should reuse an accepted source clip first.
- **Generate media:** identify the affected action ids and accepted visual anchor, then load `$minimax-h3-character-animation`. Generate only the selected media before returning here for Rabi export and runtime work.
- **Package or activate:** create a new immutable pack, preserve unselected states and behavior unless explicitly changed, then validate through Manager and the installed local Desktop.

## Core Rules

1. Start from the target persona, current binding, accepted baseline pack, and relevant manifest. “Current” and “installed” are runtime questions; do not infer them from the newest directory name.
2. Write the affected action ids and change layer before editing. A local defect must not expand into full regeneration.
3. Define action semantics independently from media: trigger, one-shot or loop, `next`, idle-pool membership, wake behavior, and sleep timing.
4. Adding a random idle is additive unless the user explicitly requests replacement. Preserve the existing pool, interval, and sleep threshold.
5. Never mutate an accepted baseline pack. Export selected changes into a new pack id and copy unselected states byte-for-byte.
6. Shared source and accepted packs live on the workspace truth source. Builds, installed applications, runtime cache, processes, and logs stay on the executing computer's local disk.
7. Do not claim completion at source generation, export, copy, binding, or process start alone. Verify Manager discovery, active binding, real asset retrieval, and visible playback.

## Required Evidence

- Locate mode: exact source path, active pack id when requested, authoring/workflow path, and whether a reported path is source, intermediate, or runtime cache.
- Behavior mode: reproduced symptom, responsible code/config layer, and regression evidence.
- Media mode: selected action ids, accepted anchor, source clip validation, and visual review.
- Pack mode: new pack id, state/frame counts, `loop`/`next`, preserved bytes, and exact `idleBehavior` delta.
- Runtime mode: Manager sees the pack, intended binding is active, an asset returns HTTP `200`, and the installed Desktop reloads and displays it.

Generated H3 video is an intermediate. A runtime cache is not the source of truth. A successful binding patch is not visible playback.
