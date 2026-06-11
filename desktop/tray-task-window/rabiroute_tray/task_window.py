from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QPoint, Qt, QTimer, Signal
from PySide6.QtGui import QGuiApplication, QIcon, QKeyEvent, QMouseEvent
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMenu,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QStyle,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .manager_client import ManagerSnapshot
from .display_helpers import route_enabled_label, route_running_label, route_state, route_status_label, route_subtitle, route_title
from .role_context_repository import ContextEntry, RoleContextSnapshot
from .task_repository import PlanItem, PlanSnapshot


VIEW_LABELS = (
    ("chat", "聊天"),
    ("current", "当前"),
    ("plans", "计划"),
    ("recent_memory", "近期记忆"),
    ("archived", "已归档"),
    ("status", "诊断"),
)

STATUS_TONES = {
    "进行中": "running",
    "未开始": "pending",
    "已完成": "done",
    "已归档": "archived",
}

PRIMARY_VIEW_KEYS = {"chat", "current", "plans"}


class ClickableHeader(QFrame):
    clicked = Signal()

    def __init__(self, accessible_name: str) -> None:
        super().__init__()
        self._accessible_base_name = accessible_name
        self.setObjectName("cardHeader")
        self.setAccessibleName(accessible_name)
        self.setCursor(Qt.PointingHandCursor)
        self.setFocusPolicy(Qt.StrongFocus)

    def set_action_word(self, action_word: str) -> None:
        self.setAccessibleName(self._accessible_base_name.replace("展开或折叠", action_word))

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.LeftButton:
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.LeftButton and self.rect().contains(event.position().toPoint()):
            self.clicked.emit()
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() in (Qt.Key_Return, Qt.Key_Enter, Qt.Key_Space):
            self.clicked.emit()
            event.accept()
            return
        super().keyPressEvent(event)


class ExpandableCard(QFrame):
    expanded_changed = Signal(bool)

    def __init__(
        self,
        label: str,
        title: str,
        fields: list[tuple[str, str]],
        tone: str,
        keywords: list[str],
        status: str = "",
        expanded: bool = False,
    ) -> None:
        super().__init__()
        self._expanded = False
        self.setObjectName("itemCard")
        self.setProperty("tone", tone)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)

        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)

        self.header = ClickableHeader(f"{label}：{title}。点击展开或折叠详情。")
        header_layout = QVBoxLayout()
        header_layout.setContentsMargins(0, 0, 0, 0)
        header_layout.setSpacing(7)

        title_row = QHBoxLayout()
        title_row.setContentsMargins(0, 0, 0, 0)
        title_row.setSpacing(8)

        self.indicator = QLabel(">")
        self.indicator.setObjectName("cardIndicator")
        self.indicator.setFixedWidth(12)
        self.indicator.setAlignment(Qt.AlignCenter)

        badge = QLabel(label)
        badge.setObjectName("cardBadge")

        title_label = QLabel(title)
        title_label.setObjectName("cardTitle")
        title_label.setWordWrap(True)

        title_row.addWidget(self.indicator, 0, Qt.AlignTop)
        title_row.addWidget(badge, 0, Qt.AlignTop)
        title_row.addWidget(title_label, 1)
        if status:
            status_label = QLabel(f"状态：{status}")
            status_label.setObjectName("planStatus")
            status_label.setProperty("statusTone", STATUS_TONES.get(status, "unknown"))
            title_row.addWidget(status_label, 0, Qt.AlignTop)
        header_layout.addLayout(title_row)
        header_layout.addWidget(self._keywords_widget(keywords))
        self.header.setLayout(header_layout)
        self.header.clicked.connect(self.toggle)

        self.details = QFrame()
        self.details.setObjectName("cardDetails")
        details_layout = QVBoxLayout()
        details_layout.setContentsMargins(20, 2, 0, 0)
        details_layout.setSpacing(6)
        if fields:
            for key, value in fields:
                details_layout.addWidget(self._field_widget(key, value))
        else:
            details_layout.addWidget(self._field_widget("详情", "暂无更多信息"))
        self.details.setLayout(details_layout)

        layout.addWidget(self.header)
        layout.addWidget(self.details)
        self.setLayout(layout)
        self.set_expanded(expanded, emit=False)

    def toggle(self) -> None:
        self.set_expanded(not self._expanded)

    def set_expanded(self, expanded: bool, emit: bool = True) -> None:
        self._expanded = expanded
        self.details.setVisible(expanded)
        self.indicator.setText("v" if expanded else ">")
        self.header.set_action_word("折叠" if expanded else "展开")
        if emit:
            self.expanded_changed.emit(expanded)

    def _keywords_widget(self, keywords: list[str]) -> QWidget:
        panel = QFrame()
        panel.setObjectName("keywordPanel")
        layout = QGridLayout()
        layout.setContentsMargins(20, 0, 0, 0)
        layout.setHorizontalSpacing(5)
        layout.setVerticalSpacing(5)

        label = QLabel("触发关键字")
        label.setObjectName("keywordLabel")
        layout.addWidget(label, 0, 0, Qt.AlignTop)

        values = keywords if keywords else ["未配置"]
        for index, keyword in enumerate(values):
            chip = QLabel(keyword)
            chip.setObjectName("keywordChip")
            chip.setProperty("empty", not keywords)
            chip.setWordWrap(True)
            row = index // 3
            column = (index % 3) + 1
            layout.addWidget(chip, row, column)
        layout.setColumnStretch(4, 1)
        panel.setLayout(layout)
        return panel

    def _field_widget(self, key: str, value: str) -> QWidget:
        row = QFrame()
        row.setObjectName("fieldRow")
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)

        key_label = QLabel(key)
        key_label.setObjectName("fieldKey")
        value_label = QLabel(value)
        value_label.setObjectName("fieldValue")
        value_label.setWordWrap(True)
        value_label.setTextInteractionFlags(Qt.TextSelectableByMouse)

        layout.addWidget(key_label)
        layout.addWidget(value_label)
        row.setLayout(layout)
        return row


