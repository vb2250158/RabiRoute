English | [简体中文](README.md)

# Install Rabi knowledge search

For project maintainers. This skill uses unified search to discover plans, memories, messages, operations, and devices, then checks source evidence. If an entry or source is unavailable, follow the actual coverage and use other available sources. It requires no Manager changes or Hook installation.

The source files are `SKILL.md` and `agents/openai.yaml` in this directory. Copy the entire directory to `.agents/skills/rabi-knowledge-search/` in the target project and add this instruction to its `AGENTS.md`:

```markdown
- When finding information, past decisions, scheduled arrangements, or task leads, read `.agents/skills/rabi-knowledge-search/SKILL.md` first. Use unified search when available, check its sources, and search files as needed; use ordinary search when offline.
```

Check the destination first. Create the directory for an initial installation; for upgrades, compare differences and preserve project changes before syncing the source files, then verify the `AGENTS.md` link. A project copy is a localized derivative: files such as `README.md` or `README_en.md` may already be rewritten there, so never replace the whole directory.

Use the script for drift comparison and baseline recording instead of relying on memory:

```powershell
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root>
pwsh -NoProfile -File scripts/Test-ProjectSkillSync.ps1 -ProjectPath <project root> -Check
```

The first command reports each skill's drift against its baseline; the second acts as a gate (non-zero when a skill is not `in-sync` or its load reference is missing from the target `AGENTS.md`). After a completed port, record the new baseline with `-UpdateBaseline`. See [Project skill distribution and drift detection](../../docs/project-skill-distribution_en.md) for the verdicts and the Agent procedure.

Role scope and caller identity metadata are optional for unified search; the connection still requires its existing authentication. The skill does not store machine addresses, credentials, or persona bindings. Follow the dynamic endpoint, bounded timeout, and offline fallback instructions in [SKILL.md](SKILL.md). Keep project-specific connection configuration in the project, separate from Rabi's generic skill.

For user-level distribution and host selection, use the agentSkills workflow on the same guide. When porting into a project, include the referenced napcat-qq-gateway message guide or replace it with current project guidance so no relative links are left broken. The unified-search architecture is available in the RabiRoute source documentation.
