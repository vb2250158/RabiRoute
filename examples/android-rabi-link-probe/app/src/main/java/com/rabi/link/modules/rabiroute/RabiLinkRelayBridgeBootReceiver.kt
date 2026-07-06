package com.rabi.link.modules.rabiroute

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class RabiLinkRelayBridgeBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val prefs = context.getSharedPreferences(RabiLinkRelayBridgeService.PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(RabiLinkRelayBridgeService.PREF_ENABLED, false)) return
        val serviceIntent = Intent(context, RabiLinkRelayBridgeService::class.java).apply {
            putExtra(RabiLinkRelayBridgeService.EXTRA_RELAY_BASE_URL, prefs.getString(RabiLinkRelayBridgeService.EXTRA_RELAY_BASE_URL, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_TOKEN, prefs.getString(RabiLinkRelayBridgeService.EXTRA_TOKEN, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_ROUTE_ID, prefs.getString(RabiLinkRelayBridgeService.EXTRA_ROUTE_ID, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_CALLBACK_URL, prefs.getString(RabiLinkRelayBridgeService.EXTRA_CALLBACK_URL, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_MANAGER_BASE_URL, prefs.getString(RabiLinkRelayBridgeService.EXTRA_MANAGER_BASE_URL, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_INSTANCE_GUID, prefs.getString(RabiLinkRelayBridgeService.EXTRA_INSTANCE_GUID, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_INSTANCE_NAME, prefs.getString(RabiLinkRelayBridgeService.EXTRA_INSTANCE_NAME, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_COMPUTER_NAME, prefs.getString(RabiLinkRelayBridgeService.EXTRA_COMPUTER_NAME, ""))
            putExtra(RabiLinkRelayBridgeService.EXTRA_DEVICE_TYPE, prefs.getString(RabiLinkRelayBridgeService.EXTRA_DEVICE_TYPE, ""))
        }
        if (Build.VERSION.SDK_INT >= 26) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
    }
}
