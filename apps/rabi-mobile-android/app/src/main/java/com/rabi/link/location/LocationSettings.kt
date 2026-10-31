package com.rabi.link.location

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Private phone settings. The API key is never included in relay settings, logs or exports. */
class LocationSettings(context: Context) {
    private val prefs = context.getSharedPreferences("rabi_location", Context.MODE_PRIVATE)
    val enabled get() = prefs.getBoolean("enabled", false)
    val addresses get() = prefs.getBoolean("addresses", false)
    val monthlyLimit get() = prefs.getInt("monthlyLimit", LocationPolicy.DEFAULT_MONTHLY_LIMIT)
    val hasKey get() = !prefs.getString("encryptedKey", "").isNullOrEmpty()
    val privacyAccepted get() = prefs.getBoolean("amapPrivacyAccepted", false)
    val sampling get() = SamplingConfig(prefs.getLong("normalIntervalMs", 60_000),
        prefs.getLong("fastIntervalMs", 5_000), prefs.getFloat("distanceMeters", 10f).toDouble())
    fun acceptPrivacy() { check(prefs.edit().putBoolean("amapPrivacyAccepted",true).commit()) { "隐私选择保存失败" } }
    fun save(enabled: Boolean, addresses: Boolean, monthlyLimit: Int, sampling: SamplingConfig = this.sampling) {
        require(monthlyLimit in 0..150_000) { "月上限需在 0–150000 之间" }
        check(prefs.edit().putBoolean("enabled", enabled).putBoolean("addresses", addresses)
            .putInt("monthlyLimit", monthlyLimit).putLong("normalIntervalMs", sampling.normalIntervalMs)
            .putLong("fastIntervalMs", sampling.fastIntervalMs).putFloat("distanceMeters", sampling.distanceMeters.toFloat()).commit()) { "位置设置保存失败" }
    }
    @Synchronized fun key(): String {
        val encoded = prefs.getString("encryptedKey", "").orEmpty()
        if (encoded.isEmpty()) return ""
        val bytes = Base64.decode(encoded, Base64.NO_WRAP)
        require(bytes.size > 12) { "密钥无法读取，请重新输入" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
    @Synchronized fun saveKey(value: String) {
        val key = value.trim()
        require(key.matches(Regex("[A-Za-z0-9]{16,128}"))) { "请输入高德 Android 平台 Key" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.iv + cipher.doFinal(key.toByteArray(Charsets.UTF_8))
        check(prefs.edit().putString("encryptedKey", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit()) { "Key 保存失败" }
    }
    fun clearKey() { check(prefs.edit().remove("encryptedKey").putBoolean("addresses", false).commit()) { "清除失败" } }
    private fun secretKey(): SecretKey {
        val alias = "rabilink_location_v1"
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
}
