<!-- docs-language-switch -->
<div align="center">English | <a href="./plugins.md">简体中文</a> | <a href="./plugins_ja.md">日本語</a></div>
<!-- /docs-language-switch -->

# Manage plugins

Select **Plugins** at the bottom of the sidebar. The list shows each configured plugin's name, purpose, version, runtime status and enable switch. Search or filter by status, then select a plugin for details.

The host version appears below the RabiRoute name in the sidebar; each plugin has its own version in the list and details. **Configured version** identifies the selected package; **Running version** identifies the actual active package. They can differ while an update has not taken effect.

The switch records your desired enabled state. **Running**, **Startup failed**, **Waiting for dependency** and **Stop unconfirmed** report actual execution. After a change, the page reads the result again. If the result is uncertain, refresh to inspect the original operation rather than toggling repeatedly.

QQ / NapCat, WeCom, Weixin, Feishu, generic Webhook, scheduled triggers, mobile, speech input and Xiaomi Home each have their own plugin. A role's add-input menu comes from available plugin contributions. Disabling a plugin preserves its existing input configuration and shows it as unavailable. Enable it again to resume use. Removing the last input leaves an empty list instead of adding QQ automatically.

Codex, DSH, Copilot CLI, Marvis, AstrBot, WorkBuddy, Antigravity, Device Agent and Grok Bot are also separate plugins. **Add Agent** lists currently available providers. Disabling a plugin preserves its saved fields, target and primary Agent selection, with an unavailable state on the card. Re-enabling resumes the original target without selecting another session.

Agent scanning runs once when entering role settings and on explicit refresh. Expanding a card, editing or saving does not scan again. A failed provider scan leaves other providers available. If a computer or device directory cannot be read, configured targets show their own diagnostics. Diagnostics from other sources are available under **Add Agent**, with refresh, while healthy local cards remain editable and savable. Disabling an Agent plugin releases this app's resources and stops its use of that provider; it does not close external Codex, DSH or other desktop applications.

**Speech services** provide shared recognition, synthesis, playback and model management. **Speech input** delivers transcripts to subscribed roles. Disabling speech input stops that entry while other consumers can continue using speech services. Mobile message input and shared PC connection transport are also managed separately.

Disabling speech services releases this app's connections and locally managed processes. It leaves external speech services running. If a managed process cannot be confirmed stopped, the details retain the reason.

If a plugin fails or lacks a dependency, open its details for the cause. Unrelated plugins and the management page remain available. The application owns the basic management shell, plugin list and identity endpoint, so the plugin page can re-enable the business core even when it is disabled.

Plugin switches and role input configuration are saved separately. Plugin switches submit immediately; role configuration uses the existing **Save** button. Credentials are omitted from the list. Plugin and instance identifiers are available in details for diagnosis.

After saving role settings, the page distinguishes persisted configuration, runtime activation and unavailable inputs. Changes to an input or Agent plugin's own connection settings update the affected plugins. Ordinary direct-delivery session changes can also update locally. Changing the primary Agent's session or workspace while message-processing or memory-consolidation workers use it follows the gateway's original lifecycle. Shared identity, primary selection, shared models, Plan-assistant configuration and message-processing changes follow their actual dependencies. An uncertain save is resolved against its original operation while preserving edits made afterward.

This page describes the source implementation. Verify the installed version and its acceptance evidence separately; a successful source build does not update the running service.