class InfoCard(QFrame):
    def __init__(self, label: str, title: str, fields: list[tuple[str, str]], tone: str = "neutral") -> None:
        super().__init__()
        self.setObjectName("infoCard")
        self.setProperty("tone", tone)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)

        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(7)

        top = QHBoxLayout()
        top.setSpacing(8)
        badge = QLabel(label)
        badge.setObjectName("cardBadge")
        title_label = QLabel(title)
        title_label.setObjectName("cardTitle")
        title_label.setWordWrap(True)
        top.addWidget(badge, 0, Qt.AlignTop)
        top.addWidget(title_label, 1)
        layout.addLayout(top)

        for key, value in fields:
            layout.addWidget(self._field_widget(key, value))
        self.setLayout(layout)

    def _field_widget(self, key: str, value: str) -> QWidget:
        row = QFrame()
        row.setObjectName("fieldRow")
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        key_label = QLabel(key)
        key_label.setObjectName("fieldKey")
        value_label = QLabel(value)
        value_label.setObjectName("fieldValue")
        value_label.setWordWrap(True)
        value_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        layout.addWidget(key_label)
        layout.addWidget(value_label)
        row.setLayout(layout)
        return row


class TaskWindow(QWidget):
    route_selected = Signal(str)
    send_message_requested = Signal(str, object)

    def __init__(self, app_icon: QIcon | None = None) -> None:
        super().__init__()
        self.setWindowTitle("RabiRoute 角色面板")
        self.setWindowFlags(Qt.Window | Qt.Tool | Qt.CustomizeWindowHint | Qt.WindowTitleHint | Qt.WindowCloseButtonHint | Qt.WindowStaysOnTopHint)
        self.setMinimumSize(760, 560)
        self.resize(920, 680)
        self._positioned = False
        self._drag_start: QPoint | None = None
        self._expanded_cards: set[str] = set()

        self.active_view = "chat"
        self.manager: ManagerSnapshot | None = None
        self.selected_gateway: dict | None = None
        self.plans: PlanSnapshot | None = None
        self.context: RoleContextSnapshot | None = None
        self.role_messages: list[dict] = []
        self.pending_attachments: list[dict] = []
        self._sidebar_collapsed = False

        self.header = QFrame()
        self.header.setObjectName("header")
        self.icon_label = QLabel()
        self.icon_label.setObjectName("brandIcon")
        self.icon_label.setFixedSize(38, 38)
        self.icon_label.setAlignment(Qt.AlignCenter)
        if app_icon and not app_icon.isNull():
            self.setWindowIcon(app_icon)
            self.icon_label.setPixmap(app_icon.pixmap(28, 28))
        self.title_label = QLabel("Rabi")
        self.title_label.setObjectName("title")
        self.subtitle_label = QLabel("角色面板")
        self.subtitle_label.setObjectName("subtitle")
        self.status_chip = QLabel("加载中")
        self.status_chip.setObjectName("statusChip")
        self.status_detail = QLabel("正在读取 manager、计划和记忆目录...")
        self.status_detail.setObjectName("statusDetail")
        self.status_detail.setWordWrap(True)

        title_block = QVBoxLayout()
        title_block.setSpacing(2)
        title_block.addWidget(self.title_label)
        title_block.addWidget(self.subtitle_label)

        header_top = QHBoxLayout()
        header_top.setSpacing(10)
        header_top.addWidget(self.icon_label, 0, Qt.AlignTop)
        header_top.addLayout(title_block, 1)
        header_top.addWidget(self.status_chip, 0, Qt.AlignTop)
        self.collapse_button = QPushButton("<")
        self.collapse_button.setObjectName("iconButton")
        self.collapse_button.setToolTip("折叠左侧航线列表")
        self.collapse_button.setAccessibleName("折叠左侧航线列表")
        self.collapse_button.clicked.connect(self._toggle_sidebar)
        self.more_button = QPushButton("...")
        self.more_button.setObjectName("iconButton")
        self.more_button.setToolTip("更多操作")
        self.more_button.setAccessibleName("更多操作")
        self.more_menu = QMenu(self)
        self.more_menu.setObjectName("moreMenu")
        self.more_button.setMenu(self.more_menu)
        header_top.addWidget(self.collapse_button, 0, Qt.AlignTop)
        header_top.addWidget(self.more_button, 0, Qt.AlignTop)

        header_layout = QVBoxLayout()
        header_layout.setContentsMargins(18, 12, 18, 10)
        header_layout.setSpacing(6)
        header_layout.addLayout(header_top)
        header_layout.addWidget(self.status_detail)
        self.header.setLayout(header_layout)

        self.route_nav = QFrame()
        self.route_nav.setObjectName("routeNav")
        route_nav_layout = QVBoxLayout()
        route_nav_layout.setContentsMargins(0, 0, 0, 0)
        route_nav_layout.setSpacing(10)
        self.route_brand = QLabel("RabiRoute")
        self.route_brand.setObjectName("routeBrand")
        route_nav_layout.addWidget(self.route_brand)
        self.route_search_label = QLabel("搜索")
        self.route_search_label.setObjectName("routeSearch")
        route_nav_layout.addWidget(self.route_search_label)
        self.route_buttons: dict[str, QPushButton] = {}
        self.route_buttons_frame = QFrame()
        self.route_buttons_frame.setObjectName("routeButtons")
        self.route_buttons_layout = QVBoxLayout()
        self.route_buttons_layout.setContentsMargins(0, 0, 0, 0)
        self.route_buttons_layout.setSpacing(6)
        self.route_buttons_frame.setLayout(self.route_buttons_layout)
        route_nav_layout.addWidget(self.route_buttons_frame)
        route_nav_layout.addStretch(1)
        self.route_nav.setLayout(route_nav_layout)

        self.view_bar = QFrame()
        self.view_bar.setObjectName("viewBar")
        view_bar_layout = QHBoxLayout()
        view_bar_layout.setContentsMargins(0, 0, 0, 0)
        view_bar_layout.setSpacing(6)
        self.view_buttons: dict[str, QPushButton] = {}
        for view_key, label in VIEW_LABELS:
            if view_key not in PRIMARY_VIEW_KEYS:
                continue
            button = QPushButton(label)
            button.setObjectName("viewButton")
            button.setCheckable(True)
            button.clicked.connect(lambda _checked=False, key=view_key: self.set_view(key))
            self.view_buttons[view_key] = button
            view_bar_layout.addWidget(button)
        view_bar_layout.addStretch(1)
        self.action_buttons: list[QPushButton] = []
        self.actions_frame = QFrame()
        self.actions_frame.setObjectName("panelActions")
        self.actions_layout = QHBoxLayout()
        self.actions_layout.setContentsMargins(0, 0, 0, 0)
        self.actions_layout.setSpacing(6)
        self.actions_frame.setLayout(self.actions_layout)
        self.view_bar.setLayout(view_bar_layout)

        self.content = QScrollArea()
        self.content.setObjectName("content")
        self.content.setWidgetResizable(True)
        self.content.setFrameShape(QFrame.NoFrame)
        self.content_body = QWidget()
        self.content_body.setObjectName("contentBody")
        self.content_layout = QVBoxLayout()
        self.content_layout.setContentsMargins(8, 8, 8, 8)
        self.content_layout.setSpacing(9)
        self.content_body.setLayout(self.content_layout)
        self.content.setWidget(self.content_body)

        self.chat_input_frame = QFrame()
        self.chat_input_frame.setObjectName("chatInput")
        chat_input_layout = QHBoxLayout()
        chat_input_layout.setContentsMargins(8, 8, 8, 8)
        chat_input_layout.setSpacing(8)
        self.message_input = QTextEdit()
        self.message_input.setObjectName("messageInput")
        self.message_input.setPlaceholderText("输入消息，发送给当前航线绑定的 Agent")
        self.message_input.setFixedHeight(72)
        self.attach_button = QPushButton("文件")
        self.attach_button.setObjectName("actionButton")
        self.attach_button.clicked.connect(self._choose_attachment)
        self.send_button = QPushButton("发送")
        self.send_button.setObjectName("sendButton")
        self.send_button.clicked.connect(self._send_message)
        chat_input_layout.addWidget(self.message_input, 1)
        chat_input_layout.addWidget(self.attach_button)
        chat_input_layout.addWidget(self.send_button)
        self.chat_input_frame.setLayout(chat_input_layout)

        self.footer_label = QLabel("聊天记录按角色保存；计划和记忆视图只读展示。")
        self.footer_label.setObjectName("footer")
        self.refresh_button = QPushButton("")
        self.refresh_button.setObjectName("primaryButton")
        self.refresh_button.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_BrowserReload))
        self.refresh_button.setToolTip("刷新")
        self.refresh_button.setAccessibleName("刷新记忆与计划")

        footer = QHBoxLayout()
        footer.addWidget(self.footer_label, 1)
        footer.addWidget(self.refresh_button)

        self.right_pane = QFrame()
        self.right_pane.setObjectName("rightPane")
        right_layout = QVBoxLayout()
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)
        right_layout.addWidget(self.header)
        right_layout.addWidget(self.view_bar)
        right_layout.addWidget(self.content, 1)
        right_layout.addWidget(self.chat_input_frame)
        right_layout.addLayout(footer)
        self.right_pane.setLayout(right_layout)

        main = QHBoxLayout()
        main.setSpacing(0)
        main.addWidget(self.route_nav, 0)
        main.addWidget(self.right_pane, 1)

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addLayout(main, 1)
        self.setLayout(layout)
        self.setStyleSheet(STYLESHEET)
        self.set_actions([])
        self._sync_buttons()

    def set_view(self, view_key: str) -> None:
        self.active_view = view_key
        self._sync_buttons()
        self._render_active_view()

    def set_actions(self, actions: list[tuple[str, object, bool]]) -> None:
        while self.action_buttons:
            button = self.action_buttons.pop()
            self.actions_layout.removeWidget(button)
            button.deleteLater()
        self.more_menu.clear()
        for view_key, label in VIEW_LABELS:
            if view_key in PRIMARY_VIEW_KEYS:
                continue
            action = self.more_menu.addAction(label)
            action.setCheckable(True)
            action.setChecked(self.active_view == view_key)
            action.triggered.connect(lambda _checked=False, key=view_key: self.set_view(key))
        if self.more_menu.actions() and actions:
            self.more_menu.addSeparator()
        for label, callback, enabled in actions:
            action = self.more_menu.addAction(label)
            action.setEnabled(enabled)
            action.triggered.connect(callback)  # type: ignore[arg-type]
        if self.more_menu.actions():
            self.more_menu.addSeparator()
        refresh_action = self.more_menu.addAction("刷新")
        refresh_action.triggered.connect(lambda _checked=False: self.refresh_button.click())
        collapse_action = self.more_menu.addAction("展开左栏" if self._sidebar_collapsed else "折叠左栏")
        collapse_action.triggered.connect(lambda _checked=False: self._toggle_sidebar())
        self.more_button.setEnabled(bool(self.more_menu.actions()))

    def _toggle_sidebar(self) -> None:
        self._sidebar_collapsed = not self._sidebar_collapsed
        self.route_nav.setVisible(not self._sidebar_collapsed)
        self.collapse_button.setText(">" if self._sidebar_collapsed else "<")
        self.collapse_button.setToolTip("展开左侧航线列表" if self._sidebar_collapsed else "折叠左侧航线列表")
        self.collapse_button.setAccessibleName(self.collapse_button.toolTip())

    def render(
        self,
        manager: ManagerSnapshot,
        selected_gateway: dict | None,
        plans: PlanSnapshot,
        context: RoleContextSnapshot,
        role_messages: list[dict] | None = None,
    ) -> None:
        scroll_bar = self.content.verticalScrollBar()
        scroll_value = scroll_bar.value()
        self.manager = manager
        self.selected_gateway = selected_gateway or manager.selected_gateway
        self.plans = plans
        self.context = context
        self.role_messages = role_messages or []

        gateway = self.selected_gateway
        role_id = str(gateway.get("agentRoleId") or plans.role_id) if gateway else plans.role_id
        running = bool(gateway.get("running")) if gateway else False

        self.setWindowTitle(role_id or plans.role_id or "角色面板")
        self.title_label.setText(role_id or plans.role_id)
        self.subtitle_label.setText(route_subtitle(gateway) if gateway else "角色面板")
        self.status_chip.setText(self._chip_text(manager.connected, running))
        self.status_detail.setText(
            f"Manager：{'已连接' if manager.connected else '离线'}  "
            f"Gateway：{'运行中' if running else '已停止'}\n"
            f"当前航线：{self._gateway_label(gateway) if gateway else '未选择'}"
        )
        self._render_route_buttons()
        self._render_active_view()
        QTimer.singleShot(0, lambda value=scroll_value: self._restore_scroll(value))

    def is_user_interacting(self) -> bool:
        if not self.isVisible():
            return False
        focused = QApplication.focusWidget()
        return self.isActiveWindow() or focused is self or (focused is not None and self.isAncestorOf(focused))

    def _restore_scroll(self, value: int) -> None:
        scroll_bar = self.content.verticalScrollBar()
        scroll_bar.setValue(min(value, scroll_bar.maximum()))

    def _render_route_buttons(self) -> None:
        while self.route_buttons:
            _key, button = self.route_buttons.popitem()
            self.route_buttons_layout.removeWidget(button)
            button.deleteLater()
        if not self.manager or not self.manager.gateways:
            empty = QPushButton("暂无航线")
            empty.setObjectName("routeButton")
            empty.setEnabled(False)
            self.route_buttons_layout.addWidget(empty)
            self.route_buttons["empty"] = empty
            return
        selected_id = str((self.selected_gateway or {}).get("id") or "")
        for gateway in self.manager.gateways:
            gateway_id = str(gateway.get("id") or "")
            label = self._gateway_label(gateway)
            button = QPushButton(f"{route_title(gateway)}\n{route_subtitle(gateway)}\n{route_enabled_label(gateway)} / {route_running_label(gateway)}")
            button.setObjectName("routeButton")
            button.setProperty("routeState", route_state(gateway))
            button.setCheckable(True)
            button.setChecked(gateway_id == selected_id)
            button.setToolTip(label)
            button.clicked.connect(lambda _checked=False, item_id=gateway_id: self.route_selected.emit(item_id))
            self.route_buttons[gateway_id] = button
            self.route_buttons_layout.addWidget(button)

    def _gateway_label(self, gateway: dict | None) -> str:
        if not gateway:
            return "未选择航线"
        return route_status_label(gateway)

    def _choose_attachment(self) -> None:
        paths, _selected_filter = QFileDialog.getOpenFileNames(self, "选择发送文件")
        for raw_path in paths:
            path_obj = Path(raw_path)
            try:
                size = path_obj.stat().st_size
            except OSError:
                size = 0
            self.pending_attachments.append({
                "kind": "file",
                "name": path_obj.name,
                "path": str(path_obj),
                "size": size,
            })
        self._update_attachment_button()

    def _update_attachment_button(self) -> None:
        count = len(self.pending_attachments)
        self.attach_button.setText(f"文件({count})" if count else "文件")

    def _send_message(self) -> None:
        text = self.message_input.toPlainText().strip()
        if not text and not self.pending_attachments:
            return
        attachments = list(self.pending_attachments)
        self.pending_attachments.clear()
        self._update_attachment_button()
        self.message_input.clear()
        self.send_message_requested.emit(text, attachments)

    def _render_active_view(self) -> None:
        self._clear_content()
        self.chat_input_frame.setVisible(self.active_view == "chat")
        if not self.manager or not self.plans or not self.context:
            self._add_section_header("加载中", "正在读取计划、记忆和路由状态。")
            self._add_info_card("状态", "正在读取计划、记忆和路由状态。", [], "neutral")
            self.content_layout.addStretch(1)
            return

        renderers = {
            "chat": self._render_chat,
            "current": self._render_current,
            "plans": self._render_plans,
            "recent_memory": lambda: self._render_context_group("近期记忆", self.context.recent_memory),
            "archived": self._render_archived,
            "status": self._render_status,
        }
        renderers.get(self.active_view, self._render_current)()
        self.content_layout.addStretch(1)

    def _render_chat(self) -> None:
        role_id = self.plans.role_id if self.plans else "Rabi"
        self._add_section_header(role_id, f"当前航线：{self._gateway_label(self.selected_gateway)}")
        if not self.role_messages:
            self._add_info_card("聊天", "还没有角色面板对话。", [("提示", "在下方输入消息，发送给当前航线绑定的 Agent。")], "empty")
            return
        last_day = ""
        for message in self.role_messages:
            day = self._message_day(message)
            if day and day != last_day:
                self._add_time_separator(day)
                last_day = day
            self._add_chat_bubble(message)

    def _message_day(self, message: dict) -> str:
        value = message.get("time")
        try:
            seconds = float(value)
            return datetime.fromtimestamp(seconds).strftime("%Y-%m-%d %H:%M")
        except Exception:
            return ""

    def _add_time_separator(self, text: str) -> None:
        label = QLabel(text)
        label.setObjectName("timeSeparator")
        label.setAlignment(Qt.AlignCenter)
        self.content_layout.addWidget(label)

    def _add_chat_bubble(self, message: dict) -> None:
        direction = str(message.get("direction") or "user")
        bubble = QFrame()
        bubble.setObjectName("chatBubble")
        bubble.setProperty("direction", "out" if direction == "user" else "in" if direction == "assistant" else "system")
        outer = QHBoxLayout()
        outer.setContentsMargins(4, 2, 4, 2)
        if direction == "user":
            outer.addStretch(1)
        body = QFrame()
        body.setObjectName("chatBubbleBody")
        body_layout = QVBoxLayout()
        body_layout.setContentsMargins(10, 8, 10, 8)
        body_layout.setSpacing(5)
        sender = QLabel(str(message.get("sender") or ("我" if direction == "user" else "Agent")))
        sender.setObjectName("chatSender")
        body_layout.addWidget(sender)
        text = str(message.get("text") or "")
        if text:
            text_label = QLabel(text)
            text_label.setObjectName("chatText")
            text_label.setWordWrap(True)
            text_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
            body_layout.addWidget(text_label)
        for attachment in message.get("attachments") or []:
            if isinstance(attachment, dict):
                body_layout.addWidget(self._attachment_widget(attachment))
        body.setLayout(body_layout)
        outer.addWidget(body, 0)
        if direction != "user":
            outer.addStretch(1)
        bubble.setLayout(outer)
        self.content_layout.addWidget(bubble)

    def _attachment_widget(self, attachment: dict) -> QWidget:
        name = str(attachment.get("name") or attachment.get("path") or attachment.get("url") or "附件")
        size = attachment.get("size")
        detail = f"{size} bytes" if isinstance(size, int) and size > 0 else "文件"
        return InfoCard("文件", name, [("详情", detail)], "neutral")

    def _render_current(self) -> None:
        assert self.plans is not None
        assert self.context is not None
        self._add_section_header("当前记忆与计划", "进行中计划和近期记忆会作为轻量上下文索引随消息进入 Agent。")
        if self.plans.current:
            self._add_plan_cards(self.plans.current, "进行中计划")
        else:
            self._add_info_card("进行中计划", "暂无 status=进行中 的计划。", [("计划目录", str(self.plans.plans_dir))], "empty")
        if self.context.recent_memory:
            self._add_context_cards(self.context.recent_memory, "近期记忆")
        else:
            self._add_info_card("近期记忆", "暂无近期记忆。", [("记忆目录", str(self.context.role_dir / "memory" / "recent"))], "empty")

    def _render_plans(self) -> None:
        assert self.plans is not None
        self._add_section_header("计划", "未归档计划的只读概览。")
        if self.plans.active:
            self._add_plan_cards(self.plans.active, "计划")
        else:
            self._add_info_card("计划", "暂无可展示计划。", [("计划目录", str(self.plans.plans_dir))], "empty")

    def _render_archived(self) -> None:
        assert self.plans is not None
        assert self.context is not None
        self._add_section_header("已归档", "已归档计划和沉淀记忆的只读概览。")
        has_content = False
        if self.plans.archived:
            self._add_plan_cards(self.plans.archived, "已归档计划")
            has_content = True
        if self.context.consolidated_memory:
            self._add_context_cards(self.context.consolidated_memory, "沉淀记忆")
            has_content = True
        if not has_content:
            self._add_info_card("已归档", "暂无已归档计划或沉淀记忆。", [("人格目录", str(self.plans.role_dir))], "empty")

    def _render_status(self) -> None:
        assert self.manager is not None
        assert self.plans is not None
        assert self.context is not None
        gateway = self.selected_gateway
        fields = [
            ("Manager", "已连接" if self.manager.connected else "离线"),
            ("Manager 地址", self.manager.manager_url),
        ]
        if self.manager.error:
            fields.append(("Manager 错误", self.manager.error))
        if gateway:
            fields.extend([
                ("Gateway 人格", str(gateway.get("agentRoleId", self.plans.role_id))),
                ("Gateway 运行中", str(bool(gateway.get("running")))),
            ])
        fields.extend([
            ("人格目录", str(self.plans.role_dir)),
            ("计划目录", str(self.plans.plans_dir)),
            ("记忆目录", str(self.context.role_dir / "memory")),
            ("路由状态目录", str(self.context.route_dir)),
        ])
        for line in self.context.status_lines or ["没有找到可读取的路由状态文件。"]:
            fields.append(("运行状态文件", line))
        self._add_section_header("诊断 / 路由状态", "manager、gateway 和角色目录的只读状态。")
        self._add_info_card("状态", "运行状态", fields, "neutral")

    def _render_context_group(self, title: str, entries: list[ContextEntry]) -> None:
        assert self.context is not None
        self._add_section_header(title, "Agent 维护的上下文条目，只读展示。")
        if entries:
            self._add_context_cards(entries, title)
        else:
            self._add_info_card(title, "这个视图暂无可展示内容。", [("人格目录", str(self.context.role_dir))], "empty")

    def _add_plan_cards(self, plans: list[PlanItem], label: str) -> None:
        for plan in plans:
            fields: list[tuple[str, str]] = [("分类", label)]
            if plan.priority:
                fields.append(("优先级", plan.priority))
            if plan.kind:
                fields.append(("类型", plan.kind))
            if plan.current_step:
                fields.append(("当前步骤", plan.current_step))
            if plan.next_action:
                fields.append(("下一步", plan.next_action))
            if plan.project_name or plan.project_path:
                fields.append(("项目", plan.project_name or plan.project_path))
            if plan.source:
                fields.append(("来源", plan.source))
            if plan.updated_at:
                fields.append(("更新时间", plan.updated_at))
            if plan.path:
                fields.append(("文件", str(plan.path)))
            self._add_expandable_card(
                "计划",
                plan.title,
                fields,
                "plan",
                plan.keywords,
                status=plan.status,
                card_key=f"plan:{plan.path or plan.title}",
            )

    def _add_context_cards(self, entries: list[ContextEntry], label: str) -> None:
        for entry in entries:
            fields: list[tuple[str, str]] = [("分类", label)]
            if entry.detail:
                fields.append(("内容", entry.detail))
            if entry.source:
                fields.append(("来源", entry.source))
            if entry.updated_at:
                fields.append(("更新时间", entry.updated_at))
            if entry.path:
                fields.append(("文件", str(entry.path)))
            self._add_expandable_card(
                "记忆",
                entry.title,
                fields,
                "memory",
                entry.keywords,
                card_key=f"memory:{entry.path or entry.title}",
            )

    def _add_expandable_card(
        self,
        label: str,
        title: str,
        fields: list[tuple[str, str]],
        tone: str,
        keywords: list[str],
        status: str = "",
        card_key: str = "",
    ) -> None:
        key = card_key or f"{label}:{title}"
        card = ExpandableCard(label, title, fields, tone, keywords, status=status, expanded=key in self._expanded_cards)
        card.expanded_changed.connect(lambda expanded, item_key=key: self._set_card_expanded(item_key, expanded))
        self.content_layout.addWidget(card)

    def _add_section_header(self, title: str, detail: str) -> None:
        section = QFrame()
        section.setObjectName("sectionHeader")
        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(4)
        title_label = QLabel(title)
        title_label.setObjectName("sectionTitle")
        detail_label = QLabel(detail)
        detail_label.setObjectName("sectionDetail")
        detail_label.setWordWrap(True)
        layout.addWidget(title_label)
        layout.addWidget(detail_label)
        section.setLayout(layout)
        self.content_layout.addWidget(section)

    def _add_info_card(self, label: str, title: str, fields: list[tuple[str, str]], tone: str) -> None:
        self.content_layout.addWidget(InfoCard(label, title, fields, tone))

    def _clear_content(self) -> None:
        while self.content_layout.count():
            item = self.content_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _set_card_expanded(self, key: str, expanded: bool) -> None:
        if expanded:
            self._expanded_cards.add(key)
        else:
            self._expanded_cards.discard(key)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self._positioned:
            self._snap_to_edge()
            self._positioned = True

    def _snap_to_edge(self) -> None:
        screen = QGuiApplication.primaryScreen()
        if not screen:
            return
        avail = screen.availableGeometry()
        w = self.frameGeometry().width()
        h = self.frameGeometry().height()
        margin = 16
        current = self.frameGeometry()
        center_x = current.center().x()
        left_x = avail.left() + margin
        right_x = avail.right() - w - margin
        x = right_x if abs(center_x - avail.right()) <= abs(center_x - avail.left()) else left_x
        y = min(max(current.top(), avail.top() + margin), avail.bottom() - h - margin)
        self.move(x, y)

    def _sync_buttons(self) -> None:
        for view_key, button in self.view_buttons.items():
            button.setChecked(view_key == self.active_view)

    def _chip_text(self, manager_connected: bool, gateway_running: bool) -> str:
        if manager_connected and gateway_running:
            return "运行中"
        if manager_connected:
            return "待检查"
        return "离线"

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.LeftButton:
            self._drag_start = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag_start is not None and event.buttons() & Qt.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_start)
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if self._drag_start is not None:
            self._drag_start = None
            self._snap_to_edge()
            event.accept()
            return
        super().mouseReleaseEvent(event)


