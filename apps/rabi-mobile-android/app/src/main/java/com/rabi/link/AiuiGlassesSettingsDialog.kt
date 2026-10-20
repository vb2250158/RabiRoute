package com.rabi.link

import android.app.Activity
import android.app.AlertDialog
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

/** 全天记录 → 设备 → 眼镜 → 眼镜设置. Changes the AIUI persona, never the capture toggle. */
object AiuiGlassesSettingsDialog {
    fun show(activity: Activity) {
        val config = RabiLinkRelaySettings.load(activity)
        if (!config.configured) { AlertDialog.Builder(activity).setTitle("眼镜设置").setMessage("请先在 RabiLink 连接电脑。").setPositiveButton("完成", null).show(); return }
        val client = AiuiGlassesClient(activity, config)
        val preferences = activity.getSharedPreferences("aiui_glasses_settings", Activity.MODE_PRIVATE)
        val pendingKey = "pending:" + client.scope
        val executor = Executors.newSingleThreadExecutor()
        val panel = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(32,16,32,16) }
        val state = TextView(activity).apply { text = "正在读取眼镜设置…"; textSize = 15f }
        val deviceButton = Button(activity).apply { text = "选择眼镜" }
        val computerButton = Button(activity).apply { text = "选择角色所在电脑" }
        val personaButton = Button(activity).apply { text = "当前使用的角色：未绑定" }
        val skillButton = Button(activity).apply { text = "采用角色 Skill" }
        val saveButton = Button(activity).apply { text = "保存" }
        val refreshButton = Button(activity).apply { text = "刷新 / 核对原请求" }
        val resumeButton = Button(activity).apply { text = "继续原保存请求"; isEnabled = false }
        val unbindButton = Button(activity).apply { text = "不使用角色" }
        val bridgeButton = Button(activity).apply { text = "手机直连 / 眼镜配对" }
        bridgeButton.setOnClickListener {
            runCatching { RabiConversationService.openPhoneEyeBridge() }.fold(onSuccess={info->
                AlertDialog.Builder(activity).setTitle("手机直连配对").setMessage("在 AIUI 连接设置中输入手机地址和配对码。地址由当前网络提供，配对码五分钟有效。\n\n"+info.getJSONArray("urls").join("\n")+"\n\n配对码："+info.getString("pairingCode"))
                    .setPositiveButton("关闭",null).show()
            },onFailure={AlertDialog.Builder(activity).setTitle("手机直连").setMessage("请先启动手机连接服务。").setPositiveButton("完成",null).show()})
        }
        panel.addView(TextView(activity).apply { text = "角色提供身份、指引和聊天记录归属，模型由乐奇提供。接口权限沿用连接鉴权。"; textSize = 14f })
        listOf(deviceButton,computerButton,personaButton,skillButton,saveButton,unbindButton,refreshButton,resumeButton,bridgeButton,state).forEach(panel::addView)
        val dialog = AlertDialog.Builder(activity).setTitle("眼镜设置 · AIUI").setView(panel).setNegativeButton("关闭", null).create()
        var busy = false; var open = true; var deviceId = ""; var ownerId = ""; var sourceId = ""; var revision = 0
        var draft: JSONObject? = null; var devices = JSONArray()
        var pending = preferences.getString(pendingKey,null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        var originalCanResume = false
        fun lock(value: Boolean) { busy = value; val enabled = !value && pending == null; listOf(deviceButton,computerButton,personaButton,skillButton,saveButton,unbindButton).forEach { it.isEnabled = enabled }; refreshButton.isEnabled = !value; resumeButton.isEnabled = !value && pending != null && originalCanResume }
        fun connectionCurrent() = RabiLinkRelaySettings.load(activity).let { it.baseUrl == config.baseUrl && it.token == config.token }
        fun <T> run(work: () -> T, complete: (T) -> Unit) {
            if (busy || !open) return
            lock(true)
            executor.execute {
                val result = runCatching(work)
                activity.runOnUiThread {
                    if (!open) return@runOnUiThread
                    if (!connectionCurrent()) { state.text = "连接已变化，请关闭后重新打开设置。"; lock(true); return@runOnUiThread }
                    result.fold(onSuccess = { value -> runCatching { complete(value) } }, onFailure = { Result.failure<Unit>(it) }).onFailure { state.text = "未确认完成，请刷新核对；原请求不会自动重发。" }
                    lock(false)
                }
            }
        }
        fun showProfile(value: JSONObject) {
            ownerId = value.optString("ownerDeviceId",ownerId)
            revision = value.optInt("savedRevision")
            draft = value.optJSONObject("profile")?.let { JSONObject(it.toString()) }
            sourceId = draft?.optJSONObject("personaRef")?.optString("sourceDeviceId").orEmpty().ifBlank { ownerId }
            deviceButton.text = "眼镜：$deviceId"
            computerButton.text = "角色所在电脑：${sourceId.ifBlank { "未选择" }}"
            personaButton.text = "当前使用的角色：${draft?.optJSONObject("personaRef")?.let { draft?.optString("name") } ?: "未绑定"}"
            skillButton.text = "采用角色 Skill（${draft?.optJSONArray("skills")?.length() ?: 0}）"
            state.text = "已保存版本 $revision；眼镜应用状态：${value.optJSONObject("applied")?.optString("status") ?: "尚未确认"}。保存后当前轮结束再切换。"
        }
        fun refresh() {
            run({
                if (pending != null) {
                    originalCanResume = false
                    val original = pending!!
                    if(original.optString("ownerDeviceId").isBlank()) {
                        // A legacy receipt may be read after server-to-PC migration,
                        // but absent original owner metadata never authorizes replay.
                        val roster = client.devices().getJSONArray("devices")
                        val connected = (0 until roster.length()).map { roster.getJSONObject(it) }.single { it.getString("id") == original.getString("bindingId") }
                        val migrated = client.operation(connected.getString("ownerDeviceId"),original.getString("bindingId"),original.getString("idempotencyKey")).optJSONObject("receipt")
                        check(migrated != null && migrated.optString("idempotencyKey") == original.getString("idempotencyKey") && AiuiGlassesClient.sameJson(migrated.getJSONObject("profile"),original.getJSONObject("profile"))) { "旧保存请求等待迁移核对" }
                        check(preferences.edit().remove(pendingKey).commit()); pending = null
                        deviceId = original.getString("bindingId"); ownerId = connected.getString("ownerDeviceId")
                        return@run client.devices()
                    }
                    val receipt = client.operation(original.getString("ownerDeviceId"), original.getString("bindingId"), original.getString("idempotencyKey")).optJSONObject("receipt")
                    deviceId = original.getString("bindingId"); ownerId = original.getString("ownerDeviceId")
                    if (receipt == null) {
                        val current = client.profile(ownerId,deviceId)
                        check(current.getInt("savedRevision") == original.getInt("expectedRevision"))
                        originalCanResume = true
                    } else {
                        check(receipt.optString("idempotencyKey") == original.getString("idempotencyKey") && AiuiGlassesClient.sameJson(receipt.getJSONObject("profile"), original.getJSONObject("profile")))
                        check(preferences.edit().remove(pendingKey).commit()); pending = null
                    }
                }
                client.devices()
            }, { result ->
                devices = result.optJSONArray("devices") ?: JSONArray()
                if (devices.length() == 0) { state.text = "尚无已领取设备凭据的眼镜，请先完成眼镜连接。"; return@run }
                val index = (0 until devices.length()).firstOrNull { devices.getJSONObject(it).optString("id") == deviceId } ?: 0
                val selected = devices.getJSONObject(index); deviceId = selected.getString("id"); showProfile(selected)
                if (originalCanResume) state.text = "原保存尚无回执，当前版本未变化；可点击继续原保存请求，使用原编号与原内容。"
            })
        }
        deviceButton.setOnClickListener {
            if (devices.length() == 0) return@setOnClickListener
            AlertDialog.Builder(activity).setTitle("选择眼镜").setItems(Array(devices.length()) { index -> devices.getJSONObject(index).optString("serialPreview").ifBlank { devices.getJSONObject(index).getString("id") } }) { _, index ->
                deviceId = devices.getJSONObject(index).getString("id"); showProfile(devices.getJSONObject(index))
            }.show()
        }
        computerButton.setOnClickListener { run({ JSONArray().also { rows -> client.computers().forEach { rows.put(JSONObject().put("id",it.id).put("name",it.name).put("online",it.online)) } } }, { computers ->
            AlertDialog.Builder(activity).setTitle("选择角色所在电脑").setItems(Array(computers.length()) { i -> computers.getJSONObject(i).optString("name") + if(computers.getJSONObject(i).optBoolean("online")) "" else "（离线）" }) { _, index ->
                sourceId = computers.getJSONObject(index).getString("id"); draft = null; personaButton.text = "当前使用的角色：请选择"; skillButton.text = "采用角色 Skill（0）"; state.text = "请在此电脑选择角色。"; computerButton.text = "角色所在电脑：" + computers.getJSONObject(index).optString("name")
            }.show()
        }) }
        personaButton.setOnClickListener { run({ client.personas(sourceId).optJSONArray("personas") ?: JSONArray() }, { personas ->
            AlertDialog.Builder(activity).setTitle("当前使用的角色").setItems(Array(personas.length()) { i -> personas.getJSONObject(i).optString("name",personas.getJSONObject(i).optString("personaId")) }) { _, index ->
                val roleId = personas.getJSONObject(index).getString("personaId")
                run({ client.template(sourceId,roleId) }, { profile ->
                    draft = profile; sourceId = profile.getJSONObject("personaRef").getString("sourceDeviceId"); personaButton.text = "当前使用的角色：" + profile.getString("name"); skillButton.text = "采用角色 Skill（0）"; state.text = "已选择，尚未保存。"
                })
            }.show()
        }) }
        skillButton.setOnClickListener {
            val roleId = draft?.optJSONObject("personaRef")?.optString("roleId").orEmpty()
            if(roleId.isBlank()) { state.text = "请先选择角色。"; return@setOnClickListener }
            run({ client.skills(sourceId,roleId) }, { result ->
                val skills = result.optJSONArray("skills") ?: result.optJSONArray("items") ?: JSONArray()
                val selected = BooleanArray(skills.length())
                AlertDialog.Builder(activity).setTitle("选择采用的 Skill").setMultiChoiceItems(Array(skills.length()) { i -> skills.getJSONObject(i).optString("title",skills.getJSONObject(i).optString("id")) },selected) { _, index, checked -> selected[index] = checked }
                    .setPositiveButton("采用") { _, _ ->
                        val ids = (0 until skills.length()).filter { selected[it] }.map { skills.getJSONObject(it).getString("id") }
                        if(ids.size > 16) { state.text = "一次可预载最多 16 项；其余 Skill 可通过接口按需读取。"; return@setPositiveButton }
                        run({ client.template(sourceId,roleId,ids) }, { profile -> draft = profile; skillButton.text = "采用角色 Skill（${ids.size}）";state.text = "已选择 Skill，尚未保存。" })
                    }.setNegativeButton("取消",null).show()
            })
        }
        unbindButton.setOnClickListener {
            draft = JSONObject().put("revision",revision+1).put("id","assistant").put("name","眼镜助手").put("systemPrompt","").put("skills",JSONArray()).put("mcp",JSONArray()).put("personaRef",JSONObject.NULL)
            sourceId = ownerId; computerButton.text = "角色所在电脑：未绑定"; skillButton.text = "采用角色 Skill（0）"; personaButton.text = "当前使用的角色：未绑定";state.text = "未绑定仍可调用接口；尚未保存。"
        }
        saveButton.setOnClickListener {
            val chosen = draft?.let { JSONObject(it.toString()) } ?: return@setOnClickListener
            if(deviceId.isBlank() || ownerId.isBlank()) return@setOnClickListener
            run({
                val latest = client.profile(ownerId,deviceId);val expected = latest.getInt("savedRevision");check(expected == revision) { "配置已变化，请刷新后重新选择" };chosen.put("revision",expected+1)
                val input = JSONObject().put("ownerDeviceId",ownerId).put("bindingId",deviceId).put("expectedRevision",expected).put("idempotencyKey","profile-"+UUID.randomUUID()).put("profile",chosen)
                check(preferences.edit().putString(pendingKey,input.toString()).commit()); pending = input
                val response = client.saveProfile(ownerId,input)
                check(response.optString("idempotencyKey") == input.getString("idempotencyKey") && AiuiGlassesClient.sameJson(response.getJSONObject("profile"),chosen))
                val confirmed = client.profile(ownerId,deviceId)
                check(confirmed.getInt("savedRevision") == expected+1 && AiuiGlassesClient.sameJson(confirmed.getJSONObject("profile"),chosen))
                check(preferences.edit().remove(pendingKey).commit()); pending = null
                confirmed
            }, { confirmed -> showProfile(confirmed) })
        }
        refreshButton.setOnClickListener { refresh() }
        resumeButton.setOnClickListener {
            val original = pending?.let { JSONObject(it.toString()) } ?: return@setOnClickListener
            run({
                originalCanResume = false
                val current = client.profile(original.getString("ownerDeviceId"),original.getString("bindingId"))
                check(current.getInt("savedRevision") == original.getInt("expectedRevision"))
                val response = client.saveProfile(original.getString("ownerDeviceId"), original)
                check(response.optString("idempotencyKey") == original.getString("idempotencyKey") && AiuiGlassesClient.sameJson(response.getJSONObject("profile"), original.getJSONObject("profile")))
                val confirmed = client.profile(original.getString("ownerDeviceId"),original.getString("bindingId"))
                check(confirmed.getInt("savedRevision") == original.getJSONObject("profile").getInt("revision") && AiuiGlassesClient.sameJson(confirmed.getJSONObject("profile"), original.getJSONObject("profile")))
                check(preferences.edit().remove(pendingKey).commit()); pending = null
                confirmed
            }, { confirmed -> showProfile(confirmed) })
        }
        dialog.setOnDismissListener { open=false; client.close(); executor.shutdownNow() }
        dialog.show(); refresh()
    }
}
