package com.rabi.link.transport

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.crypto.util.PublicKeyFactory
import org.bouncycastle.crypto.util.SubjectPublicKeyInfoFactory
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Wire compatible with src/peerTunnel/security.ts. No application token enters a LAN socket. */
internal class TunnelCrypto(private val seed: ByteArray, private val device: String, private val generation: String) {
    private val privateKey = Ed25519PrivateKeyParameters(seed,0)
    val publicKey = pem(SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(privateKey.generatePublicKey()).encoded)
    fun sign(bytes: ByteArray): String = Ed25519Signer().run { init(true,privateKey); update(bytes,0,bytes.size); b64(generateSignature()) }
    fun bootstrap(target: String, service: String = "speech"): JSONObject {
        require(service in listOf("speech","resources"))
        val expires = System.currentTimeMillis()+50_000
        val fields = "{\"source\":${q(device)},\"publicKey\":${q(publicKey)},\"target\":${q(target)},\"expiresAt\":$expires}"
        return JSONObject(fields).put("kind","bootstrap-$service").put("signature",sign(("rabi-$service-bootstrap-v1"+fields).toByteArray()))
    }
    fun handshake(target: String, trustedKey: String): Handshake = Handshake(target,trustedKey)
    inner class Handshake(private val target: String, private val trustedKey: String) {
        private val ephemeral = X25519PrivateKeyParameters(SecureRandom())
        private val fields = "{\"deviceId\":${q(device)},\"generation\":${q(generation)},\"publicKey\":${q(publicKey)},\"ephemeral\":${q(pem(SubjectPublicKeyInfoFactory.createSubjectPublicKeyInfo(ephemeral.generatePublicKey()).encoded))},\"nonce\":${q(hex(ByteArray(24).also { SecureRandom().nextBytes(it) }))},\"target\":${q(target)}}"
        val hello = fields.dropLast(1)+",\"signature\":${q(sign(("rabi-tunnel-v1"+fields).toByteArray()))}}"
        fun accept(bytes: ByteArray): SessionCipher {
            require(bytes.size <= 8192)
            val remote = JSONObject(String(bytes,Charsets.UTF_8))
            require(remote.getString("deviceId")==target && remote.getString("target")==device && remote.getString("publicKey")==trustedKey)
            require(remote.getString("nonce").matches(Regex("[a-f0-9]{48}")))
            val body = listOf("deviceId","generation","publicKey","ephemeral","nonce","target").joinToString(",","{","}") { q(it)+":"+q(remote.getString(it)) }
            val signer = Ed25519Signer(); signer.init(false,PublicKeyFactory.createKey(unpem(trustedKey)) as Ed25519PublicKeyParameters)
            val signed = ("rabi-tunnel-v1"+body).toByteArray(); signer.update(signed,0,signed.size)
            require(signer.verifySignature(unb64(remote.getString("signature")))) { "peer_signature_denied" }
            val secret = ByteArray(32); ephemeral.generateSecret(PublicKeyFactory.createKey(unpem(remote.getString("ephemeral"))) as X25519PublicKeyParameters,secret,0)
            val remoteHello = body.dropLast(1)+",\"signature\":${q(remote.getString("signature"))}}"
            val transcript = "[$hello,$remoteHello]".toByteArray()
            val prk = hmac(transcript,secret)
            return SessionCipher(hmac(prk,"rabi-tunnel-v1caller".toByteArray()+byteArrayOf(1)),hmac(prk,"rabi-tunnel-v1receiver".toByteArray()+byteArrayOf(1)))
        }
    }
    class SessionCipher(private val tx: ByteArray, private val rx: ByteArray) {
        private var sent = 0L; private var received = 0L
        private fun nonce(value: Long) = java.nio.ByteBuffer.allocate(12).putInt(0).putLong(value).array()
        @Synchronized fun encode(value: JSONObject): ByteArray {
            val plain = value.toString().toByteArray(); require(plain.size <= 32768)
            val iv = nonce(++sent); return iv + crypt(Cipher.ENCRYPT_MODE,tx,iv,plain,"rabi-tunnel-v1")
        }
        @Synchronized fun decode(bytes: ByteArray): JSONObject {
            require(bytes.size in 28..32796 && bytes.copyOfRange(0,12).contentEquals(nonce(received+1)))
            val result = JSONObject(String(crypt(Cipher.DECRYPT_MODE,rx,bytes.copyOfRange(0,12),bytes.copyOfRange(12,bytes.size),"rabi-tunnel-v1"),Charsets.UTF_8))
            received++; return result
        }
    }
    companion object {
        fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
        fun unb64(text: String): ByteArray = Base64.getDecoder().decode(text)
        // Android JSONStringer escapes slashes; Node JSON.stringify does not.
        // Signed payloads and HKDF transcripts must use the same canonical spelling.
        fun q(text: String): String = JSONObject.quote(text).replace("\\/", "/")
        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
        private fun pem(bytes: ByteArray) = "-----BEGIN PUBLIC KEY-----\n"+b64(bytes).chunked(64).joinToString("\n")+"\n-----END PUBLIC KEY-----\n"
        private fun unpem(text: String) = unb64(text.lineSequence().filterNot { it.startsWith("---") }.joinToString(""))
        private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key,"HmacSHA256")); doFinal(data) }
        private fun crypt(mode: Int,key: ByteArray,iv: ByteArray,data: ByteArray,aad: String): ByteArray = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(mode,SecretKeySpec(key,"AES"),GCMParameterSpec(128,iv)); updateAAD(aad.toByteArray()); doFinal(data)
        }
        fun peerPacket(value: JSONObject, token: String): JSONObject {
            val key = MessageDigest.getInstance("SHA-256").digest(("rabi-peer-rpc-v1\u0000"+token).toByteArray())
            val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
            val encrypted = crypt(Cipher.ENCRYPT_MODE,key,iv,value.toString().toByteArray(),"peer-rpc-v1")
            return JSONObject().put("version",1).put("iv",b64(iv)).put("data",b64(encrypted.copyOfRange(0,encrypted.size-16))).put("tag",b64(encrypted.takeLast(16).toByteArray()))
        }
        fun openPeer(value: JSONObject,token: String): JSONObject {
            require(value.getInt("version")==1)
            val key = MessageDigest.getInstance("SHA-256").digest(("rabi-peer-rpc-v1\u0000"+token).toByteArray())
            return JSONObject(String(crypt(Cipher.DECRYPT_MODE,key,unb64(value.getString("iv")),unb64(value.getString("data"))+unb64(value.getString("tag")),"peer-rpc-v1"),Charsets.UTF_8))
        }
    }
}
