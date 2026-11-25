package com.rabi.link

import android.app.Activity
import android.text.InputType
import android.view.View
import android.widget.LinearLayout
import android.widget.ScrollView

internal class RabiMobileLoginView(
    activity: Activity,
    server: String,
    signIn: (String, String, String) -> Unit,
    restore: () -> Unit,
) : ScrollView(activity) {
    private val serverInput = RabiMobileUi.input(activity, "https://服务器地址").apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setText(server)
    }
    private val username = RabiMobileUi.input(activity, "账号").apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_NORMAL
        setAutofillHints(View.AUTOFILL_HINT_USERNAME)
    }
    private val password = RabiMobileUi.input(activity, "密码").apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        setAutofillHints(View.AUTOFILL_HINT_PASSWORD)
    }
    private val feedback = RabiMobileUi.note(activity, "").apply {
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val submit = RabiMobileUi.primary(activity, "登录") {
        signIn(serverInput.text.toString().trim().trimEnd('/'), username.text.toString().trim(), password.text.toString())
    }
    private val retry = RabiMobileUi.secondary(activity, "重试旧连接") { restore() }

    init {
        setBackgroundColor(RabiMobileUi.background)
        val spacing = RabiMobileUi.dp(activity, 12)
        addView(LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            isFocusableInTouchMode = true
            val inset = RabiMobileUi.dp(activity, 24)
            setPadding(inset, inset, inset, inset)
            for (view in listOf(RabiMobileUi.title(activity, "登录 RabiLink", 26f),
                RabiMobileUi.label(activity, "RabiLink 服务器"), serverInput, username, password, submit, retry, feedback)) {
                addView(view, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = spacing })
            }
            requestFocus()
        })
        update("", busy = false, allowRetry = false)
    }

    fun update(message: String, busy: Boolean, allowRetry: Boolean) {
        feedback.text = message
        feedback.visibility = if (message.isBlank()) View.GONE else View.VISIBLE
        for (view in listOf(serverInput, username, password, submit, retry)) view.isEnabled = !busy
        retry.visibility = if (allowRetry && !busy) View.VISIBLE else View.GONE
    }

    fun clearPassword() = password.text.clear()
}
