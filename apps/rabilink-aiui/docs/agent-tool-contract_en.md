# AIUI Agent tool contract review

English | [简体中文](agent-tool-contract.md)

Status: native result submission remains unverified; an application loop now uses supported messages for continued reasoning. Real-host acceptance remains pending.

## Official sources

The official public content endpoint returned the actual `0.18.0` (`v0.18.x`) documentation, not merely an HTML shell:

- [Model documentation](https://js.rokid.com/AIUI/api/ai/language-model?lang=zh-CN&version=0.18.0)
- [Public content endpoint](https://js.rokid.com/api/aiui/docs/content?version=0.18.0&locale=zh-CN&sourcePath=3-api%2Fai%2Flanguage-model)
- [Versioned source document](https://raw.githubusercontent.com/jsar-project/AIUI/v0.18.x/documentation/3-api/ai/language-model.md)

Documented methods include `LanguageModel.create({initialPrompts, tools})`, `prompt(input)`, `promptStreaming(input)`, `clone()` and `destroy()`. Only one request should be active in a session. Tool events expose `callId`, `functionName`, `arguments`, `toolType`, `index` and `isComplete`; arguments are usually parsed objects.

The example handles `toolcall` in application code but documents no tool-result submission method or message structure carrying `tool_call_id`. Structured messages mention `user`, `system` and `assistant`, without proving support for a `tool` role. Do not invent `respondWith` or `submitToolResult`, or treat ordinary user prompt text as an official tool-result channel.

## Additional official repository review

Six subsequent targeted public fetches confirmed that the GitHub API for `jsar-project/AIUI` redirects to `yodaos-project/AIUI`. Reviewing the model documentation on `main` and `v0.18.x` still found `toolcall` events and application-handling examples, but no contract for submitting execution results by `callId` and continuing the model.

- [main README](https://raw.githubusercontent.com/yodaos-project/AIUI/main/README.md) describes the project as Developer Tools & Skills.
- [main model documentation](https://raw.githubusercontent.com/yodaos-project/AIUI/main/documentation/3-api/ai/language-model.md) is documentation evidence, not proof of the version installed on a device.
- The [fixed-commit tree](https://api.github.com/repos/yodaos-project/AIUI/git/trees/0fc2d412bf60859ffa2acab6b72375bee3584807?recursive=1) includes packages such as `cloud-integration` and `create-aiui-agent`, but does not provide a host `LanguageModel` implementation establishing result continuation.

This research did not launch or call a real host. Do not describe `main` as the latest released runtime or conclude that a result-submission API does not exist. Public evidence remains insufficient; actual host types, version or official implementation evidence is still required. Use explicit application observations for continuation without guessing native APIs.

## Implementation boundary

The AIUI page's host model executes the glasses Agent. PC provides HTTP tools; it neither replaces that model nor requires QuickJS to launch stdio. Skills are bounded guidance, and MCP references do not prove connected or loaded tools.

The [official AI type reference](https://raw.githubusercontent.com/yodaos-project/AIUI/main/skills/aiui-dev/references/apis/ai.md), read on 2026-10-10, permits prompt-time user/assistant messages, retains session history, emits tool events after a request completes, and permits one active request per session. AgentWorker is a Page/Widget lifecycle worker, not another model result-submission API.

Default conversation uses an application decision protocol: native tool declarations are empty, and a complete model action JSON frame goes through existing managed tools. Actual results return to the same model as explicit application observations inside supported user messages. These observations preserve call IDs and untrusted-data labels; they do not create a native tool role, tool_call_id contract or automatic JavaScript execution. Persona identity and connection authority remain unchanged.

The executor validates request IDs, connected tools, arguments, idempotency and limits. Invalid or partial actions cannot execute. Fixtures prove results reach subsequent reasoning; real-host acceptance remains pending. See [execution loop](agent-turn-runtime_en.md).

## Acceptance still required

Record the real host version, application decision, matching call receipt and subsequent observation-based reasoning, then test cancellation, timeout, duplicate events and denied permissions. Mocks, documents and availability checks do not substitute for device evidence.

`rabi_api_help` and `rabi_api_call` share one generic Manager transport. Optional `targetDeviceId` selects another authenticated PC; the default is frozen for the turn. Operation fingerprints include target, method, path and body digest, so unknown writes cannot replay on another target. Relay does not register each business API or route by persona/profile revision. See [transport](generic-api-transport_en.md).
