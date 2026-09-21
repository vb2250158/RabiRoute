[English](rabi-desktop-pet-standard.md) | [简体中文](rabi-desktop-pet-standard_zh.md)

# Rabi desktop-pet animation standard

Use this reference for Rabi desktop-pet locations, action semantics, visual anchors, immutable resource packs, and runtime acceptance.

## Location map and lookup order

`RabiRoute/` and `RabiRoute/data/` below denote conceptual project and data locations, not the current working directory on this computer. Resolve them from the actual project and data configuration. `<MediaWorkspace>` is a placeholder for the confirmed media workspace.

For a request asking where an animation, installed action, or old workflow is, check these known owners before any broad search:

1. Shared accepted source packs: `RabiRoute/data/roles/<personaId>/desktop-pet/packs/<packId>/`.
2. Persona authoring and generation records: `RabiRoute/data/roles/<personaId>/designs/desktop-pet/working/`.
3. Rabi desktop-pet overview: `RabiRoute/data/roles/<personaId>/desktop-pet/README.md`.
4. H3 scripts and templates: `<MediaWorkspace>/scripts/` and `<MediaWorkspace>/workflows/`.
5. Manager plugin: `RabiRoute/plugins/builtin/io.rabiroute.manager.desktop-pet/`.
6. Desktop playback implementation: `RabiRoute/desktop/tray-task-window/rabiroute_tray/`.
7. Installed pack/cache: resolve it from the current local installation and Manager runtime DTO. It is a deployment copy, not source truth.

“Installed in Rabi” means query the persona desktop-pet binding first, then match that `packId` in Manager's runtime pack index. The newest source directory is not proof of the active pack.

Treat a persona README's “current package” paragraph as maintained documentation that can lag deployment. If it conflicts with Manager binding or runtime DTOs, report the mismatch and use Manager for the current-state answer; do not silently rewrite history or declare the README authoritative.

Locate mode is read-only. Do not start ComfyUI, run H3, export a pack, rebuild Desktop, change a binding, restart a process, or scan Downloads/the whole workspace unless the user asks for a change and the known owners genuinely do not contain the object.

When answering a location question, label each returned path as one of: accepted source, authoring intermediate, generation workflow, playback implementation, or local runtime copy.

## Decide what must change

| Observed need | Responsible layer | Media generation |
|---|---|---|
| Locate source, active pack, workflow, or frame count | Files plus Manager read APIs | None |
| Click does nothing, wrong state maps, random action never triggers | Desktop/Manager code or configuration | None |
| Playback begins slowly | Runtime client/cache/network path | None unless media size is proven causal |
| Animation is too long, blink cut is poor, transparency is bad | Recut or re-export accepted source | None first |
| One named gesture has wrong motion, anatomy, or return pose | That action's guards and source media | Named action only |
| Add another random idle | New `idle-*` action plus idle-pool update | New action only |
| Identity, costume, proportions, body width, rendering style, canvas, camera, or background anchor changes | Every action sharing that anchor | Affected set; all only if global |

Write the selected action ids and accepted baseline pack before media or pack work. `-All` is never the default response to a local defect.

## Visual anchor

Derive identity from the target persona and accepted guards. Preserve named hair, eyes, ears or species traits, signature accessories, clothing, palette, proportions, and rendering style.

Read the hair, eye, clothing, proportion, and rendering-style constraints from the target persona's approved appearance references. Do not share an unconfirmed appearance baseline across different personas or design lines.

Desktop-pet media normally preserves:

- locked camera and one continuous composition;
- uniform chroma background for bounded transparency export;
- character scale, body center, silhouette width, floor contact, and safe margins;
- both shoes and signature features unless the action explicitly requires occlusion;
- no text, logo, duplicate limb, fused hand/face, extra character, or unexplained prop.

“Preserve character details” preserves observable identity anchors. It does not require painterly shading when the accepted style is flat cel rendering.

## Action semantics

- Base states such as `idle`, `thinking`, `talking`, `sleep`, or `drag` loop only when their motion and seam were designed for looping.
- Interaction and random-idle gestures are normally one-shot: `loop: false` and `next: "idle"`.
- A one-shot gesture returning to rest should begin and end on the accepted idle anchor.
- A real transition may use a different final guard, which must be the accepted target-state anchor.
- Adding a random idle inserts its state id once into `idleBehavior.randomStates`; preserve prior entries and order, avoid duplicates, and preserve the interval, sleep threshold, and sleep state unless explicitly changed.
- Random idle playback does not redefine click behavior, work-state mapping, wake rules, or long-idle sleep timing.

For hands near the face, specify palm direction, target area, features that remain uncovered, finger/wrist consistency, peak gesture, hold, and recovery.

## Media-generation boundary

If source media must be generated or regenerated, load `$minimax-h3-character-animation`. Give it:

- the selected action ids;
- exact first and last guards;
- the persona-specific visual continuity contract;
- canvas/background/camera requirements;
- observable motion and forbidden failure modes;
- seed, frame length, and output directory.

The general H3 skill returns an accepted source clip and evidence. It does not decide Rabi `loop`, `next`, random idle membership, pack ids, runtime installation, or active binding.

## Manifest and export

The Rabi action manifest binds the persona, canvas, generation input, action id, guards, `desktopFrames`, `loop`, source output, and any explicit `idleBehavior` change. Include `idleBehavior` only when the new pack must change it; otherwise inherit it from the accepted baseline.

For an incremental desktop-pet update, the following is a placeholder example, not a verified local command. The example source script's existence and parameters have not been verified for this documentation update. Before using it, confirm the actual media workspace, verify that the source script exists, and check that its supported parameters match the example. This reference does not establish that a pack has been installed or deployed.

```powershell
& <local-python-with-export-dependencies> `
  <MediaWorkspace>/scripts/export_minimax_h3_desktop_pet.py `
  --manifest <action-manifest.json> `
  --pack-directory <new-pack-directory> `
  --pack-id <new-pack-id> `
  --action <action-id> `
  --base-pack <accepted-pack-directory> `
  --target-width 512 `
  --target-height 512
```

Repeat `--action` for multiple changed actions. The required export behavior is to chroma-key accepted source media into transparent RGBA PNG sequences, use each action's `desktopFrames`, preserve unselected state bytes, and refuse to overwrite an existing pack. Verify that the actual exporter meets these requirements. Raw H3 MP4 is never a runtime pack.

After export, compare source and destination manifests and verify persona, canvas, state ids, changed frame counts, `fps`, `loop`, `next`, and `idleBehavior`. Confirm unchanged state files are byte-identical.

## Activation and acceptance

Install runtime assets into the executing computer's local Rabi installation; do not run Desktop or its cache from NAS. Before activation, make Manager discover the local pack and verify persona, pack id, state count, assets, and size limits.

When the request includes activation, update the persona binding through Manager, reload the installed Desktop, then verify:

- the intended pack id is active;
- the changed action has the expected frame count, `fps`, `loop`, and `next`;
- random idle and sleep behavior changed exactly as requested;
- at least one representative asset returns HTTP `200`;
- visible playback matches the accepted media review.

Keep the accepted baseline active when media, export, pack validation, installation, or runtime verification fails. Diagnose at the layer where the evidence fails instead of regenerating everything.