STYLESHEET = """
QWidget {
    background: #1f1f1f;
    color: #e8e8e8;
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    font-size: 13px;
}
QFrame#rightPane {
    background: #1f1f1f;
    border-left: 1px solid #303030;
}
QFrame#header {
    background: #1f1f1f;
    border: 0;
    border-bottom: 1px solid #2d2d2d;
    border-radius: 0;
}
QLabel#title {
    color: #f4f4f4;
    font-size: 18px;
    font-weight: 800;
}
QLabel#subtitle {
    color: #9c9c9c;
    font-size: 12px;
    font-weight: 650;
}
QLabel#statusChip {
    background: #18c875;
    border-radius: 9px;
    color: #ffffff;
    font-weight: 800;
    padding: 3px 9px;
}
QLabel#statusDetail {
    color: #8f8f8f;
    line-height: 1.4;
    font-weight: 650;
}
QLabel#brandIcon {
    background: #2a2a2a;
    border: 1px solid #3a3a3a;
    border-radius: 19px;
}
QPushButton#iconButton {
    background: transparent;
    border: 0;
    border-radius: 8px;
    color: #b9b9b9;
    min-width: 34px;
    max-width: 34px;
    min-height: 34px;
    padding: 0;
    font-size: 18px;
    font-weight: 800;
}
QPushButton#iconButton:hover {
    background: #2d2d2d;
    color: #ffffff;
}
QPushButton#iconButton::menu-indicator {
    width: 0;
}
QMenu#moreMenu {
    background: #2b2b2b;
    border: 1px solid #454545;
    border-radius: 8px;
    color: #eeeeee;
    padding: 6px;
}
QMenu#moreMenu::item {
    border-radius: 6px;
    padding: 8px 28px 8px 12px;
}
QMenu#moreMenu::item:selected {
    background: #3a3a3a;
}
QMenu#moreMenu::item:disabled {
    color: #777777;
}
QFrame#routeNav {
    background: #252525;
    border-right: 1px solid #333333;
    min-width: 252px;
    max-width: 252px;
}
QLabel#routeBrand {
    background: transparent;
    color: #f2f2f2;
    font-size: 16px;
    font-weight: 900;
    padding: 12px 14px 2px 14px;
}
QLabel#routeSearch {
    background: #303030;
    border: 1px solid #303030;
    border-radius: 8px;
    color: #bdbdbd;
    min-height: 28px;
    margin: 0 12px;
    padding: 4px 10px;
    font-weight: 700;
}
QPushButton#routeButton {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: #f1f1f1;
    min-height: 78px;
    margin: 0 4px;
    padding: 8px 12px;
    text-align: left;
    font-weight: 800;
}
QPushButton#routeButton[routeState="running"] {
    background: rgba(22, 163, 74, 0.13);
    border-left: 4px solid #16a34a;
}
QPushButton#routeButton[routeState="stopped"] {
    background: rgba(234, 179, 8, 0.12);
    border-left: 4px solid #eab308;
}
QPushButton#routeButton[routeState="disabled"] {
    background: rgba(148, 163, 184, 0.10);
    border-left: 4px solid #94a3b8;
    color: #a9a9a9;
}
QPushButton#routeButton:hover {
    background: #303030;
}
QPushButton#routeButton:checked {
    background: #3b3b3b;
    color: #ffffff;
}
QFrame#viewBar {
    background: #1f1f1f;
    border-bottom: 1px solid #2d2d2d;
    padding: 8px 14px;
}
QLabel#actionsLabel {
    color: #9c9c9c;
    font-size: 11px;
    font-weight: 800;
    padding-top: 4px;
}
QFrame#panelActions {
    background: transparent;
}
QPushButton#viewButton {
    background: transparent;
    border: 1px solid #3a3a3a;
    border-radius: 6px;
    color: #bbbbbb;
    min-height: 32px;
    padding: 4px 10px;
    font-weight: 800;
}
QPushButton#sendButton {
    background: #0b7de3;
    border: 0;
    border-radius: 8px;
    color: #ffffff;
    min-width: 88px;
    min-height: 44px;
    padding: 6px 16px;
    font-weight: 800;
}
QFrame#chatInput {
    background: #1f1f1f;
    border-top: 1px solid #2d2d2d;
    border-radius: 0;
}
QTextEdit#messageInput {
    background: #1f1f1f;
    border: 1px solid #3a3a3a;
    border-radius: 8px;
    color: #eeeeee;
    padding: 8px;
    selection-background-color: #0b7de3;
}
QFrame#chatBubble {
    background: transparent;
    border: 0;
}
QFrame#chatBubbleBody {
    background: #3a3a3a;
    border: 1px solid #3f3f3f;
    border-radius: 8px;
    max-width: 560px;
}
QFrame#chatBubble[direction="out"] QFrame#chatBubbleBody {
    background: #5f5f5f;
    border-color: #656565;
}
QFrame#chatBubble[direction="in"] QFrame#chatBubbleBody {
    background: #3a3a3a;
}
QLabel#chatSender {
    color: #aaaaaa;
    font-size: 11px;
    font-weight: 800;
}
QLabel#chatText {
    color: #f1f1f1;
    font-size: 14px;
    line-height: 1.45;
}
QLabel#timeSeparator {
    color: #777777;
    font-size: 11px;
    padding: 4px;
}
QPushButton#viewButton:hover {
    background: #2c2c2c;
    border-color: #4a4a4a;
    color: #ffffff;
}
QPushButton#viewButton:checked {
    background: #3b3b3b;
    border-color: #4a4a4a;
    color: #ffffff;
    font-weight: 800;
}
QPushButton#actionButton {
    background: #2b2b2b;
    border: 1px solid #454545;
    border-radius: 6px;
    color: #eeeeee;
    min-height: 34px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 750;
    text-align: left;
}
QPushButton#actionButton:hover {
    background: #383838;
    border-color: #5a5a5a;
}
QPushButton#actionButton:disabled {
    background: #292929;
    color: #777777;
}
QScrollArea#content {
    background: #1f1f1f;
    border: 0;
    border-radius: 0;
}
QWidget#contentBody {
    background: #1f1f1f;
}
QFrame#sectionHeader {
    background: #252525;
    border: 1px solid #323232;
    border-radius: 8px;
}
QLabel#sectionTitle {
    color: #f2f2f2;
    font-size: 17px;
    font-weight: 800;
}
QLabel#sectionDetail {
    color: #a6a6a6;
    font-size: 12px;
}
QFrame#itemCard, QFrame#infoCard {
    background: #252525;
    border: 1px solid #343434;
    border-radius: 8px;
}
QFrame#itemCard[tone="plan"] {
    background: #29251d;
    border-left: 4px solid #c8902b;
}
QFrame#itemCard[tone="memory"] {
    background: #1f2b27;
    border-left: 4px solid #18c875;
}
QFrame#infoCard[tone="neutral"] {
    background: #222a35;
    border-left: 4px solid #0b7de3;
}
QFrame#infoCard[tone="empty"] {
    background: #252525;
    border-left: 4px solid #5f5f5f;
}
QFrame#cardHeader {
    background: transparent;
    border: 0;
    border-radius: 6px;
}
QFrame#cardHeader:hover {
    background: rgba(255, 255, 255, 0.05);
}
QFrame#cardHeader:focus {
    border: 2px solid #0b7de3;
}
QLabel#cardIndicator {
    color: #b8b8b8;
    font-size: 13px;
    font-weight: 900;
}
QLabel#cardBadge {
    background: #303030;
    border: 1px solid #444444;
    border-radius: 8px;
    color: #bcbcbc;
    font-size: 11px;
    font-weight: 800;
    padding: 2px 7px;
}
QLabel#cardTitle {
    color: #eeeeee;
    font-size: 15px;
    font-weight: 850;
}
QLabel#planStatus {
    border-radius: 8px;
    font-size: 11px;
    font-weight: 850;
    padding: 3px 7px;
}
QLabel#planStatus[statusTone="running"] {
    background: #163f2d;
    color: #65e7a7;
}
QLabel#planStatus[statusTone="pending"] {
    background: #3b2d16;
    color: #f2c266;
}
QLabel#planStatus[statusTone="done"] {
    background: #1d2f46;
    color: #8ac3ff;
}
QLabel#planStatus[statusTone="archived"] {
    background: #333333;
    color: #b8b8b8;
}
QLabel#planStatus[statusTone="unknown"] {
    background: #303030;
    color: #b8b8b8;
}
QFrame#keywordPanel {
    background: transparent;
    border: 0;
}
QLabel#keywordLabel {
    color: #9c9c9c;
    font-size: 11px;
    font-weight: 800;
    padding-top: 3px;
}
QLabel#keywordChip {
    background: #303030;
    border: 1px solid #444444;
    border-radius: 8px;
    color: #d0d0d0;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 6px;
}
QLabel#keywordChip[empty="true"] {
    color: #888888;
}
QFrame#cardDetails {
    background: transparent;
    border: 0;
}
QFrame#fieldRow {
    background: transparent;
    border: 0;
}
QLabel#fieldKey {
    color: #9c9c9c;
    font-size: 11px;
    font-weight: 800;
}
QLabel#fieldValue {
    color: #dedede;
    line-height: 1.45;
}
QLabel#footer {
    background: #1f1f1f;
    border-top: 1px solid #2d2d2d;
    color: #888888;
    font-size: 12px;
    padding: 8px 14px;
}
QPushButton#primaryButton {
    background: #2f4158;
    border: 0;
    border-radius: 8px;
    color: #ffffff;
    min-width: 38px;
    max-width: 38px;
    min-height: 34px;
    padding: 4px;
}
QPushButton#primaryButton:hover {
    background: #3c5c7f;
}
"""
