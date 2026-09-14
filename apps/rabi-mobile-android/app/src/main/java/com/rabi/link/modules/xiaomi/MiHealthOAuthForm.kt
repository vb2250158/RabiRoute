package com.rabi.link.modules.xiaomi

import android.content.Context
import android.text.InputType
import android.widget.EditText
import android.widget.LinearLayout
import com.rabi.link.RabiMobileUi

internal class MiHealthOAuthForm(
    private val context: Context,
    initial: MiHealthOAuthSettings
) {
    private val appIdInput = EditText(context).apply {
        hint = "小米开放平台 AppID"
        inputType = InputType.TYPE_CLASS_TEXT
        setText(initial.appId)
        RabiMobileUi.styleInput(context, this)
    }

    private val tokenInput = EditText(context).apply {
        hint = "access_token，可手动粘贴"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        setSingleLine(false)
        minLines = 2
        setText(initial.accessToken)
        RabiMobileUi.styleInput(context, this, multiline = true)
    }

    private val redirectInput = EditText(context).apply {
        hint = "OAuth redirect_uri，必须和小米开放平台配置一致"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setText(initial.redirectUri)
        RabiMobileUi.styleInput(context, this)
    }

    private val scopeInput = EditText(context).apply {
        hint = "scope，可留空使用应用已授权范围"
        inputType = InputType.TYPE_CLASS_TEXT
        setText(initial.scope)
        RabiMobileUi.styleInput(context, this)
    }

    private val dataTypesInput = EditText(context).apply {
        hint = "data_types，逗号分隔"
        inputType = InputType.TYPE_CLASS_TEXT
        setText(initial.dataTypes)
        RabiMobileUi.styleInput(context, this)
    }

    private val hoursInput = EditText(context).apply {
        hint = "拉取最近多少小时，默认 24"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.hours.toString())
        RabiMobileUi.styleInput(context, this)
    }

    private val sliceHoursInput = EditText(context).apply {
        hint = "分片小时，0 表示不分片；例如 24 表示按天拉"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.sliceHours.toString())
        RabiMobileUi.styleInput(context, this)
    }

    private val limitInput = EditText(context).apply {
        hint = "每页条数，默认 500"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.limit.toString())
        RabiMobileUi.styleInput(context, this)
    }

    private val maxPagesInput = EditText(context).apply {
        hint = "最大页数，默认 20"
        inputType = InputType.TYPE_CLASS_NUMBER
        setText(initial.maxPages.toString())
        RabiMobileUi.styleInput(context, this)
    }

    fun addFieldsTo(root: LinearLayout) {
        addCredentialFieldsTo(root)
        addAdvancedFieldsTo(root)
    }

    fun addCredentialFieldsTo(root: LinearLayout) {
        addLabeled(root, "合作方 AppID", appIdInput)
        addLabeled(root, "OAuth 回调地址", redirectInput)
        addLabeled(root, "Access token（授权成功后自动填写）", tokenInput)
    }

    fun addAdvancedFieldsTo(root: LinearLayout) {
        addLabeled(root, "授权范围 scope", scopeInput)
        addLabeled(root, "健康数据类型", dataTypesInput)
        addLabeled(root, "最近小时数", hoursInput)
        addLabeled(root, "分片小时数", sliceHoursInput)
        addLabeled(root, "每页条数", limitInput)
        addLabeled(root, "最大页数", maxPagesInput)
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

    private fun addLabeled(root: LinearLayout, label: String, input: EditText) {
        root.addView(RabiMobileUi.label(context, label))
        root.addView(input, LinearLayout.LayoutParams(-1, -2).apply {
            setMargins(0, 0, 0, RabiMobileUi.dp(context, 6))
        })
    }
}
