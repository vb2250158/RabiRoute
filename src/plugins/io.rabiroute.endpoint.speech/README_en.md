English | [简体中文](README.md)

# Speech message endpoint

Connect microphone transcripts to message routes and use the shared speech service to synthesize and play replies. This plugin owns the route configuration card, endpoint discovery, transcript subscriptions, and speech reply delivery.

Open **Plugins** at the bottom left of the WebGUI to enable or disable **Speech message endpoint**. Recognition, synthesis, models, and host playback belong to the separate **Speech service** plugin. This endpoint reports a missing dependency when that service is unavailable.

Disabling the endpoint stops new route deliveries and speech replies while accepted work finishes under its original identity. It leaves recognition, synthesis, and model services used by other features running. The shared service retains original transcripts; a transcript without a route subscription is not reported as delivered to an Agent.

The package publishes the native capabilities `endpoint.speech@1` and `endpoint.speech.egress@1`, and requires `manager.speech@1` and the host's generic message endpoint interface. The host supplies general route and resource ports; this plugin owns its subscriptions, configuration interface, and outbound lifecycle.
