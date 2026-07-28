<!-- docs-language-switch -->
<div align="center">
English | <a href="./interface-and-status.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Interface and status

RibiWebGUI is RabiRoute's local control console. It edits configuration, invokes Manager actions, and shows diagnostics. Local files and runtime state remain the underlying sources of truth.

## Access WebGUI from the LAN

Manager on the Rabi PC is RibiWebGUI's complete HTTP backend. The default `http://127.0.0.1:8790/` is local-only. On another device, `127.0.0.1` points back to that device, not to the Rabi PC.

On the Rabi PC, open **Console → Directory configuration → LAN WebGUI access**, enable access, and generate a key. After restarting Manager, a WebGUI still opened locally through `localhost/127.0.0.1` automatically redirects to the preferred LAN IP while preserving the current Route, page, and authentication. You can also copy the generated link, for example:

An HTTP LAN page may not receive secure browser clipboard permission. Copy-link, copy-key, and other WebGUI copy actions try the Clipboard API first and automatically fall back to an in-page copy operation when that API is unavailable or rejected. A manual-copy message appears only when the browser rejects both mechanisms.

```text
http://192.168.0.57:8790/#/routes/<Route-config-name>/overview?webgui_token=<access-key>
```

The sidebar **Current Route** selector is the only selection source. Changing it on the Console, Message Adapters, Persona, or Plans & Memory page immediately redirects the corresponding Route-scoped page URL; the Console page uses `overview`. To open that Route's **Plans & Memory** directly, use the same Route configuration name with the `knowledge` page, or click **Copy Route knowledge link**:

```text
http://192.168.0.57:8790/#/routes/<Route-config-name>/knowledge?webgui_token=<access-key>
```

The Route configuration name is URL-encoded. The link selects that Route before rendering the page. Switching the sidebar Route while on this page also updates the scoped knowledge path for the current browser session. To bookmark, reopen, or share the shortcut with an authorized device on the same LAN, use the complete keyed link copied by the Console rather than the address bar after WebGUI has removed the key.

WebGUI keeps the URL key in the current browser session, automatically applies it to HTTP, SSE, and persona-avatar requests, and removes it from the address bar so later screenshots do not keep exposing it. Rotating the key immediately invalidates old links. The switch and key can be managed only from the Rabi PC running Manager; that PC's redirected LAN address remains manageable, while other devices cannot manage them. If the link times out, first confirm that Manager restarted, then check whether Windows Firewall allows RabiRoute or Node.js TCP `8790` on the private/domain network. Never publish the link in a public chat, log, or repository.

## Access WebGUI remotely through RabiLink

When the Rabi PC has the global RabiLink Relay connection enabled and belongs to the current Relay account, sign in at `https://rabiroute.cottongame.com/manage`, then open:

```text
https://rabiroute.cottongame.com/manage/<account>/<RabiGUID>/#/routes/<Route-config-name>/knowledge
```

Replace the final page with `overview` or another WebGUI route when needed. This remote entry does not use the LAN `webgui_token`; it uses the browser's Relay management login cookie, while the PC worker separately authenticates with its application token. Ordinary APIs, images, attachments, audio, downloads, and byte-range video playback return to the selected PC's loopback Manager, and Manager events refresh through remote SSE. If the shell opens but data, attachments, or live status do not, verify that the target PC is online in Relay, the RabiGUID is correct, and the Relay script plus `ribiwebgui/dist` were published together. Restarting only the local Manager does not update the public Relay.

## The six main areas

| Area | Primary purpose | Common actions |
| --- | --- | --- |
| Console | Routes, current path, Rabi identity, and directories | Add, quick-configure, start, or stop a Route |
| Message Adapters | Message sources and Agent handlers | Scan, add, connect, and bind tasks |
| Rabi Persona | Persona, Route variables, and message rules | Add rules, regexes, and schedules |
| Plans & Memory | Plans, recent memory, consolidated memory, and approval records for the current persona | Search, expand steps, review execution contracts, submit feedback for approval steps, and refresh Manager data |
| Log Diagnostics | Find path breaks and run real tests | Start, restart, trigger, and inspect logs |
| User Guide | Task-based product instructions | Search, change page, and open deeper material |

After approval feedback is submitted, the Agent updates the affected plan or step and writes its user-facing explanation back to that plan as an `approval_response`. The Codex task retains only a short processing status and is not the delivery surface for the response body.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 05 | RibiWebGUI layout</strong>
  <span>Suggested frame: the full desktop console with sidebar, top bar, and main content visible.</span>
  <span>Callouts: current Route, six areas, Manager status, Refresh, Add Route, Save.</span>
