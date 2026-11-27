<!-- docs-language-switch -->
English | [简体中文](computer-control.md) | [日本語](computer-control_ja.md)
<!-- /docs-language-switch -->

# Computer control

RabiLink Home displays authorized devices as cards, three per row on wide screens. Select a device card to open its settings in Device control.

Open **RabiLink → Device control**. The local PC, connected RabiPC hosts, lightweight computer nodes and connected phones share one list; the leading icon reports Windows, Mac, Linux, Android or iOS, while a device without a reported system keeps a generic computer or phone icon. Expanding a row reads settings and work status only. Failed reads retain recent information and show unknown status separately from offline devices.

The complete feature ships with 0.13.0 and updated Windows executors. Older nodes retain their declared capabilities; being online does not prove an update. Use actual capabilities, rather than names, IP addresses or an empty terminal-session list.

## Choose features

Each computer has a master switch and separate switches for the desktop, individual window actions, and the player controller. Terminal commands, files, and Agent tasks have their own settings. Missing settings default to enabled. Status and cleanup remain available for previously accepted work. Update the executor on an older node to use capabilities it does not yet advertise.

Settings save to the target's existing configuration owner. The UI distinguishes storage confirmation from executor application. If application remains unconfirmed, inspect original work status without repeating the settings write.

## Input and observation

| Target | Operation | API |
| --- | --- | --- |
| The computer's desktop | Discover windows and displays, capture or wait for changes | `windows.list`, `displays.list`, `screen.capture`, `screen.wait` |
| The computer's desktop | Shared foreground keyboard and mouse, independent screen annotations | `input.perform`, `control.*`, `annotation.*` |
| A selected window | Restore and request foreground focus, attempt a background capture, or post input | `windows.activate`, `screen.capture.background`, `input.background` |
| An independent input device | Xbox-compatible controller that can run alongside physical keyboard and mouse input | `input.gamepad`, `input.gamepad.status`, `input.gamepad.close` |

Use the window handle and PID returned by `windows.list`. Background input takes receiver client-area coordinates and can address a child control in the same window. The app and Windows decide whether a minimized window processes messages or provides an image. A `posted` receipt confirms message delivery to the queue. Observe the app to confirm the effect. Foreground activation reports `foreground` or `denied`.

Foreground input arbitrates mouse and keyboard separately. People and Agents can use different channels, with physical input taking priority during a conflict on the same channel. The application still decides which player receives its desktop input. The controller requires ViGEmBus on the Windows target. Assign it to the appropriate player in the game. It returns to neutral after each batch and can be disconnected explicitly.

1. Select a computer and read its windows or capture a frame.
2. Choose “Begin manual control”, or let an Agent call `control.begin`.
3. Submit an ordered batch of pointer movement, clicks, scrolling, dragging, Unicode text or shortcuts. Frame coordinates retain their source frame, instance, window and pixel extent. Observe again after a layout change.
4. End control from the UI or the target's configured shortcut. The default is **Ctrl+Alt+Esc**; bare Esc remains an ordinary application key. Idle control ends after 120 seconds by default, with a countdown during the last 10 seconds. Both are configurable.

Observation, injected input and application results are reported separately. `captureAfter` defaults to false. A failed post-input capture does not rewrite already injected input as unexecuted. Cancellation preserves the executed prefix and never replays the batch. Closing a preview does not end an Agent's background work.

## Screen annotations

Draw rectangles, ellipses, arrows, paths, plain text or highlights on an observed frame. Static annotations last 10 seconds by default, with a custom duration or explicit cleanup. Annotations are independent of keyboard/mouse control; clearing annotations, stopping tracking and ending control are separate actions.

Dynamic annotations default to off. Once enabled, explicitly start CPU KCF or local template matching; only then is the tracking library loaded. Requested and effective rates are separate. Lost targets, ambiguity, short predictions and resource reductions retain their actual status. Prediction is not reported as recognition. Automatic budgets first reduce preview work, then frame rate or analysis size. Paused work reports its reason. Advanced controls use the shared settings schema.

Tracking ends through explicit expiry, stop, a recorded source connection closing, or feature shutdown. Ending an ordinary HTTP request is not a business task ending; without a persistent source-connection scope, use explicit expiry or cleanup. A completed Rabi plan clears only work attributed through its exact task binding. One model turn ending is not a business task ending. Connections without a real task mapping do not invent one; use explicit expiry or cleanup.

## CLI, MCP and other Agents

All entries consume the same running catalog and parameter schemas. Hosts with a generic HTTP tool can call these APIs without another dedicated business-tool implementation.

```sh
node apps/rabi-agent/rabi-cli.mjs search "computer list" --category devices
node apps/rabi-agent/rabi-cli.mjs describe manager.lan-agent.computers.list --view input
node apps/rabi-agent/rabi-cli.mjs call manager.lan-agent.computers.list --input-json '{}'
node apps/rabi-agent/rabi-cli.mjs describe manager.lan-agent.computer.execute --view input
```

Standard MCP uses `rabi_search`, `rabi_describe` and `rabi_call`. Read the business directory for the real `instanceId` and owning host before invoking its contract. API search counts are not computer counts.

A full remote host row includes `ownerDeviceId`. Read that host's own contract and use the existing `manager.rabilink.peer.http.get/post/patch` operation with `deviceId` set to that owner, `service` to `manager`, and `path` to the original API path. Keep its body and target parameters unchanged. Do not treat a remote `instanceId` as a local target. The UI uses this same Peer entry.

Control, input and annotation actions share `POST /api/lan-agent/instances/:instanceId/computer` through `body.action`. Actions such as `control.status` are not additional operation IDs. Preserve the original request ID for result queries; input is never automatically replayed. Settings use the same target's `GET/PATCH .../computer-settings` and original ETag.

[Unified interfaces](../unified-agent-api_en.md) · [Implementation design](../computer-control-design_en.md)

Dynamic annotation has a default memory budget of 512 MiB to cover normal operation after loading KCF; the budget covers the whole annotation executor process. Saved custom budgets retain their values, and dynamic tracking remains off by default.
