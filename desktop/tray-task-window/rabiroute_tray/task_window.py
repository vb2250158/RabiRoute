from __future__ import annotations

from html import escape

from PySide6.QtCore import QPoint, Qt
from PySide6.QtGui import QGuiApplication, QIcon, QMouseEvent
from PySide6.QtWidgets import QFrame, QHBoxLayout, QLabel, QPushButton, QStyle, QTextEdit, QVBoxLayout, QWidget

from .manager_client import ManagerSnapshot
from .role_context_repository import ContextEntry, RoleContextSnapshot
from .task_repository import PlanItem, PlanSnapshot


VIEW_LABELS = (
    ("current", "当前记忆与计划"),
    ("plans", "计划"),
    ("recent_memory", "近期记忆"),
    ("archived", "已归档"),
    ("status", "诊断"),
)


class TaskWindow(QWidget):
    def __init__(self, app_icon: QIcon | None = None) -> None:
        super().__init__()
        self.setWindowTitle("RabiRoute 记忆与计划")
        self.setWindowFlags(Qt.Window | Qt.Tool | Qt.CustomizeWindowHint | Qt.WindowTitleHint | Qt.WindowCloseButtonHint | Qt.WindowStaysOnTopHint)
        self.setMinimumSize(420, 500)
        self.resize(500, 620)
        self._positioned = False
        self._drag_start: QPoint | None = None

        self.active_view = "current"
        self.manager: ManagerSnapshot | None = None
        self.plans: PlanSnapshot | None = None
        self.context: RoleContextSnapshot | None = None

        self.header = QFrame()
        self.header.setObjectName("header")
        self.icon_label = QLabel()
        self.icon_label.setObjectName("brandIcon")
        self.icon_label.setFixedSize(38, 38)
        self.icon_label.setAlignment(Qt.AlignCenter)
        if app_icon and not app_icon.isNull():
            self.setWindowIcon(app_icon)
            self.icon_label.setPixmap(app_icon.pixmap(28, 28))
        self.title_label = QLabel("RabiRoute / Rabi")
        self.title_label.setObjectName("title")
        self.subtitle_label = QLabel("默认投递给 Agent 的上下文便签")
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

        header_layout = QVBoxLayout()
        header_layout.setContentsMargins(16, 14, 16, 14)
        header_layout.setSpacing(10)
        header_layout.addLayout(header_top)
        header_layout.addWidget(self.status_detail)
        self.header.setLayout(header_layout)

        self.nav = QFrame()
        self.nav.setObjectName("noteNav")
        nav_layout = QVBoxLayout()
        nav_layout.setContentsMargins(0, 0, 0, 0)
        nav_layout.setSpacing(8)
        self.view_buttons: dict[str, QPushButton] = {}
        for index, (view_key, label) in enumerate(VIEW_LABELS):
            button = QPushButton(label)
            button.setObjectName("viewButton")
            button.setCheckable(True)
            button.clicked.connect(lambda _checked=False, key=view_key: self.set_view(key))
            self.view_buttons[view_key] = button
            nav_layout.addWidget(button)
        nav_layout.addStretch(1)
        self.action_buttons: list[QPushButton] = []
        self.actions_label = QLabel("操作")
        self.actions_label.setObjectName("actionsLabel")
        nav_layout.addWidget(self.actions_label)
        self.actions_frame = QFrame()
        self.actions_frame.setObjectName("panelActions")
        self.actions_layout = QVBoxLayout()
        self.actions_layout.setContentsMargins(0, 0, 0, 0)
        self.actions_layout.setSpacing(6)
        self.actions_frame.setLayout(self.actions_layout)
        nav_layout.addWidget(self.actions_frame)
        self.nav.setLayout(nav_layout)

        self.content = QTextEdit()
        self.content.setObjectName("content")
        self.content.setReadOnly(True)
        self.content.setLineWrapMode(QTextEdit.WidgetWidth)
        self.footer_label = QLabel("只读：显示默认随消息投递到 Agent 端的记忆与计划")
        self.footer_label.setObjectName("footer")
        self.refresh_button = QPushButton("")
        self.refresh_button.setObjectName("primaryButton")
        self.refresh_button.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_BrowserReload))
        self.refresh_button.setToolTip("刷新")
        self.refresh_button.setAccessibleName("刷新记忆与计划")

        footer = QHBoxLayout()
        footer.addWidget(self.footer_label, 1)
        footer.addWidget(self.refresh_button)

        main = QHBoxLayout()
        main.setSpacing(10)
        main.addWidget(self.nav, 0)
        main.addWidget(self.content, 1)

        layout = QVBoxLayout()
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(10)
        layout.addWidget(self.header)
        layout.addLayout(main, 1)
        layout.addLayout(footer)
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
        self.actions_label.setVisible(bool(actions))
        self.actions_frame.setVisible(bool(actions))
        for label, callback, enabled in actions:
            button = QPushButton(label)
            button.setObjectName("actionButton")
            button.setEnabled(enabled)
            button.setToolTip(label)
            button.clicked.connect(callback)  # type: ignore[arg-type]
            self.actions_layout.addWidget(button)
            self.action_buttons.append(button)

    def render(self, manager: ManagerSnapshot, plans: PlanSnapshot, context: RoleContextSnapshot) -> None:
        self.manager = manager
        self.plans = plans
        self.context = context

        gateway = manager.selected_gateway
        role_id = str(gateway.get("agentRoleId") or plans.role_id) if gateway else plans.role_id
        running = bool(gateway.get("running")) if gateway else False

        self.title_label.setText(f"RabiRoute / {role_id or plans.role_id}")
        self.status_chip.setText(self._chip_text(manager.connected, running))
        self.status_detail.setText(
            f"Manager：{'已连接' if manager.connected else '离线'}  "
            f"Gateway：{'运行中' if running else '已停止'}\n"
            f"当前栏显示：进行中计划 + 近期记忆"
        )
        self._render_active_view()

    def _render_active_view(self) -> None:
        if not self.manager or not self.plans or not self.context:
            self.content.setHtml(self._empty_html("加载中", "正在读取计划、记忆和路由状态。"))
            return

        renderers = {
            "current": self._current_text,
            "plans": self._plans_text,
            "recent_memory": lambda: self._context_group_text("近期记忆", self.context.recent_memory),
            "archived": self._archived_text,
            "status": self._status_text,
        }
        self.content.setHtml(renderers.get(self.active_view, self._current_text)())

    def _current_text(self) -> str:
        assert self.plans is not None
        assert self.context is not None
        blocks = [self._section_header_html("当前记忆与计划", "进行中计划和近期记忆会作为轻量上下文索引随消息进入 Agent。")]
        if self.plans.current:
            blocks.append(self._plan_list_text(self.plans.current, "进行中计划"))
        else:
            blocks.append(self._empty_note_html("进行中计划", f"暂无 status=进行中 的计划。计划目录：{self.plans.plans_dir}"))
        if self.context.recent_memory:
            blocks.append(self._context_list_text(self.context.recent_memory, "近期记忆"))
        else:
            blocks.append(self._empty_note_html("近期记忆", f"暂无近期记忆。记忆目录：{self.context.role_dir / 'memory' / 'recent'}"))
        return self._page_html("".join(blocks))

    def _plans_text(self) -> str:
        assert self.plans is not None
        if not self.plans.active:
            return self._empty_html("计划", f"暂无可展示计划。计划目录：{self.plans.plans_dir}")
        return self._page_html(self._section_header_html("计划", "未归档计划的只读概览。") + self._plan_list_text(self.plans.active, "计划"))

    def _archived_text(self) -> str:
        assert self.plans is not None
        assert self.context is not None
        blocks = [self._section_header_html("已归档", "已归档计划和沉淀记忆的只读概览。")]
        has_content = False
        if self.plans.archived:
            blocks.append(self._plan_list_text(self.plans.archived, "已归档计划"))
            has_content = True
        if self.context.consolidated_memory:
            blocks.append(self._context_list_text(self.context.consolidated_memory, "沉淀记忆"))
            has_content = True
        if not has_content:
            blocks.append(self._empty_note_html("已归档", f"暂无已归档计划或沉淀记忆。人格目录：{self.plans.role_dir}"))
        return self._page_html("".join(blocks))

    def _status_text(self) -> str:
        assert self.manager is not None
        assert self.plans is not None
        assert self.context is not None
        gateway = self.manager.selected_gateway
        lines = [
            f"Manager：{'已连接' if self.manager.connected else '离线'}",
            f"Manager 地址：{self.manager.manager_url}",
        ]
        if self.manager.error:
            lines.append(f"Manager 错误：{self.manager.error}")
        if gateway:
            lines.extend([
                f"Gateway 人格：{gateway.get('agentRoleId', self.plans.role_id)}",
                f"Gateway 运行中：{bool(gateway.get('running'))}",
            ])
        lines.extend([
            f"人格目录：{self.plans.role_dir}",
            f"计划目录：{self.plans.plans_dir}",
            f"记忆目录：{self.context.role_dir / 'memory'}",
            f"路由状态目录：{self.context.route_dir}",
            "运行状态文件：",
        ])
        lines.extend(self.context.status_lines or ["没有找到可读取的路由状态文件。"])
        return self._page_html(self._section_header_html("诊断 / 路由状态", "manager、gateway 和角色目录的只读状态。") + self._note_html("状态", lines, "note neutral"))

    def _context_group_text(self, title: str, entries: list[ContextEntry]) -> str:
        assert self.context is not None
        if entries:
            return self._page_html(self._section_header_html(title, "Agent 维护的上下文条目，只读展示。") + self._context_list_text(entries, title))
        return self._empty_html(title, f"这个视图暂无可展示内容。人格目录：{self.context.role_dir}")

    def _plan_list_text(self, plans: list[PlanItem], label: str) -> str:
        return "".join(self._plan_text(index, plan, label) for index, plan in enumerate(plans, start=1))

    def _plan_text(self, index: int, plan: PlanItem, label: str) -> str:
        fields = [("分类", label), ("状态", plan.status)]
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
        return self._card_html("计划", f"{index}. {plan.title}", fields, "plan")

    def _context_list_text(self, entries: list[ContextEntry], label: str) -> str:
        blocks: list[str] = []
        for index, entry in enumerate(entries, start=1):
            fields: list[tuple[str, str]] = []
            fields.append(("分类", label))
            if entry.detail:
                fields.append(("内容", entry.detail))
            if entry.source:
                fields.append(("来源", entry.source))
            if entry.path:
                fields.append(("文件", str(entry.path)))
            blocks.append(self._card_html("记忆", f"{index}. {entry.title}", fields, "memory"))
        return "".join(blocks)

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

    def _page_html(self, body: str) -> str:
        return f"""
<style>
body {{
    margin: 0;
    background: #fffaf0;
    color: #1f2933;
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    font-size: 13px;
}}
.page {{
    padding: 4px;
}}
.sectionHeader {{
    margin: 2px 0 10px 0;
    padding: 10px 12px;
    background: #ffffff;
    border: 1px solid #eadfca;
    border-radius: 8px;
}}
.sectionTitle {{
    color: #23364d;
    font-size: 18px;
    font-weight: 800;
}}
.sectionDetail {{
    color: #61717e;
    font-size: 12px;
    margin-top: 4px;
}}
.itemCard {{
    margin: 0 0 9px 0;
    padding: 10px 12px 11px 12px;
    border-radius: 8px;
    border: 1px solid #e1d3b4;
    background: #ffffff;
}}
.plan {{
    background: #fff4c7;
    border-left: 5px solid #d99d22;
}}
.memory {{
    background: #ddf7f0;
    border-left: 5px solid #21a382;
}}
.neutral {{
    background: #edf2ff;
    border-left: 5px solid #5577c8;
}}
.empty {{
    background: #f7f1e4;
    border-left: 5px solid #b8a786;
}}
.cardTop {{
    margin-bottom: 5px;
}}
.cardBadge {{
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(83, 70, 47, 0.18);
    border-radius: 10px;
    color: #607080;
    font-size: 11px;
    font-weight: 800;
    padding: 2px 7px;
}}
.cardTitle {{
    color: #243241;
    font-size: 15px;
    font-weight: 850;
    margin-bottom: 7px;
}}
.cardFields {{
    margin-top: 2px;
}}
.fieldRow {{
    margin-top: 4px;
}}
.fieldKey {{
    color: #6f5f45;
    font-size: 11px;
    font-weight: 800;
    margin-right: 7px;
}}
.fieldValue {{
    color: #2f3c48;
    line-height: 1.45;
}}
</style>
<div class='page'>{body}</div>
"""

    def _section_header_html(self, title: str, detail: str) -> str:
        return (
            "<div class='sectionHeader'>"
            f"<div class='sectionTitle'>{escape(title)}</div>"
            f"<div class='sectionDetail'>{escape(detail)}</div>"
            "</div>"
        )

    def _empty_html(self, title: str, detail: str) -> str:
        return self._page_html(self._section_header_html(title, detail) + self._empty_note_html(title, detail))

    def _empty_note_html(self, label: str, detail: str) -> str:
        return self._note_html(label, [detail], "note empty")

    def _note_html(self, label: str, lines: list[str], class_name: str) -> str:
        title = lines[0] if lines else "暂无内容"
        fields = [("详情", line) for line in lines[1:]]
        return self._card_html(label, title, fields, class_name.replace("note ", ""))

    def _card_html(self, label: str, title: str, fields: list[tuple[str, str]], tone: str) -> str:
        rows = []
        for key, value in fields:
            safe_value = escape(value).replace("\n", "<br>")
            rows.append(
                "<div class='fieldRow'>"
                f"<span class='fieldKey'>{escape(key)}</span>"
                f"<span class='fieldValue'>{safe_value}</span>"
                "</div>"
            )
        rows_html = "".join(rows) if rows else "<div class='fieldRow'><span class='fieldValue'>暂无更多信息</span></div>"
        return (
            f"<div class='itemCard {escape(tone)}'>"
            "<div class='cardTop'>"
            f"<span class='cardBadge'>{escape(label)}</span>"
            "</div>"
            f"<div class='cardTitle'>{escape(title)}</div>"
            f"<div class='cardFields'>{rows_html}</div>"
            "</div>"
        )


