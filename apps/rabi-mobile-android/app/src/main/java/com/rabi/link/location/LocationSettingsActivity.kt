package com.rabi.link.location

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.view.WindowManager
import android.widget.*
import androidx.core.content.ContextCompat
import com.rabi.link.RabiConversationService
import com.rabi.link.RabiMobileUi
import com.rabi.link.recording.AllDayRecordingSettings
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

class LocationSettingsActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private lateinit var config: LocationSettings
    private lateinit var repository: LocationRepository
    private lateinit var enabled: Switch
    private lateinit var addresses: Switch
    private lateinit var key: EditText
    private lateinit var limit: EditText
    private lateinit var normalInterval: EditText
    private lateinit var fastInterval: EditText
    private lateinit var distance: EditText
    private lateinit var status: TextView
    private lateinit var history: TextView
    private lateinit var usage: TextView
    private lateinit var keyTestStatus: TextView
    private lateinit var dateButton: Button
    private var date = LocalDate.now()
    private var exportRange: Pair<Long, Long>? = null
    private var loading = false
    private var refreshAgain = false
    private var testing = false
    private val receiver = object : BroadcastReceiver() { override fun onReceive(context: Context?, intent: Intent?) { refresh() } }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        config = LocationSettings(this); repository = LocationRepository(this)
        date = state?.getString("date")?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: LocalDate.now()
        if(state?.containsKey("exportFrom") == true) exportRange = state.getLong("exportFrom") to state.getLong("exportUntil")
        val body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20),dp(16),dp(20),dp(24)); setBackgroundColor(RabiMobileUi.background) }
        fun text(value: String, size: Float = 14f) = TextView(this).apply { text = value; textSize = size; setTextColor(RabiMobileUi.text); setPadding(0,dp(8),0,dp(8)) }
        fun button(value: String, action: () -> Unit) = Button(this).apply { text = value; isAllCaps = false; setOnClickListener { action() } }
        body.addView(text("位置记录", 24f))
        body.addView(text("手机记录经纬度和时间，断网也能保存。开始、暂停与全天记录总开关一致。GPS 不消耗高德调用配额。"))
        status = text(""); body.addView(status)
        enabled = RabiMobileUi.styleSwitch(this, Switch(this).apply { text = "全天记录时同时保存位置"; isChecked = config.enabled })
        body.addView(enabled)
        fun number(label: String, value: String): EditText {
            body.addView(text(label))
            return EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(value); isSingleLine = true; body.addView(this) }
        }
        val sampling = config.sampling
        normalInterval = number("常规定位间隔（秒，5–300）", (sampling.normalIntervalMs / 1000).toString())
        fastInterval = number("快速移动时最短间隔（秒，5–60）", (sampling.fastIntervalMs / 1000).toString())
        distance = number("记录新位置的位移阈值（米，5–1000）", sampling.distanceMeters.toInt().toString())
        body.addView(text("运动时加快，静止三分钟后放慢至至少两分钟，静止十分钟后至至少五分钟。会结合定位精度过滤漂移；静止仍保留约五分钟一次的新鲜位置。实际间隔受系统和信号影响。"))
        body.addView(button("保存位置设置") { save() })
        body.addView(button("开始仅位置记录") { startLocationOnly() })
        body.addView(button("切回音频记录模式") {
            if(AllDayRecordingSettings.load(this).running) toast("请先暂停全天记录，再切换模式")
            else runCatching {
                val s = AllDayRecordingSettings.load(this)
                AllDayRecordingSettings(false,"audio",s.source,s.processingPolicy,s.routeProfileId,s.healthEnabled,s.uploadEnabled,false,s.windowStartedAt).save(this)
                toast("已切回音频模式，可返回记录页开始")
            }.onFailure { toast("模式保存失败") }
        })
        body.addView(button("暂停全天记录") { runCatching { RabiConversationService.pauseRecording(this) }.onFailure { toast("暂停失败，请在记录页重试") } })
        body.addView(button("打开系统定位设置") { startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) })
        body.addView(text("高德地点名称（可选）", 19f))
        body.addView(text("使用高德 Android 定位 SDK 补充地点名称。Key 使用 Android Keystore 加密，仅保存在本机；留空表示保留已保存的 Key。"))
        body.addView(button("高德定位隐私说明") { showPrivacy {} })
        key = EditText(this).apply { hint = if(config.hasKey) "已保存 Key，输入可替换" else "高德 Android 平台 Key"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; isSingleLine = true; importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS; isSaveEnabled = false }
        key.setOnFocusChangeListener { _, focus -> if(focus) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
        body.addView(key)
        addresses = RabiMobileUi.styleSwitch(this, Switch(this).apply { text = "向高德查询地点名称"; isChecked = config.addresses }); body.addView(addresses)
        body.addView(text("本机每月高德定位请求上限"))
        limit = EditText(this).apply { inputType = InputType.TYPE_CLASS_NUMBER; setText(config.monthlyLimit.toString()); isSingleLine = true }; body.addView(limit)
        body.addView(text("默认至少间隔十分钟，附近地点复用缓存。每次最多发起一次 SDK 定位。达到本机上限只暂停高德查询，系统 GPS 继续记录。"))
        body.addView(button("保存 Key 与查询设置") { save() })
        body.addView(button("测试 Android Key 与定位") { testKey() })
        keyTestStatus = text(getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE).getString("locationKeyTestStatus", "尚未测试 Android Key").orEmpty())
        body.addView(keyTestStatus)
        body.addView(button("清除 Key") { AlertDialog.Builder(this).setMessage("清除本机 Key 并关闭地点查询？已有轨迹保留。")
            .setPositiveButton("清除") { _, _ -> runCatching { config.clearKey() }.onSuccess { addresses.isChecked = false; key.setText(""); key.hint = "高德 Android 平台 Key"; toast("Key 已清除"); refresh() }.onFailure { toast("清除失败") } }.setNegativeButton("取消", null).show() })
        usage = text(""); body.addView(usage)
        body.addView(text("全账号配额以高德控制台为准；这里统计本机发起的 SDK 定位，含失败和测试，不代表 SDK 内部网络请求次数。"))
        dateButton = button(date.toString()) { DatePickerDialog(this, { _, y, m, d -> date = LocalDate.of(y,m+1,d); dateButton.text = date.toString(); refresh() },date.year,date.monthValue-1,date.dayOfMonth).show() }; body.addView(dateButton)
        body.addView(button("导出当天轨迹 GeoJSON") { exportRange = range(); startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("application/geo+json").putExtra(Intent.EXTRA_TITLE, "rabi-location-$date.geojson"), 41) })
        history = text(""); body.addView(history)
        setContentView(ScrollView(this).apply { addView(body) })
    }
    override fun onResume() { super.onResume(); ContextCompat.registerReceiver(this, receiver, IntentFilter("com.rabi.link.conversation.RUNTIME_UPDATED"), ContextCompat.RECEIVER_NOT_EXPORTED); refresh() }
    override fun onPause() { unregisterReceiver(receiver); super.onPause() }
    override fun onSaveInstanceState(out: Bundle) { out.putString("date", date.toString()); exportRange?.let { out.putLong("exportFrom",it.first); out.putLong("exportUntil",it.second) }; super.onSaveInstanceState(out) }
    private fun save(reconfigure: Boolean = true): Boolean {
        if(addresses.isChecked && !config.privacyAccepted) { showPrivacy { save(reconfigure) }; return false }
        return try {
        val monthly = limit.text.toString().toIntOrNull() ?: throw IllegalArgumentException("请输入月上限")
        require(monthly in 0..150_000) { "月上限需在 0–150000 之间" }
        val sampling = SamplingConfig(
            (normalInterval.text.toString().toIntOrNull() ?: throw IllegalArgumentException("请输入常规间隔")) * 1000L,
            (fastInterval.text.toString().toIntOrNull() ?: throw IllegalArgumentException("请输入最快间隔")) * 1000L,
            distance.text.toString().toDoubleOrNull() ?: throw IllegalArgumentException("请输入位移阈值"))
        if(key.text.isNotBlank()) config.saveKey(key.text.toString())
        require(!addresses.isChecked || config.hasKey) { "请先输入高德 Android Key" }
        config.save(enabled.isChecked, addresses.isChecked, monthly, sampling)
        key.setText(""); key.hint = if(config.hasKey) "已保存 Key，输入可替换" else "高德 Android 平台 Key"
        toast("已保存到本机")
        val recording = AllDayRecordingSettings.load(this)
        if (recording.running && reconfigure) {
            if (enabled.isChecked && !LocationController.permitted(this)) requestLocation(false)
            else RabiConversationService.refreshLocation(this)
        }
        refresh(); true
    } catch (error: Exception) { toast(if(error is IllegalArgumentException) error.message ?: "设置无效" else "保存失败，请重试"); false }
    }
    private fun showPrivacy(accepted: () -> Unit) {
        val description = TextView(this).apply {
            text = android.text.Html.fromHtml("高德定位 SDK（高德软件有限公司）会处理位置、设备信息、网络信息，以及 Wi-Fi / 基站等信息，用于联网定位和查询地点。仅在你开启地点查询或主动测试后调用。关闭地点查询后，系统 GPS 仍可离线记录。<br/><br/><a href=\"https://lbs.amap.com/pages/privacy/\">阅读高德隐私权政策</a>", android.text.Html.FROM_HTML_MODE_LEGACY)
            movementMethod = android.text.method.LinkMovementMethod.getInstance(); setPadding(dp(24),dp(16),dp(24),dp(16))
        }
        AlertDialog.Builder(this).setTitle("高德定位隐私说明").setView(description)
            .setPositiveButton("同意") { _,_ -> runCatching { config.acceptPrivacy(); accepted() }.onFailure { toast("选择保存失败") } }
            .setNegativeButton("取消",null).show()
    }
    private var pendingStart = false
    private fun requestLocation(start: Boolean) { pendingStart = start; requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 42) }
    private fun startLocationOnly() {
        if (!save(false)) return
        if (!LocationController.permitted(this)) { requestLocation(true); return }
        val old = AllDayRecordingSettings.load(this)
        if (old.running && old.mode != "location") {
            AlertDialog.Builder(this).setMessage("切换为仅位置记录将暂停当前音频或视频采集，已有记录保留。")
                .setPositiveButton("切换") { _, _ -> switchToLocation() }.setNegativeButton("取消", null).show()
        } else switchToLocation()
    }
    private fun switchToLocation() {
        runCatching {
            val s = AllDayRecordingSettings.load(this)
            AllDayRecordingSettings(s.running,"location",s.source,s.processingPolicy,s.routeProfileId,s.healthEnabled,s.uploadEnabled,s.autoResume,s.windowStartedAt).save(this)
            RabiConversationService.startRecording(this)
        }.onFailure { toast("定位启动失败，请检查权限后重试") }
    }
    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == 42) {
            if (LocationController.permitted(this)) { if(pendingStart) startLocationOnly() else runCatching { RabiConversationService.refreshLocation(this) }.onFailure { toast("请在记录页重新开始") } }
            else toast("未获得定位权限，位置记录未启动")
            pendingStart = false
        }
        if(code == 43) { if(LocationController.permitted(this)) testKey() else toast("定位权限未授予，无法测试 Android SDK") }
    }
    private fun testKey() {
        if(!config.privacyAccepted) { showPrivacy { testKey() }; return }
        if(!LocationController.permitted(this)) { requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION),43); return }
        if(testing || !save(false)) return
        testing = true
        keyTestStatus.text = "正在通过高德 Android SDK 测试当前位置…"
        toast("正在通过高德 Android SDK 测试当前位置")
        worker.execute {
            val result = runCatching { AmapLocationLookup(this, { repository.reserveRequest(System.currentTimeMillis(), config.monthlyLimit) }).resolve(config.key()) }
            val message = if(result.isSuccess) "Android Key 与地点查询成功（计入一次 SDK 调用）" else result.exceptionOrNull()?.message?.takeIf { !it.contains("http") } ?: "Key 测试失败"
            getSharedPreferences("rabi_conversation_runtime",MODE_PRIVATE).edit().putString("locationKeyTestStatus",message).apply()
            main.post { testing = false; if(!isDestroyed) { keyTestStatus.text = message; toast(message); refresh() } }
        }
    }
    private fun range(): Pair<Long,Long> { val zone=ZoneId.systemDefault(); return date.atStartOfDay(zone).toInstant().toEpochMilli() to date.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli() }
    private fun refresh() {
        if(loading) { refreshAgain = true; return }; loading = true
        val runtime = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
        status.text = listOf(runtime.getString("locationStatus", "尚未开始位置记录"), runtime.getString("locationSamplingStatus", "")).filter { !it.isNullOrBlank() }.joinToString("\n")
        val (from,until)=range()
        worker.execute {
            val result=runCatching { Triple(repository.count(from,until),repository.recent(from,until),repository.used(System.currentTimeMillis())) }
            main.post {
                loading = false
                if(!isDestroyed) {
                    result.onSuccess { (count, points, used) ->
                        usage.text="本机本月调用：$used / ${config.monthlyLimit}"
                        val format=DateTimeFormatter.ofPattern("HH:mm:ss").withZone(ZoneId.systemDefault())
                        history.text="当天 $count 个位置点，显示最近 ${points.size} 个；导出包含全部。\n\n" + points.mapIndexed { index, it ->
                            val delta = points.getOrNull(index + 1)?.let { older -> " · 距上一点约 ${LocationPolicy.distance(older.point,it.point).toInt()} 米" }.orEmpty()
                            "${format.format(java.time.Instant.ofEpochMilli(it.point.time))} · 精度 ${it.point.accuracy.toInt()} 米$delta\n${it.address.ifBlank { "地点未查询" }}\n${String.format(java.util.Locale.ROOT,"%.6f, %.6f",it.point.latitude,it.point.longitude)}"
                        }.joinToString("\n\n")
                    }.onFailure { history.text="轨迹读取失败，已有数据保留" }
                    if(refreshAgain) { refreshAgain=false; refresh() }
                }
            }
        }
    }
    @Deprecated("Activity result bridge") override fun onActivityResult(code: Int, result: Int, data: Intent?) {
        super.onActivityResult(code,result,data)
        val uri=data?.data ?: return; val (from,until)=exportRange ?: return
        if(code != 41 || result != RESULT_OK) return
        worker.execute { val success=runCatching { contentResolver.openOutputStream(uri)?.use { repository.export(from,until,it) } ?: error("output unavailable") }.isSuccess
            main.post { if(!isDestroyed) toast(if(success) "轨迹已导出" else "导出失败，手机原记录保留") } }
    }
    override fun onDestroy() { worker.execute { repository.close() }; worker.shutdown(); super.onDestroy() }
    private fun dp(n:Int)=(n*resources.displayMetrics.density).toInt()
    private fun toast(text:String)=Toast.makeText(this,text,Toast.LENGTH_LONG).show()
}
