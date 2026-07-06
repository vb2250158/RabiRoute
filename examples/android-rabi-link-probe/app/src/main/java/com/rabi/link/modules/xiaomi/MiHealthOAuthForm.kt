package com.rabi.link.modules.xiaomi

import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout

internal class MiHealthOAuthForm(
    private val context: Context,
    initial: MiHealthOAuthSettings
) {
    private val appIdInput = EditText(context).apply {
        hint = "小米开放平台 AppID"
        inputType = InputType.TYPE_CLASS_TEXT
        setText(initial.appId)
    }

    private val tokenInput = EditText(context).apply {
        hint = "access_token，可手动粘贴"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        setSingleLine(false)
        minLines = 2
        setText(initial.accessToken)
    }

    private val redirectInput = EditText(context).apply {
        hint = "OAuth redirect_uri，必须和小米开放平台配置一致"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setText(initial.redirectUri)
    }

    private val scopeInput = EditText(context).apply {
        hint = "scope，可留空使用应用已授权范围"
        inputType = InputType.TYPE_CLASS_TEXT
        setText(initial.scope)
    }

    private val dataTypesInput = EditText(context).apply {
        hint = "data_types，逗号分隔"
        inputType = InputType.TYPE_CLASS_TEXT
        setText(initial.dataTypes)
    }

    private val hoursInput = EditText(context).apply {
        hint = "拉取最近多少小时，默认 24"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.hours.toString())
    }

    private val sliceHoursInput = EditText(context).apply {
        hint = "分片小时，0 表示不分片；例如 24 表示按天拉"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.sliceHours.toString())
    }

    private val limitInput = EditText(context).apply {
        hint = "每页条数，默认 500"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.limit.toString())
    }

    private val maxPagesInput = EditText(context).apply {
        hint = "最大页数，默认 20"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.maxPages.toString())
    }

    fun addFieldsTo(root: LinearLayout) {
        root.addView(appIdInput)
        root.addView(tokenInput)
        root.addView(redirectInput)
        root.addView(scopeInput)
        root.addView(dataTypesInput)
        root.addView(hoursInput)
        root.addView(sliceHoursInput)
        root.addView(limitInput)
        root.addView(maxPagesInput)
    }

    fun readSettings(): MiHealthOAuthSettings {
        return MiHealthOAuthSettings(
            appId = appIdInput.value(),
            accessToken = tokenInput.value(),
            redirectUri = redirectInput.value(),
            scope = scopeInput.value(),
            dataTypes = readDataTypes(),
            hours = readHours(),
            sliceHours = readSliceHours(),
            limit = readLimit(),
            maxPages = readMaxPages()
        )
    }

    fun setToken(token: String) {
        tokenInput.setText(token)
    }

    fun clearToken() {
        tokenInput.setText("")
    }

    private fun readDataTypes(): String {
        return dataTypesInput.value().ifBlank { MiHealthCloudContract.DEFAULT_HEART_RATE_DATA_TYPES }
    }

    private fun readHours(): Long {
        return hoursInput.value().toLongOrNull()?.coerceIn(1L, 24L * 365L) ?: 24L
    }

    private fun readSliceHours(): Long {
        return sliceHoursInput.value().toLongOrNull()?.coerceIn(0L, 24L * 365L) ?: 0L
    }

    private fun readLimit(): Int {
        return limitInput.value().toIntOrNull()?.coerceIn(1, 5000) ?: 500
    }

    private fun readMaxPages(): Int {
        return maxPagesInput.value().toIntOrNull()?.coerceIn(1, 200) ?: 20
    }

    private fun EditText.value(): String {
        return text.toString().trim()
    }
}
