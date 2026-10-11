package com.rabiroute.sdk

/** Stateless SDK boundary. The application owns connection selection and lifetime. */
fun interface RabiLinkManagerHttpTransport {
    fun request(relayBaseUrl: String, token: String, target: RabiLinkPc, method: String, path: String,
                headers: Map<String, String>, body: ByteArray): RabiLinkManagerHttpResponse
}

/** Reports the actual selected path, not a promised or simulated fallback. */
data class RabiLinkManagerHttpResponse(
    val statusCode: Int,
    val headers: Map<String, String>,
    val body: ByteArray,
    val transport: String,
    val capabilities: Set<String>
)
