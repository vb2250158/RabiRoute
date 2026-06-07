from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QGuiApplication
from PySide6.QtWidgets import QFrame, QGridLayout, QHBoxLayout, QLabel, QPushButton, QTextEdit, QVBoxLayout, QWidget

from .manager_client import ManagerSnapshot
from .role_context_repository import ContextEntry, RoleContextSnapshot
from .task_repository import TaskItem, TaskSnapshot


VIEW_LABELS = (
    ("current", "当前"),
    ("short_plan", "短期"),
    ("long_plan", "长期"),
    ("short_memory", "短记忆"),
    ("long_memory", "长记忆"),
    ("tasks", "任务"),
    ("status", "诊断"),
)


class TaskWindow(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("RabiRoute 任务面板")
        self.setWindowFlags(self.windowFlags() | Qt.WindowStaysOnTopHint)
        self.setMinimumSize(540, 580)
        self.resize(620, 680)
        self._positioned = False  # 首次显示时定位一次，之后记住位置

        self.active_view = "current"
        self.manager: ManagerSnapshot | None = None
        self.tasks: TaskSnapshot | None = None
        self.context: RoleContextSnapshot | None = None

        self.header = QFrame()
        self.header.setObjectName("header")
        self.title_label = QLabel("RabiRoute / Rabi")
        self.title_label.setObjectName("title")
        self.subtitle_label = QLabel("Rabi 桌面分诊面板 · 只读")
        self.subtitle_label.setObjectName("subtitle")
        self.status_chip = QLabel("加载中")
        self.status_chip.setObjectName("statusChip")
        self.status_detail = QLabel("正在读取 manager、当前航线和任务目录...")
        self.status_detail.setObjectName("statusDetail")
        self.status_detail.setWordWrap(True)

        title_block = QVBoxLayout()
        title_block.setSpacing(2)
        title_block.addWidget(self.title_label)
        title_block.addWidget(self.subtitle_label)

        header_top = QHBoxLayout()
        header_top.addLayout(title_block, 1)
        header_top.addWidget(self.status_chip, 0, Qt.AlignTop)

        header_layout = QVBoxLayout()
        header_layout.setContentsMargins(16, 14, 16, 14)
        header_layout.setSpacing(10)
        header_layout.addLayout(header_top)
        header_layout.addWidget(self.status_detail)
        self.header.setLayout(header_layout)

        self.view_buttons: dict[str, QPushButton] = {}
        tabs = QGridLayout()
        tabs.setHorizontalSpacing(8)
        tabs.setVerticalSpacing(8)
        for index, (view_key, label) in enumerate(VIEW_LABELS):
            button = QPushButton(label)
            button.setObjectName("viewButton")
            button.setCheckable(True)
            button.clicked.connect(lambda _checked=False, key=view_key: self.set_view(key))
            self.view_buttons[view_key] = button
            tabs.addWidget(button, index // 4, index % 4)

        self.content = QTextEdit()
        self.content.setObjectName("content")
        self.content.setReadOnly(True)
        self.content.setLineWrapMode(QTextEdit.WidgetWidth)
        self.footer_label = QLabel("只读面板：不会写入任务、记忆或路由配置")
        self.footer_label.setObjectName("footer")
        self.refresh_button = QPushButton("刷新")
        self.refresh_button.setObjectName("primaryButton")

        footer = QHBoxLayout()
        footer.addWidget(self.footer_label, 1)
        footer.addWidget(self.refresh_button)

        layout = QVBoxLayout()
        layout.setContentsMargins(14, 14, 14, 14)
        layout.setSpacing(12)
        layout.addWidget(self.header)
        layout.addLayout(tabs)
        layout.addWidget(self.content)
        layout.addLayout(footer)
        self.setLayout(layout)
        self.setStyleSheet(STYLESHEET)
        self._sync_buttons()

    def set_view(self, view_key: str) -> None:
        self.active_view = view_key
        self._sync_buttons()
        self._render_active_view()

    def render(self, manager: ManagerSnapshot, tasks: TaskSnapshot, context: RoleContextSnapshot) -> None:
        self.manager = manager
        self.tasks = tasks
        self.context = context

        gateway = manager.selected_gateway
        role_id = str(gateway.get("agentRoleId") or tasks.role_id) if gateway else tasks.role_id
        running = bool(gateway.get("running")) if gateway else False

        self.title_label.setText(f"RabiRoute / {role_id or tasks.role_id}")
        self.status_chip.setText(self._chip_text(manager.connected, running))
        self.status_detail.setText(
            f"Manager：{'已连接' if manager.connected else '离线'}　"
            f"Gateway：{'运行中' if running else '已停止'}\n"
            f"任务目录：{tasks.tasks_dir}"
        )
        self._render_active_view()

    def _render_active_view(self) -> None:
        if not self.manager or not self.tasks or not self.context:
            self.content.setPlainText("加载中...")
            return

        renderers = {
            "current": self._current_text,
            "short_plan": lambda: self._task_group_text("短期计划", self.tasks.short_term),
            "long_plan": lambda: self._task_group_text("长期计划", self.tasks.long_term),
            "short_memory": lambda: self._context_group_text("短期记忆", self.context.short_memory),
            "long_memory": lambda: self._context_group_text("长期记忆", self.context.long_memory),
            "tasks": self._all_tasks_text,
            "status": self._status_text,
        }
        self.content.setPlainText(renderers.get(self.active_view, self._current_text)())

    def _current_text(self) -> str:
        assert self.tasks is not None
        assert self.context is not None
        sections = ["当前计划 / 当前任务", "Rabi 会在这里放最近需要看住的消息包裹。", ""]
        if self.tasks.current:
            sections.append(self._task_list_text(self.tasks.current))
        else:
            sections.append("还没有找到正式的当前任务 JSON。")
            sections.append(f"任务目录：{self.tasks.tasks_dir}")

        if self.context.current_notes:
            sections.extend(
                [
                    "",
                    "运行态计划备注（只读补充）",
                    self._context_list_text(self.context.current_notes),
                ]
            )
        if self.tasks.message:
            sections.extend(["", self.tasks.message])
        return "\n".join(sections)

    def _all_tasks_text(self) -> str:
        assert self.tasks is not None
        if not self.tasks.all_tasks:
            return "\n".join(
                [
                    "任务",
                    "",
                    "还没有找到正式任务 JSON。",
                    f"任务目录：{self.tasks.tasks_dir}",
                    "",
                    "当前只读查找位置包括：",
                    "tasks/current.json",
                    "tasks/short-term.json",
                    "tasks/long-term.json",
                    "tasks/items/short-term/*.json",
                    "tasks/items/long-term/*.json",
                    "tasks/items/project-linked/*.json",
                ]
            )
        return "\n".join(["任务", "", self._task_list_text(self.tasks.all_tasks)])

    def _status_text(self) -> str:
        assert self.manager is not None
        assert self.tasks is not None
        assert self.context is not None
        gateway = self.manager.selected_gateway
        lines = [
            "诊断 / 路由状态",
            "",
            f"Manager：{'已连接' if self.manager.connected else '离线'}",
            f"Manager 地址：{self.manager.manager_url}",
        ]
        if self.manager.error:
            lines.append(f"Manager 错误：{self.manager.error}")
        if gateway:
            lines.extend(
                [
                    f"Gateway 人格：{gateway.get('agentRoleId', self.tasks.role_id)}",
                    f"Gateway 运行中：{bool(gateway.get('running'))}",
                ]
            )
        lines.extend(
            [
                f"人格目录：{self.tasks.role_dir}",
                f"任务目录：{self.tasks.tasks_dir}",
                f"路由状态目录：{self.context.route_dir}",
                "",
                "运行状态文件",
            ]
        )
        lines.extend(self.context.status_lines or ["没有找到可读取的路由状态文件。"])
        return "\n".join(lines)

    def _task_group_text(self, title: str, tasks: list[TaskItem]) -> str:
        assert self.tasks is not None
        if tasks:
            return "\n".join([title, "", self._task_list_text(tasks)])
        return "\n".join([title, "", "这个视图还没有正式任务 JSON。", f"任务目录：{self.tasks.tasks_dir}"])

    def _context_group_text(self, title: str, entries: list[ContextEntry]) -> str:
        assert self.context is not None
        if entries:
            return "\n".join([title, "", self._context_list_text(entries)])
        return "\n".join([title, "", "这个视图还没有可读取的记忆摘要。", f"人格目录：{self.context.role_dir}"])

    def _task_list_text(self, tasks: list[TaskItem]) -> str:
        return "\n\n".join(self._task_text(index, task) for index, task in enumerate(tasks, start=1))

    def _task_text(self, index: int, task: TaskItem) -> str:
        lines = [f"{index}. {task.title}", f"   状态：{task.status}"]
        if task.priority:
            lines.append(f"   优先级：{task.priority}")
        if task.task_type:
            lines.append(f"   类型：{task.task_type}")
        if task.current_step:
            lines.append(f"   当前步骤：{task.current_step}")
        if task.next_action:
            lines.append(f"   下一步：{task.next_action}")
        if task.project_name or task.project_path:
            lines.append(f"   项目：{task.project_name or task.project_path}")
        if task.source:
            lines.append(f"   来源：{task.source}")
        if task.updated_at:
            lines.append(f"   更新时间：{task.updated_at}")
        if task.path:
            lines.append(f"   文件：{task.path}")
        return "\n".join(lines)

    def _context_list_text(self, entries: list[ContextEntry]) -> str:
        blocks: list[str] = []
        for index, entry in enumerate(entries, start=1):
            lines = [f"{index}. {entry.title}"]
            if entry.detail:
                lines.append(f"   {entry.detail.replace(chr(10), chr(10) + '   ')}")
            if entry.source:
                lines.append(f"   来源：{entry.source}")
            if entry.path:
                lines.append(f"   文件：{entry.path}")
            blocks.append("\n".join(lines))
        return "\n\n".join(blocks)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self._positioned:
            self._snap_to_edge()
            self._positioned = True

    def _snap_to_edge(self) -> None:
        """首次显示时贴右边缘；若放不下则贴左边缘。之后不再自动移动。"""
        screen = QGuiApplication.primaryScreen()
        if not screen:
            return
        avail = screen.availableGeometry()
        w = self.frameGeometry().width()
        h = self.frameGeometry().height()
        margin = 16
        # 优先贴右边
        x = avail.right() - w - margin
        if x < avail.left():
            x = avail.left() + margin
        # 垂直：靠下但留 margin，防止超出
        y = avail.bottom() - h - margin
        if y < avail.top():
            y = avail.top() + margin
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


STYLESHEET = """
QWidget {
    background: #eef6f8;
    color: #112033;
    font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif;
    font-size: 13px;
}
QFrame#header {
    background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 #ffffff, stop:0.62 #effdff, stop:1 #fff7fb);
    border: 1px solid #c7eef0;
    border-radius: 10px;
}
QLabel#title {
    color: #0c2a4a;
    font-size: 22px;
    font-weight: 800;
}
QLabel#subtitle {
    color: #667586;
    font-size: 12px;
    font-weight: 650;
}
QLabel#statusChip {
    background: #19bfc1;
    border-radius: 12px;
    color: #ffffff;
    font-weight: 800;
    padding: 5px 12px;
}
QLabel#statusDetail {
    color: #54677a;
    line-height: 1.4;
    font-weight: 650;
}
QPushButton#viewButton {
    background: #ffffff;
    border: 1px solid #cfdbe4;
    border-radius: 8px;
    color: #4c5e70;
    min-height: 32px;
    padding: 6px 10px;
    font-weight: 700;
}
QPushButton#viewButton:hover {
    background: #f2fbfc;
    border-color: #19bfc1;
}
QPushButton#viewButton:checked {
    background: #0c2a4a;
    border-color: #0c2a4a;
    color: #ffffff;
    font-weight: 800;
}
QTextEdit#content {
    background: #ffffff;
    border: 1px solid #cfdbe4;
    border-radius: 8px;
    color: #112033;
    padding: 12px;
    selection-background-color: #19bfc1;
}
QLabel#footer {
    color: #667586;
    font-size: 12px;
}
QPushButton#primaryButton {
    background: #0c2a4a;
    border: 0;
    border-radius: 8px;
    color: #ffffff;
    font-weight: 800;
    min-width: 82px;
    min-height: 32px;
    padding: 6px 14px;
}
QPushButton#primaryButton:hover {
    background: #16466e;
}
"""
