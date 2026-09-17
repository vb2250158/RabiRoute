package com.rabi.link.transport

import android.content.Context
import livekit.org.webrtc.*
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import java.net.URI
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

internal abstract class TunnelChannel : AutoCloseable {
    private val incoming = LinkedBlockingQueue<ByteArray>(64)
    @Volatile var closed = false; private set
    fun receive(bytes: ByteArray) { if(bytes.size > 40_000 || !incoming.offer(bytes)) close() }
    fun read(timeoutMs: Long): ByteArray {
        check(!closed) { "Tunnel closed" }
        val bytes = incoming.poll(timeoutMs.coerceAtLeast(1),TimeUnit.MILLISECONDS) ?: error("Tunnel timeout")
        check(bytes.isNotEmpty() && !closed) { "Tunnel closed" }; return bytes
    }
    abstract fun send(bytes: ByteArray)
    protected abstract fun dispose()
    @Synchronized final override fun close() { if(closed) return; closed = true; incoming.clear(); incoming.offer(byteArrayOf()); dispose() }
    companion object {
        fun websocket(url: String, headers: Map<String,String>, timeoutMs: Long): TunnelChannel {
            lateinit var socket: WebSocketClient
            val channel = object : TunnelChannel() {
                override fun send(bytes: ByteArray) { check(!closed && socket.isOpen); socket.send(bytes) }
                override fun dispose() { socket.close() }
            }
            socket = object : WebSocketClient(URI(url),headers) {
                override fun onOpen(handshake: ServerHandshake) {}
                override fun onMessage(message: String) { channel.receive(message.toByteArray()) }
                override fun onMessage(bytes: ByteBuffer) { channel.receive(ByteArray(bytes.remaining()).also { bytes.get(it) }) }
                override fun onClose(code: Int,reason: String,remote: Boolean) { channel.close() }
                override fun onError(error: Exception) { channel.close() }
            }
            try { check(socket.connectBlocking(timeoutMs,TimeUnit.MILLISECONDS)); return channel }
            catch(error: Throwable) { channel.close(); throw error }
        }

        fun rtc(context: Context, signal: (String) -> String): TunnelChannel {
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions())
            val factory = PeerConnectionFactory.builder().createPeerConnectionFactory()
            var peer: PeerConnection? = null; var data: DataChannel? = null
            val opened = CountDownLatch(1); val gathered = CountDownLatch(1)
            val channel = object : TunnelChannel() {
                override fun send(bytes: ByteArray) {
                    val target = data ?: error("P2P closed")
                    check(!closed && target.state()==DataChannel.State.OPEN && target.bufferedAmount()<2*1024*1024)
                    check(target.send(DataChannel.Buffer(ByteBuffer.wrap(bytes),true)))
                }
                override fun dispose() {
                    opened.countDown(); gathered.countDown()
                    Thread { data?.close(); data?.dispose(); peer?.close(); peer?.dispose(); factory.dispose() }.start()
                }
            }
            val config = PeerConnection.RTCConfiguration(listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()))
            try {
                peer = factory.createPeerConnection(config,object : PeerConnection.Observer {
                    override fun onSignalingChange(state: PeerConnection.SignalingState) {}
                    override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) { if(state in listOf(PeerConnection.IceConnectionState.FAILED,PeerConnection.IceConnectionState.CLOSED)) channel.close() }
                    override fun onIceConnectionReceivingChange(value: Boolean) {}
                    override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) { if(state==PeerConnection.IceGatheringState.COMPLETE) gathered.countDown() }
                    override fun onIceCandidate(candidate: IceCandidate) {}
                    override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) {}
                    override fun onAddStream(stream: MediaStream) {}
                    override fun onRemoveStream(stream: MediaStream) {}
                    override fun onDataChannel(unexpected: DataChannel) { unexpected.close() }
                    override fun onRenegotiationNeeded() {}
                    override fun onAddTrack(receiver: RtpReceiver,streams: Array<out MediaStream>) {}
                }) ?: error("P2P unavailable")
                data = peer!!.createDataChannel("rabi.tunnel.v1",DataChannel.Init())
                data!!.registerObserver(object : DataChannel.Observer {
                    override fun onBufferedAmountChange(previous: Long) {}
                    override fun onStateChange() { if(data?.state()==DataChannel.State.OPEN) opened.countDown(); if(data?.state()==DataChannel.State.CLOSED) channel.close() }
                    override fun onMessage(buffer: DataChannel.Buffer) { channel.receive(ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }) }
                })
                val offer = SdpResult(); peer!!.createOffer(offer,MediaConstraints()); val description = offer.description()
                val local = SdpResult(); peer!!.setLocalDescription(local,description); local.await()
                check(gathered.await(5,TimeUnit.SECONDS) && !channel.closed) { "P2P discovery timeout" }
                val answer = signal(peer!!.localDescription.description)
                require(answer.startsWith("v=0") && answer.contains("m=application ") && !answer.contains(" typ relay"))
                val remote = SdpResult(); peer!!.setRemoteDescription(remote,SessionDescription(SessionDescription.Type.ANSWER,answer)); remote.await()
                check(opened.await(5,TimeUnit.SECONDS) && !channel.closed) { "P2P connect timeout" }
                return channel
            } catch(error: Throwable) { channel.close(); throw error }
        }
    }
    private class SdpResult : SdpObserver {
        private val latch = CountDownLatch(1); private var value: SessionDescription? = null; private var failure: String? = null
        override fun onCreateSuccess(description: SessionDescription) { value=description; latch.countDown() }
        override fun onSetSuccess() { latch.countDown() }
        override fun onCreateFailure(error: String) { failure=error; latch.countDown() }
        override fun onSetFailure(error: String) { failure=error; latch.countDown() }
        fun await() { check(latch.await(3,TimeUnit.SECONDS) && failure==null) { "P2P description failed" } }
        fun description(): SessionDescription { await(); return value ?: error("No P2P offer") }
    }
}
