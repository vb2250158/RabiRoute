package com.rabi.link.recording

/** A presentation of the recording owner's snapshot; an enabled preference is not capture evidence. */
internal data class RecordingStatusPresentation(val title: String, val detail: String, val recoverable: Boolean) {
    companion object {
        fun from(running: Boolean, autoResume: Boolean, receiving: Boolean, status: String, recovering: Boolean = false, saving: Boolean = false, saveError: String = ""): RecordingStatusPresentation {
            if(saving) return RecordingStatusPresentation("正在保存", "正在停止并保存当前记录。", false)
            if(saveError.isNotBlank()) return RecordingStatusPresentation("保存失败",saveError,true)
            if (!running && !autoResume) return RecordingStatusPresentation("已暂停", "", false)
            if (recovering && !receiving) return RecordingStatusPresentation("正在恢复记录", "正在读取本机历史，完成后开始采集。", false)
            if(!receiving && status.contains("权限")) return RecordingStatusPresentation("等待权限",status,true)
            if (status.contains("storage_low") || status.contains("空间不足"))
                return RecordingStatusPresentation("空间不足，采集已暂停", "请检查手机剩余空间；已有记录仍保留。", true)
            if (listOf("失败", "异常", "未启动", "未能启动", "中断").any(status::contains))
                return RecordingStatusPresentation("采集失败", status, true)
            if (listOf("正在停止", "正在保存").any(status::contains))
                return RecordingStatusPresentation("正在保存", status, false)
            if (running && receiving) return RecordingStatusPresentation("正在记录", "", false)
            val title = if (!running || status.contains("恢复")) "等待恢复采集" else "等待采集数据"
            return RecordingStatusPresentation(title, status.ifBlank { "尚未收到采集数据，请检查设备和权限。" }, true)
        }
    }
}
