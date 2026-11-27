package com.rabi.link

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.text.TextWatcher
import android.view.inputmethod.EditorInfo
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import com.rabiroute.sdk.RabiLinkPc
import com.rabiroute.sdk.RabiHttpException
import com.rabiroute.sdk.RabiLinkAccountApplication
import com.rabiroute.sdk.RabiLinkAccountApplications
import com.rabiroute.sdk.RabiLinkMobileAccount
import com.rabiroute.sdk.RabiLinkMobileAccountStatus
import com.rabiroute.sdk.RabiInstance
import com.rabiroute.sdk.RabiRouteInfo
import com.rabiroute.sdk.RabiRouteSdk
import com.rabi.link.modules.conversation.RabiPhoneAudioCapture

/** Phone companion: glasses backend and Relay transport, not a duplicate Rabi PC configuration UI. */
class MainActivity : Activity() {
    private val requestPhoneMedia = 9032
    private val requestNotifications = 9033
    private val managerTransport = lazy { com.rabi.link.transport.RabiManagerHttpTransport(applicationContext) }
    private val sdk by lazy { RabiRouteSdk(managerTransport = managerTransport.value) }
    private val discoverySdk = RabiRouteSdk(timeoutMs = 160, discoveryTimeout = { key, fallback -> com.rabi.link.transport.ScopedManagerTimeouts.active(this).get(key,fallback) })
    private val pcs = mutableListOf<RabiLinkPc>()
    private val discoveredManagers = mutableListOf<RabiInstance>()
    private lateinit var relayUrl: EditText
    private lateinit var relayToken: EditText
    private lateinit var relayUrlHelp: TextView
    private lateinit var relayTokenHelp: TextView
    private lateinit var status: TextView
    private var statusIcon: ImageView? = null
    private lateinit var connectButton: Button
    private lateinit var discoveredPcAction: Button
    private lateinit var runtimeStatus: TextView
    private lateinit var runtimeTranscript: TextView
    private lateinit var runtimeReply: TextView
    private lateinit var runtimeCaptureHealth: TextView
    private lateinit var runtimeMode: TextView
    private lateinit var runtimeConnection: TextView
    private lateinit var runtimeRoute: TextView
    private lateinit var runtimeGlasses: TextView
    private lateinit var runtimeQueue: TextView
    private lateinit var runtimeError: TextView
    private val runtimeHandler = Handler(Looper.getMainLooper())
    private var captureBar: Button? = null
    private val captureListener = Runnable { runtimeHandler.post { refreshCaptureBar() } }
    private fun refreshCaptureBar() {
        val settings = com.rabi.link.recording.AllDayRecordingSettings.load(this)
        val runtime = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
        captureBar?.apply {
            visibility = if (settings.running) View.VISIBLE else View.GONE
            text = "全天记录 · ${runtime.getString("allDayStatus", "等待运行状态")}"
        }
    }
    private lateinit var proactivityPreference: Spinner
    private lateinit var autoPlayAgentVoice: Switch
    private lateinit var ttsModel: EditText
    private lateinit var ttsVoice: EditText
    private lateinit var audioRetentionHours: EditText
    private lateinit var audioReserveFreeMb: EditText
    private enum class Screen { LOGIN, CONVERSATIONS, CHAT, SETTINGS, CONFIG_ASSISTANT }
    private data class ConversationRow(
        val id: String,
        val title: String,
        val chatAvailable: Boolean,
        val running: Boolean,
        val latest: RabiChatStore.Message?,
        val unread: Int,
        val route: RabiRouteInfo? = null,
        val pinned: Boolean = false,
        val destinationHint: String = "",
    )
    private data class AvatarTarget(
        val routeId: String,
        val image: ImageView,
        val status: TextView?,
    )
    private data class ConversationRowViewState(
        val id: String, val title: String, val destination: String, val preview: String, val time: String,
        val unread: Int, val pinned: Boolean, val hint: String, val source: String, val avatarRevision: String,
    )

