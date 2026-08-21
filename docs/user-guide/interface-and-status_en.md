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

The sidebar **Current Route** selector is the only selection source. Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, and Runtime Diagnostics all use `#/routes/<Route-config-name>/<page>`, with `overview`, `adapters`, `persona`, `knowledge`, `speech`, and `runtime` respectively. Changing Current Route preserves the page type and immediately redirects the URL. **Performance** and **Settings** are host-wide pages and do not change with the selected Route. To open that Route's **Plans & Memory** directly, use the same Route configuration name with the `knowledge` page, or click **Copy Route knowledge link**:

Clicking any sidebar page label updates the selected state, top title, and URL first, then immediately shows **Page switched. Loading content…**. Console, Message Adapters, Persona Configuration, Plans & Memory, Speech Service, Performance, Runtime Diagnostics, and Settings load their page code and data asynchronously instead of delaying the tab switch until the complete page is ready. If a page chunk fails to load, WebGUI refreshes once and restores the intended page.

```text
http://192.168.0.57:8790/#/routes/<Route-config-name>/knowledge?webgui_token=<access-key>
```

The Route configuration name is URL-encoded. Any Route-scoped link selects that Route before rendering the page. Switching the sidebar Route updates the current browser session to the same page type under the new Route. To bookmark, reopen, or share the shortcut with an authorized device on the same LAN, use a complete keyed link rather than the address bar after WebGUI has removed the key.

WebGUI keeps the URL key in the current browser session, automatically applies it to HTTP, SSE, and persona-avatar requests, and removes it from the address bar so later screenshots do not keep exposing it. Rotating the key immediately invalidates old links. The switch and key can be managed only from the Rabi PC running Manager; that PC's redirected LAN address remains manageable, while other devices cannot manage them. If the link times out, first confirm that Manager restarted, then check whether Windows Firewall allows RabiRoute or Node.js TCP `8790` on the private/domain network. Never publish the link in a public chat, log, or repository.

Requests from the Rabi PC to its own LAN address are still treated as local requests. Enabling LAN access therefore does not make message sending, the tray, or local tools on that same PC require the WebGUI key. Other devices must still use the complete link with a valid key.

## Access WebGUI remotely through RabiLink

When the Rabi PC has the global RabiLink Relay connection enabled and belongs to the current Relay account, sign in at `https://rabiroute.cottongame.com/manage`, then open:

```text
https://rabiroute.cottongame.com/manage/<account>/<RabiGUID>/#/routes/<Route-config-name>/knowledge
```

The remote entry uses the same Route page names. Replace `knowledge` with `overview`, `adapters`, `persona`, `speech`, or `runtime` as needed. Settings uses the host-wide `#/settings` path, and Performance uses the host-wide `/performance` path.

Replace the final page with `overview` or another WebGUI route when needed. This remote entry does not use the LAN `webgui_token`; it uses the browser's Relay management login cookie, while the PC worker separately authenticates with its application token. Ordinary APIs, images, attachments, audio, downloads, and byte-range video playback return to the selected PC's loopback Manager, and Manager events refresh through remote SSE. If the shell opens but data, attachments, or live status do not, verify that the target PC is online in Relay, the RabiGUID is correct, and the Relay script plus `ribiwebgui/dist` were published together. Restarting only the local Manager does not update the public Relay.

## The main pages

| Area | Primary purpose | Common actions |
| --- | --- | --- |
| Console | View and operate each Route | Add, enable, restart, or delete a Route |
| Message Adapters | Message sources and Agent handlers | Scan, add, connect, and bind tasks |
| Persona Configuration | Persona, Route variables, and message rules | Add rules, regexes, and schedules |
| Plans & Memory | Plans, recent memory, consolidated memory, plan guidance, and approval records for the current persona | Search, guide running plans, expand steps, review execution contracts, submit approval feedback, and refresh Manager data |
| Speech Service | Host TTS, ASR, microphone, and playback | Inspect status, adjust parameters, and test speech |
| Performance | Manager, Route, and speech-service runtime metrics | Inspect live state and history |
| Log Diagnostics | Find path breaks and run real tests | Start, restart, trigger, and inspect logs |
| Settings | Host identity, RabiLink, directories, LAN access, and desktop entry points | Configure screenshots, the selected-text menu, login startup, access keys, and access links |
| User Guide | Task-based product instructions | Search, change page, and open deeper material |

