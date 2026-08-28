English | <a href="./README.md">简体中文</a>

# Desktop Pet Manager Plugin

This plugin independently owns the desktop-pet pack, binding, and asset APIs. It reads bounded packs from persona directories and registers `/api/desktop-pet/` through the Manager plugin-route lifecycle. Disabling or replacing the plugin stops new requests and drains accepted requests before disposal.

RabiRoute Desktop still owns the window and animation state. The plugin does not edit persona text, task state, or work results.