    private var selectedPc: RabiLinkPc? = null
    private var busy = false
    private var showingSettings = false
    private var screen = Screen.LOGIN
    private lateinit var loginView: RabiMobileLoginView
    private var loginBusy = false
    private var pendingEntryState: Bundle? = null
    private var resumed = false
    private var settingsReturnScreen = Screen.CONVERSATIONS
    private var activeRouteId = ""
    private var mediaTargetRouteId = ""
    private var listScrollY = 0
    private var conversationQuery = ""
    private var chatMessages: LinearLayout? = null
    private var chatScroll: ScrollView? = null
    private var newMessagesAction: Button? = null
    private var chatSignature = ""
    private var followNextMessage = true
    private var restoringChatViewport = false
    private var chatRenderGeneration = 0
    private var renderedLastMessageId = ""
    private var lastReadChatSignature = ""
    private var pendingCallRouteId = ""
    private var composer: EditText? = null
    private var conversationListHost: LinearLayout? = null
    private var callPanel: LinearLayout? = null
    private var conversationListScroll: ScrollView? = null
    private var renderedConversationRows: List<ConversationRowViewState>? = null
    private var accountHeaderAvatar: ImageView? = null
    private var accountHeaderName: TextView? = null
    private var accountHeaderStatus: TextView? = null
    private val outgoingAvatars = mutableListOf<ImageView>()
    private val incomingAvatars = mutableListOf<ImageView>()
    private var chatHeaderAvatar: ImageView? = null
    private var chatHeaderName: TextView? = null
    private var chatHeaderStatus: TextView? = null
    private var accountProfile: MobileAccountSnapshot? = null
    private var accountProfileScope: Pair<String, String>? = null
    private var accountProfileConnection: RabiLinkRelayConfig? = null
    private var accountRequestAt = 0L
    private var accountRequestVersion = 0
    private var pendingAccountStatus: RabiLinkMobileAccountStatus? = null
    private var accountRefreshPending = false
    private var availableRoutes: List<RabiRouteInfo> = emptyList()
    private var routeRequest: RabiLinkRelayConfig? = null
    private var routeRequestAt = 0L
    private var routeRefreshPending = false
    private var routesLoaded = false
    private var routeLoadFailed = false
    private var routeLoadMessage = "正在读取 Rabi PC 上的聊天角色…"
    private var runtimeReceiverRegistered = false
    private val refreshFromChatStore = Runnable {
        when (screen) {
            Screen.CHAT -> renderChat()
            Screen.CONVERSATIONS -> renderConversationList()
            else -> Unit
        }
    }
    private val refreshComputerCatalog = Runnable { loadRouteTargets(force = true) }
    private val avatarTargets = mutableMapOf<String, MutableList<AvatarTarget>>()
    private data class AvatarDirectory(val relay: RabiLinkRelayConfig, val loadedAt: Long, val workers: List<RabiLinkPc>)
    private val avatarDirectoryLock = Any()
    private var avatarDirectory: AvatarDirectory? = null
    private val runtimeReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                RabiConversationService.ACTION_ACCOUNT_PROFILE_CHANGED -> {
                    if (screen == Screen.CONVERSATIONS || screen == Screen.CHAT) {
                        if (pendingAccountStatus == null) refreshAccountProfile(force = true)
                        else accountRefreshPending = true
                    }
                }
                RabiConversationService.ACTION_COMPUTER_DIRECTORY_CHANGED -> {
                    if (screen == Screen.CONVERSATIONS || screen == Screen.CHAT) {
                        runtimeHandler.removeCallbacks(refreshComputerCatalog)
                        runtimeHandler.postDelayed(refreshComputerCatalog, 350L)
                    }
                }
                RabiPersonaAvatarEvents.ACTION_CHANGED ->
                    refreshPersonaAvatar(intent.getStringExtra(RabiPersonaAvatarEvents.EXTRA_ROLE_ID).orEmpty())
                RabiChatStore.ACTION_CHANGED -> {
                    val changedId = intent.getStringExtra(RabiChatStore.EXTRA_CONVERSATION_ID)
                    val activeChatChanged = screen == Screen.CHAT &&
                        !intent.getBooleanExtra(RabiChatStore.EXTRA_LIST_STATE_ONLY, false) &&
                        (changedId == null || changedId == activeRouteId)
                    if (screen == Screen.CONVERSATIONS || activeChatChanged) {
                        runtimeHandler.removeCallbacks(refreshFromChatStore)
                        runtimeHandler.post(refreshFromChatStore)
                    }
                }
                else -> {
                    refreshCaptureBar()
                    refreshConversationRuntime()
                    renderCallPanel()
                }
            }
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.setSoftInputMode(android.view.WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        pendingEntryState = state
        if (RabiLinkRelaySettings.accountId(this).isBlank()) showLogin()
        else openAuthenticatedEntry()
    }

    private fun showLogin(restore: Boolean = true, message: String = "") {
        screen = Screen.LOGIN
        unregisterRuntime()
        captureBar = null
        val saved = RabiLinkRelaySettings.load(this)
        loginView = RabiMobileLoginView(this, saved.baseUrl, ::signIn) { restoreLegacyConnection() }
        super.setContentView(loginView)
        loginView.update(message, busy = false, allowRetry = saved.configured)
        if (restore && saved.configured) restoreLegacyConnection()
    }

    private fun restoreLegacyConnection() {
        val saved = RabiLinkRelaySettings.load(this)
        if (!saved.configured) return
        runLogin("正在验证旧版连接…", "旧连接已失效，请用账号和密码登录。", {
            sdk.getMobileState(saved.baseUrl, saved.token).also {
                check(it.appId.isNotBlank() && it.ownerAccountId.isNotBlank()) { "服务器未返回旧连接所属账号" }
            }
        }) { state ->
            RabiLinkRelaySettings.confirmExisting(this, saved, state.ownerAccountId)
            if (resumed) openAuthenticatedEntry()
        }
    }

    private fun signIn(url: String, username: String, password: String) {
        if (url.isBlank() || username.isBlank() || password.isBlank()) {
            loginView.update("请填写服务器地址、账号和密码。", false, RabiLinkRelaySettings.load(this).configured)
            return
        }
        runLogin("正在登录…", "账号或密码不正确。", { sdk.getMobileAccountApplications(url, username, password) }) { account ->
            loginView.clearPassword()
            val apps = account.applications
            when (apps.size) {
                0 -> loginView.update("此账号没有可连接的应用。请在 RabiLink 管理页创建或启用应用后重试。",
                    false, RabiLinkRelaySettings.load(this).configured)
                1 -> openAccountApplication(url, account, apps.single())
                else -> android.app.AlertDialog.Builder(this).setTitle("选择要连接的应用")
                    .setItems(apps.map { it.name }.toTypedArray()) { _, index ->
                        openAccountApplication(url, account, apps[index])
                    }.setNegativeButton("取消", null).show()
            }
        }
    }

    private fun openAccountApplication(url: String, account: RabiLinkAccountApplications, app: RabiLinkAccountApplication) {
        val accountId = account.accountId
        runLogin("正在验证应用连接…", "所选应用已失效，请重新登录。", {
            sdk.getMobileState(url, app.token).also {
                check(it.appId == app.id && it.ownerAccountId == accountId) { "服务器未确认所选应用属于当前账号" }
            }
        }) { state ->
            state.selectedWorker?.let {
                com.rabi.link.recording.TargetWorkerIdentity.save(this, url, app.token, it.id)
                RabiLinkRelaySettings.rememberComputer(this, it.name, it.id, url, app.token)
            }
            RabiLinkRelaySettings.saveAuthenticated(this, url, app.token, accountId)
            if (account.username.isNotBlank() && RabiMobileAccountCache.load(this, url, accountId) == null) {
                RabiMobileAccountCache.save(this, url, RabiLinkMobileAccount(accountId, account.username, "", null))
            }
            RabiConversationServiceState.setRestoreEnabled(this, true)
            if (resumed) openAuthenticatedEntry()
        }
    }

    private fun <T> runLogin(message: String, authFailure: String, work: () -> T, success: (T) -> Unit) {
        if (loginBusy) return
        loginBusy = true
        val canRetry = RabiLinkRelaySettings.load(this).configured
        loginView.update(message, busy = true, allowRetry = false)
        val reportError: (Throwable) -> Unit = { error ->
            loginBusy = false
            if (!isFinishing && !isDestroyed && screen == Screen.LOGIN) {
                val detail = when {
                    error is RabiHttpException && error.statusCode in listOf(401, 403) -> authFailure
                    error is RabiHttpException -> "服务器暂时无法完成登录（HTTP ${error.statusCode}），请核对地址后重试。"
                    error is java.net.URISyntaxException -> "请填写有效的 RabiLink 服务器地址。"
                    error is java.io.IOException -> "暂时无法连接服务器，请检查网络和地址后重试。"
                    else -> error.message ?: "登录未完成，请重试。"
                }
                loginView.update(detail, busy = false, allowRetry = canRetry)
            }
        }
        runAsync(work, { result ->
            loginBusy = false
            if (!isFinishing && !isDestroyed) {
                loginView.update("", busy = false, allowRetry = canRetry)
                runCatching { success(result) }.onFailure(reportError)
            }
        }, error = reportError)
    }

    private fun openAuthenticatedEntry() {
        val state = pendingEntryState
        pendingEntryState = null
        if (RabiConversationServiceState.shouldRestore(this)) {
            // Starting a message connection does not start capture.
            runCatching { RabiConversationService.start(this) }.onFailure {
                android.util.Log.w("RabiMobile", "Message transport could not start", it)
            }
        }
        if (!intent.getBooleanExtra("open_messages", false) && !intent.getBooleanExtra("open_settings", false) && intentRoute(intent).isBlank()) {
            startActivity(Intent(this, com.rabi.link.recording.RabiRecordingHubActivity::class.java)
                .putExtra("video", intent.getBooleanExtra("open_offline_recorder", false)))
            finish()
            return
        }
        val saved = RabiLinkRelaySettings.load(this)
        if (saved.configured) availableRoutes = RabiRouteMetadataCache.load(this, saved)
        activeRouteId = intentRoute(intent).ifBlank { state?.getString("active_route_id").orEmpty() }
        pendingCallRouteId = state?.getString("pending_call_route_id").orEmpty()
        listScrollY = state?.getInt("conversation_list_scroll_y", 0) ?: 0
        conversationQuery = state?.getString("conversation_query").orEmpty()
        val restored = runCatching { Screen.valueOf(state?.getString("screen").orEmpty()) }.getOrNull()
        when {
            intent.getBooleanExtra("open_settings", false) -> showSettings(saved)
            restored == Screen.SETTINGS -> showSettings(saved)
            activeRouteId.isNotBlank() -> showConversationDetail(activeRouteId)
            else -> showConversationList()
        }
        if (resumed) registerRuntime()
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), requestNotifications)
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (screen == Screen.LOGIN) return
        val routeProfileId = intentRoute(intent)
        when {
            routeProfileId.isNotBlank() -> showConversationDetail(routeProfileId)
            intent?.getBooleanExtra("open_settings", false) == true -> showSettings()
            intent?.getBooleanExtra("open_messages", false) == true -> showConversationList()
        }
    }

    private fun intentRoute(intent: Intent?): String = intent?.getStringExtra("route_profile_id")?.trim().orEmpty()

    override fun setContentView(view: View) {
        val shell = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        shell.addView(view, LinearLayout.LayoutParams(-1, 0, 1f))
        captureBar = RabiMobileUi.compactAction(this, "全天记录") { openAllDayRecording() }.apply {
            textSize = 12f; minHeight = dp(40); minimumHeight = dp(40)
            val record = RabiMobileUi.icon(this@MainActivity, R.drawable.ic_ui_records).drawable.apply { setBounds(0, 0, dp(18), dp(18)) }
            val chevron = RabiMobileUi.icon(this@MainActivity, R.drawable.ic_ui_chevron).drawable.apply { setBounds(0, 0, dp(18), dp(18)) }
            setCompoundDrawables(record, null, chevron, null)
            compoundDrawablePadding = dp(8)
        }
        shell.addView(captureBar)
        refreshCaptureBar()
        if (screen != Screen.CHAT) {
            val selectedTab = if (screen in setOf(Screen.SETTINGS, Screen.CONFIG_ASSISTANT)) "settings" else "messages"
            shell.addView(RabiMobileUi.bottomNavigation(this, selectedTab) { key ->
                if (key == "messages") { if (screen != Screen.CONVERSATIONS) showConversationList() }
                else if (key == "settings") { if (screen != Screen.SETTINGS) showSettings() }
                else {
                    startActivity(Intent(this@MainActivity, com.rabi.link.recording.RabiRecordingHubActivity::class.java)
                        .putExtra("page", key).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    finish()
                }
            })
        }
        super.setContentView(shell)
    }

    private fun refreshAccountProfile(force: Boolean = false) {
        val relay = RabiLinkRelaySettings.load(this)
        val id = RabiLinkRelaySettings.accountId(this)
        if (!relay.configured || id.isBlank()) return
        val scope = relay.baseUrl to id
        if (accountProfileScope != scope || accountProfileConnection != relay) {
            accountProfileScope = scope
            accountProfileConnection = relay
            accountProfile = null
            accountRequestAt = 0L
            pendingAccountStatus = null
            accountRefreshPending = false
        }
        drawAccountProfile()
        if (pendingAccountStatus != null) return
        val now = android.os.SystemClock.elapsedRealtime()
        if (!force && accountRequestAt != 0L && now - accountRequestAt < 60_000L) return
        accountRequestAt = now
        val version = ++accountRequestVersion
        val previous = accountProfile
        fun current() = !isDestroyed && !isFinishing && accountRequestVersion == version &&
            accountProfileScope == scope && RabiLinkRelaySettings.accountId(this) == id && RabiLinkRelaySettings.load(this) == relay
        fun show(snapshot: MobileAccountSnapshot) {
            if (!current()) return
            if (accountProfile?.profile != snapshot.profile) {
                accountProfile = snapshot
                drawAccountProfile()
            }
        }
        runAsync({
            val cached = if (previous == null) RabiMobileAccountCache.load(applicationContext, scope.first, id) else null
            if (cached != null) {
                val snapshot = RabiMobileAccountCache.snapshot(cached)
                runOnUiThread { show(snapshot) }
            }
            val profile = sdk.getMobileAccount(relay.baseUrl, relay.token)
            check(profile.id == id) { "Mobile account identity changed" }
            if (previous != null && previous.profile.avatarPng == profile.avatarPng) previous.copy(profile = profile)
            else RabiMobileAccountCache.snapshot(profile)
        }, { snapshot ->
            if (current()) {
                RabiMobileAccountCache.save(this, scope.first, snapshot.profile)
                show(snapshot)
            }
        }, error = {})
    }

    private fun bindOwnAvatar(avatar: ImageView) {
        val profile = accountProfile
        val bitmap = profile?.avatar
        val avatarSource = bitmap ?: R.drawable.ic_persona_avatar_placeholder
        if (avatar.tag != avatarSource) {
            avatar.tag = avatarSource
            if (bitmap != null) avatar.setImageBitmap(bitmap)
            else avatar.setImageResource(R.drawable.ic_persona_avatar_placeholder)
        }
        avatar.contentDescription = profile?.profile?.displayName?.takeIf { it.isNotBlank() }?.let { "$it 的头像" } ?: "我的头像"
    }

    private fun drawAccountProfile() {
        if (screen == Screen.CONVERSATIONS) {
            accountHeaderName?.text = accountProfile?.profile?.displayName?.ifBlank { "已登录" } ?: "已登录"
            accountHeaderAvatar?.let(::bindOwnAvatar)
            val status = pendingAccountStatus ?: accountProfile?.profile?.status
            accountHeaderStatus?.apply {
                visibility = if (status == null) View.GONE else View.VISIBLE
                if (status != null) {
                    val label = accountStatusLabel(status)
                    text = android.text.SpannableString("●  $label  ⌄").apply {
                        setSpan(android.text.style.ForegroundColorSpan(accountStatusColor(status)), 0, 1, 0)
                    }
                    isEnabled = pendingAccountStatus == null
                    contentDescription = if (isEnabled) "我的状态，$label，点按修改" else "正在保存状态，$label"
                }
            }
        }
        if (screen == Screen.CHAT) outgoingAvatars.forEach(::bindOwnAvatar)
    }

    private fun accountStatusLabel(status: RabiLinkMobileAccountStatus): String = when (status) {
        RabiLinkMobileAccountStatus.ONLINE -> "在线"
        RabiLinkMobileAccountStatus.AWAY -> "离开"
        RabiLinkMobileAccountStatus.BUSY -> "忙碌"
        RabiLinkMobileAccountStatus.DO_NOT_DISTURB -> "请勿打扰"
    }

    private fun accountStatusColor(status: RabiLinkMobileAccountStatus): Int = when (status) {
        RabiLinkMobileAccountStatus.ONLINE -> Color.rgb(33, 172, 105)
        RabiLinkMobileAccountStatus.AWAY -> Color.rgb(188, 130, 27)
        RabiLinkMobileAccountStatus.BUSY -> Color.rgb(220, 105, 54)
        RabiLinkMobileAccountStatus.DO_NOT_DISTURB -> Color.rgb(221, 77, 104)
    }

    private fun chooseAccountStatus() {
        val current = accountProfile?.profile?.status ?: return
        if (pendingAccountStatus != null) return
        val choices = RabiLinkMobileAccountStatus.entries
        android.app.AlertDialog.Builder(this)
            .setTitle("我的状态")
            .setSingleChoiceItems(choices.map(::accountStatusLabel).toTypedArray(), choices.indexOf(current)) { dialog, index ->
                dialog.dismiss()
                if (choices[index] != current) saveAccountStatus(choices[index])
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun saveAccountStatus(status: RabiLinkMobileAccountStatus) {
        val snapshot = accountProfile ?: return
        val relay = RabiLinkRelaySettings.load(this)
        val id = snapshot.profile.id
        if (id != RabiLinkRelaySettings.accountId(this) || accountProfileScope != (relay.baseUrl to id)) return
        val version = ++accountRequestVersion
        pendingAccountStatus = status
        drawAccountProfile()
        fun current() = !isDestroyed && !isFinishing && version == accountRequestVersion &&
            RabiLinkRelaySettings.accountId(this) == id && RabiLinkRelaySettings.load(this) == relay
        runAsync({ sdk.setMobileAccountStatus(relay.baseUrl, relay.token, id, status) }, { saved ->
            if (current()) {
                pendingAccountStatus = null
                val updated = snapshot.profile.copy(status = saved)
                accountProfile = snapshot.copy(profile = updated)
                RabiMobileAccountCache.save(this, relay.baseUrl, updated)
                drawAccountProfile()
                if (accountRefreshPending) {
                    accountRefreshPending = false
                    refreshAccountProfile(force = true)
                }
            }
        }, error = {
            if (current()) {
                pendingAccountStatus = null
                accountRefreshPending = false
                toast("暂未确认状态已保存，正在读取服务器状态")
                refreshAccountProfile(force = true)
            }
        })
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("screen", screen.name)
        outState.putString("active_route_id", activeRouteId)
        outState.putInt("conversation_list_scroll_y", conversationListScroll?.scrollY ?: listScrollY)
        outState.putString("conversation_query", conversationQuery)
        outState.putString("pending_call_route_id", pendingCallRouteId)
        super.onSaveInstanceState(outState)
    }

    override fun onBackPressed() {
        if (screen == Screen.SETTINGS &&
            (intent.hasExtra("computer_id") || intent.getBooleanExtra("relay_settings",false))) {
            finish()
            return
        }
        when (screen) {
            Screen.CHAT -> showConversationList()
            Screen.SETTINGS -> if (settingsReturnScreen == Screen.CHAT && activeRouteId.isNotBlank()) showConversationDetail(activeRouteId) else showConversationList()
            Screen.CONFIG_ASSISTANT -> showSettings()
            Screen.LOGIN, Screen.CONVERSATIONS -> super.onBackPressed()
        }
    }

    private fun showSettings(savedConnection: RabiLinkRelayConfig = RabiLinkRelaySettings.load(this)) {
        pendingCallRouteId = ""
        val saved = RabiLinkRelaySettings.computers(this).firstOrNull {
            it.id == intent.getStringExtra("computer_id") && it.connection == savedConnection
        }?.connection ?: savedConnection
        if (screen != Screen.SETTINGS && screen != Screen.LOGIN) settingsReturnScreen = screen
        screen = Screen.SETTINGS
        showingSettings = true
        avatarTargets.clear()
        chatMessages = null; chatScroll = null; composer = null; conversationListHost = null; conversationListScroll = null
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        root.addView(RabiMobileUi.title(this, "设置", 23f).apply { setPadding(dp(20), dp(16), dp(20), dp(12)); setBackgroundColor(RabiMobileUi.surface) })
        root.addView(buildUi(), LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        if (saved.baseUrl.isNotBlank()) {
            relayUrl.setText(saved.baseUrl)
            setUrlHelp("已填入上次验证过的服务器地址。App 会自动重新检查它是否可用。", RabiGuidanceTone.SUCCESS)
        }
        if (saved.token.isNotBlank()) {
            relayToken.setText(saved.token)
            setTokenHelp("已安全保存登录码。这里不会显示明文，也不会把它写入日志。", RabiGuidanceTone.SUCCESS)
        }
        loadConversationSettings()
        autoPrepareSetup(saved)
    }

    private fun showConversationList() {
        if (screen == Screen.CHAT) currentFocus?.let { focused ->
            getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                .hideSoftInputFromWindow(focused.windowToken, 0)
        }
        pendingCallRouteId = ""
        screen = Screen.CONVERSATIONS
        showingSettings = false
        activeRouteId = ""
        avatarTargets.clear()
        outgoingAvatars.clear()
        incomingAvatars.clear()
        chatHeaderAvatar = null
        chatHeaderName = null
        chatHeaderStatus = null
        chatMessages = null; chatScroll = null; composer = null
        renderedConversationRows = null
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(RabiMobileUi.surface)
            isFocusableInTouchMode = true
        }
        val search = input("搜索会话").apply {
            setSingleLine(); setText(conversationQuery)
            minHeight = dp(44); minimumHeight = dp(44)
            setPadding(dp(14), dp(8), dp(14), dp(8))
            background = panel(RabiMobileUi.inputSurface, Color.TRANSPARENT, 14)
            val searchIcon = RabiMobileUi.icon(this@MainActivity, R.drawable.ic_ui_search, RabiMobileUi.muted).drawable.mutate()
            searchIcon.setTint(RabiMobileUi.muted)
            searchIcon.setBounds(0, 0, dp(18), dp(18))
            setCompoundDrawablesRelative(searchIcon, null, null, null)
            compoundDrawablePadding = dp(10)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun afterTextChanged(value: Editable?) = Unit
                override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) {
                    conversationQuery = value?.toString().orEmpty()
                    listScrollY = 0
                    renderConversationList()
                }
            })
        }
        root.addView(row().apply {
            setPadding(dp(16), dp(8), dp(8), dp(6))
            accountHeaderAvatar = RabiConversationListUi(this@MainActivity).avatar("我的头像", 40).also {
                addView(it, LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(10) })
            }
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                accountHeaderName = RabiMobileUi.title(this@MainActivity, "已登录", 18f).apply {
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                }.also { addView(it) }
                accountHeaderStatus = note("").apply {
                    textSize = 12f
                    maxLines = 1
                    ellipsize = android.text.TextUtils.TruncateAt.END
                    minHeight = dp(26)
                    gravity = Gravity.CENTER_VERTICAL
                    isFocusable = true
                    visibility = View.GONE
                    setOnClickListener { chooseAccountStatus() }
                }.also { addView(it) }
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(RabiMobileUi.iconAction(this@MainActivity, R.drawable.ic_ui_mic, "语音助手") {
                startActivity(Intent(this@MainActivity, com.rabi.link.assistant.MobileAssistantActivity::class.java))
            }, LinearLayout.LayoutParams(dp(48), dp(48)))
        })
        root.addView(search, full(16, 2, 16, 6))
        conversationListHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.surface) }
        conversationListScroll = ScrollView(this).apply {
            isFillViewport = true
            addView(conversationListHost)
            setOnScrollChangeListener { _, _, scrollY, _, _ -> listScrollY = scrollY }
        }
        root.addView(conversationListScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        root.requestFocus()
        refreshAccountProfile()
        renderConversationList()
        loadRouteTargets()
    }

    private fun showConversationDetail(routeProfileId: String) {
        val routeId = routeProfileId.trim()
        if (routeId.isBlank()) return showConversationList()
        screen = Screen.CHAT
        showingSettings = false
        activeRouteId = routeId
        chatSignature = ""
        renderedLastMessageId = ""
        lastReadChatSignature = ""
        followNextMessage = true
        avatarTargets.clear()
        outgoingAvatars.clear()
        incomingAvatars.clear()
        accountHeaderAvatar = null
        accountHeaderName = null
        RabiConversationTarget.save(this, routeId)
        conversationListHost = null; conversationListScroll = null
        val route = availableRoutes.firstOrNull { it.id == routeId }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        val header = appBar(routeTitle(routeId), routeStatus(route), "返回", avatarRoute = route) { showConversationList() } as LinearLayout
        header.addView(RabiMobileUi.iconAction(this, R.drawable.ic_ui_phone, "语音通话") { beginCall(routeId) }, LinearLayout.LayoutParams(dp(48), dp(48)))
        root.addView(header)
        root.addView(RabiMobileUi.insetDivider(this, 0), LinearLayout.LayoutParams(-1, 1))
        callPanel = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(12), dp(16), dp(12)); setBackgroundColor(RabiMobileUi.surface) }
        root.addView(callPanel)
        renderCallPanel()
        chatMessages = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(18)) }
        chatScroll = ScrollView(this).apply {
            addView(chatMessages)
            setOnScrollChangeListener { _, _, _, _, _ ->
                if (!restoringChatViewport && isChatAtBottom()) {
                    newMessagesAction?.visibility = View.GONE
                    markConversationRead()
                }
            }
        }
        root.addView(chatScroll, LinearLayout.LayoutParams(-1, 0, 1f))
        newMessagesAction = RabiMobileUi.compactAction(this,"有新消息 · 查看") {
            chatScroll?.fullScroll(View.FOCUS_DOWN)
            markConversationRead()
        }.apply { visibility = View.GONE }.also { root.addView(it) }
        val canSend = route?.let(::isRouteChatCapable) ?: !routesLoaded
        if (canSend) {
            val composePanel = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setBackgroundColor(RabiMobileUi.surface)
            }
            val bottom = row().apply {
                setPadding(dp(12), dp(8), dp(12), 0)
                gravity = Gravity.BOTTOM; isBaselineAligned = false
            }
            val send = primary("发送") { sendComposer() }.apply {
                contentDescription = "发送消息"
                minWidth = dp(64)
            }
            fun updateSend(value: CharSequence?) {
                send.isEnabled = !value.isNullOrBlank()
                send.alpha = if (send.isEnabled) 1f else .50f
            }
            composer = input("消息").apply {
                setSingleLine(false); minLines = 1; maxLines = 5
                gravity = Gravity.TOP or Gravity.START
                setPadding(dp(14), dp(12), dp(14), dp(12))
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
                imeOptions = EditorInfo.IME_ACTION_SEND
                setText(RabiChatStore(this@MainActivity).draft(routeId))
                updateSend(text)
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) {
                        RabiChatStore(this@MainActivity).saveDraft(routeId, value?.toString().orEmpty())
                        updateSend(value)
                    }
                    override fun afterTextChanged(value: Editable?) = Unit
                })
                setOnEditorActionListener { _, actionId, event ->
                    val sendAction = actionId == EditorInfo.IME_ACTION_SEND
                        || (event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN && !event.isShiftPressed)
                    if (sendAction) sendComposer()
                    sendAction
                }
            }
            bottom.addView(composer, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(8) })
            bottom.addView(send, LinearLayout.LayoutParams(-2, dp(48)))
            composePanel.addView(bottom)
            composePanel.addView(row().apply {
                setPadding(dp(4), 0, dp(4), dp(2))
                fun shortcut(label: String, description: String, icon: Int, mimeType: String) =
                    RabiMobileUi.compactAction(this@MainActivity, label) { pickPhoneMedia(mimeType) }.apply {
                        contentDescription = description
                        getDrawable(icon)?.mutate()?.let { image ->
                            image.setTint(RabiMobileUi.primary)
                            image.setBounds(0, 0, dp(18), dp(18))
                            setCompoundDrawablesRelative(image, null, null, null)
                            compoundDrawablePadding = dp(7)
                        }
                    }
                addView(shortcut("图片", "选择图片", android.R.drawable.ic_menu_gallery, "image/*"))
                addView(shortcut("文件", "添加附件", R.drawable.ic_ui_attach, "*/*"))
            })
            root.addView(composePanel)
        } else {
            root.addView(RabiMobileUi.guidance(this, RabiSetupGuidance(
                "这个角色当前不能发送消息",
                if (route == null) "Rabi PC 已不再发布这个会话；历史消息仍可查看。" else "对应 RabiLink 消息端尚未启用。",
                "打开设置里的远程配置，启用该角色的 RabiLink 消息端。",
                RabiGuidanceTone.WARNING,
            )).apply { setOnClickListener { showSettings() } })
        }
        setContentView(root)
        refreshAccountProfile()
        renderChat()
        loadRouteTargets()
    }

    private fun showConfigurationAssistant() {
        screen = Screen.CONFIG_ASSISTANT
        showingSettings = false
        avatarTargets.clear()
        val routeId = RabiConversationTarget.load(this).ifBlank {
            availableRoutes.firstOrNull(::isRouteChatCapable)?.id.orEmpty()
        }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(RabiMobileUi.background) }
        root.addView(appBar("配置助手", "独立于普通聊天", "返回") { showSettings() })
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(16), dp(16), dp(28))
            addView(RabiMobileUi.guidance(this@MainActivity, RabiSetupGuidance(
                "先描述你想检查或调整什么",
                "配置请求会交给 ${if (routeId.isBlank()) "当前 Rabi PC" else routeTitle(routeId)}；删除、停止、覆盖和外部动作仍需经过 Rabi PC 安全门。",
                "如果你知道具体字段，优先回到设置在对应输入框中修改；这里适合不知道字段名时求助。",
                RabiGuidanceTone.INFO,
            )), full(0, 0, 0, 12))
            val request = input("例如：帮我检查为什么手机收不到夜雨的回复").apply {
                setSingleLine(false); minLines = 4; maxLines = 8
                gravity = Gravity.TOP or Gravity.START
                setPadding(dp(14), dp(12), dp(14), dp(12))
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            }
            addView(label("配置请求")); addView(request, full(0, 0, 0, 6))
            addView(RabiMobileUi.fieldHelp(this@MainActivity,
                "请写清“想达到什么结果”和“现在看到什么失败”。助手不会绕过确认，也不会把失败说成成功。"), full(0, 0, 0, 8))
            addView(primary("交给 Rabi 检查") {
                val text = request.text.toString().trim()
                if (text.isBlank()) return@primary toast("请先描述要检查的配置")
                if (routeId.isBlank()) return@primary toast("还没有可用聊天角色，请先在远程配置中启用 RabiLink 消息端")
                if (!confirmChatDestination(routeId)) return@primary
                RabiConversationService.sendConfigurationRequest(this@MainActivity, text, routeId)
                request.text.clear()
                toast("配置请求已进入安全队列；结果会回到对应会话")
            }, full(0, 4, 0, 8))
            addView(secondary("我知道字段，打开远程配置") { openRemoteConfig() }, full(0, 0, 0, 0))
        }
        root.addView(ScrollView(this).apply { addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun beginCall(routeId: String) {
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            pendingCallRouteId = routeId
            requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), 7451)
            return
        }
        val route = availableRoutes.firstOrNull { it.id == routeId }
        if (!routesLoaded || routeLoadFailed) {
            pendingCallRouteId = routeId
            toast("正在确认通话连接…"); loadRouteTargets(); return
        }
        if (route == null || !isRouteChatCapable(route)) {
            pendingCallRouteId = ""
            toast("当前会话暂不支持通话，请检查电脑连接与消息设置"); return
        }
        val worker = route.rawJson.optString("ownerWorkerId")
        if (worker.isBlank() || route.rawJson.optInt("voiceCallProtocol") != 1) {
            toast("这台电脑尚未提供语音通话能力，请更新并检查会话详情"); return
        }
        RabiConversationService.startVoiceCall(this, worker, routeId)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 7451) return
        val routeId = pendingCallRouteId
        pendingCallRouteId = ""
        if (grantResults.firstOrNull() == android.content.pm.PackageManager.PERMISSION_GRANTED &&
            screen == Screen.CHAT && routeId.isNotBlank() && routeId == activeRouteId) beginCall(routeId)
        else if (grantResults.firstOrNull() != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            android.app.AlertDialog.Builder(this).setTitle("通话需要麦克风权限")
                .setMessage("允许麦克风后才能说话；文字聊天仍可使用。")
                .setPositiveButton("应用权限") { _, _ -> startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.parse("package:$packageName"))) }
                .setNegativeButton("取消",null).show()
        }
    }

    private fun renderCallPanel() {
        val panel = callPanel ?: return
        panel.removeAllViews()
        val runtime = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
        val state = runtime.getString("callState", "ended").orEmpty()
        val route = runtime.getString("callRouteId", "").orEmpty()
        val active = runtime.getBoolean("callActive", false)
        panel.visibility = if (route == activeRouteId && (active || state == "error")) View.VISIBLE else View.GONE
        if (panel.visibility != View.VISIBLE) return
        panel.addView(TextView(this).apply {
            text = when(state) {
                "listening" -> "可以说话了"
                "waiting" -> "正在等待回复"
                "speaking" -> "正在播报 · 请等播报结束再说话"
                "muted" -> "麦克风已静音"
                "offline" -> "连接已断开 · 录音仍保留"
                "error" -> "通话遇到问题"
                else -> "正在连接"
            }
            textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.text)
        })
        panel.addView(TextView(this).apply {
            text = if(state == "error") runtime.getString("callStatus", "请检查电脑连接后重试")
                else "轮流说话，播报时暂不收音。通话录音会保存；挂断后已送出的任务仍可能继续。"
            textSize = 12f; setTextColor(RabiMobileUi.muted); setPadding(0, dp(6), 0, dp(8))
        })
        if (active) panel.addView(row().apply {
            addView(secondary(if (runtime.getBoolean("callMuted", false)) "取消静音" else "静音") { RabiConversationService.muteVoiceCall(this@MainActivity) }, LinearLayout.LayoutParams(0, dp(48), 1f))
            addView(secondary("挂断") { RabiConversationService.endVoiceCall(this@MainActivity) }, LinearLayout.LayoutParams(0, dp(48), 1f).apply { setMargins(dp(8), 0, 0, 0) })
        })
        else if(state == "error") panel.addView(secondary("重新连接通话") { beginCall(activeRouteId) })
    }

    private fun appBar(title: String, subtitle: String, leading: String? = null, trailing: String? = null, avatarRoute: RabiRouteInfo? = null, action: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8)); setBackgroundColor(RabiMobileUi.surface)
            if (leading != null) addView(RabiMobileUi.iconAction(this@MainActivity, R.drawable.ic_ui_back, leading, action = action), LinearLayout.LayoutParams(dp(48), dp(48)))
            if (screen == Screen.CHAT) {
                val avatar = RabiConversationListUi(this@MainActivity).avatar(title, 36)
                chatHeaderAvatar = avatar
                if (avatarRoute != null) bindPersonaAvatar(avatarRoute, avatar, null)
                addView(avatar, LinearLayout.LayoutParams(dp(36), dp(36)).apply { marginEnd = dp(10) })
            }
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@MainActivity).apply {
                    text = title; textSize = 18f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.text)
                    maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                    if (screen == Screen.CHAT) chatHeaderName = this
                })
                if (subtitle.isNotBlank()) addView(TextView(this@MainActivity).apply {
                    text = subtitle; textSize = 12f; maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END
                    setTextColor(RabiMobileUi.muted)
                    if (screen == Screen.CHAT) chatHeaderStatus = this
                })
            }, LinearLayout.LayoutParams(0, -2, 1f))
            if (trailing != null) addView(RabiMobileUi.compactAction(this@MainActivity, trailing, action), LinearLayout.LayoutParams(-2, dp(48)))
        }

    private fun loadRouteTargets(force: Boolean = false) {
        val relay = RabiLinkRelaySettings.load(this)
        if (!relay.configured) return
        if (routeRequest == relay) {
            if (force) routeRefreshPending = true
            return
        }
        val now = android.os.SystemClock.elapsedRealtime()
        if (!force && routesLoaded && now - routeRequestAt < 15_000L) return
        routeRequest = relay
        routeRefreshPending = false
        routeRequestAt = now
        routesLoaded = false
        routeLoadFailed = false
        routeLoadMessage = "正在读取 Rabi PC 上的聊天角色…"
        val previous = availableRoutes
        runAsync({
            val workers = sdk.getMobileState(relay.baseUrl, relay.token).workers
            val online = workers.filter { it.online }
            val pool = java.util.concurrent.Executors.newFixedThreadPool(online.size.coerceIn(1, 4))
            val catalogs = try {
                val requests = online.associate { worker -> worker.id to pool.submit<List<RabiRouteInfo>> {
                    sdk.getMobileRouteCatalog(relay.baseUrl, relay.token, worker).routes
                } }
                requests.mapNotNull { (id, request) -> runCatching { id to request.get() }.getOrNull() }.toMap()
            } finally { pool.shutdown() }
            if (online.isNotEmpty() && catalogs.isEmpty()) error("No computer catalog could be refreshed")
            RabiConversationRules.mergeComputerCatalogs(previous, workers, catalogs)
        }, { routes ->
            if (routeRequest == relay) routeRequest = null
            if (isDestroyed || RabiLinkRelaySettings.load(this) != relay) return@runAsync
            routesLoaded = true; routeLoadFailed = false
            // The PC catalog includes personas without a configured mobile chat route.
            // Listing a persona does not enable or alter its chat configuration.
            availableRoutes = routes
            RabiRouteMetadataCache.save(this@MainActivity, relay, routes)
            syncAiuiChatHistory()
            if (screen == Screen.CONVERSATIONS) renderConversationList()
            if (screen == Screen.CHAT) {
                val route = routes.firstOrNull { it.id == activeRouteId }
                chatHeaderName?.text = routeTitle(activeRouteId)
                chatHeaderStatus?.text = routeStatus(route)
                if (route != null) chatHeaderAvatar?.let { avatar ->
                    val oldTarget = avatarTargets[route.agentRoleId]?.any { it.image === avatar } == true
                    bindPersonaAvatar(route, avatar, null, register = !oldTarget)
                }
                renderChat()
            }
            if(screen == Screen.CHAT && pendingCallRouteId.isNotBlank() && pendingCallRouteId == activeRouteId) {
                val pending = pendingCallRouteId
                pendingCallRouteId = ""
                beginCall(pending)
            }
        }, complete = {
            if (!isDestroyed && resumed && (screen == Screen.CONVERSATIONS || screen == Screen.CHAT) && routeRefreshPending) {
                loadRouteTargets(force = true)
            }
        }, error = { error ->
            if (routeRequest == relay) routeRequest = null
            if (isDestroyed || RabiLinkRelaySettings.load(this) != relay) return@runAsync
            routesLoaded = true; routeLoadFailed = true
            val unauthorized = error.message.orEmpty().contains("unauthorized", ignoreCase = true) || error.message.orEmpty().contains("401")
            routeLoadMessage = if (unauthorized) {
                "移动端登录已失效，请到设置重新粘贴登录码。"
            } else {
                "暂时无法更新电脑上的聊天角色，已保留本机数据。"
            }
            if (screen == Screen.CONVERSATIONS) renderConversationList()
            if (screen == Screen.CHAT) {
                chatHeaderStatus?.text = if (unauthorized) "连接验证失败" else "暂时无法更新会话状态"
                renderChat()
            }
        })
    }

    private fun renderConversationList() {
        val host = conversationListHost ?: return
        val restoreScrollY = listScrollY
        fun clearRows() {
            renderedConversationRows = null
            host.removeAllViews()
            avatarTargets.clear()
        }
        if (!RabiLinkRelaySettings.load(this).configured) {
            clearRows()
            host.addView(conversationEmpty("尚未连接 Rabi", "连接后即可查看会话。", "前往设置") { showSettings() })
            return
        }
        if (!routesLoaded && availableRoutes.isEmpty()) {
            clearRows()
            host.addView(conversationEmpty("正在加载会话", routeLoadMessage, "重新加载") { loadRouteTargets(force = true) })
            return
        }
        val store = RabiChatStore(this)
        val summaries = try { store.summaries() } catch (error: Exception) {
            clearRows()
            host.addView(conversationEmpty("无法读取会话状态", "本机消息或置顶状态读取失败。", "重试") { renderConversationList() })
            return
        }
        val chatRoutes = RabiConversationRules.personaConversations(availableRoutes)
        val titleCounts = chatRoutes.groupingBy(::personaTitle).eachCount()
        val rows = chatRoutes.map { route ->
            val summary = summaries[route.id]
            ConversationRow(route.id, personaTitle(route),
                isRouteChatCapable(route), route.running,
                summary?.latest, summary?.unread ?: 0, route, summary?.pinned ?: false,
                if ((titleCounts[personaTitle(route)] ?: 0) > 1) "${route.rawJson.optString("ownerComputerName")} · ${route.routeName.ifBlank { route.name }}" else "")
        }.toMutableList()
        rows.sortWith(compareByDescending<ConversationRow> { it.latest?.createdAt ?: 0L }.thenBy { it.title })
        if (rows.isEmpty()) {
            clearRows()
            host.addView(conversationEmpty(
                if (routeLoadFailed) "还没能读取聊天角色" else "PC 上还没有角色",
                if (routeLoadFailed) routeLoadMessage else "已连接的 Rabi PC 暂无聊天角色。",
                if (routeLoadFailed) "重新加载" else "打开设置",
            ) { if (routeLoadFailed) loadRouteTargets(force = true) else showSettings() })
            return
        }
        val matching = rows.filter {
            conversationQuery.isBlank() || listOf(it.title, conversationDestination(it), preview(it.latest)).any { value -> value.contains(conversationQuery.trim(), ignoreCase = true) }
        }
        val presentation = matching.map { item ->
            val route = item.route
            ConversationRowViewState(item.id, item.title, conversationDestination(item), preview(item.latest),
                formatListTime(item.latest?.createdAt ?: 0), item.unread, item.pinned, item.destinationHint,
                RabiConversationRules.personaComputerName(route),
                route?.let { "${it.avatarConfigured}:${personaAvatarVersion(it)}:${it.rawJson.optString("personaSourceWorkerId")}:${it.rawJson.optString("ownerWorkerId")}" }.orEmpty())
        }
        if (renderedConversationRows == presentation) return
        clearRows()
        renderedConversationRows = presentation
        if (matching.isEmpty()) host.addView(note("没有匹配的会话").apply { setPadding(dp(24), dp(32), dp(24), dp(32)) })
        val pinned = matching.filter { it.pinned }
        pinned.forEach { host.addView(conversationRow(it)) }
        if (pinned.isNotEmpty()) host.addView(RabiMobileUi.insetDivider(this, 20, 20), LinearLayout.LayoutParams(-1, 1).apply {
            topMargin = dp(4); bottomMargin = dp(8)
        })
        matching.filterNot { it.pinned }.forEachIndexed { index, item ->
            if (index > 0) host.addView(RabiMobileUi.insetDivider(this, 76), LinearLayout.LayoutParams(-1, 1))
            host.addView(conversationRow(item))
        }
        conversationListScroll?.post { conversationListScroll?.scrollTo(0, restoreScrollY) }
    }

    private fun conversationDestination(item: ConversationRow): String {
        val computer = item.route?.rawJson?.optString("ownerComputerName").orEmpty().ifBlank { "电脑名称待更新" }
        val routeLabel = item.route?.routeName.orEmpty().ifBlank { item.route?.name.orEmpty() }
        return "$computer · $routeLabel"
    }

    private fun conversationRow(item: ConversationRow): View {
        val ui = RabiConversationListUi(this)
        val avatar = ui.avatar(item.title, 46)
        item.route?.let { bindPersonaAvatar(it, avatar, null) }
        return ui.row(item.title, preview(item.latest), formatListTime(item.latest?.createdAt ?: 0), conversationDestination(item), avatar, item.unread,
            { showConversationDetail(item.id) }, { showConversationActions(item) }, item.destinationHint,
            sourceComputer = RabiConversationRules.personaComputerName(item.route), pinned = item.pinned)
    }

    private fun showConversationActions(item: ConversationRow) {
        val ui = RabiConversationListUi(this)
        val avatar = ui.avatar(item.title, 48)
        item.route?.let { bindPersonaAvatar(it, avatar, null, register = false) }
        fun update(action: (RabiChatStore) -> Unit) {
            try {
                action(RabiChatStore(this))
                listScrollY = 0
            } catch (error: Exception) { toast("会话状态保存失败，请重试") }
        }
        ui.actions(item.title, conversationDestination(item), avatar, item.pinned, item.unread,
            open = { showConversationDetail(item.id) },
            pin = { update { it.setPinned(item.id, !item.pinned) } },
            read = { update {
                if (item.unread > 0) {
                    it.markRead(item.id)
                    RabiConversationService.clearConversationNotification(this, item.id)
                } else it.markUnread(item.id)
            } },
            copy = {
                (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("会话 ID", item.id))
                toast("已复制会话 ID")
            })
    }

    private fun conversationEmpty(title: String, reason: String, actionText: String, action: () -> Unit): View =
        LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(28), dp(72), dp(28), dp(28))
            addView(ImageView(this@MainActivity).apply { setImageResource(R.drawable.rabiroute_icon); contentDescription = "Rabi" }, LinearLayout.LayoutParams(dp(72), dp(72)))
            addView(TextView(this@MainActivity).apply { text = title; textSize = 19f; typeface = Typeface.DEFAULT_BOLD; setTextColor(RabiMobileUi.primary); gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(8)) })
            addView(TextView(this@MainActivity).apply { text = reason; textSize = 13f; setTextColor(RabiMobileUi.muted); gravity = Gravity.CENTER; setLineSpacing(0f, 1.15f) })
            addView(primary(actionText, action), LinearLayout.LayoutParams(-1, dp(52)).apply { setMargins(0, dp(18), 0, 0) })
        }

    private fun sendComposer() {
        val text = composer?.text?.toString()?.trim().orEmpty()
        if (text.isBlank() || activeRouteId.isBlank()) return
        if (!confirmChatDestination(activeRouteId)) return
        try { RabiConversationService.sendText(this, text, activeRouteId) }
        catch (error: Exception) { toast("消息未能入队，草稿已保留"); return }
        followNextMessage = true
        RabiChatStore(this).saveDraft(activeRouteId, "")
        composer?.text?.clear()
    }

    private fun confirmChatDestination(routeId: String): Boolean {
        val route = availableRoutes.firstOrNull { it.id == routeId }
        if (route == null || route.rawJson.optString("ownerWorkerId").isBlank()) {
            toast("暂时无法确认会话所属电脑，请刷新后重试")
            return false
        }
        if (!isRouteChatCapable(route)) {
            toast("请在会话所属电脑上启用 RabiLink 消息端")
            return false
        }
        return true
    }

    private fun renderChat() {
        val host = chatMessages ?: return
        val store = RabiChatStore(this)
        val messages = store.listForConversation(activeRouteId)
        val signature = messages.joinToString("|") { "${it.id}:${it.deliveryState}:${it.failure}:${it.playbackState}:${it.playbackFailure}:${it.text.hashCode()}:${it.localPath}" }
        if(signature == chatSignature && !followNextMessage) return
        val oldScrollY = chatScroll?.scrollY ?: 0
        val following = followNextMessage || isChatAtBottom()
        val newLastMessageId = messages.lastOrNull()?.id.orEmpty()
        val hasNewMessage = renderedLastMessageId.isNotBlank() && renderedLastMessageId != newLastMessageId
        renderedLastMessageId = newLastMessageId
        followNextMessage = false
        chatSignature = signature
        restoringChatViewport = true
        val renderGeneration = ++chatRenderGeneration
        host.removeAllViews()
        outgoingAvatars.clear()
        incomingAvatars.clear()
        if (messages.isEmpty()) host.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setPadding(dp(24), dp(64), dp(24), dp(24))
            addView(TextView(this@MainActivity).apply { text = "暂无消息"; textSize = 14f; setTextColor(RabiMobileUi.muted); gravity = Gravity.CENTER })
        })
        var previousDay = ""
        var previousRole = ""
        var previousTime = 0L
        val avatarUi = RabiConversationListUi(this)
        messages.forEach { message ->
            val mine = message.role == "user"
            val day = formatMessageDay(message.createdAt)
            val newDay = day != previousDay
            val newPeriod = newDay || message.createdAt - previousTime >= 5 * 60_000L
            val startsGroup = newPeriod || message.role != previousRole
            if (day.isNotBlank() && newPeriod) {
                val stamp = if (newDay) "$day ${formatMessageTime(message.createdAt)}" else formatMessageTime(message.createdAt)
                host.addView(TextView(this).apply {
                    text = stamp; textSize = 11f; setTextColor(RabiMobileUi.muted)
                    gravity = Gravity.CENTER; setPadding(0, dp(14), 0, dp(10))
                }, LinearLayout.LayoutParams(-1, -2))
            }
            previousDay = day
            previousTime = message.createdAt
            previousRole = message.role
            val group = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = if (mine) Gravity.END else Gravity.START }
            val bubble = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; setPadding(dp(14), dp(10), dp(14), dp(10))
                val color = if (mine) RabiMobileUi.secondary else RabiMobileUi.surface
                background = panel(color, if (mine) color else RabiMobileUi.border, 17)
            }
            val kindLabel = messageKindLabel(message.kind)
            if (kindLabel.isNotBlank()) bubble.addView(TextView(this).apply {
                text = kindLabel; textSize = 11f; typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) RabiMobileUi.onAccent else RabiMobileUi.secondary)
                setPadding(0, 0, 0, if (message.text.isBlank()) 0 else dp(5))
            })
            if (message.text.isNotBlank()) bubble.addView(TextView(this).apply {
                text = message.text; textSize = 15f; setTextColor(if (mine) RabiMobileUi.onAccent else RabiMobileUi.text); setLineSpacing(0f, 1.08f)
                setTextIsSelectable(true)
                android.text.util.Linkify.addLinks(this, android.text.util.Linkify.WEB_URLS)
                setLinkTextColor(if(mine) RabiMobileUi.onAccent else RabiMobileUi.secondary)
            })
            bubble.setOnLongClickListener {
                val copyText = message.text.ifBlank { message.fileName }
                (getSystemService(CLIPBOARD_SERVICE) as android.content.ClipboardManager)
                    .setPrimaryClip(android.content.ClipData.newPlainText("消息",copyText))
                toast("已复制消息"); true
            }
            if (message.fileName.isNotBlank()) bubble.addView(TextView(this).apply {
                text = message.fileName; textSize = 13f; typeface = Typeface.DEFAULT_BOLD
                setTextColor(if (mine) RabiMobileUi.onAccent else RabiMobileUi.primary); setPadding(0, if (message.text.isBlank()) dp(2) else dp(8), 0, 0)
            })
            if (message.kind == "tts" && message.localPath.isNotBlank()) {
                bubble.addView(TextView(this).apply {
                    text = ttsPlaybackLabel(message); textSize = 12f
                    setTextColor(if (mine) RabiMobileUi.onAccent else RabiMobileUi.secondary)
                    setPadding(0, dp(7), 0, 0)
                })
                bubble.isClickable = true; bubble.contentDescription = "重播语音"
                bubble.setOnClickListener { RabiConversationService.replayTts(this, message.id, message.localPath) }
            } else if (message.localPath.isNotBlank()) {
                bubble.isClickable = true; bubble.contentDescription = "打开附件 ${message.fileName}"
                bubble.setOnClickListener { openAttachment(message) }
            }
            group.addView(bubble, LinearLayout.LayoutParams(-2, -2))
            if (mine && message.deliveryState.isNotBlank()) group.addView(TextView(this).apply {
                text = deliveryLabel(message); textSize = 11f
                setTextColor(if (message.deliveryState == "failed") RabiMobileUi.error else RabiMobileUi.muted)
                gravity = Gravity.END; setPadding(dp(4), dp(3), dp(4), 0)
            })
            if(mine && message.deliveryState == "failed") group.addView(row().apply {
                addView(RabiMobileUi.compactAction(this@MainActivity,"重试") {
                    runCatching { RabiConversationService.retryMessage(this@MainActivity,message.clientMessageId,message.routeProfileId) }
                        .onSuccess { toast("正在重试这条消息") }.onFailure { toast("重试未启动，请稍后再试") }
                })
                addView(RabiMobileUi.compactAction(this@MainActivity,"查看原因") {
                    android.app.AlertDialog.Builder(this@MainActivity).setTitle("消息未能发送")
                        .setMessage(message.failure.ifBlank { "请检查手机网络、电脑连接和该会话是否可用。" })
                        .setPositiveButton("连接设置") { _, _ -> showSettings() }.setNegativeButton("关闭",null).show()
                })
            })
            val avatar = if (startsGroup) avatarUi.avatar(if (mine) "我" else routeTitle(activeRouteId), 34).also {
                if (mine) {
                    outgoingAvatars.add(it)
                    bindOwnAvatar(it)
                } else {
                    incomingAvatars.add(it)
                    bindIncomingAvatar(it)
                }
            } else View(this).apply { importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
            host.addView(row().apply {
                gravity = Gravity.TOP
                val avatarSpace = LinearLayout.LayoutParams(dp(34), dp(34)).apply {
                    if (mine) marginStart = dp(8) else marginEnd = dp(8)
                }
                if (!mine) addView(avatar, avatarSpace)
                addView(group, LinearLayout.LayoutParams(0, -2, 1f))
                if (mine) addView(avatar, avatarSpace)
            }, LinearLayout.LayoutParams(-1, -2).apply {
                setMargins(if (mine) dp(26) else 0, if (startsGroup) dp(7) else dp(3), if (mine) 0 else dp(26), 0)
            })
        }
        if(following) { newMessagesAction?.visibility = View.GONE; markConversationRead() }
        else if(hasNewMessage) newMessagesAction?.visibility = View.VISIBLE
        val scroll = chatScroll
        scroll?.post {
            if(chatMessages !== host || chatScroll !== scroll || chatRenderGeneration != renderGeneration) return@post
            if(following) scroll.fullScroll(View.FOCUS_DOWN) else scroll.scrollTo(0,oldScrollY)
            restoringChatViewport = false
        }
    }

    private fun isChatAtBottom(): Boolean {
        val scroll = chatScroll ?: return true
        val content = chatMessages ?: return true
        return content.height-scroll.height-scroll.scrollY <= dp(48)
    }

    private fun markConversationRead() {
        if(activeRouteId.isBlank() || lastReadChatSignature == chatSignature) return
        RabiChatStore(this).markRead(activeRouteId)
        RabiConversationService.clearConversationNotification(this,activeRouteId)
        lastReadChatSignature = chatSignature
    }

    private fun currentComputerLabel(): String = RabiLinkRelaySettings.computers(this)
        .firstOrNull { RabiLinkRelaySettings.isActive(this,it) }?.let { "电脑 · ${it.name}" } ?: "选择连接的电脑"

    private fun chooseComputer() {
        if(!RabiLinkRelaySettings.load(this).configured) { showSettings(); return }
        RabiComputerPicker.show(this) {
            availableRoutes = RabiRouteMetadataCache.load(this,RabiLinkRelaySettings.load(this))
            routesLoaded = false
            if(screen == Screen.SETTINGS) showSettings() else showConversationList()
        }
    }

    private fun personaTitle(route: RabiRouteInfo): String =
        RabiConversationRules.personaDisplayName(route.personaDisplayName, route.agentRoleId, route.name, route.configName, route.id)

    private fun personaAvatarVersion(route: RabiRouteInfo): String =
        getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE).getString("version:${route.agentRoleId}", "").orEmpty()
            .ifBlank { route.avatarVersion }

    private fun readPersonaAvatar(relay: RabiLinkRelayConfig, workerId: String, role: String, version: String): ByteArray {
        val worker = synchronized(avatarDirectoryLock) {
            val now = android.os.SystemClock.elapsedRealtime()
            val current = avatarDirectory?.takeIf { it.relay == relay && now - it.loadedAt < 30_000L }
                ?: AvatarDirectory(relay, now, sdk.getMobileState(relay.baseUrl, relay.token).workers).also { avatarDirectory = it }
            current.workers.firstOrNull { it.id == workerId || it.guid == workerId }
                ?: error("Avatar PC is not in the authenticated connection directory")
        }
        val path = "/api/roles/${android.net.Uri.encode(role)}/avatar?v=${android.net.Uri.encode(version)}"
        val reply = managerTransport.value.request(relay.baseUrl, relay.token, worker, "GET", path,
            mapOf("accept" to "image/*"), ByteArray(0))
        check(reply.statusCode in 200..299) { "Persona avatar HTTP ${reply.statusCode}" }
        return reply.body
    }

    private fun bindPersonaAvatar(route: RabiRouteInfo, image: ImageView, avatarStatus: TextView?, register: Boolean = true) {
        val role = route.agentRoleId.trim()
        val title = personaTitle(route)
        val avatarPreferences = getSharedPreferences("rabi_persona_avatars", MODE_PRIVATE)
        val configured = route.avatarConfigured || avatarPreferences.getBoolean("configured:$role", false)
        if (register && role.isNotBlank()) {
            avatarTargets.getOrPut(role) { mutableListOf() }
                .add(AvatarTarget(route.id, image, avatarStatus))
        }
        val version = personaAvatarVersion(route)
        val relay = RabiLinkRelaySettings.load(this)
        val workerId = route.rawJson.optString("personaSourceWorkerId").ifBlank {
            route.rawJson.optString("ownerWorkerId")
        }.ifBlank { com.rabi.link.recording.TargetWorkerIdentity.load(this, relay.baseUrl, relay.token) }
        if (!configured || role.isBlank() || version.isBlank() || !relay.configured || workerId.isBlank()) {
            image.tag = "unavailable\u0000$role\u0000$version"
            image.setImageResource(R.drawable.ic_persona_avatar_placeholder)
            image.contentDescription = RabiAvatarLoadRules.placeholderContentDescription(title, configured)
            avatarStatus?.text = RabiAvatarLoadRules.unavailableLabel(configured)
            if (image === chatHeaderAvatar) incomingAvatars.forEach(::bindIncomingAvatar)
            return
        }
        val source = "${relay.baseUrl}\u0000${relay.token}\u0000$workerId"
        RabiPersonaAvatarCache.load(this, image, source, role, version, {
            readPersonaAvatar(relay, workerId, role, version)
        }) { state ->
            image.contentDescription = when (state) {
                RabiAvatarLoadRules.State.READY, RabiAvatarLoadRules.State.VALIDATING -> "$title 头像"
                RabiAvatarLoadRules.State.STALE -> "$title 头像（旧缓存）"
                RabiAvatarLoadRules.State.LOADING -> "$title 头像加载中"
                RabiAvatarLoadRules.State.UNAVAILABLE -> RabiAvatarLoadRules.placeholderContentDescription(title, configured = true)
            }
            if (image === chatHeaderAvatar) incomingAvatars.forEach(::bindIncomingAvatar)
            avatarStatus?.text = when (state) {
                RabiAvatarLoadRules.State.LOADING -> "头像加载中"
                RabiAvatarLoadRules.State.VALIDATING -> "头像校验中"
                RabiAvatarLoadRules.State.READY -> ""
                RabiAvatarLoadRules.State.STALE -> "头像暂为旧缓存"
                RabiAvatarLoadRules.State.UNAVAILABLE -> RabiAvatarLoadRules.unavailableLabel(configured = true)
            }
        }
    }

    private fun bindIncomingAvatar(image: ImageView) {
        val source = chatHeaderAvatar
        val drawable = source?.drawable?.constantState?.newDrawable(resources)
        if (drawable != null) image.setImageDrawable(drawable)
        else image.setImageResource(R.drawable.ic_persona_avatar_placeholder)
        image.contentDescription = source?.contentDescription ?: "${routeTitle(activeRouteId)} 的头像"
    }

    private fun refreshPersonaAvatar(changedRoleId: String) {
        val targets = avatarTargets.entries
            .filter { RabiConversationRules.shouldRefreshAvatar(changedRoleId, it.key) }
            .flatMap { it.value.toList() }
        targets.forEach { target ->
            val route = availableRoutes.firstOrNull { it.id == target.routeId } ?: return@forEach
            bindPersonaAvatar(route, target.image, target.status, register = false)
        }
    }

    private fun syncAiuiChatHistory() {
        val connection = RabiLinkRelaySettings.load(this)
        if (!connection.configured) return
        val client = AiuiGlassesClient(this, connection)
        val routeIds = availableRoutes.groupBy {
            it.rawJson.optString("personaSourceWorkerId").ifBlank { it.rawJson.optString("ownerWorkerId") } to it.agentRoleId
        }.mapNotNull { (source, routes) -> routes.singleOrNull()?.let { source to it.id } }.toMap()
        runAsync({ client.use { it.history(routeIds) } }, { messages ->
            val current = RabiLinkRelaySettings.load(this)
            if(current.baseUrl != connection.baseUrl || current.token != connection.token) return@runAsync
            val store = RabiChatStore(this)
            val titles = getSharedPreferences("aiui_history_titles:" + client.scope, MODE_PRIVATE).edit()
            for(message in messages) {
                val timestamp = runCatching { java.time.Instant.parse(message.receivedAt).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
                store.appendRecorded(message.id,message.role,"aiui",message.text,"","text/plain",message.conversationId,"",message.id,"recorded","",timestamp)
                titles.putString(message.conversationId,message.name)
            }
            check(titles.commit())
        }, error = { if(screen == Screen.CHAT) Toast.makeText(this,"眼镜聊天记录暂未同步，已保留本机记录",Toast.LENGTH_SHORT).show() })
    }

    private fun routeTitle(routeId: String): String = availableRoutes.firstOrNull { it.id == routeId }?.let(::personaTitle)
        ?: getSharedPreferences("aiui_history_titles:"+AiuiGlassesClient.accountScope(RabiLinkRelaySettings.load(this)), MODE_PRIVATE).getString(routeId,null)
        ?: if (routeId == RabiConversationRules.LEGACY_CONVERSATION_ID) "Rabi（旧会话）" else "Rabi"

    private fun routeStatus(route: RabiRouteInfo?): String = when {
        route == null && !routesLoaded -> "正在确认聊天状态…"
        route == null -> "历史会话 · 只读"
        else -> {
            val current = RabiConversationRules.routeStatus(
                isRouteChatCapable(route),
                route.running,
                routeAdapterStates(route),
            )
            when {
                routeLoadFailed -> "上次状态 · 暂未刷新 · $current"
                !routesLoaded -> "上次状态 · 正在刷新 · $current"
                else -> current
            }
        }
    }

    private fun isRouteChatCapable(route: RabiRouteInfo): Boolean {
        val advertised = route.rawJson.takeIf { it.has("chatAvailable") }?.optBoolean("chatAvailable")
        return RabiConversationRules.isChatCapable(
            route.enabled,
            route.messageAdapters,
            jsonStringList(route.rawJson.optJSONArray("messageAdaptersDisabled")),
            advertised,
        )
    }

    private fun routeAdapterStates(route: RabiRouteInfo): List<RabiAdapterPresentation> {
        val values = route.rawJson.optJSONArray("adapterStates") ?: return emptyList()
        return (0 until values.length()).mapNotNull { index ->
            values.optJSONObject(index)?.let { item ->
                val type = item.optString("type").trim()
                val label = item.optString("label").trim()
                val state = item.optString("state").trim()
                val summary = item.optString("summary").trim()
                if (type.isBlank() || summary.isBlank()) null
                else RabiAdapterPresentation(type, label, state, summary)
            }
        }
    }

    private fun jsonStringList(values: org.json.JSONArray?): List<String> =
        (0 until (values?.length() ?: 0)).mapNotNull { index ->
            values?.optString(index)?.trim()?.takeIf(String::isNotBlank)
        }

    private fun preview(message: RabiChatStore.Message?): String = when {
        message == null -> "还没有消息"
        message.text.isNotBlank() -> message.text.replace('\n', ' ')
        message.fileName.isNotBlank() -> "${messageKindLabel(message.kind).ifBlank { "附件" }} · ${message.fileName}"
        else -> messageKindLabel(message.kind).ifBlank { "新消息" }
    }

    private fun deliveryLabel(message: RabiChatStore.Message): String = when (message.deliveryState) {
        "queued" -> "等待发送"
        "sending" -> "正在发送"
        "sent" -> "已交给 Rabi PC"
        "failed" -> "发送失败${message.failure.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""}"
        else -> ""
    }

    private fun formatMessageDay(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("yyyy-MM-dd", Locale.getDefault()).format(Date(createdAt))
    private fun formatMessageTime(createdAt: Long): String = if (createdAt <= 0) "" else SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(createdAt))
    private fun formatListTime(createdAt: Long): String {
        if (createdAt <= 0) return ""
        if (android.text.format.DateUtils.isToday(createdAt)) return formatMessageTime(createdAt)
        val yesterday = java.util.Calendar.getInstance().apply { add(java.util.Calendar.DAY_OF_YEAR, -1) }
        if (formatMessageDay(createdAt) == formatMessageDay(yesterday.timeInMillis)) return "昨天"
        return SimpleDateFormat("MM-dd", Locale.getDefault()).format(Date(createdAt))
    }
    private fun messageKindLabel(kind: String): String = when (kind) {
        "aiui" -> "眼镜 AIUI"; "voice" -> "语音转写"; "tts" -> "语音回复"; "image" -> "图片"; "video" -> "视频"
        "audio-file" -> "音频文件"; "file" -> "文件"; "configuration" -> "配置请求"; else -> ""
    }

    private fun ttsPlaybackLabel(message: RabiChatStore.Message): String = when (message.playbackState) {
        "queued" -> "等待播放…"
        "playing" -> "正在播放…"
        "played" -> "已播放 · 点按重播"
        "failed" -> "播放失败${message.playbackFailure.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""} · 点按重试"
        else -> "点按播放"
    }

    private fun openAttachment(message: RabiChatStore.Message) {
        try {
            val uri = if (message.localPath.startsWith("content://")) android.net.Uri.parse(message.localPath)
                else FileProvider.getUriForFile(this, "$packageName.files", File(message.localPath))
            startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, message.contentType.ifBlank { "application/octet-stream" })
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
        } catch (error: Throwable) { toast("没有可打开该文件的应用：${error.message ?: "未知错误"}") }
    }

    private fun buildUi(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(28))
            setBackgroundColor(RabiMobileUi.background)
        }
        status = TextView(this).apply {
            textSize = 13f; setTextColor(RabiMobileUi.muted)
            setLineSpacing(dp(3).toFloat(), 1f)
        }
        val connection = row().apply {
            minimumHeight = dp(80); setPadding(dp(18), dp(16), dp(18), dp(16))
            background = panel(RabiMobileUi.surface, android.graphics.Color.TRANSPARENT, 20)
            statusIcon = RabiMobileUi.icon(this@MainActivity, R.drawable.ic_ui_connection, RabiMobileUi.secondary)
            addView(statusIcon, LinearLayout.LayoutParams(dp(28), dp(28)).apply { marginEnd = dp(14) })
            addView(status, LinearLayout.LayoutParams(0, -2, 1f))
        }
        content.addView(connection, full(0, 0, 0, 20))
        showGuidance(RabiSetupGuidance("正在检查连接…", "", ""))
        val entries = listOf(
            RabiMobileUi.actionRow(this, R.drawable.ic_ui_palette, "皮肤与外观", grouped = true) { RabiAppearanceActivity.open(this) },
            RabiMobileUi.actionRow(this, R.drawable.ic_ui_devices, "记录与设备", grouped = true) { openAllDayRecording() },
            RabiMobileUi.actionRow(this, R.drawable.ic_ui_devices, "位置记录", grouped = true) { startActivity(Intent(this, com.rabi.link.location.LocationSettingsActivity::class.java)) },
            RabiMobileUi.settingsGroup(this, R.drawable.ic_ui_account, "连接与电脑", serverCard(), grouped = true),
            RabiMobileUi.actionRow(this, R.drawable.ic_ui_devices, "文件操作", grouped = true) { showPhoneFileSettings() },
            RabiMobileUi.settingsGroup(this, R.drawable.ic_ui_volume, "语音与消息", conversationCard(), grouped = true),
            RabiMobileUi.settingsGroup(this, R.drawable.ic_ui_tune, "连接诊断", conversationRuntimeCard(), grouped = true),
            RabiMobileUi.settingsGroup(this, R.drawable.ic_ui_tools, "高级工具", toolsCard(), grouped = true),
        )
        content.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = panel(RabiMobileUi.surface, android.graphics.Color.TRANSPARENT, 20)
            clipToOutline = true
            entries.forEachIndexed { index, entry ->
                if (index > 0) addView(RabiMobileUi.insetDivider(this@MainActivity, 56), LinearLayout.LayoutParams(-1, 1))
                addView(entry)
            }
        })
        return ScrollView(this).apply { addView(content) }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        if (isFinishing) return
        if (screen == Screen.LOGIN) {
            if (RabiLinkRelaySettings.accountId(this).isNotBlank()) openAuthenticatedEntry()
            return
        }
        registerRuntime()
        if (screen == Screen.CONVERSATIONS) loadRouteTargets()
    }

    private fun registerRuntime() {
        com.rabi.link.recording.CaptureOwnership.listen(captureListener)
        refreshCaptureBar()
        if (!runtimeReceiverRegistered) {
            ContextCompat.registerReceiver(
                this,
                runtimeReceiver,
                IntentFilter().apply {
                    addAction("com.rabi.link.conversation.RUNTIME_UPDATED")
                    addAction(RabiPersonaAvatarEvents.ACTION_CHANGED)
                    addAction(RabiChatStore.ACTION_CHANGED)
                    addAction(RabiConversationService.ACTION_ACCOUNT_PROFILE_CHANGED)
                    addAction(RabiConversationService.ACTION_COMPUTER_DIRECTORY_CHANGED)
                },
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            runtimeReceiverRegistered = true
        }
        refreshConversationRuntime()
        if (screen == Screen.CONVERSATIONS || screen == Screen.CHAT) refreshAccountProfile()
        if (screen == Screen.CHAT) renderChat()
        if (screen == Screen.CONVERSATIONS) renderConversationList()
        if (screen == Screen.CHAT) {
            availableRoutes.firstOrNull { it.id == activeRouteId }?.agentRoleId?.let(::refreshPersonaAvatar)
        }
    }
    override fun onPause() {
        resumed = false
        unregisterRuntime()
        super.onPause()
    }

    private fun unregisterRuntime() {
        runtimeHandler.removeCallbacks(refreshFromChatStore)
        runtimeHandler.removeCallbacks(refreshComputerCatalog)
        com.rabi.link.recording.CaptureOwnership.unlisten(captureListener)
        if (runtimeReceiverRegistered) {
            unregisterReceiver(runtimeReceiver)
            runtimeReceiverRegistered = false
        }
    }

    private fun conversationRuntimeCard(): View = card().apply {
        addView(title("消息连接与诊断"))
        runtimeStatus = note("尚未启动")
        runtimeMode = runtimeLine("模式：尚未启动")
        runtimeConnection = runtimeLine("连接：尚未启动")
        runtimeRoute = runtimeLine("Route / 角色：尚未选择")
        runtimeGlasses = runtimeLine("眼镜：未使用")
        runtimeQueue = runtimeLine("可靠队列：正在读取")
        runtimeError = runtimeLine("最近错误：无")
        runtimeTranscript = runtimeLine("你：等待语音")
        runtimeReply = runtimeLine("Rabi：等待回复")
        runtimeCaptureHealth = runtimeLine("采集：尚无长时运行记录")
        addView(runtimeStatus)
        addView(runtimeMode, full(0, 2, 0, 2))
        addView(runtimeConnection, full(0, 2, 0, 2))
        addView(runtimeRoute, full(0, 2, 0, 2))
        addView(runtimeGlasses, full(0, 2, 0, 2))
        addView(runtimeQueue, full(0, 2, 0, 2))
        addView(runtimeError, full(0, 2, 0, 6))
        addView(runtimeTranscript, full(0, 2, 0, 2))
        addView(runtimeReply, full(0, 2, 0, 8))
        addView(runtimeCaptureHealth, full(0, 2, 0, 8))
        addView(primary("打开全天记录") { openAllDayRecording() }, full(0, 8, 0, 0))
        addView(secondary("恢复消息连接（不开启采集）") { RabiConversationService.start(this@MainActivity) }, full(0, 8, 0, 0))
    }

    private fun refreshConversationRuntime() {
        if (!::runtimeStatus.isInitialized) return
        val values = getSharedPreferences("rabi_conversation_runtime", MODE_PRIVATE)
        val settings = RabiConversationSettings.load(this)
        val allDay = com.rabi.link.recording.AllDayRecordingSettings.load(this)
        runtimeStatus.text = values.getString("status", "尚未启动")
        runtimeMode.text = "全天记录：${if (allDay.running) values.getString("allDayStatus", "等待运行状态") else "已暂停"}"
        runtimeConnection.text = "连接：${values.getString("connection", "等待服务事件")}"
        val routeId = allDay.routeProfileId
        runtimeRoute.text = "固定记录目标：${if (routeId.isBlank()) "尚未选择" else routeTitle(routeId)} · 主动性 ${proactivityLabel(settings.proactivityPreference)}"
        runtimeGlasses.text = "眼镜：${values.getString("glasses", "尚无连接证据")}"
        runtimeQueue.text = "可靠队列：${values.getString("queue", "等待服务读取")}"
        runtimeError.text = "最近错误：${values.getString("error", "").orEmpty().ifBlank { "无" }}"
        runtimeTranscript.text = "你：${values.getString("transcript", "等待语音")}"
        runtimeReply.text = "Rabi：${values.getString("reply", "等待回复")}"
        runtimeCaptureHealth.text = RabiPhoneAudioCapture.runtimeSummary(this)
    }

    private fun serverCard(): View = card().apply {
        addView(secondary(currentComputerLabel()) { chooseComputer() },full(0,0,0,8))
        relayUrl = input("例如：http://192.168.1.10:8794/rabilink")
        relayToken = input("从 Rabi PC 复制的移动端登录码").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        relayUrlHelp = RabiMobileUi.fieldHelp(this@MainActivity, "这里填手机能访问的 RabiLink 地址。通常不用手填，App 找到电脑后会自动写入。")
        relayTokenHelp = RabiMobileUi.fieldHelp(this@MainActivity, "这里粘贴 Rabi PC“RabiLink / 移动端”页面显示的登录码；它是安全凭证，所以不能静默读取。")
        addView(label("RabiLink 服务器地址")); addView(relayUrl); addView(relayUrlHelp)
        addView(label("移动端登录码")); addView(relayToken); addView(relayTokenHelp)
        discoveredPcAction = secondary("打开 Rabi PC 获取登录码") { openDiscoveredManager() }.apply { visibility = View.GONE }
        addView(discoveredPcAction, full(0, 0, 0, 8))
        connectButton = primary("连接 Rabi") { connectRelay() }
        addView(connectButton, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("自动检测") { scanLocalRabi() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        addView(secondary("打开消息") { showConversationList() },full(0,8,0,0))
    }

    private fun toolsCard(): View = card().apply {
        addView(note("电脑与 Agent 设置：先登录 Relay 管理，再选择目标电脑，进入其 WebGUI 配置 Agent 模型、会话等。此入口不会直接打开当前电脑。Skill / MCP 需实际 Agent 宿主支持并确认加载；手机当前不提供直接管理。不了解字段时可使用下方配置助手。"))
        val row = row()
        row.addView(secondary("电脑与 Agent 设置") { openRemoteConfig() }, LinearLayout.LayoutParams(0, -2, 1f)); row.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        row.addView(secondary("接口测试中心") { startActivity(Intent(this@MainActivity, TestCenterActivity::class.java)) }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(row)
        addView(secondary("不知道填什么？打开配置助手") { showConfigurationAssistant() }, full(0, 8, 0, 0))
    }

    private fun conversationCard(): View = card().apply {
        addView(title("语音与消息"))
        proactivityPreference = RabiMobileUi.spinner(this@MainActivity, Spinner(this@MainActivity).apply {
            adapter = ArrayAdapter(
                this@MainActivity,
                android.R.layout.simple_spinner_item,
                listOf("由角色决定", "偏安静", "均衡", "偏主动"),
            ).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
        })
        autoPlayAgentVoice = RabiMobileUi.styleSwitch(this@MainActivity, Switch(this@MainActivity).apply { text = "自动播放语音回复" })
        addView(label("主动联系偏好")); addView(proactivityPreference, full(0, 0, 0, 6))
        addView(note("角色会结合当前情景决定何时联系你。"))
        addView(autoPlayAgentVoice)
        ttsModel = input("local-tts/gpt-sovits")
        ttsVoice = input("Rabi")
        audioRetentionHours = input("6").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        audioReserveFreeMb = input("1024").apply { inputType = InputType.TYPE_CLASS_NUMBER }
        addView(RabiMobileUi.settingsGroup(this@MainActivity,R.drawable.ic_ui_tune,"声音与存储高级设置",card().apply {
            addView(note("使用电脑上已配置的模型与声线标识。"))
            addView(label("语音模型")); addView(ttsModel,full(0,0,0,6))
            addView(label("声线")); addView(ttsVoice,full(0,0,0,6))
            addView(label("已确认录音保留（小时，0–168）")); addView(audioRetentionHours,full(0,0,0,6))
            addView(label("设备剩余空间水位（MiB，至少 256）")); addView(audioReserveFreeMb,full(0,0,0,6))
            addView(note("电脑归档并核验可回放后，才允许清理手机原件。手机空间不足时暂停采集，已有记录保留。"))
        }))
        addView(primary("保存设置") { saveConversationSettings() }, full(0, 0, 0, 8))
        val actions = row()
        actions.addView(secondary("请角色查看近况") { RabiConversationService.requestReview(this@MainActivity) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(space(), LinearLayout.LayoutParams(dp(8), 1))
        actions.addView(secondary("全天记录设置") { openAllDayRecording() }, LinearLayout.LayoutParams(0, -2, 1f))
        addView(actions)
        addView(secondary("重试全部失败消息与语音") { RabiConversationService.retryFailed(this@MainActivity) }, full(0, 8, 0, 0))
        addView(secondary("检查系统后台保活设置") { openBatteryOptimizationSettings() }, full(0, 8, 0, 0))
    }

    private fun loadConversationSettings() {
        val value = RabiConversationSettings.load(this)

        proactivityPreference.setSelection(when (value.proactivityPreference) {
            RabiConversationSettings.ProactivityPreference.AGENT_DECIDES -> 0
            RabiConversationSettings.ProactivityPreference.QUIET -> 1
            RabiConversationSettings.ProactivityPreference.BALANCED -> 2
            RabiConversationSettings.ProactivityPreference.PROACTIVE -> 3
            else -> 0
        })
        autoPlayAgentVoice.isChecked = value.autoPlayAgentVoice
        ttsModel.setText(value.ttsModel)
        ttsVoice.setText(value.ttsVoice)
        audioRetentionHours.setText(value.audioRetentionHours.toString())
        audioReserveFreeMb.setText(value.audioReserveFreeMb.toString())
    }

    private fun saveConversationSettings() {
        val previous = RabiConversationSettings.load(this)
        val next = RabiConversationSettings(
            RabiConversationSettings.InputMode.PAUSED,
            when (proactivityPreference.selectedItemPosition) {
                1 -> RabiConversationSettings.ProactivityPreference.QUIET
                2 -> RabiConversationSettings.ProactivityPreference.BALANCED
                3 -> RabiConversationSettings.ProactivityPreference.PROACTIVE
                else -> RabiConversationSettings.ProactivityPreference.AGENT_DECIDES
            },
            false, // Retired auto-start preference never grants microphone consent.
            autoPlayAgentVoice.isChecked,
            ttsModel.text.toString(),
            ttsVoice.text.toString(),
            audioRetentionHours.text.toString().toIntOrNull() ?: 6,
            audioReserveFreeMb.text.toString().toIntOrNull() ?: 1024
        )
        next.save(this)
        RabiConversationSettings.setDirectVideoEnabled(this, false)
        if (previous.proactivityPreference != next.proactivityPreference) {
            RabiConversationService.updateProactivityPreference(this, next.proactivityPreference.wireValue)
        }
        toast("语音服务设置已保存")
    }

    private fun openAllDayRecording() {
        startActivity(Intent(this, com.rabi.link.recording.RabiRecordingHubActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }

    private fun proactivityLabel(value: RabiConversationSettings.ProactivityPreference): String = when (value) {
        RabiConversationSettings.ProactivityPreference.AGENT_DECIDES -> "由 Agent 决定"
        RabiConversationSettings.ProactivityPreference.QUIET -> "偏安静"
        RabiConversationSettings.ProactivityPreference.BALANCED -> "均衡"
        RabiConversationSettings.ProactivityPreference.PROACTIVE -> "偏主动"
    }

    private fun openBatteryOptimizationSettings() {
        val manager = getSystemService(PowerManager::class.java)
        if (manager?.isIgnoringBatteryOptimizations(packageName) == true) {
            toast("Rabi 移动端已不受系统电池优化限制")
        }
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (_: Throwable) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = android.net.Uri.parse("package:$packageName")
            })
        }
    }


    private fun showPhoneFileSettings() {
        val relay = RabiLinkRelaySettings.load(this)
        if (!relay.configured) return toast("请先连接 RabiLink")
        val enabled = RabiPhoneFiles.enabled(this, relay.baseUrl, relay.token)
        val granted = android.os.Environment.isExternalStorageManager()
        android.app.AlertDialog.Builder(this)
            .setTitle("文件操作")
            .setView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(24), dp(12), dp(24), dp(8))
                addView(note("开启后，同一 RabiLink 连接的授权设备可在「设备控制」的手机行读取和修改手机内部共享存储。"))
                addView(note(if (granted) "Android 已授予所有文件访问权限。" else "请在 Android 系统设置中允许访问所有文件。"))
                addView(Switch(this@MainActivity).apply {
                    text = "启用文件操作"
                    isChecked = enabled
                    minHeight = dp(48)
                    setOnClickListener {
                        val saved = runCatching {
                            check(RabiLinkRelaySettings.load(this@MainActivity) == relay)
                            RabiPhoneFiles.setEnabled(this@MainActivity, relay, isChecked)
                        }
                        if (saved.isFailure) {
                            isChecked = !isChecked
                            toast("文件操作设置保存失败，请重试")
                        }
                    }
                })
            })
            .setNegativeButton("关闭", null)
            .apply {
                if (!granted) setPositiveButton("打开系统授权") { _, _ ->
                    val packageUri = android.net.Uri.parse("package:$packageName")
                    try {
                        startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, packageUri))
                    } catch (_: android.content.ActivityNotFoundException) {
                        runCatching { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
                            .onFailure { toast("请在 Android 系统设置中打开所有文件访问权限") }
                    }
                }
            }.show()
    }

    private fun pickPhoneMedia(mimeType: String) {
        if (!confirmChatDestination(activeRouteId)) return
        mediaTargetRouteId = activeRouteId
        startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = mimeType
        }, requestPhoneMedia)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != requestPhoneMedia || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        try { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Throwable) { }
        val routeProfileId = mediaTargetRouteId.ifBlank { activeRouteId }
        if (routeProfileId.isBlank()) return toast("请先进入一个会话，再选择要发送的文件")
        if (!confirmChatDestination(routeProfileId)) return
        RabiConversationService.enqueueMedia(this, uri, contentResolver.getType(uri) ?: "application/octet-stream", routeProfileId)
    }

    private fun autoPrepareSetup(saved: RabiLinkRelayConfig) {
        if (saved.configured) {
            showGuidance(RabiSetupGuidance(
                "已找到上次的连接",
                "App 正在自动验证登录状态和在线 Rabi PC。",
                "验证通过后，只有一个在线 PC 时会自动选择。",
            ))
            connectRelay()
        } else {
            scanLocalRabi()
        }
    }

    private fun scanLocalRabi() {
        if (busy) return
        setBusy(true)
        showGuidance(RabiSetupGuidance(
            "正在自动寻找 Rabi PC",
            "正在扫描同一 Wi-Fi；找到后会把地址直接填进第一个输入框。",
            "请稍候。",
        ))
        runAsync({ discoverySdk.scanLan(applicationContext) }, { instances ->
            discoveredManagers.clear()
            discoveredManagers.addAll(instances)
            val first = instances.firstOrNull()
            if (first == null) {
                discoveredPcAction.visibility = View.GONE
                if (relayUrl.text.toString().trim().isBlank()) {
                    setUrlHelp(
                        "没有自动找到电脑。请确认手机与 Rabi PC 在同一 Wi-Fi；也可手填 http://电脑局域网IP:8794/rabilink。",
                        RabiGuidanceTone.WARNING,
                    )
                }
                if (relayToken.text.toString().trim().isBlank()) {
                    setTokenHelp(
                        "登录码要在 Rabi PC 的“RabiLink / 移动端”页面复制；App 不会猜测或生成安全凭证。",
                        RabiGuidanceTone.WARNING,
                    )
                } else {
                    setTokenHelp("登录码已经填写，连接时会安全验证。", RabiGuidanceTone.INFO)
                }
                showGuidance(RabiSetupGuidance("还差连接信息", "请按输入框下方的提示完成标橙项目。", "" , RabiGuidanceTone.WARNING))
            } else {
                discoveredPcAction.visibility = View.VISIBLE
                val pcName = first.name.ifBlank { first.computerName.ifBlank { "Rabi PC" } }
                val inferredUrl = "http://${first.host}:8794/rabilink"
                if (relayUrl.text.toString().trim().isBlank()) {
                    relayUrl.setText(inferredUrl)
                    setUrlHelp("已从 $pcName 自动检测并填入：$inferredUrl", RabiGuidanceTone.SUCCESS)
                } else {
                    setUrlHelp("已保留你填写的地址；同时检测到 $pcName 可用地址 $inferredUrl。", RabiGuidanceTone.INFO)
                }
                if (relayToken.text.toString().trim().isBlank()) {
                    setTokenHelp(
                        "还差这一项：点下面“打开 $pcName 获取登录码”，在 RabiLink / 移动端页面复制后粘贴到这里。",
                        RabiGuidanceTone.WARNING,
                    )
                }
                discoveredPcAction.text = "打开 $pcName 获取登录码"
                showGuidance(RabiSetupGuidance(
                    "已找到 ${instances.size} 台 Rabi PC，服务器地址已填好",
                    if (relayToken.text.toString().isBlank()) "现在只需完成标橙的“移动端登录码”。" else "连接信息已经齐全。",
                    if (relayToken.text.toString().isBlank()) "按第二个输入框下方的提示获取登录码。" else "点“连接 Rabi”。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
        }, complete = { setBusy(false) }, error = { error ->
            setUrlHelp(
                "自动检测失败：${error.message ?: "Android 无法完成局域网扫描"}。可手填 http://电脑局域网IP:8794/rabilink。",
                RabiGuidanceTone.ERROR,
            )
            showGuidance(RabiSetupGuidance("自动检测没有完成", "请按服务器地址输入框下方的提示处理。", "", RabiGuidanceTone.WARNING))
        })
    }

    private fun openDiscoveredManager() {
        val instance = discoveredManagers.firstOrNull()
        if (instance == null) {
            showGuidance(RabiSetupGuidance(
                "没有可打开的 Rabi PC",
                "本轮扫描没有保留可用地址。",
                "确认手机和电脑在同一 Wi-Fi 后重新检测。",
                RabiGuidanceTone.WARNING,
            ))
            return
        }
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(instance.baseUrl)))
    }

    private fun connectRelay() {
        val accountId = RabiLinkRelaySettings.accountId(this)
        if (accountId.isBlank()) return showLogin()
        val active = RabiLinkRelaySettings.load(this)
        val url = relayBaseUrl(); val token = relayToken.text.toString().trim()
        if (url.isBlank() || token.isBlank()) {
            if (url.isBlank()) setUrlHelp(
                "这里必须填服务器地址。先点“自动检测”；仍找不到时填 http://电脑局域网IP:8794/rabilink。",
                RabiGuidanceTone.ERROR,
            )
            if (token.isBlank()) setTokenHelp(
                "这里必须粘贴移动端登录码。请在 Rabi PC 的“RabiLink / 移动端”页面复制；这是安全凭证，App 不能替你生成。",
                RabiGuidanceTone.ERROR,
            )
            showGuidance(RabiSetupGuidance("连接信息还没填完整", "请完成标红输入框；每项下面都有获取方法。", "", RabiGuidanceTone.WARNING))
            if (url.isBlank() && discoveredManagers.isEmpty()) scanLocalRabi()
            return
        }
        if (url != active.baseUrl) {
            showGuidance(RabiSetupGuidance("请使用当前登录的服务器", "更换连接时请保留当前账号的服务器地址。", "", RabiGuidanceTone.WARNING))
            return
        }
        setUrlHelp("正在验证这个服务器地址是否可由手机访问。", RabiGuidanceTone.INFO)
        setTokenHelp("正在安全验证登录码；不会把明文写入日志。", RabiGuidanceTone.INFO)
        setBusy(true)
        showGuidance(RabiSetupGuidance(
            "正在验证连接",
            "App 正在检查服务器、登录码和可用 Rabi PC。",
            "请稍候，不需要重复点击。",
        ))
        runAsync({
            val initial = sdk.getMobileState(url, token)
            check(initial.ownerAccountId == accountId) { "此应用不属于当前登录账号" }
            val requested = RabiLinkRelaySettings.computers(this).firstOrNull { it.id == intent.getStringExtra("computer_id") && it.connection.baseUrl == url && it.connection.token == token }
            if(requested != null && requested.workerId.isNotBlank()) {
                val verified = sdk.selectMobileRabiPc(url,token,requested.workerId)
                check(verified.selectedWorker?.id == requested.workerId) { "电脑选择未获服务器确认" }
                return@runAsync verified
            }
            val onlyOnlinePc = initial.workers.filter { it.online }.singleOrNull()
            if (initial.selectedWorker == null && onlyOnlinePc != null) {
                sdk.selectMobileRabiPc(url, token, onlyOnlinePc.id)
            } else initial
        }, { state ->
            com.rabi.link.recording.TargetWorkerIdentity.save(this, url, token, state.selectedWorker?.id.orEmpty())
            state.selectedWorker?.let { RabiLinkRelaySettings.rememberComputer(this,it.name,it.id,url,token) }
            RabiLinkRelaySettings.saveAuthenticated(this, url, token, accountId)
            RabiConversationService.start(this) // Message transport only.
            setUrlHelp("服务器地址验证通过，已保存到本机。", RabiGuidanceTone.SUCCESS)
            setTokenHelp("登录码验证通过，已安全保存到本机。", RabiGuidanceTone.SUCCESS)
            pcs.clear(); pcs.addAll(state.workers); selectedPc = state.selectedWorker
            if (pcs.isEmpty()) {
                showGuidance(RabiSetupGuidance(
                    "RabiLink 已登录，但没有在线 PC",
                    "服务器接受了登录码，当前却没有 Rabi PC worker 在线。",
                    "在电脑启动 RabiRoute 并启用 RabiLink Relay worker，然后点“连接 Rabi”刷新。",
                    RabiGuidanceTone.WARNING,
                ))
            } else {
                val pc = selectedPc
                showGuidance(RabiSetupGuidance(
                    "连接完成",
                    "已登录 RabiLink，${pc?.name ?: "Rabi PC"} ${if (pc?.online == true) "在线" else "当前离线"}。",
                    "点“选择电脑”切换目标，或点“打开消息”开始聊天。",
                    RabiGuidanceTone.SUCCESS,
                ))
            }
        }, complete = { setBusy(false) }, error = { error ->
            if (token == active.token && error is RabiHttpException && error.statusCode == 401) {
                RabiLinkRelaySettings.clearSignIn(this)
                showLogin(restore = false, message = "当前连接已失效，请重新登录。")
            } else showConnectionError(error)
        })
    }

    private fun openRemoteConfig() {
        val url = relayBaseUrl()
        if (url.isBlank()) return showGuidance(RabiSetupGuide.missingConnection(true, relayToken.text.toString().trim().isBlank(), discoveredManagers.size))
        startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse("$url/manage")))
    }

    private fun refreshStatus(message: String) {
        if (!::status.isInitialized || busy) return
        val saved = RabiLinkRelaySettings.load(this)
        if (saved.configured && selectedPc != null) {
            showGuidance(RabiSetupGuidance(
                "连接已就绪",
                "RabiLink 已登录，当前使用 ${selectedPc?.name}。",
                message,
                RabiGuidanceTone.SUCCESS,
            ))
        }
    }
    private fun showGuidance(value: RabiSetupGuidance) {
        if (!::status.isInitialized) return
        val pc = selectedPc
        val displayed = if (screen == Screen.SETTINGS && value.tone == RabiGuidanceTone.SUCCESS && pc != null) {
            value.copy(title = if (pc.online) "已连接" else "电脑离线", reason = "${pc.name} · ${if (pc.online) "在线" else "离线"}", action = "")
        } else value
        val text = android.text.SpannableString(displayed.displayText()).apply {
            setSpan(android.text.style.StyleSpan(Typeface.BOLD), 0, displayed.title.length, 0)
            setSpan(android.text.style.AbsoluteSizeSpan(16, true), 0, displayed.title.length, 0)
            setSpan(android.text.style.ForegroundColorSpan(RabiMobileUi.text), 0, displayed.title.length, 0)
        }
        status.text = text
        statusIcon?.apply {
            setImageResource(if (value.tone == RabiGuidanceTone.SUCCESS && pc?.online == true) R.drawable.ic_ui_check_circle else R.drawable.ic_ui_connection)
            imageTintList = android.content.res.ColorStateList.valueOf(when (value.tone) {
                RabiGuidanceTone.ERROR -> RabiMobileUi.error
                RabiGuidanceTone.WARNING -> RabiMobileUi.warning
                else -> RabiMobileUi.secondary
            })
        }
    }

    private fun setUrlHelp(message: String, tone: RabiGuidanceTone) {
        if (!::relayUrlHelp.isInitialized || !::relayUrl.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, relayUrlHelp, message, tone)
        RabiMobileUi.styleInputState(this, relayUrl, tone)
    }

    private fun setTokenHelp(message: String, tone: RabiGuidanceTone) {
        if (!::relayTokenHelp.isInitialized || !::relayToken.isInitialized) return
        RabiMobileUi.styleFieldHelp(this, relayTokenHelp, message, tone)
        RabiMobileUi.styleInputState(this, relayToken, tone)
    }

    private fun showConnectionError(error: Throwable) {
        val guidance = RabiSetupGuide.connectionError(error)
        val raw = error.message.orEmpty().lowercase()
        val fieldMessage = listOf(guidance.reason, guidance.action).filter { it.isNotBlank() }.joinToString(" ")
        when {
            "401" in raw || "403" in raw || "unauthorized" in raw || "forbidden" in raw ->
                setTokenHelp(fieldMessage, RabiGuidanceTone.ERROR)
            "unknownhost" in raw || "resolve host" in raw || "timeout" in raw || "timed out" in raw ||
                "cleartext" in raw || "refused" in raw || "failed to connect" in raw || "unreachable" in raw ->
                setUrlHelp(fieldMessage, RabiGuidanceTone.ERROR)
            else -> {
                setUrlHelp("服务器或网络没有完成验证，请核对地址后重试。", RabiGuidanceTone.WARNING)
                setTokenHelp("如果地址无误，请重新从 Rabi PC 复制移动端登录码。", RabiGuidanceTone.WARNING)
            }
        }
        showGuidance(RabiSetupGuidance(guidance.title, "请查看对应输入框下方的修复提示。", "", guidance.tone))
    }

    private fun relayBaseUrl() = relayUrl.text.toString().trim().trimEnd('/')
    private fun setBusy(value: Boolean) {
        busy = value
        if (::connectButton.isInitialized) {
            connectButton.isEnabled = !value
            connectButton.text = if (value) "正在检查…" else "连接 Rabi"
        }
    }
    private fun <T> runAsync(
        work: () -> T,
        success: (T) -> Unit,
        complete: () -> Unit = {},
        error: (Throwable) -> Unit = { toast(it.message ?: it.javaClass.simpleName) },
    ) { Thread { try { val result = work(); runOnUiThread { success(result); complete() } } catch (cause: Throwable) { runOnUiThread { error(cause); complete() } } }.start() }
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()

    private fun card() = RabiMobileUi.card(this)
    private fun title(text: String) = RabiMobileUi.title(this, text)
    private fun note(text: String) = RabiMobileUi.note(this, text)
    private fun runtimeLine(text: String) = TextView(this).apply { this.text = text; textSize = 14f; setTextColor(RabiMobileUi.text); maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END }
    private fun label(text: String) = RabiMobileUi.label(this, text)
    private fun input(hint: String) = RabiMobileUi.input(this, hint)
    private fun numberInput(hint: String) = input(hint).apply { inputType = InputType.TYPE_CLASS_NUMBER }
    private fun primary(text: String, action: () -> Unit) = RabiMobileUi.primary(this, text, action)
    private fun secondary(text: String, action: () -> Unit) = RabiMobileUi.secondary(this, text, action)
    private fun row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private fun space() = View(this)
    private fun full(l: Int, t: Int, r: Int, b: Int) = LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(l), dp(t), dp(r), dp(b)) }
    private fun panel(color: Int, stroke: Int, radius: Int) = RabiMobileUi.panel(this, color, stroke, radius)
    private fun dp(value: Int) = RabiMobileUi.dp(this, value)
    override fun onDestroy() {
        if(managerTransport.isInitialized()) managerTransport.value.close()
        super.onDestroy()
    }
}
