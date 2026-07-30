<!-- docs-language-switch -->
<div align="center">
English | <a href="./development-hot-reload.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# RabiRoute development hot reload

Development feedback and release acceptance are separate:

- WebGUI uses Vite HMR at `http://127.0.0.1:8793/`.
- RabiSpeech can explicitly use Uvicorn reload. Stop the installed service on port `8781` first.
- Manager is excluded from the safe reload loop. It owns Route child processes, so restarting it would bounce NapCat, RabiLink, personal-Weixin, and persona sessions and may invalidate source-session tokens.
- Native Android code is not covered by this reload loop and still requires a new APK build.
- After a feature is ready, run the complete build, package it, update the installed runtime, and perform the formal acceptance pass.

Common commands:

```powershell
# WebGUI only; safe default
npm run dev:hot

# WebGUI plus RabiSpeech; stop the installed service on 8781 first
npm run dev:hot:speech

# RabiSpeech only
npm run speech:dev

# Manager only in a manually isolated data directory and port
npm run manager:dev:isolated
```

`npm run dev:hot -- --check` checks the required ports without starting services. The safe launcher rejects `--manager` so long-lived message adapters cannot accidentally enter a file-watch restart loop.