When Plans & Memory opens, it first requests eight lightweight plan summaries and fetches the complete details for the first two visible cards in parallel before mounting those cards, so the first screen does not pause on `Loading plan details`. Without requiring scroll, it then completes the selected plan category in background pages of up to 50 summaries and completes the visible memory category in pages of up to 100 items. The page keeps the loaded and total counts visible. These background requests pause while the tab is hidden; when the tab becomes visible again, the page refreshes and resumes completion. The left directory retains every returned title, while the content area initially mounts only eight plan cards and 24 memory cards, then appends bounded batches while scrolling. Clicking a directory item that is not mounted creates a bounded forward window starting at that target and gives that plan's detail request highest priority; the current Manager and LAN environment uses a one-second interactive detail budget. The page does not create every preceding body card at once. Scrolling down renders later plans, while scrolling up restores earlier plans in bounded batches and keeps the current card at the same viewport position. Other body text, steps, approvals, and attachment metadata hydrate only when cards are genuinely near the viewport; each observer turn promotes only the nearest two cards and runs at most two concurrent detail requests. Each later summary page yields one rendering frame without waiting for body hydration, so heavy cards or attachments cannot delay directory completion. Only cards with a real in-flight detail request show the loading animation; cards that have not approached the viewport use a compact hint instead of instantiating a large skeleton for every plan, and the browser skips layout and paint for off-screen cards. Image and video cards show a light `Loading attachment` placeholder instead of a black block until media is ready.

The page reads Codex Desktop state only when the user expands a plan, and after a page refresh it checks only plans that remain expanded. It no longer starts a state scan for every loaded plan. One plan is not requested twice in the same pass, and each read has a three-second limit. Expanded details show the Task Agent, the Plan Secretary when enabled, each Agent's work state, and the matching Codex task state. A missing task has its own `Task Agent session is missing` label. A valid non-working binding can be located or awakened in Codex from the card or Agent row; this opens only the exact task ID and sends no message or replacement task.

For a running plan outside approval, expanding the card exposes whole-plan guidance. It is associated only with `planId`, not one step; the Agent uses it to continue the plan and adjust not-started steps when needed, then writes a `guidance_response` without `stepId`. Approval plans continue to use the owning step's approval contract and `approval_response`.

Choose the current Route in the sidebar, then check the Manager connection in the top bar. Use the Console or Log diagnostics runtime state to decide whether that Route is running.

The **Plans & Memory** page never reads `data/` directly or reinterprets Manager presentation. Non-terminal cards expose only green `In progress`, blue `Awaiting package`, purple `Awaiting QA`, gray `Paused`, red `Awaiting approval`, and orange `Awaiting manual verification`. External information, accounts, devices, owners, authorization, and receipts remain internal plan details instead of status labels. RibiWebGUI and the Qt tray consume the same Manager DTO, palette, counts, and order.

The current-step summary now shows the step's `detail` description directly below its title, so users can see what the step requires without opening the full execution plan. Steps without a description do not render an empty placeholder.

The directory never introduces horizontal scrolling for the whole panel. The trailing sort label remains fixed while an overflowing title moves at a constant speed on pointer hover or keyboard focus. Reduced-motion preferences disable title movement. Choices in the list dialog remain drafts until **Done**. Closing the dialog leaves the current list unchanged; **Done** closes it and immediately calls the complete plan list once with the selected Manager-side sort and filters, updating directory and content cards together.

The dialog includes both status filters and plan `keywords` tags. Each group supports multiple selections with OR matching inside the group; a plan must match both groups. The tag section is searchable. The trigger and result summary show the active filter count, with per-group clear actions and **Clear filters**. Narrow screens stack the groups into one column, and checkbox and action targets remain at least 44px.

When Plans & Memory is opened directly, the page loads memory counts in parallel, so the Recent Memory, Consolidated Memory, and Archived tab numbers do not wait for the user to open those tabs. Each Recent Memory card shows both its recorded time and its last true recall-hit time; a memory that has never matched a message says `Not recalled yet`. Archived source-memory cards show the recorded time and archive time. Memory bodies render as Markdown with headings, lists, code, links, and HTTP(S) images; local absolute paths and dangerous protocols are not loaded. A memory card is capped at 512px. Extra body content is clipped without an internal card scrollbar, and **View details** opens the complete memory in a separate dialog. When the least-active memory is less than 24 hours away from the 72-hour trigger, a separate consolidation panel appears above the list with the remaining time, the memory that will trigger the run, and the expected candidate count. Candidate cards are marked. At zero, Manager automatically creates and delivers the batch; the page does not need to remain open. The cohort is frozen to memories already beyond 24 hours at the original 72-hour trigger, so late execution does not append later boundary crossings. Manager derives and caches the booleans; the browser neither treats a direct view as a recall nor recalculates the candidate set.

