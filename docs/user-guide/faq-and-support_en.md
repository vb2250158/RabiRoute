<!-- docs-language-switch -->
<div align="center">
English | <a href="./faq-and-support.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# FAQ and support

This page answers common first-use questions and provides a report format that maintainers can reproduce quickly.

## Must I configure QQ first?

No. Run Scheduled trigger plus Codex first, then add NapCat. This separates handler-delivery problems from QQ login problems.

## Manager is connected. Why is there no delivery?

Manager connectivity only means WebGUI can reach the control plane. Check Route runtime, message connection, rule match, and handler binding separately.

## Why are ordinary group messages ignored?

Ambient group messages are not forwarded unconditionally. Add a `group_message` rule with a focused regex. Mentions, reply chains, and private messages use their own Route kinds.

## Why did Save not change the external system?

Confirm the unsaved notice disappeared. Some changes synchronize or reload the Route, while NapCat, WeCom, or Relay settings also need to become active on that platform.

## Why does a renamed Codex task still receive messages?

RabiRoute uses the complete task ID and workspace as a stable binding. The title is display information; a rename or completed goal does not invalidate the task.

## Why does the task use a different model or tool set?

The Codex Desktop task owns its model, tools, sandbox, and approval. RabiRoute compatibility fields do not override those settings.

## Where does a `draft` wait for approval?

There is no generic WebGUI approval queue today. `draft` is an Outbox result and audit payload. Inspect its data and logs, then follow the explicit business process.

## Is Manual trigger safe?

It is useful for controlled validation, but it is not a side-effect-free preview. It writes logs, builds an AgentPacket, and starts a real handler delivery.

## Can I attach the entire `data/` directory?

No. It can contain real messages, accounts, tokens, task context, and private paths. Provide minimal current-run logs after sanitization.

## Where is the current version?

The sidebar brand area displays the running version. You can also inspect the root `package.json`. Report whether you used source, a package, or the tray launcher.

## Minimal checks before reporting

1. Rebuild and restart the Manager and target Route.
2. Reproduce with one minimal Route instead of several experimental inputs.
3. Record the current startup time and first error.
4. Check separately for a message record, AgentPacket, and Outbox result.
5. Remove identities, tokens, cookies, private chat, and private absolute paths.

<div class="screenshot-placeholder">
  <strong>Screenshot placeholder 15 | Sanitized diagnostic screenshot</strong>
  <span>Suggested frame: sidebar version, current Route, Diagnosis Summary, and last error with accounts, tokens, private tasks, and paths hidden.</span>
  <span>Callouts: version, Route type, source, handler, error time; include no secrets.</span>
</div>

## Issue template

Copy and fill in:

```markdown
### Environment
- RabiRoute version:
- Startup: source / package / tray
- Operating system:
- Node.js version:

### Route
- Message adapter:
- Agent handler:
- Persona: yes / no
- External platform version:

### Steps to reproduce
1.
2.
3.

### Expected result

### Actual result

### Evidence
- Message record present:
- AgentPacket present:
- Outbox result:
- Minimal logs after current startup:

### Sanitization
- [ ] No accounts, group IDs, tokens, cookies, private chat, or private paths
```

## Get help

- Search this guide and the deeper [Troubleshooting guide](../troubleshooting_en.md) first.
- Check [Current Capabilities and Maturity](../current-capabilities_en.md) before treating a planned feature as a bug.
- Report reproducible bugs or documentation issues in [GitHub Issues](https://github.com/vb2250158/RabiRoute/issues).
- For code extension, begin at the [developer documentation index](../README_en.md).

Do not publish credentials, account data, or exploitable detail in a security report. Use a private security channel offered by the repository; if none is listed, first ask without disclosing the sensitive details.
