package com.rabi.link.modules.xiaomi

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log

class MiHealthReadReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val tag = "RabiMiHealthRead"
        val uri = Uri.parse("content://com.mi.health.provider.main/heartrate/recent")
        val projection = arrayOf("hrm", "timestamp")
        Log.i(tag, "开始后台读取小米健康最近心率：$uri")
        try {
            context.contentResolver.query(uri, projection, null, null, null).use { cursor ->
                if (cursor == null) {
                    Log.i(tag, "cursor=null")
                    return
                }
                Log.i(tag, "列名：${cursor.columnNames.joinToString()}")
                Log.i(tag, "行数：${cursor.count}")
                var index = 0
                while (cursor.moveToNext() && index < 10) {
                    val hrm = cursor.getInt(cursor.getColumnIndexOrThrow("hrm"))
                    val timestamp = cursor.getLong(cursor.getColumnIndexOrThrow("timestamp"))
                    Log.i(tag, "心率[$index]：hrm=$hrm timestamp=$timestamp")
                    index++
                }
            }
        } catch (error: Throwable) {
            Log.e(tag, "读取失败：${error.javaClass.simpleName}: ${error.message}", error)
        }
    }
}