A complete actionable `approvalRequest` with `responseStatus=pending` produces red `Awaiting approval`; an incomplete contract remains green `In progress`. A content-changing plan becomes blue `Awaiting package` after applicable sync, commit, and conflict-free readback. Proven package inclusion produces purple `Awaiting QA`. A development-closed `manual-verify-*` step produces orange `Awaiting manual verification`. A plan with no safe action becomes gray `Paused`, while `waitingFor` keeps the exact internal reason.

Available CLI, static checks, fallback validation, retries, sending, or coordination stay green `In progress`. A completed delivery gate that only lacks package identity or inclusion proof is blue `Awaiting package`; proven inclusion is purple `Awaiting QA`. Test infrastructure, assets, documents, owner replies, renewed authorization, or external receipts produce gray `Paused` only when no safe action remains, and their exact reason stays outside the status badge.

The `implementation/development validation/applicable sync and commit → Awaiting package → Awaiting QA → complete on QA pass; return to implementation on failure` lifecycle applies only to plans that change project content such as code, prefabs, assets, or configuration. Investigation, design review, operations, information gathering, external dependencies, and control-plane maintenance continue to show their real steps and wait reasons instead of being forced into package or QA stages.

A quoted **claim** in the work group only means that the Agent publicly took ownership. For the matching item to appear under Plans & Memory, managed registration must also validate the source message, verified claim receipt, unique plan, unique business task, two deduplication passes, and the same workspace across all three records. A successful claim with failed registration has not entered the managed plan lifecycle.

The Agent may also add images, videos, or ordinary files to the plan itself when creating or updating it, including effect previews, demo videos, design drafts, reports, or patches already produced for a plan awaiting approval. Images, videos, and Markdown appear below the plan description in compact, fixed-width 16:9 preview cards that shrink only when the container is narrower. A Markdown card safely reads the beginning of the document and displays a clamped plain-text excerpt; it does not execute HTML, open links, or load images. Clicking it opens the in-page document preview with headings, lists, tables, blockquotes, and code blocks plus a source-download action. Video thumbnails keep a play icon visible before hover or selection, then show an `m:ss` or `h:mm:ss` duration in the lower-right corner after the browser reads media metadata. Images open in an in-page large-image preview, while videos open in an in-page player with controls. Markdown files larger than 2 MiB remain download-only to avoid freezing the browser. The complete-document renderer escapes raw HTML, disables dangerous or relative links, and replaces remote images with text placeholders instead of loading third-party resources from attachment content. Recognized media includes PNG, JPEG, WebP, GIF, MP4/M4V, WebM, Ogg Video, and MOV/QuickTime, with actual video codec support depending on the browser. Other files show name, type, and size and open or download through Manager. The browser never reads a local path from the plan record directly; every attachment crosses the constrained Manager endpoint, and LAN WebGUI automatically applies the current session key to thumbnails, media previews, and file links.

RabiLink remote WebGUI automatically preserves the `/manage/<account>/<RabiGUID>` prefix for thumbnails, media previews, and file links, and forwards byte-range video requests. Do not add the LAN `webgui_token` to a remote URL.

Long plan lists keep the normal page scroll, while only the external plan directory scrolls independently within the viewport. As the plan cards scroll, browser visibility observation updates the directory's current reading item; the directory adjusts its own scroll only when that highlighted item leaves the directory viewport, without continuously scanning the full list on every page-scroll event. A directory click temporarily locks the selected highlight and resumes reading-position observation after smooth scrolling settles, so intermediate cards do not make the cursor jump through the directory. On desktop widths, the plan-view tabs, search field, and refresh action stick immediately below the fixed app bar. Directory jumps reserve the sticky toolbar height so the destination card heading remains visible. Narrow layouts return the toolbar to normal page flow instead of letting a two-row control block occupy the viewport. Detail expansion remains animation-free, and the approval input does not repeatedly auto-grow.

After plan guidance or approval feedback is durably recorded, Agent notification continues in the background. The next draft remains editable while another submission is temporarily disabled, and a nearby status row explains the reason and recovery condition. Each plan detail also has a collapsed **Work history** section. Open it to review plan guidance, step approval feedback, Agent replies, and plan revisions; the entry remains available for approved, completed, and archived plans.

## Sidebar: select the current Route first

**Current Route** determines which configuration most pages display and edit. If changes are unsaved, the interface asks before switching.