STYLESHEET = """
QWidget {
    background: #f5ead3;
    color: #112033;
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    font-size: 13px;
}
QFrame#header {
    background: #fffaf0;
    border: 1px solid #dfcda9;
    border-radius: 8px;
}
QLabel#title {
    color: #26384d;
    font-size: 20px;
    font-weight: 800;
}
QLabel#subtitle {
    color: #6f5f45;
    font-size: 12px;
    font-weight: 650;
}
QLabel#statusChip {
    background: #237c67;
    border-radius: 11px;
    color: #ffffff;
    font-weight: 800;
    padding: 5px 10px;
}
QLabel#statusDetail {
    color: #766a56;
    line-height: 1.4;
    font-weight: 650;
}
QLabel#brandIcon {
    background: #ffffff;
    border: 1px solid #e0c99b;
    border-radius: 8px;
}
QFrame#noteNav {
    background: transparent;
    min-width: 128px;
    max-width: 128px;
}
QLabel#actionsLabel {
    color: #6f5f45;
    font-size: 11px;
    font-weight: 800;
    padding-top: 4px;
}
QFrame#panelActions {
    background: transparent;
}
QPushButton#viewButton {
    background: #fff4c7;
    border: 1px solid #dec58d;
    border-left: 5px solid #d99d22;
    border-radius: 6px;
    color: #5a4a2f;
    min-height: 44px;
    padding: 5px 8px;
    font-weight: 800;
    text-align: left;
}
QPushButton#viewButton:hover {
    background: #ffedac;
    border-color: #d99d22;
}
QPushButton#viewButton:checked {
    background: #ddf7f0;
    border-color: #21a382;
    border-left-color: #21a382;
    color: #153f35;
    font-weight: 800;
}
QPushButton#actionButton {
    background: #ffffff;
    border: 1px solid #dfcda9;
    border-radius: 6px;
    color: #344256;
    min-height: 34px;
    padding: 5px 7px;
    font-size: 12px;
    font-weight: 750;
    text-align: left;
}
QPushButton#actionButton:hover {
    background: #fff4c7;
    border-color: #d99d22;
}
QPushButton#actionButton:disabled {
    background: #eee5d5;
    color: #9a8a73;
}
QTextEdit#content {
    background: #fffaf0;
    border: 1px solid #dfcda9;
    border-radius: 8px;
    color: #1f2933;
    padding: 8px;
    selection-background-color: #21a382;
}
QLabel#footer {
    color: #6f5f45;
    font-size: 12px;
}
QPushButton#primaryButton {
    background: #26384d;
    border: 0;
    border-radius: 8px;
    color: #ffffff;
    min-width: 38px;
    max-width: 38px;
    min-height: 34px;
    padding: 4px;
}
QPushButton#primaryButton:hover {
    background: #3a5572;
}
"""
