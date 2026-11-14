<!-- docs-language-switch -->
<div align="center">
English | <a href="./README.md">简体中文</a>
</div>
<!-- /docs-language-switch -->

# Route templates for first startup

On first startup of a new workspace, the configuration owner copies these templates into `data/route`. Only `main` is enabled by default. Existing Routes are not overwritten by these defaults.

Owned listeners use port `0`; the original listener receives an available port on startup. Use the actual address published by the current Route status or API discovery rather than constructing a URL from a template port. An explicit nonzero port remains available when a fixed port is required.

`main.napcatHttpUrl` is an example address for the external NapCat HTTP service; verify it against the actual QQ instance before use. The Weixin vendor address and other explicit external service URLs retain their protocols and do not participate in Rabi listener allocation.

`voice-chat` has no preset local TTS URL and uses the configured current Speech service. Explicit external TTS URLs remain supported.

The XiaoAI template retains automatic-port configuration. See the [standalone bridge guide](../../../src/plugins/xiaoai-rabiroute/README.md) for its actual listening address and forwarding setup. This template does not create a native Gateway XiaoAI listener. Retired FenneNote port fields do not restore that entry point.
