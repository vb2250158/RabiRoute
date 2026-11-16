English | [简体中文](README.md)

# Install Rabi knowledge search

For project maintainers. Begin task retrieval with at least one unified search, read its contents and coverage, then choose detail queries, keyword changes or local file search. Known files, previous standards, examples and direct collaboration follow this sequence. When Rabi discovery, connection, search or its calling tool fails, record the actual error once, skip that same failure for the current turn and continue local retrieval and the original task. The skill uses the existing API.

The source files are `SKILL.md` and `agents/openai.yaml` in this directory. Copy the entire directory to `.agents/skills/rabi-knowledge-search/` in the target project and add this instruction to its `AGENTS.md`:

```markdown
- Read `.agents/skills/rabi-knowledge-search/SKILL.md` before task retrieval. When Rabi is available, complete at least one `/api/search`, read `label`, `excerpt`, coverage and `handle`, then choose detail queries, keyword changes or local search. Known files, previous standards and direct collaboration follow this sequence. When Rabi discovery, connection, search or its calling tool fails, record the actual error once, skip that same failure for the current turn and continue local retrieval and the original task.
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
