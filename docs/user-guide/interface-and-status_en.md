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

The sidebar **Current Route** selector is the only selection source. Console, Message Adapters, Rabi Persona, Plans & Memory, Speech Service, and Runtime Diagnostics all use `#/routes/<Route-config-name>/<page>`, with `overview`, `adapters`, `persona`, `knowledge`, `speech`, and `runtime` respectively. Changing Current Route preserves the page type and immediately redirects the URL. To open that Route's **Plans & Memory** directly, use the same Route configuration name with the `knowledge` page, or click **Copy Route knowledge link**:

```text
http://192.168.0.57:8790/#/routes/<Route-config-name>/knowledge?webgui_token=<access-key>
```

The Route configuration name is URL-encoded. Any Route-scoped link selects that Route before rendering the page. Switching the sidebar Route updates the current browser session to the same page type under the new Route. To bookmark, reopen, or share the shortcut with an authorized device on the same LAN, use a complete keyed link rather than the address bar after WebGUI has removed the key.

WebGUI keeps the URL key in the current browser session, automatically applies it to HTTP, SSE, and persona-avatar requests, and removes it from the address bar so later screenshots do not keep exposing it. Rotating the key immediately invalidates old links. The switch and key can be managed only from the Rabi PC running Manager; that PC's redirected LAN address remains manageable, while other devices cannot manage them. If the link times out, first confirm that Manager restarted, then check whether Windows Firewall allows RabiRoute or Node.js TCP `8790` on the private/domain network. Never publish the link in a public chat, log, or repository.

## Access WebGUI remotely through RabiLink

When the Rabi PC has the global RabiLink Relay connection enabled and belongs to the current Relay account, sign in at `https://rabiroute.cottongame.com/manage`, then open:

```text
https://rabiroute.cottongame.com/manage/<account>/<RabiGUID>/#/routes/<Route-config-name>/knowledge
```

The remote entry uses the same page names. Replace `knowledge` with `overview`, `adapters`, `persona`, `speech`, or `runtime` as needed.

Replace the final page with `overview` or another WebGUI route when needed. This remote entry does not use the LAN `webgui_token`; it uses the browser's Relay management login cookie, while the PC worker separately authenticates with its application token. Ordinary APIs, images, attachments, audio, downloads, and byte-range video playback return to the selected PC's loopback Manager, and Manager events refresh through remote SSE. If the shell opens but data, attachments, or live status do not, verify that the target PC is online in Relay, the RabiGUID is correct, and the Relay script plus `ribiwebgui/dist` were published together. Restarting only the local Manager does not update the public Relay.

## The six main areas

| Area | Primary purpose | Common actions |
| --- | --- | --- |
| Console | Routes, current path, Rabi identity, and directories | Add, quick-configure, start, or stop a Route |
| Message Adapters | Message sources and Agent handlers | Scan, add, connect, and bind tasks |
| Rabi Persona | Persona, Route variables, and message rules | Add rules, regexes, and schedules |
| Plans & Memory | Plans, recent memory, consolidated memory, plan guidance, and approval records for the current persona | Search, guide running plans, expand steps, review execution contracts, submit approval feedback, and refresh Manager data |
| Log Diagnostics | Find path breaks and run real tests | Start, restart, trigger, and inspect logs |
| User Guide | Task-based product instructions | Search, change page, and open deeper material |

When Plans & Memory opens, it first requests eight lightweight plan summaries and immediately shows their title, type, status, and ordering. It keeps consuming later summaries in larger background pages even when the user does not scroll. The left directory retains every returned title, while the content area initially mounts only eight cards and appends bounded batches while scrolling. Clicking a directory item that is not mounted creates a bounded forward window starting at that target instead of creating every preceding body card, and later batches no longer insert older cards above the current reading position. Body text, steps, approvals, and attachment metadata hydrate only when cards are genuinely near the viewport; each observer turn promotes only the nearest two cards and runs at most two concurrent detail requests. Each later summary page yields one rendering frame without waiting for body hydration, so heavy cards or attachments cannot delay directory completion. Only cards with a real in-flight detail request show the loading animation; cards that have not approached the viewport use a compact hint instead of instantiating a large skeleton for every plan, and the browser skips layout and paint for off-screen plan cards. The larger memory list starts after the first plan page, while image and video cards show a light `Loading attachment` placeholder instead of a black block until media is ready.

For a running plan outside approval, expanding the card exposes whole-plan guidance. It is associated only with `planId`, not one step; the Agent uses it to continue the plan and adjust not-started steps when needed, then writes a `guidance_response` without `stepId`. Approval plans continue to use the owning step's approval contract and `approval_response`.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 05 | RibiWebGUI layout</strong>
  <span>Suggested frame: the full desktop console with sidebar, top bar, and main content visible.</span>
  <span>Callouts: current Route, six areas, Manager status, Refresh, Add Route, Save.</span>
</div>

