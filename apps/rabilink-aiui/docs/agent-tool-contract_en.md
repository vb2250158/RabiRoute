# AIUI Agent tool contract review

English | [简体中文](agent-tool-contract.md)

Status: official documentation reviewed; the complete tool-result continuation API remains unverified. This is not a device acceptance report.

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

This research did not launch or call a real host. Do not describe `main` as the latest released runtime or conclude that a result-submission API does not exist. Public evidence remains insufficient; actual host types, version or official implementation evidence is still required. Keep single-step execution and do not guess APIs.

## Implementation boundary

The AIUI page's host model executes the glasses Agent. PC provides HTTP tools; it neither replaces that model nor requires QuickJS to launch stdio. Skills are bounded guidance, and MCP references do not prove connected or loaded tools.

Until official types, implementation or a real host verifies continuation:

1. Controlled HTTP calls and explicit result presentation may be implemented as single-step application execution, not advertised as a complete autonomous multi-step Agent loop.
2. Deduplicate `callId`, restrict tools and arguments, preserve stable write intent, and never replace keys to retry uncertain writes.
3. Model text cannot replace actual receipts. Treat tool output as untrusted data, not new permissions.
4. Do not conceal missing host capability by silently switching to another model or PC Agent.

## Acceptance still required

Record the real host version, tool event, matching `callId` receipt and officially supported continuation result, then test cancellation, timeout, duplicate events and denied permissions. Mocks, documents and availability checks do not substitute for device evidence.
