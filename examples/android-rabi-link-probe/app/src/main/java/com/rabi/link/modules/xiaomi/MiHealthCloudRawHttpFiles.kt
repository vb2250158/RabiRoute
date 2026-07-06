package com.rabi.link.modules.xiaomi

import android.content.Context
import java.io.File

internal class MiHealthCloudRawHttpFiles(private val context: Context) {
    fun clear() {
        val dir = MiHealthCloudArtifacts.rawHttpDir(context)
        if (!dir.exists()) {
            return
        }
        dir.listFiles()?.forEach { file ->
            if (file.isFile) {
                file.delete()
            }
        }
    }

    fun save(index: Int, stage: String, dataTypeName: String, sourceId: String?, body: String): File {
        val dir = MiHealthCloudArtifacts.rawHttpDir(context)
        dir.mkdirs()
        val sourcePart = sourceId?.let { "-" + safeFilePart(it).take(48) }.orEmpty()
        val file = File(dir, "%03d-%s-%s%s.json".format(index, safeFilePart(stage), safeFilePart(dataTypeName), sourcePart))
        file.writeText(body, Charsets.UTF_8)
        return file
    }

    private fun safeFilePart(value: String): String {
        return value.replace(Regex("[^A-Za-z0-9._-]+"), "_").trim('_').ifBlank { "unknown" }
    }
}