The **Plans & Memory** page never reads `data/` directly or reinterprets categories, ordering, status colors, or contract completeness in the browser. Manager supplies shared `Current / Plans / Recent Memory / Archived` membership plus `status / tone / sortBucket / palette`, `counts.stages`, and approval details used by both RibiWebGUI and the Qt tray. Except for paused plans, complete approval contracts sort first and incomplete contracts next, followed by `Awaiting approval → Awaiting QA acceptance → Executing → Awaiting environment/assets/information/external response → Awaiting shared package → Not started → Completed → Archived` and update time. External waits use the amber presentation, while blue `Awaiting shared package` remains current work but sorts below execution and other external waits. Paused plans appear only under Plans with the shared slate palette and always sort last. RibiWebGUI shows a plan's non-duplicate `focus`, and search matches step details, current actions, waiting notes, approval contracts, attachment metadata, memory bodies, and source summaries. Multiple plans remain independently framed, with a sticky external directory that follows the current tab and search result. Running plans outside approval expose whole-plan guidance at the top of expanded details; approval plans instead keep the approval contract inside the Manager-identified step card. User feedback, Agent replies, and system records remain ordered from oldest to newest. Incomplete details are labeled `Approval information incomplete / approval disabled`; approval input, attachments, and submission stay disabled until `ready/enabled=true`.

A step waiting for approval, plan confirmation, or authorization carries a complete `approvalRequest`. Only a complete actionable contract with `responseStatus=pending` makes Manager show `Awaiting approval` and enable the approval entry. An incomplete contract disables formal approval but leaves the presentation at `Executing` for Agent investigation and repair. `Awaiting QA acceptance` requires the current structured `qa-* / verify-*` step. Authoritative `waitingFor` fields may derive `Awaiting environment`, `Awaiting assets`, `Awaiting information`, or `Awaiting external response`; a qualifying current package/build step whose prior work is complete becomes blue `Awaiting shared package`. These are presentation stages and do not add top-level plan lifecycle states.

The `implementation/development validation → Awaiting shared package → Awaiting QA acceptance → complete on QA pass; return to implementation on failure` lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance continue to show their real steps and wait reasons instead of being forced into package or QA stages.

The Agent may also add images, videos, or ordinary files to the plan itself when creating or updating it, including effect previews, demo videos, design drafts, reports, or patches already produced for a plan awaiting approval. Images, videos, and Markdown appear below the plan description in compact, fixed-width 16:9 preview cards that shrink only when the container is narrower. A Markdown card safely reads the beginning of the document and displays a clamped plain-text excerpt; it does not execute HTML, open links, or load images. Clicking it opens the in-page document preview with headings, lists, tables, blockquotes, and code blocks plus a source-download action. Video thumbnails keep a play icon visible before hover or selection, then show an `m:ss` or `h:mm:ss` duration in the lower-right corner after the browser reads media metadata. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Markdown files larger than 2 MiB remain download-only to avoid freezing the browser. The complete-document renderer escapes raw HTML, disables dangerous or relative links, and replaces remote images with text placeholders instead of loading third-party resources from attachment content. Recognized media includes PNG, JPEG, WebP, GIF, MP4/M4V, WebM, Ogg Video, and MOV/QuickTime, with actual video codec support depending on the browser. Other files show name, type, and size and open or download through Manager. The browser never reads a local path from the plan record directly; every attachment crosses the constrained Manager endpoint, and LAN WebGUI automatically applies the current session key to thumbnails, media previews, and file links.

RabiLink remote WebGUI automatically preserves the `/manage/<account>/<RabiGUID>` prefix for thumbnails, media previews, and file links, and forwards byte-range video requests. Do not add the LAN `webgui_token` to a remote URL.

Long plan lists keep the normal page scroll, while only the external plan directory scrolls independently within the viewport. As the plan cards scroll, browser visibility observation updates the directory's current reading item; the directory adjusts its own scroll only when that highlighted item leaves the directory viewport, without continuously scanning the full list on every page-scroll event. A directory click temporarily locks the selected highlight and resumes reading-position observation after smooth scrolling settles, so intermediate cards do not make the cursor jump through the directory. On desktop widths, the plan-view tabs, search field, and refresh action stick immediately below the fixed app bar. Directory jumps reserve the sticky toolbar height so the destination card heading remains visible. Narrow layouts return the toolbar to normal page flow instead of letting a two-row control block occupy the viewport. Detail expansion remains animation-free, and the approval input does not repeatedly auto-grow.

After plan guidance or approval feedback is durably recorded, Agent notification continues in the background. The next draft remains editable while another submission is temporarily disabled, and a nearby status row explains the reason and recovery condition.

## Sidebar: select the current Route first

**Current Route** determines which configuration most pages display and edit. If changes are unsaved, the interface asks before switching.

The count beside the selector is the number of configurations. The selected value and menu items prefer the persona title, while the Route configuration name, disabled state, and adapter combination remain secondary details so multiple Routes for one persona stay distinguishable. When no persona title is available, WebGUI falls back to the Route display name, persona ID, and then configuration name. The status below does not prove that every external platform is authenticated.

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
