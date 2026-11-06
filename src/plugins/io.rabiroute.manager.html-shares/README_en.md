[简体中文](README.md)

# HTML shares

This plugin snapshots the HTML attachments explicitly selected by a completion message and publishes links carrying a content key. The package owns the complete PC implementation, Relay helper, browser viewer and lifecycle.

It uses the existing RabiLink connection. Browsers follow the shared LAN → P2P → encrypted Relay order. Relay stores routing metadata and forwards signaling/encrypted frames; it stores neither HTML nor content keys. The link fragment contains the decryption key. Anyone holding the complete link can view it while the PC is online.

Private snapshots, intents and keys use the Host's stable `pluginStorageRoot(pluginId, instanceId)`, independent of source versions. Disabling this plugin retires only its interfaces/connections, preserves snapshots, and leaves existing Relay, Markdown, image and ordinary messages intact.

The plugin declares `host.peer-transports@1`. Older Hosts missing that extension leave only this plugin waiting for its dependency, before executing its factory. Other Host ports retain their existing contracts; no compatibility fallback is installed.

Install the package's declared dependencies and run `npm run build` with the public `@rabiroute/plugin-sdk`. `./relay` exports the unique Relay helper. `relay/`, `assets/` and `src/` are part of this source package. Runtime data and credentials stay outside it.
