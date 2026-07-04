package com.rabiroute.bandprobe

import android.Manifest
import android.app.Instrumentation
import android.net.Uri
import android.os.Bundle
import android.util.Log

class MiHealthInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        super.onStart()
        val result = Bundle()
        runCatching {
            uiAutomation.adoptShellPermissionIdentity(
                Manifest.permission.BLUETOOTH_CONNECT,
                "com.mi.health.permission.DEFAULT_READ_DATA"
            )
            val rows = readRecentHeartRate()
            result.putString("recent_heart_rate", rows.joinToString("; "))
            Log.i(TAG, "读取完成：${rows.joinToString("; ")}")
        }.onFailure { error ->
            result.putString("error", "${error.javaClass.simpleName}: ${error.message}")
            Log.e(TAG, "读取失败：${error.javaClass.simpleName}: ${error.message}", error)
        }.also {
            runCatching { uiAutomation.dropShellPermissionIdentity() }
        }
        finish(0, result)
    }

    private fun readRecentHeartRate(): List<String> {
        val uri = Uri.parse("content://com.mi.health.provider.main/heartrate/recent")
        val projection = arrayOf("hrm", "timestamp")
        val rows = mutableListOf<String>()
        targetContext.contentResolver.query(uri, projection, null, null, null).use { cursor ->
            if (cursor == null) {
                rows += "cursor=null"
                return rows
            }
            rows += "columns=${cursor.columnNames.joinToString()}"
            rows += "count=${cursor.count}"
            var index = 0
            while (cursor.moveToNext() && index < 20) {
                val hrm = cursor.getInt(cursor.getColumnIndexOrThrow("hrm"))
                val timestamp = cursor.getLong(cursor.getColumnIndexOrThrow("timestamp"))
                rows += "hr[$index]=$hrm@$timestamp"
                index++
            }
        }
        return rows
    }

    companion object {
        private const val TAG = "RabiMiHealthInstr"
    }
}