</div>

The **Plans & Memory** page never reads `data/` directly or reinterprets categories, ordering, status colors, or contract completeness in the browser. Manager supplies shared `Current / Plans / Recent Memory / Archived` membership, presentation status, one palette, and approval details used by both RibiWebGUI and the Qt tray. Except for paused plans, approval-ready cards sort first, incomplete contracts next, then display status and update time. Paused plans appear only under Plans with the shared slate palette and always sort last. RibiWebGUI shows a plan's `focus` below its title when it differs from the title; legacy title fallbacks are not duplicated. Multiple plans are separated by a neutral gutter and independent framed surfaces, and each card shows its ordinal within the current filtered result. Inside a card, the visual hierarchy is explicitly `issue title and description -> current step and timing -> expanded execution plan`, so adjacent plans and internal steps no longer share one visual plane. Expanded in-progress steps show only the Manager-recorded start time, completed steps show only the completion time, and not-started steps show no time. A sticky floating plan directory sits outside the plan panel and lists plans visible under the current tab and search query. Each entry uses one line with the Manager-owned status label first and a compact title after removing consecutive leading `[...]` category prefixes; per-item sequence numbers remain hidden. The directory scrolls within the viewport, while plan cards remain in the normal page flow; selecting a directory title smoothly scrolls to and focuses the matching card, whose full original title remains unchanged. On narrow layouts the directory moves above the panel; no duplicate directory is added inside an individual plan card. The approval contract expands directly inside the step card identified by Manager and lists the full approval materials and receipt state. User feedback, Agent replies, and system records stack vertically from oldest to newest, each retaining its own space; a new reply never replaces an earlier opinion, and the next feedback input remains below the record list. Incomplete details remain labeled `Approval information incomplete / approval disabled`, and formal approval stays unavailable. The feedback field, attachments, and submission remain available as `Add details / request changes`, so the user can ask the Agent to complete provenance, scope, or other contract fields. Such feedback is not treated as approval; normal approval feedback returns only after the contract is complete. Feedback accepts ordinary files from the picker and clipboard images pasted with `Ctrl+V` inside the input. The page shows image thumbnails or file cards and lets the user remove them before submission. A request may contain up to 8 attachments, limited to 10 MiB each and 25 MiB in total. After entering feedback, press `Enter` to submit or `Shift+Enter` for a new line; Enter used to confirm an IME candidate does not submit. After a button or keyboard submission, loading ends as soon as the feedback is durably recorded; Agent notification continues in the background, terminal state refreshes only that card, and failure restores the submitted text and attachments for retry instead of reloading all plans and memory.

A step waiting for approval, plan confirmation, or authorization must explicitly set `isBlocked=true` and name who must approve what in `blockedBy`. The secretary keeps following up, but the business task is not repeatedly dispatched for implementation. QA, missing materials, and external artifacts are not blocked automatically. `Awaiting QA` requires the current structured `qa-* / verify-*` step; an implementation step remains `In progress` even when its prose mentions a QA gate or says QA has not been notified. An incomplete approval contract is shown as `Approval information incomplete / approval disabled`.

The Agent may also add images, videos, or ordinary files to the plan itself when creating or updating it, including effect previews, demo videos, design drafts, reports, or patches already produced for a plan awaiting approval. Images, videos, and Markdown appear below the plan description in compact, fixed-width 16:9 preview cards that shrink only when the container is narrower. A Markdown card safely reads the beginning of the document and displays a clamped plain-text excerpt; it does not execute HTML, open links, or load images. Clicking it opens the in-page document preview with headings, lists, tables, blockquotes, and code blocks plus a source-download action. Video thumbnails keep a play icon visible before hover or selection, then show an `m:ss` or `h:mm:ss` duration in the lower-right corner after the browser reads media metadata. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Markdown files larger than 2 MiB remain download-only to avoid freezing the browser. The complete-document renderer escapes raw HTML, disables dangerous or relative links, and replaces remote images with text placeholders instead of loading third-party resources from attachment content. Recognized media includes PNG, JPEG, WebP, GIF, MP4/M4V, WebM, Ogg Video, and MOV/QuickTime, with actual video codec support depending on the browser. Other files show name, type, and size and open or download through Manager. The browser never reads a local path from the plan record directly; every attachment crosses the constrained Manager endpoint, and LAN WebGUI automatically applies the current session key to thumbnails, media previews, and file links.

