[English](README_en.md) | [简体中文](README.md)

# QQ favorite sticker name compatibility plugin

New NapCat versions already exposing `fetch_custom_face_detail` do not need this plugin. On older versions it adds the same read-only OneBot action, returning the logged-in account's favorite MD5s, native descriptions and media references. Rabi uses the descriptions as names and exposes IDs, names and protected previews.

Copy this directory to the target NapCat's `plugins/napcat-plugin-rabi-stickers/` and enable it in NapCat's plugin manager. It reuses existing OneBot authentication without another password or allowlist. It reads the native collection without storing an album, sending messages or editing names. Additions, removals and renames appear on the next read. Unnamed favorites have an empty name and can be selected after viewing their Rabi preview.

See [QQ stickers](../../docs/rabi-agent-interfaces_en.md#qq-stickers) for discovery and sending. Unloading removes only this plugin's registration and preserves an existing upstream action.
