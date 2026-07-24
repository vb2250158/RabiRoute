<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Client applications

`apps/` contains RabiRoute clients that can be built, accepted, and released independently. They may use the Manager, Relay, or shared SDKs, but they do not own the final PC-side Route, persona, Agent-session, or Action-Gate state.

| Directory | Platform | Responsibility |
| --- | --- | --- |
| [`rabilink-android/`](./rabilink-android/README_en.md) | Android phone + Rokid glasses | Conversation list and chat details, continuous messaging, remote configuration, wearable-health entry points, and the glasses frontend built with the phone project. |
| [`rabilink-aiui/`](./rabilink-aiui/README_en.md) | Rokid AIUI | Foreground messaging, configuration assistant, AIX packaging, and acceptance. Its host has no SSE, WebSocket, or chunk callback, so a controlled long wait remains to preserve proactive downlink; the newer native path prefers Android companion events. |

The shared Android transport contract lives under [`packages/android-sdk/`](../packages/android-sdk/README_en.md). Copyable Route/persona and Relay samples remain under [`examples/`](../examples/README_en.md).