RabiLink remote WebGUI automatically preserves the `/manage/<account>/<RabiGUID>` prefix for thumbnails, media previews, and file links, and forwards byte-range video requests. Do not add the LAN `webgui_token` to a remote URL.

Long plan lists keep the normal page scroll, while only the external plan directory scrolls independently within the viewport. As the plan cards scroll, browser visibility observation updates the directory's current reading item; the directory adjusts its own scroll only when that highlighted item leaves the directory viewport, without continuously scanning the full list on every page-scroll event. A directory click temporarily locks the selected highlight and resumes reading-position observation after smooth scrolling settles, so intermediate cards do not make the cursor jump through the directory. On desktop widths, the plan-view tabs, search field, and refresh action stick immediately below the fixed app bar. Directory jumps reserve the sticky toolbar height so the destination card heading remains visible. Narrow layouts return the toolbar to normal page flow instead of letting a two-row control block occupy the viewport. Detail expansion remains animation-free, and the approval input does not repeatedly auto-grow.

After approval feedback is durably recorded, Agent notification continues in the background. During that delivery, the field, pasted images, and new attachments remain editable; only another submission is temporarily disabled, and a nearby status row explains why. The same row explains an unavailable approval entry, an active save, or a missing Route and tells the user how the control will recover instead of showing unexplained disabled controls.

## Sidebar: select the current Route first

**Current Route** determines which configuration most pages display and edit. If changes are unsaved, the interface asks before switching.

The count beside the selector is the number of configurations. The status below combines lifecycle and adapter labels; it does not prove that every external platform is authenticated.

The footer contains four supporting actions:

- **Quick setup**: configure common paths in three steps.
- **GitHub**: open the repository.
- **User Guide**: open this task-based documentation center.
- **Open config directory**: open the local Manager configuration location.

## Top bar: connection, save, and refresh differ

`Manager connected` only means the browser can reach the Manager. It does not mean the Route, NapCat, or Codex task is ready.

| Control | Actual effect |
| --- | --- |
| 中 / EN | Changes this browser's interface language only |
| Refresh status | Reloads Manager, configuration, and runtime state; does not save edits |
| Add Route | Creates a Route and opens Quick setup |
| Save configuration | Writes the current edits and may synchronize or reload the Route |

When the unsaved-changes notice appears, save before switching Routes or leaving. Refresh is not Save, and Restart does not save form edits.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 06 | Top-bar status and unsaved notice</strong>
  <span>Suggested frame: a close view of the unsaved notice, locale menu, Manager state, Refresh, and Save.</span>
  <span>Callouts: connection is not Route health; Refresh is not Save.</span>
</div>

## Common runtime states

| State | Meaning | Next check |
| --- | --- | --- |
| Running | A Route that needs a child process has started | Check source and handler connectivity |
| Enabled | The Route is enabled but its current entry is Manager-owned | Check the corresponding Manager entry |
| Stopped | Configuration exists but the child process is not running | Start it or inspect errors in Log Diagnostics |
| Disabled | The Route or its message input is off | Enable intentionally, then save |
| Manager disconnected | WebGUI cannot reach the local Manager | Check the process, port, and startup directory |

An **Experimental** badge is not itself an error. It means a code path exists, while the external system or real-device loop still needs acceptance in your environment.

## Start, stop, restart, and delete

- **Start** begins the current Route's runtime entry.
- **Stop** ends the Route process without deleting configuration or history.
- **Restart** stops and starts it again after build or connection changes.
- **Delete** removes Route configuration and has a wider impact than Stop.

The Manager supervises Route processes that it starts. External programs such as NapCat, QQNT, and Codex/ChatGPT Desktop keep their own lifecycles.

## Locale boundaries

Locale is stored in this browser. Route/persona IDs, rule names, templates, regexes, task names, paths, tokens, logs, and runtime values stay unchanged.

The User Guide selects the matching language file. Developer documents, code paths, and external pages open through links; RabiRoute does not maintain a third machine-translated source.

## Continue

- No successful delivery yet: [Run your first Route](first-route_en.md).
- Unsure which source to choose: [Routes and message adapters](routes-and-adapters_en.md).
- Status looks healthy but delivery fails: [Operations, logs, and troubleshooting](operations-and-troubleshooting_en.md).
