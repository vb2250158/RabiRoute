English | [简体中文](README.md)

# Video generation plugin

Provides a separate video page, job APIs, H3 workflow and job persistence. The page is enabled by default; users start the GPU service explicitly. `host.manager.video@1` provides the constrained local process lease, while `host.manager.http@1` registers authenticated Manager APIs and events.

The Host provides `requestAccess(request)`; the plugin revalidates after asynchronous waits and before filesystem/process/network/stream dispatch. Accepted background tasks belong to the plugin lifecycle and do not retain initiating request authority. Revocation returns a sanitized 403; mutation outcomes distinguish `not_started` from `unknown` without claiming rollback.

See [Video generation plugin](../../../../docs/video-generation-plugin_en.md) for installation, APIs, data locations and acceptance boundaries. Models and private runtime data are not included in this package.
