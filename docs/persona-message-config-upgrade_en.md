English | [简体中文](persona-message-config-upgrade.md)

# Persona message configuration upgrades

Messages, the second tab in Role configuration, manages a persona's message Routes. The separate Route configuration sidebar entry is removed. Create persona replaces Quick setup and opens the persona creation dialog.

## Configuration ownership

| File | Contents |
| --- | --- |
| `data/roles/<RoleId>/personaConfig.json` | Automation, message rules, recent-message context, wake words, language style and Hooks |
| `data/route/<RouteName>/adapterConfig.json` | Endpoint connections, handling Agent, sessions, workspace, enabled state and persona ID / source PC reference |
| `data/manager.json` | Global settings and custom `rolesDir` / `routeDir` |

`agentRoleId` and `agentRoleDeviceId` link Routes to personas. The persona page derives its list from the Route catalog instead of storing another list. Directories, message history, logs and external path references stay in place. A persona can have multiple Routes. Remote personas remain on their source PC; identical IDs on different PCs are distinct.

Authenticated remote personas use the same writable editor as local personas, without another read-only restriction or feature grant. Configuration, avatars, identities, virtual characters, chat history, all-day recording and companion activities use the source PC's full Manager transport. Opening a configuration file also runs on that PC. Source changes use distinct editor identities and caches; failures never redirect to a same-name local persona. Persona creation appears only in the lower sidebar, without a duplicate button at the top of the persona page.

Legacy persona rules, context, wake words, language style and Hooks in local Routes move into the referenced local persona. Known rules in `roleMessageConfig.json` / `routes.json` merge into persona configuration before those legacy files are removed. Existing persona values take precedence; rules use the runtime's existing merge-by-ID behavior. Existing runtime Agent-target migration preserves real tasks and recipients. Extension fields are retained. Unrecognized legacy rule fields, invalid JSON, persona settings in unbound Routes or missing referenced personas stop the script before source writes; review the association first.

## Upgrade

Use the script in the new release package, or install dependencies and run `npm run build` in a source checkout first. The script needs Node.js without `tsx` or developer tools. It requires no running Manager or network connection. `--root` is the application's data root containing `data/manager.json`. Unless overridden, directory settings come from that file and then the defaults above.

1. Preview first. The default only reports file counts and does not modify source configuration:

   ```powershell
   node scripts/upgrade-persona-message-config.mjs --root "<application-root>"
   ```

2. Exit the Host normally and stop every instance using these shared directories. Then apply offline:

   ```powershell
   node scripts/upgrade-persona-message-config.mjs --root "<application-root>" --apply --offline
   ```

   Override directories with `--roles-root "<personas>" --route-root "<routes>"`. Backups go to `data/config-upgrade-backups/<unique-id>` under the application root, or a private directory specified by `--backup-dir`. Configurations and backups may contain connection credentials; keep them private and do not upload them to public repositories or issue attachments.

3. Success returns `applied:true` and `snapshot`. The script runs existing runtime migrations in temporary staging, generates the complete candidate, backs up original bytes, checks for concurrent changes, replaces files atomically and verifies every result. A repeated preview returns `changedFiles:0`; an unchanged apply returns `applied:false`.
4. Start the application normally. Verify Routes, endpoints, handling Agents and sessions under Role configuration → Messages. Existing Route links select the original Route in this tab. Unbound Routes retain the old editor or can be explicitly assigned in Messages; no replacement persona or task is needed.

## Failure and restore

On failure, files already written by this attempt are restored if nobody changed them. If the result says `recovery_required`, stop further operations and review the returned snapshot; concurrent edits are preserved. Temporary preview files are removed; permanent backups are retained.

Restore a completed or interrupted migration while the application is stopped. Interrupted snapshots restore only files written by that attempt and leave untouched originals in place:

```powershell
node scripts/upgrade-persona-message-config.mjs --restore "<snapshot-directory>" --apply --offline
```

Restore verifies snapshot integrity and current files first. It refuses to overwrite configuration edited since migration and creates its own recovery snapshot. Older programs may run their own startup migrations; before downgrading, exit the new program, restore the configuration and then use the matching old program.
