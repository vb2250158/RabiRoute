package com.rabi.link.modules.xiaomi

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.net.Uri
import android.os.Bundle
import android.os.IBinder
import android.os.Parcel
import android.util.Log

class MiHealthDeepProbeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        Thread {
            try {
                val appContext = context.applicationContext
                MiHealthDeepProbe(appContext).run()
            } catch (error: Throwable) {
                Log.e(TAG, "深探针失败：${error.javaClass.simpleName}: ${error.message}", error)
            } finally {
                pending.finish()
            }
        }.start()
    }

    private companion object {
        const val TAG = "RabiMiHealthDeep"
    }
}

private class MiHealthDeepProbe(
    private val context: Context
) {
    fun run() {
        Log.i(TAG, "开始小米健康深探针：普通 APK Provider + HealthProviderService")
        probeProviders()
        probeHealthProviderService()
        Log.i(TAG, "小米健康深探针结束")
    }

    private fun probeProviders() {
        val candidates = listOf(
            "content://com.mi.health.provider.main",
            "content://com.mi.health.provider.main/heartrate",
            "content://com.mi.health.provider.main/heartrate/recent",
            "content://com.mi.health.provider.main/heartrate/report",
            "content://com.mi.health.provider.main/heartrate/records",
            "content://com.mi.health.provider.main/sleep",
            "content://com.mi.health.provider.main/sleep/report",
            "content://com.mi.health.provider.main/sleep/record",
            "content://com.mi.health.provider.device"
        )
        for (candidate in candidates) {
            queryProvider(candidate)
        }
    }

    private fun queryProvider(candidate: String) {
        try {
            val uri = Uri.parse(candidate)
            val args = Bundle().apply {
                putInt(ContentResolver.QUERY_ARG_LIMIT, 20)
            }
            val projection = when (candidate) {
                "content://com.mi.health.provider.main/heartrate/recent" -> arrayOf("hrm", "timestamp")
                else -> null
            }
            context.contentResolver.query(uri, projection, args, null).use { cursor ->
                if (cursor == null) {
                    Log.i(TAG, "Provider $candidate -> cursor=null")
                    return
                }
                Log.i(
                    TAG,
                    "Provider $candidate -> columns=${cursor.columnNames.joinToString()} count=${safeCount(cursor.count)}"
                )
                var rows = 0
                while (rows < 20 && cursor.moveToNext()) {
                    rows++
                }
                Log.i(TAG, "Provider $candidate -> sampledRows=$rows")
            }
        } catch (error: Throwable) {
            Log.i(TAG, "Provider $candidate -> ${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun safeCount(count: Int): String {
        return if (count < 0) "unknown" else count.toString()
    }

    private fun probeHealthProviderService() {
        val intent = Intent("com.mi.health.action.HEALTH_PROVIDER").apply {
            setPackage("com.mi.health")
        }
        val lock = Object()
        var completed = false
        val connection = object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, service: IBinder) {
                Log.i(TAG, "HealthProviderService connected: $name")
                try {
                    val version = transactGetVersion(service)
                    Log.i(TAG, "HealthProviderService getVersion=$version")
                } catch (error: Throwable) {
                    Log.i(TAG, "HealthProviderService transact failed: ${error.javaClass.simpleName}: ${error.message}")
                } finally {
                    context.unbindService(this)
                    synchronized(lock) {
                        completed = true
                        lock.notifyAll()
                    }
                }
            }

            override fun onServiceDisconnected(name: ComponentName) {
                Log.i(TAG, "HealthProviderService disconnected: $name")
                synchronized(lock) {
                    completed = true
                    lock.notifyAll()
                }
            }

            override fun onBindingDied(name: ComponentName) {
                Log.i(TAG, "HealthProviderService binding died: $name")
                synchronized(lock) {
                    completed = true
                    lock.notifyAll()
                }
            }

            override fun onNullBinding(name: ComponentName) {
                Log.i(TAG, "HealthProviderService null binding: $name")
                synchronized(lock) {
                    completed = true
                    lock.notifyAll()
                }
            }
        }

        try {
            val bound = context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
            Log.i(TAG, "HealthProviderService bindService result=$bound")
            if (!bound) {
                return
            }
            synchronized(lock) {
                if (!completed) {
                    lock.wait(10_000L)
                }
            }
        } catch (error: Throwable) {
            Log.i(TAG, "HealthProviderService bind failed: ${error.javaClass.simpleName}: ${error.message}")
        }
    }

    private fun transactGetVersion(service: IBinder): Int {
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInterfaceToken("com.mi.health_provider.IHealthProviderApi")
            service.transact(3, data, reply, 0)
            reply.readException()
            reply.readInt()
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    private companion object {
        const val TAG = "RabiMiHealthDeep"
    }
}
