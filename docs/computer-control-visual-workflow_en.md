<!-- docs-language-switch -->
<div align="center">English | <a href="./computer-control-visual-workflow.md">简体中文</a></div>
<!-- /docs-language-switch -->

# Visual computer operation

Use one computer-operation contract for observation, targeting, batch input and result inspection. CLI, MCP and Agent plugins share parameters, target identity and original request receipts.

Host 0.15.0 and Core 0.1.8 jointly provide registered image responses. Agent SDK／CLI 0.4.3 and MCP 0.2.4 provide the corresponding media projection and native batch protocol. Read actual adopted versions from the running plugin, client and desktop executor.

## Observe the target

1. Find computer operations in the current catalog, list connected computers and select the target instance.
2. Use `displays.list` to obtain its display IDs, physical bounds, work areas, scaling and layout revision.
3. Use `screen.capture` to observe the required display, region or window.
4. Locate the target in the image actually presented to the model and retain the complete returned `source`.

| Capture scope | Parameters |
| --- | --- |
| Virtual desktop overview | `scope: "virtual"` |
| One display | `scope: "display"` and the original `displayId` |
| Region within a display | `scope: "region"`, the original `displayId` and `region: {x, y, width, height}` |
| Window | `scope: "window"`, the original `windowId` and `pid` |

Region coordinates use physical pixels relative to the selected display. Explicit display／region captures default to native pixels. Set `maxWidth` to request a particular output width. Legacy overview requests retain their existing default width. Selection fields may appear at the top level, in `source` or in `captureSpec`. Repeated fields should carry the same value. `layoutRevision` can identify the original display layout.

## Images and coordinates

MCP returns valid images as image content, while its text receipt retains request identity, source and outcome. The DSH adapter uses the official attachment service and the selected model's image-request preview API.

`source.width`, `source.height`, `frameId` and `imageItemId` identify the original cached image. After host preview resizing, `source.imageView.width` and `height` record the complete image dimensions presented to the model. Input, annotation and tracking map these coordinates back to the cached image and desktop automatically. Reuse the complete source with the coordinates read from the image.

A media-conversion failure retains the original business outcome and the corresponding media error. Query the original request for its actual execution state.

## Submit a complete input batch

Call `control.begin` to obtain a `controlSessionId`. Place one logical operation in a single `input.execute.actions` array, such as clicking a field, entering text and submitting a shortcut. Use the original `requestId` when inspecting that operation.

Before its first input, the native executor records the user's cursor and foreground. It executes actions in order, releases its own keys／buttons and returns the cursor and foreground when the batch ends. `captureAfter: true` can return the resulting image. Captures attached to other control operations also retain display, region, window, layout revision and `maxWidth` parameters.

`completedActions`, `results`, `releaseState` and `returnState` describe the executed prefix, individual action results, resource release and return outcome. `returnState.keys`, `cursor` and `foreground` report independently. Cancellation, failure, deadline and physical takeover finish through the original input owner.

| Setting | Behavior |
| --- | --- |
| `control.returnCursor` | Return the cursor after the batch, enabled by default |
| `control.returnForeground` | Return foreground after the batch, enabled by default |
| `control.returnForegroundTimeoutMs` | Native confirmation budget after the foreground request, 120ms by default, with 0 for immediate confirmation |

Physical mouse movement preserves the user's new position. Receipts distinguish takeover cancellation from an incomplete return.

## Operation feedback

The desktop bar follows the observed display. `presentation.barPlacement` selects top-center or bottom-center placement. Text size and motion follow current settings and theme. The bar presents the observed region, observation／operation／return phase and stop action. WebGUI receives activity updates and can expand the image.

## Updates and local failures

The existing native handshake declares display／region capture, whole-batch input and `imageView` support. Legacy overview and window captures continue through their original protocol. A missing new capability produces a specific error and desktop-resource update guidance for that request.

Positioned operations on a resized preview use the receiver's declared `imageView-v1` format capability. An older receiver returns format guidance for that positioned request. Text, status, cancellation and cleanup remain available. An unsent dispatch says nothing about earlier execution of the original ID. Query `input.status` with the original `requestId` for its existing receipt. Remote PCs use their own operation contract.

Legacy clients keep focus between individual action calls and release their own keys and buttons. The whole-batch protocol performs automatic return after the complete batch.

This Core image declaration ships with the matching generic Host response support. Independent plugin adoption uses actual compatibility validation on the target Host. Plugin, media and individual input failures remain with their corresponding owner while unrelated operations remain available.

See [computer-control design](computer-control-design_en.md), [plugin updates](plugin-source-layout_en.md) and [Agent interfaces](rabi-agent-interfaces_en.md).
