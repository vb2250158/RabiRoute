package com.rabi.link

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.*
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiRouteSdk
import com.rabi.link.modules.rokid.RokidDeviceStatusSyncService
import com.rabi.link.modules.rokid.RokidProbeActivity

/** Phone companion: glasses backend and Relay transport, not a duplicate Rabi PC configuration UI. */
class MainActivity : Activity() {
    private val sdk = RabiRouteSdk()
    private val pcs = mutableListOf<RabiLinkPc>()
    private lateinit var relayUrl: EditText
    private lateinit var relayToken: EditText
    private lateinit var pcSpinner: Spinner
    private lateinit var pcAdapter: ArrayAdapter<String>
    private lateinit var status: TextView
    private lateinit var connectButton: Button
    private var selectedPc: RabiLinkPc? = null
    private var busy = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        setContentView(buildUi())
        val saved = RabiLinkRelaySettings.load(this)
        if (saved.baseUrl.isNotBlank()) relayUrl.setText(saved.baseUrl)
        if (saved.token.isNotBlank()) relayToken.setText(saved.token)
        refreshStatus("等待连接")
        if (saved.configured && saved.statusSyncEnabled) RokidDeviceStatusSyncService.start(this)
    }

    private fun buildUi(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(24))
            setBackgroundColor(Color.rgb(246, 247, 249))
        }
        content.addView(TextView(this).apply {
            text = "RabiLink 眼镜伴侣"
            textSize = 26f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(Color.rgb(20, 25, 32))
        })
        content.addView(TextView(this).apply {
            text = "手机负责眼镜连接、媒体中转与本地设置；Rabi PC 负责 ASR、TTS、Agent 和配置。"
            textSize = 13f
            setTextColor(Color.rgb(88, 94, 104))
            setPadding(0, dp(4), 0, dp(12))
        })
        status = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(31, 38, 48))
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = panel(Color.rgb(236, 244, 255), Color.rgb(174, 199, 237), 8)
        }
        content.addView(status, full(0, 0, 0, 14))
        content.addView(serverCard(), full(0, 0, 0, 12))
        content.addView(glassesCard(), full(0, 0, 0, 12))
        content.addView(mediaCard(), full(0, 0, 0, 12))
        content.addView(toolsCard(), full(0, 0, 0, 12))
        return ScrollView(this).apply { addView(content) }
    }

    private fun serverCard(): View = card().apply {
        addView(title("1. RabiLink 与 Rabi PC"))
        addView(note("只选择目标 Rabi PC。Route、人格、Agent 和模型配置统一从 RabiLink 远程 WebGUI 调整，不在手机重复维护。"))
        relayUrl = input("https://relay.example.com")
        relayToken = input("RabiLink 应用 token").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        addView(label("服务器 URL")); addView(relayUrl, full(0, 0, 0, 8))
        addView(label("应用 token")); addView(relayToken, full(0, 0, 0, 8))
        pcAdapter = ArrayAdapter(this@MainActivity, android.R.layout.simple_spinner_item, mutableListOf("尚未连接"))
        pcAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        pcSpinner = Spinner(this@MainActivity).apply {
            adapter = pcAdapter
            onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) { selectedPc = pcs.getOrNull(position); refreshStatus("已选择目标 PC") }
                override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            }
        }
        addView(label("处理眼镜消息的 Rabi PC")); addView(pcSpinner, full(0, 0, 0, 10))
        val row = row()
        connectButton = primary("连接 / 刷新") { connectRelay() }
        row.addView(connectButton, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("绑定所选 PC") { bindPc() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
    }

    private fun glassesCard(): View = card().apply {
        addView(title("2. 眼镜音频前端"))
        addView(note("眼镜只录音、播放和显示状态。手机接收 PCM，经过 Relay 交给 Rabi PC ASR；回复由 Rabi PC TTS 后通过手机发回眼镜。"))
        addView(primary("打开眼镜后端") { openRokid("connect_glass_app") }, full(0, 0, 0, 8))
        val row = row()
        row.addView(secondary("安装眼镜 App") { openRokid("install_glass_asr") }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("启动眼镜 App") { openRokid("start_glass_asr") }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
    }

    private fun mediaCard(): View = card().apply {
        addView(title("3. 照片与视频消息"))
        addView(note("照片和短视频作为可靠附件慢传：手机暂存、压缩、排队、重试，再交给 Rabi PC。当前不把公网链路描述成直播。"))
        addView(secondary("打开拍照 / 媒体桥") { openRokid("") })
    }

    private fun toolsCard(): View = card().apply {
        addView(title("4. 管理与诊断"))
        addView(note("Rabi PC 配置请使用 RabiLink 服务器里的远程 WebGUI。设备探针保留在高级入口。"))
        val row = row()
        row.addView(secondary("打开远程配置") { openRemoteConfig() }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("接口测试中心") { startActivity(Intent(this@MainActivity, TestCenterActivity::class.java)) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
    }

    private fun connectRelay() {
        val url = relayBaseUrl(); val token = relayToken.text.toString().trim()
        if (token.isBlank()) return toast("请填写应用 token")
        setBusy(true); refreshStatus("连接服务器中")
        runAsync({ sdk.getMobileState(url, token) }, { state ->
            RabiLinkRelaySettings.save(this, url, token); RokidDeviceStatusSyncService.start(this)
            pcs.clear(); pcs.addAll(state.workers); pcAdapter.clear()
            if (pcs.isEmpty()) pcAdapter.add("没有在线 Rabi PC") else pcAdapter.addAll(pcs.map { "${it.name} · ${if (it.online) "在线" else "离线"}" })
            pcAdapter.notifyDataSetChanged(); selectedPc = state.selectedWorker ?: pcs.firstOrNull()
            selectedPc?.let { pc -> pcSpinner.setSelection(pcs.indexOfFirst { it.id == pc.id }.coerceAtLeast(0)) }
            refreshStatus("Relay 已连接")
        }) { setBusy(false) }
    }

    private fun bindPc() {
        val pc = selectedPc ?: return toast("请先选择 Rabi PC")
        val token = relayToken.text.toString().trim(); if (token.isBlank()) return toast("请先连接服务器")
        setBusy(true)
        runAsync({ sdk.selectMobileRabiPc(relayBaseUrl(), token, pc.id) }, { state -> selectedPc = state.selectedWorker ?: pc; refreshStatus("已绑定 ${selectedPc?.name}") }) { setBusy(false) }
    }

    private fun openRokid(command: String) {
        val config = RabiLinkRelaySettings.load(this)
        if (!config.configured) return toast("请先连接 RabiLink 服务器")
        startActivity(Intent(this, RokidProbeActivity::class.java).apply { if (command.isNotBlank()) putExtra("rokid_probe_command", command) })
    }

    private fun openRemoteConfig() {
        val url = relayBaseUrl()
        if (url.isBlank()) return toast("请先填写服务器 URL")
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("$url/manage")))
    }

    private fun refreshStatus(message: String) { if (!::status.isInitialized) return; status.text = "Relay：${if (RabiLinkRelaySettings.load(this).configured) "已配置" else "未配置"}\nRabi PC：${selectedPc?.name ?: "未选择"}\n眼镜后端：${if (busy) "处理中" else message}" }
    private fun relayBaseUrl() = relayUrl.text.toString().trim().trimEnd('/')
    private fun setBusy(value: Boolean) { busy = value; connectButton.isEnabled = !value; connectButton.text = if (value) "处理中..." else "连接 / 刷新" }
    private fun <T> runAsync(work: () -> T, success: (T) -> Unit, complete: () -> Unit = {}) { Thread { try { val result = work(); runOnUiThread { success(result); complete() } } catch (error: Throwable) { runOnUiThread { toast(error.message ?: error.javaClass.simpleName); complete() } } }.start() }
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun card() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(12), dp(14), dp(12)); background = panel(Color.WHITE, Color.rgb(218, 222, 228), 8) }
    private fun title(text: String) = TextView(this).apply { this.text = text; textSize = 17f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(24, 30, 38)) }
    private fun note(text: String) = TextView(this).apply { this.text = text; textSize = 12f; setTextColor(Color.rgb(80, 87, 98)); setPadding(0, dp(6), 0, dp(8)) }
    private fun label(text: String) = TextView(this).apply { this.text = text; textSize = 12f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Color.rgb(62, 70, 82)); setPadding(0, dp(4), 0, dp(3)) }
    private fun input(hint: String) = EditText(this).apply { this.hint = hint; textSize = 13f; setSingleLine(true); setPadding(dp(10), 0, dp(10), 0); background = panel(Color.WHITE, Color.rgb(205, 211, 220), 6) }
    private fun primary(text: String, action: () -> Unit) = Button(this).apply { this.text = text; isAllCaps = false; setTextColor(Color.WHITE); background = panel(Color.rgb(36, 95, 235), Color.rgb(36, 95, 235), 8); setOnClickListener { action() } }
    private fun secondary(text: String, action: () -> Unit) = Button(this).apply { this.text = text; isAllCaps = false; setTextColor(Color.rgb(38, 48, 68)); background = panel(Color.rgb(239, 242, 247), Color.rgb(213, 218, 226), 8); setOnClickListener { action() } }
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = View(this)
    private fun full(l: Int, t: Int, r: Int, b: Int) = LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(l), dp(t), dp(r), dp(b)) }
    private fun panel(color: Int, stroke: Int, radius: Int) = GradientDrawable().apply { setColor(color); setStroke(dp(1), stroke); cornerRadius = dp(radius).toFloat() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density + 0.5f).toInt()
}
