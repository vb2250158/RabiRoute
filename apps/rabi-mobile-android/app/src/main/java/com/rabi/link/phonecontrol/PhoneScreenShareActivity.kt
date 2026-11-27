package com.rabi.link.phonecontrol

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import com.rabi.link.RabiMobileUi

class PhoneScreenShareActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var action: Button

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val padding = (20 * resources.displayMetrics.density).toInt()
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(padding, padding, padding, padding)
            setBackgroundColor(RabiMobileUi.background)
        }
        body.addView(TextView(this).apply { text = "共享手机屏幕"; textSize = 24f; setTextColor(RabiMobileUi.text) })
        status = TextView(this).apply { setTextColor(RabiMobileUi.text) }
        body.addView(status)
        action = Button(this).apply { setOnClickListener { toggleSharing() } }
        action.tag = "screen-sharing-toggle"
        body.addView(action)
        if (PhoneInputAccess.supported(this)) {
            body.addView(TextView(this).apply {
                text = "触屏操作只在共享屏幕时可用。手机和 Agent 轮流操作，系统会结束当前正在进行的触屏手势。"
                setTextColor(RabiMobileUi.text)
            })
            body.addView(Button(this).apply {
                text = "管理触屏授权"
                setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
            })
        }
        setContentView(body)
    }

    override fun onResume() {
        super.onResume()
        val sharing = PhoneScreenShareService.current() != null
        status.text = if (sharing) "已开启屏幕共享。你也可以从通知中停止。" else "允许已连接的 Rabi 会话请求截图。开启时需确认 Android 的屏幕共享提示。"
        action.text = if (sharing) "停止共享" else "开启共享"
    }

    private fun toggleSharing() {
        if (PhoneScreenShareService.current() != null) {
            stopService(Intent(this, PhoneScreenShareService::class.java))
            finish()
            return
        }
        val manager = getSystemService(MediaProjectionManager::class.java)
        val prompt = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
            else manager.createScreenCaptureIntent()
        @Suppress("DEPRECATION")
        startActivityForResult(prompt, CONSENT)
    }

    @Deprecated("Uses the platform capture result on the same Activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != CONSENT || resultCode != RESULT_OK || data == null) return
        startForegroundService(Intent(this, PhoneScreenShareService::class.java).putExtra(PhoneScreenShareService.GRANT, data))
        finish()
    }

    private companion object { const val CONSENT = 39 }
}