The count beside the selector is the number of configurations. The selected value and menu items prefer the persona title, while the Route configuration name, disabled state, and adapter combination remain secondary details so multiple Routes for one persona stay distinguishable. When no persona title is available, WebGUI falls back to the Route display name, persona ID, and then configuration name. The status below does not prove that every external platform is authenticated.

The secondary navigation above the footer contains **Speech Service**, **Performance**, **Log Diagnostics**, and **Settings**; these entries sit above **User Guide**.

## Interface theme

In **Settings** > **RabiRoute desktop features**, choose **Follow system**, **Light**, or **Dark**, then use the top-bar **Save configuration** action. The current WebGUI changes immediately. The Windows tray, role panel, selected-text action bar, and screenshot windows change on the next settings refresh, usually within ten seconds. The theme changes colors and control appearance only. See [Interface theme](interface-theme_en.md) for the full guide.

## System screenshots and persona delivery

Open **Settings** in WebGUI and find **Desktop shortcuts**:

1. Enable **System screenshot**, then set the screenshot shortcut, **Auto-copy selection**, and **Pin shortcut**. The default pin shortcut is `F3`. Every shortcut can use `F1` through `F12` alone, or `Ctrl`, `Alt`, `Shift`, or `Win` plus one letter or function key. When the other Settings edits are ready, use the single top-bar **Save configuration** action.
2. Press the screenshot shortcut in any Windows application; the capture window opens first without dimming the screen so you can drag to select immediately. After dragging, everything outside the selection is dimmed while the selected area remains at its original brightness; drag inside the selection to reposition it without changing its size. If the image is still preparing, **Copy**, **Pin**, or **Send** continues when it is ready. Dragging only creates a selection awaiting confirmation: `Enter` / `Ctrl+C` copies it, `F2` sends it, and the pin shortcut confirms and pins it. By default, confirming a pin or send also copies the selection to the clipboard; turn that off in **Auto-copy selection** and use `Ctrl+C` or **Copy** when needed. `Ctrl+A` selects the full screen. Pressing `Esc` or closing the capture window cancels that capture without adding it to history; copying, pinning, or sending saves the screen capture and selected area.
3. Press `<` / `>` in the capture window to view the previous / next saved screen capture. The last area used to copy, pin, or send that capture is restored. While a selected capture is open, press the pin shortcut to pin that selected area. Otherwise, it pins an image already on the clipboard. A pinned selection keeps its original screen position and size; its drag position, zoomed size, and opacity are restored after RabiRoute Desktop restarts. It can also be copied and saved. Closing that individual pin removes it.
4. Click **Send**, add optional text, choose an active persona in **Send to persona**, and confirm. The image is sent even if the text is empty.

The screenshot and text use the role-panel delivery entry. Codex and DSH receive the screenshot as image input. The file is kept temporarily in the private project directory `.rabiroute-message-images/`; pinned images and selected-area records are stored in private `data/desktop/`. After changing the screenshot toggle, screenshot shortcut, auto-copy setting, pin shortcut, or **Windows login startup**, the tray reads the new settings automatically; restarting is not required.

## Enable selected-text menu

Open **Settings** in WebGUI and find **Enable selected-text menu**:

1. Turn on **Enable selected-text menu**. When the other Settings edits are ready, use the single top-bar **Save configuration** action. Select text with a mouse drag or with `Shift` plus an arrow key, `Home`, `End`, `PageUp`, or `PageDown`. The floating buttons are horizontally centered on the selection bounds. An upward mouse drag places them above; a downward or same-line drag places them below. Keyboard selection uses system caret bounds; when Unity has no system caret, the most recent click in the same window keeps the buttons near the text.
2. Move the cursor to **Send to** to list currently enabled and running personas. Click one item to deliver the selected text to that Route.
3. **Selected-text reading** is a sub-feature of the selected-text menu. When it is on, the left button is **Read aloud** and only a click enqueues host speech. When it is off, the bar keeps only **Send to**.
4. The **Selected-text voice model** selector appears only when both **Selected-text reading** and **Advanced options** are on.

Selection alone does not read or send. Password controls and still-unreadable selections are ignored. Normal applications never receive a simulated `Ctrl+C`; only the Unity Editor sends a guarded temporary copy when UI Automation cannot read the selection, waits for the editor to update the clipboard, and restores the original clipboard afterward. After saving, the tray reads the new settings; restarting is not required.

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
| Save configuration | Saves the current Route on Route pages; on **Settings**, saves desktop features, selected-text menu, Rabi instance, directories, and LAN WebGUI access together; on **Performance monitor**, saves the performance-recording settings |

When the unsaved-changes notice appears, save before switching Routes or leaving. Refresh is not Save, and Restart does not save form edits.


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
