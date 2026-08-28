English | <a href="./README.md">简体中文</a>

# YeYu Gamer Manager Plugin

This plugin provides a disabled-by-default local facade for YeYu Gamer. The target is fixed to `http://127.0.0.1:8877/api/v1`; the plugin only reads health, meta, snapshot, and capabilities and can create only `mode: "plan"` Agent work items.

Configuration belongs to the Profile instead of `data/manager.json`. The Bearer token is read from the local YeYu Gamer runtime directory only for protected snapshot/capability reads or work-item creation and is never stored in the Profile, responses, or logs.
