package com.rabi.link

import android.app.Activity
import android.app.AlertDialog
import android.widget.Toast
import com.rabi.link.recording.TargetWorkerIdentity
import com.rabiroute.sdk.RabiRouteSdk

/** Both connection settings and recording devices select through the same verified transport. */
internal object RabiComputerPicker {
    fun show(activity: Activity, onSelected: () -> Unit) {
        val relay = RabiLinkRelaySettings.load(activity)
        if (!relay.configured) return
        val progress = AlertDialog.Builder(activity).setMessage("正在读取电脑…").setCancelable(false).show()
        Thread {
            val result = runCatching { RabiRouteSdk().getMobileState(relay.baseUrl, relay.token) }
            activity.runOnUiThread {
                progress.dismiss()
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                result.onSuccess { state ->
                    if (state.workers.isEmpty()) {
                        AlertDialog.Builder(activity).setTitle("没有可用电脑")
                            .setMessage("请在电脑启动 Rabi 并连接到当前 RabiLink 服务，再重新选择。")
                            .setPositiveButton("完成", null).show()
                    } else AlertDialog.Builder(activity).setTitle("选择电脑")
                        .setItems(state.workers.map {
                            "${it.name} · ${if (it.online) "在线" else "离线"}${if (it.id == state.selectedWorker?.id) " · 当前" else ""}"
                        }.toTypedArray()) { _, index ->
                            val pc = state.workers[index]
                            val switching = AlertDialog.Builder(activity).setMessage("正在切换电脑…").setCancelable(false).show()
                            Thread {
                                val selected = runCatching {
                                    val current = RabiLinkRelaySettings.load(activity)
                                    check(current.baseUrl == relay.baseUrl && current.token == relay.token) { "连接已变化，请重新选择" }
                                    val confirmed = RabiRouteSdk().selectMobileRabiPc(relay.baseUrl, relay.token, pc.id)
                                    check(confirmed.selectedWorker?.id == pc.id) { "电脑选择未获确认" }
                                    TargetWorkerIdentity.save(activity, relay.baseUrl, relay.token, pc.id)
                                    RabiLinkRelaySettings.rememberComputer(activity, pc.name, pc.id, relay.baseUrl, relay.token)
                                }
                                activity.runOnUiThread selectedUi@ {
                                    switching.dismiss()
                                    if (activity.isFinishing || activity.isDestroyed) return@selectedUi
                                    selected.onSuccess {
                                        RabiConversationService.start(activity)
                                        onSelected()
                                        Toast.makeText(activity, "已切换到 ${pc.name}", Toast.LENGTH_SHORT).show()
                                    }.onFailure { showFailure(activity) }
                                }
                            }.start()
                        }.setNegativeButton("取消", null).show()
                }.onFailure { showFailure(activity) }
            }
        }.start()
    }

    private fun showFailure(activity: Activity) {
        AlertDialog.Builder(activity).setTitle("电脑连接未确认")
            .setMessage("请检查网络和电脑上的 Rabi 服务，重新打开电脑列表核对当前选择。")
            .setPositiveButton("完成", null).show()
    }
}
