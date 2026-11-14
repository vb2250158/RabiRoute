[简体中文](README.md) | English

# Phone-to-glasses Android transport

This Android library provides phone-side HTTP, streaming responses, WebSocket upgrade transport, and device leases with caller-configured lifetimes. The Rabi mobile app uses the same implementation through a Gradle project dependency.

The caller authenticates each request, verifies device identity and permissions, and chooses the upstream target. This library does not authenticate requests or choose a Rabi Manager or DSH Host. The server listens on all network interfaces on a system-allocated port; callers must authorize requests before handling them. The existing JSON convenience constructor remains available for Rabi, and other hosts can use the streaming interface.

Only the Rabi integration has been migrated; DSH integration and testing with physical glasses remain outstanding.
