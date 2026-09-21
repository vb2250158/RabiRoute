English | [简体中文](README.md)

# Install Rabi knowledge search

For project maintainers. This skill asks an Agent to search plans and memories before locating files when Rabi is online, and use ordinary search when it is offline. It requires no Manager changes or Hook installation.

The source files are `SKILL.md` and `agents/openai.yaml` in this directory. Copy the entire directory to `.agents/skills/rabi-knowledge-search/` in the target project and add this instruction to its `AGENTS.md`:

```markdown
- When finding information, past decisions, scheduled arrangements, or task leads, read `.agents/skills/rabi-knowledge-search/SKILL.md` first. If Rabi is online, search memories and plans before searching files as needed; otherwise use ordinary search.
```

Check the destination first. Create the directory for an initial installation; for upgrades, compare differences and preserve project changes before syncing the source files, then verify the `AGENTS.md` link. A project copy is a localized derivative: files such as `README.md` or `README_en.md` may already be rewritten there, so never replace the whole directory.

Use the script for drift comparison and baseline recording instead of relying on memory:

```powershell
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root>
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root> -Check
```

The first command reports each skill's drift against its baseline; the second acts as a gate (non-zero when a skill is not `in-sync` or its load reference is missing from the target `AGENTS.md`). After a completed port, record the new baseline with `-UpdateBaseline`. See [Project skill distribution and drift detection](../../docs/project-skill-distribution_en.md) for the verdicts and the Agent procedure.

The task needs an existing relevant persona scope and a supported connection entry. The skill does not store machine addresses, credentials, or persona bindings. Follow the dynamic endpoint, bounded timeout, and offline fallback instructions in [SKILL.md](SKILL.md). Keep project-specific connection configuration in the project, separate from Rabi's generic skill.

For user-level distribution and host selection, use the agentSkills workflow on the same guide. First-turn message history guidance references napcat-qq-gateway; when porting into a project, port that dependency or replace the reference with the project current message-query guide.
