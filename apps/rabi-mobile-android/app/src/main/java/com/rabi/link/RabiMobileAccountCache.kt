package com.rabi.link

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import com.rabiroute.sdk.RabiLinkMobileAccount
import com.rabiroute.sdk.RabiLinkMobileAccountStatus
import org.json.JSONObject

internal data class MobileAccountSnapshot(val profile: RabiLinkMobileAccount, val avatar: Bitmap?)

internal object RabiMobileAccountCache {
    private fun prefs(context: Context) = context.getSharedPreferences("rabi_mobile_account_profile", Context.MODE_PRIVATE)

    fun load(context: Context, server: String, accountId: String): RabiLinkMobileAccount? {
        val raw = prefs(context).getString("profile", null) ?: return null
        return runCatching {
            JSONObject(raw).takeIf { it.optString("server") == server && it.optString("id") == accountId }
                ?.let { RabiLinkMobileAccount(accountId, it.getString("username"), it.getString("nickname"),
                    it.opt("avatar") as? String, RabiLinkMobileAccountStatus.fromWireValue(it.optString("status"))) }
        }.getOrNull()
    }

    fun save(context: Context, server: String, profile: RabiLinkMobileAccount) {
        val raw = JSONObject().put("server", server).put("id", profile.id)
            .put("username", profile.username).put("nickname", profile.nickname).put("avatar", profile.avatarPng)
            .put("status", profile.status?.wireValue)
        prefs(context).edit().putString("profile", raw.toString()).apply()
    }

    fun snapshot(profile: RabiLinkMobileAccount): MobileAccountSnapshot {
        val avatar = profile.avatarPng?.takeIf { it.length <= 175000 }?.let {
            runCatching {
                val bytes = Base64.decode(it, Base64.DEFAULT)
                val size = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, bytes.size, size)
                if (size.outWidth == 160 && size.outHeight == 160)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size) else null
            }.getOrNull()
        }
        return MobileAccountSnapshot(profile, avatar)
    }
}
