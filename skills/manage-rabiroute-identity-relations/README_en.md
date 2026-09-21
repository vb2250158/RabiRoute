English | [简体中文](README.md)

# Install the RabiRoute identity relation skill

For maintainers and Agents that handle persona identity positioning. The skill resolves who an endpoint account is, confirms or corrects people, handles multi-PC conflicts and shared accounts, and restricts on-scene Agents to candidate observations.

The source file is `SKILL.md` in this directory. Use it in one of two ways:

- Inside the RabiRoute repository, read `skills/manage-rabiroute-identity-relations/SKILL.md` directly.
- To install into another project, copy `SKILL.md` to `.agents/skills/manage-rabiroute-identity-relations/SKILL.md` and reference it from the project `AGENTS.md`:

```markdown
- Before handling persona identity positioning, confirming or correcting account ownership, or diagnosing a wrong-person call, read `.agents/skills/manage-rabiroute-identity-relations/SKILL.md`.
```

This skill is listed in the user-level `agentSkills` section of `project-skills.json`, with `install=true`, `audience=runtime`, and `hosts=["*"]`; it is not an entry in the separate `skills` section for localized downstream-project copies under `.agents/skills/`. Follow the `agentSkills` distribution flow for user-level installation. To include it in downstream project skill synchronization, register it in the project `skills` catalog before copying, so no unmaintained drift copy appears.

Check the target directory before installing: create it on first install, and compare differences while preserving project edits on upgrade. The skill stores no machine addresses, access secrets, or persona bindings; connections and requests follow the dynamic address and instance identity checks in `SKILL.md`.

The data source of truth and field definitions are in the "identity relation memory interface" section of [the Agent interface contract](../../docs/rabi-agent-interfaces_en.md); the page entry point and maturity are in [the project function map](../../docs/project-function-map_en.md).
