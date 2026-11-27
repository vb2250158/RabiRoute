from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QEvent, QPoint, QSignalBlocker, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QBrush, QIcon, QPainter, QPalette, QPixmap
from PySide6.QtWidgets import (
    QApplication, QDialog, QFrame, QHBoxLayout, QLineEdit, QListWidget, QListWidgetItem, QStyle, QWidget,
)

from .manager_client import ManagerClient
from .qt_async import start_qt_task
from .system_selection import SelectionDeliveryTarget

NEW_SESSION = "__new_session__"


class ScreenshotTargetPicker(QLineEdit):
    """Three-stage delivery target: Agent end, its task list (new session first), then a project."""

    selection_changed = Signal()
    _DATA = Qt.ItemDataRole.UserRole

    def __init__(self, dialog: QDialog, targets: list[SelectionDeliveryTarget], manager: ManagerClient | None):
        super().__init__(dialog)
        self.setAccessibleName("投递至")
        self._manager = manager
        self._roles = targets
        self._agents = {}
        self._icons = {}
        self._icons_loading = set()
        self._avatars = {}
        self._selected_role = None
        self.selection: dict[str, str] | None = None
        self._label = ""
        self._provider = ""
        self._project = ""
        self._creating = False
        self._projects: dict[str, list[str]] = {}
        self._projects_loading = False
        self._projects_failed = False
        self._request = None
        self._next_offset = None
        self._timer = QTimer(self, singleShot=True, interval=180)
        self._timer.timeout.connect(self._load_threads)

        self._panel = QFrame(dialog)
        self._panel.setAutoFillBackground(True)
        self._panel.setFrameShape(QFrame.Shape.StyledPanel)
        self._panel.hide()
        panes = QHBoxLayout(self._panel)
        panes.setContentsMargins(1, 1, 1, 1)
        panes.setSpacing(0)
        self._channels = QListWidget(self._panel)
        self._channels.setAccessibleName("投递渠道")
        self._channels.setIconSize(QSize(20, 20))
        self._channels.setMouseTracking(True)
        self._channels.itemEntered.connect(self._channels.setCurrentItem)
        self._channels.currentItemChanged.connect(self._preview_channel)
        self._channels.itemClicked.connect(self._choose_channel)
        panes.addWidget(self._channels, 2)
        self._threads = QListWidget(self._panel)
        self._threads.setAccessibleName("渠道对话")
        self._threads.itemClicked.connect(self._choose_thread)
        panes.addWidget(self._threads, 3)
        self._projects_view = QListWidget(self._panel)
        self._projects_view.setAccessibleName("新建会话项目")
        self._projects_view.itemClicked.connect(self._choose_project)
        panes.addWidget(self._projects_view, 2)

        self._chosen_icon = self.addAction(QIcon(), QLineEdit.ActionPosition.LeadingPosition)
        self._chosen_icon.setVisible(False)
        arrow = self.addAction(
            self.style().standardIcon(QStyle.StandardPixmap.SP_ArrowDown),
            QLineEdit.ActionPosition.TrailingPosition,
        )
        arrow.setText("展开投递目标")
        arrow.triggered.connect(self._toggle_panel)
        self.setPlaceholderText("选择或搜索投递目标…")
        self.textEdited.connect(self._search)
        self.installEventFilter(self)
        if manager is None and targets:
            self._set_role(targets[0])

    def load_agents(self, agents, remembered) -> bool:
        self._agents = {agent["provider"]: agent["label"] for agent in agents}
        if self._panel.isVisible():
            self._search(self.text())
        if self.selection or not isinstance(remembered, dict):
            return True
        if remembered.get("kind") == "role":
            role = next((role for role in self._roles if role.gateway_id == remembered.get("gatewayId")), None)
            if role:
                self._set_role(role)
                return True
        provider, thread_id = remembered.get("provider"), remembered.get("threadId")
        if remembered.get("kind") == "agent" and provider in self._agents and thread_id:
            self._set_thread(provider, {"id": thread_id, "cwd": remembered.get("cwd", "")})
            if not self._panel.isVisible():
                self._provider = provider
                self._load_threads()
            return True
        return False

    def _icon(self, provider="") -> QIcon:
        if provider not in self._icons:
            fallback = QStyle.StandardPixmap.SP_ComputerIcon if provider else QStyle.StandardPixmap.SP_DirHomeIcon
            icon = self.style().standardIcon(fallback)
            if provider and provider.replace("-", "").replace("_", "").isalnum():
                module = Path(__file__).resolve()
                bundled = module.parent / "assets" / "agent-icons"
                source = module.parents[3] / "src" / "plugins" / f"io.rabiroute.agent.{provider}" / "web" / "assets"
                for directory in (bundled, source):
                    for extension in (".png", ".svg", ".ico", ".jpg"):
                        candidate = directory / f"{provider}{extension}"
                        if candidate.is_file():
                            asset = QIcon(str(candidate))
                            if not asset.pixmap(QSize(20, 20)).isNull():
                                self._icons[provider] = asset
                                return asset
            self._icons[provider] = icon
        return self._icons[provider]

    def _role_icon(self, role) -> QIcon:
        """A role target shows its own avatar; the first character of the name stands in until it loads."""
        role_id = getattr(role, "role_id", "") or ""
        if not role_id:
            return self._role_initial_icon(getattr(role, "label", ""))
        if role_id in self._avatars:
            return self._avatars[role_id] or self._role_initial_icon(role.label)
        if self._manager is not None and role_id not in self._icons_loading:
            self._icons_loading.add(role_id)

            def loaded(_task, result):
                self._icons_loading.discard(role_id)
                if isinstance(result, Exception) or not result:
                    self._avatars[role_id] = QIcon()
                    return
                pixmap = QPixmap()
                if not pixmap.loadFromData(result) or pixmap.isNull():
                    self._avatars[role_id] = QIcon()
                    return
                self._avatars[role_id] = QIcon(pixmap.scaled(
                    20, 20, Qt.AspectRatioMode.KeepAspectRatioByExpanding, Qt.TransformationMode.SmoothTransformation))
                if self._panel.isVisible():
                    self._refresh_role_icons()

            start_qt_task(lambda: self._manager.role_avatar(role_id), loaded)
        return self._role_initial_icon(role.label)

    def _role_initial_icon(self, label: str) -> QIcon:
        cached = self._icons.get("role-initial:" + label)
        if cached is not None:
            return cached
        pixmap = QPixmap(20, 20)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        palette = self.palette()
        painter.setBrush(QBrush(palette.color(QPalette.ColorRole.Mid)))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(0, 0, 20, 20)
        painter.setPen(palette.color(QPalette.ColorRole.Text))
        font = painter.font()
        font.setPointSizeF(9)
        painter.setFont(font)
        painter.drawText(pixmap.rect(), Qt.AlignmentFlag.AlignCenter, (label or "R").strip()[:1].upper())
        painter.end()
        icon = QIcon(pixmap)
        self._icons["role-initial:" + label] = icon
        return icon

    def _refresh_role_icons(self):
        for row in range(self._channels.count()):
            item = self._channels.item(row)
            role = item.data(self._DATA)
            if isinstance(role, SelectionDeliveryTarget):
                item.setIcon(self._role_icon(role))

    def _set_role(self, role):
        self._selected_role = role
        self.selection = {"kind": "role", "gatewayId": role.gateway_id}
        self._label = role.label
        self._show_selection()

    def _set_thread(self, provider, thread):
        self._selected_role = None
        self.selection = {"kind": "agent", "provider": provider, "threadId": thread["id"], "cwd": thread.get("cwd") or ""}
        self._label = f"{self._agents[provider]} · {thread.get('title') or thread['id']}"
        self._show_selection()

    def _set_new_session(self, provider, project):
        """A new session is addressed by Agent end plus project; the ID only exists after creation."""
        self._selected_role = None
        self.selection = {"kind": "new", "provider": provider, "cwd": project}
        self._label = f"{self._agents[provider]} · 新建会话 · {Path(project).name or project}"
        self._show_selection()

    def _show_selection(self):
        if self._panel.isVisible():
            return
        self.setText(self._label)
        if self.selection:
            role = self._selected_role if self.selection.get("kind") == "role" else None
            self._chosen_icon.setIcon(self._role_icon(role) if role is not None
                                      else self._icon(self.selection.get("provider", "")))
        self._chosen_icon.setVisible(self.selection is not None)

    def _toggle_panel(self):
        if self._panel.isVisible():
            self.dismiss()
        else:
            self.setFocus()
            self._open_panel()

    def _open_panel(self):
        if self._panel.isVisible():
            return
        self.clear()
        self._chosen_icon.setVisible(False)
        self.setPlaceholderText("搜索角色、对话名称或工作目录…")
        self._provider = (self.selection or {}).get("provider", "")
        self._project = ""
        self._position_panel()
        self._panel.show()
        self._panel.raise_()
        QApplication.instance().installEventFilter(self)
        self._search("")

    def dismiss(self):
        self._timer.stop()
        self._request = None
        self._creating = False
        if self._panel.isVisible():
            self._panel.hide()
        QApplication.instance().removeEventFilter(self)
        self.setPlaceholderText("选择或搜索投递目标…")
        self._show_selection()

    def _position_panel(self):
        dialog = self.parentWidget()
        top = self.mapTo(dialog, QPoint(0, 0))
        below = dialog.height() - top.y() - self.height() - 8
        above = top.y() - 8
        open_below = below >= 180 or below >= above
        height = min(255, below if open_below else above)
        y = top.y() + self.height() if open_below else top.y() - height
        channel_width = min(self.width(), max(230, self.width() * 2 // 5))
        self._channels.setFixedWidth(channel_width - 2)
        width = self.width() if self._provider else channel_width
        if self._project or self._projects_loading or self._projects_failed:
            width = self.width() if self._provider else channel_width
        self._panel.setGeometry(top.x(), y, width, height)
        self._size_columns(channel_width)

    def _size_columns(self, channel_width: int):
        total = self._panel.width()
        remaining = max(0, total - channel_width)
        visible = [widget for widget in (self._threads, self._projects_view) if widget.isVisible()]
        if not visible:
            return
        share = remaining // len(visible)
        for widget in (self._threads, self._projects_view):
            widget.setFixedWidth(share if widget.isVisible() else 0)

    def resizeEvent(self, event):
        super().resizeEvent(event)
        if self._panel.isVisible():
            self._position_panel()

    def focusInEvent(self, event):
        super().focusInEvent(event)
        if event.reason() in (Qt.FocusReason.TabFocusReason, Qt.FocusReason.BacktabFocusReason):
            self.selectAll()

    def eventFilter(self, watched, event):
        event_type = event.type()
        if event_type == QEvent.Type.WindowDeactivate and watched is self.parentWidget():
            self.dismiss()
        if event_type == QEvent.Type.MouseButtonPress:
            if watched is self and event.button() == Qt.MouseButton.LeftButton:
                self._open_panel()
            elif self._panel.isVisible() and isinstance(watched, QWidget) and watched not in (self, self._panel) and (
                not self.isAncestorOf(watched) and not self._panel.isAncestorOf(watched)
            ):
                self.dismiss()
        if event_type != QEvent.Type.KeyPress or watched not in (self, self._channels, self._threads, self._projects_view):
            return False
        key = event.key()
        if not self._panel.isVisible():
            if watched is self and key in (Qt.Key.Key_Down, Qt.Key.Key_Return, Qt.Key.Key_Enter):
                self._open_panel()
                return True
            return False
        if key == Qt.Key.Key_Escape:
            self.dismiss()
            self.setFocus()
            return True
        if key in (Qt.Key.Key_Tab, Qt.Key.Key_Backtab):
            self.dismiss()
            self.setFocus()
            return False
        if watched is self and key == Qt.Key.Key_Down:
            items = self._threads if self.text().strip() and self._provider else self._channels
            if items.currentRow() < 0:
                items.setCurrentRow(self._first_selectable_row(items))
            items.setFocus()
            return True
        if watched is self and key in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            return True
        if watched is self._channels:
            if key == Qt.Key.Key_Right and self._provider:
                self._threads.setCurrentRow(self._first_selectable_row(self._threads))
                self._threads.setFocus()
                return True
            if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and watched.currentItem():
                self._choose_channel(watched.currentItem())
                return True
        if watched is self._threads:
            if key == Qt.Key.Key_Left:
                self._channels.setFocus()
                return True
            if key == Qt.Key.Key_Right and self._project_visible():
                self._projects_view.setCurrentRow(self._first_selectable_row(self._projects_view))
                self._projects_view.setFocus()
                return True
            if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and watched.currentItem():
                self._choose_thread(watched.currentItem())
                return True
        if watched is self._projects_view:
            if key == Qt.Key.Key_Left:
                self._threads.setFocus()
                return True
            if key in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and watched.currentItem():
                self._choose_project(watched.currentItem())
                return True
        return False

    def _search(self, query):
        if not self._panel.isVisible():
            # Typing with keyboard focus also opens the selector.
            self._open_panel()
            self.setText(query)
        term = query.strip().casefold()
        if term and not self._provider:
            self._provider = next(iter(self._agents), "")
        with QSignalBlocker(self._channels):
            self._channels.clear()
            for role in self._roles:
                if term in role.label.casefold():
                    self._add_item(self._channels, role.label, role, self._role_icon(role))
            for provider, label in self._agents.items():
                item = self._add_item(self._channels, f"{label}  ›", provider, self._icon(provider))
                if provider == self._provider:
                    self._channels.setCurrentItem(item)
            if not self._channels.count():
                self._add_item(self._channels, "暂无投递目标")
        self._update_threads()

    def _preview_channel(self, item):
        if item is None:
            return
        provider = item.data(self._DATA)
        provider = provider if isinstance(provider, str) else ""
        if provider != self._provider:
            self._provider = provider
            self._project = ""
            self._update_threads()

    def _choose_channel(self, item):
        value = item.data(self._DATA)
        if isinstance(value, SelectionDeliveryTarget):
            self._set_role(value)
            self._confirm()
        else:
            self._channels.setCurrentItem(item)

    def _choose_thread(self, item):
        value = item.data(self._DATA)
        if value == "more":
            self._load_threads(offset=self._next_offset)
        elif value == "retry":
            self._load_threads()
        elif value == NEW_SESSION:
            self._open_projects()
        elif isinstance(value, dict):
            self._set_thread(self._provider, value)
            self._confirm()

    def _choose_project(self, item):
        value = item.data(self._DATA)
        if value == "retry":
            self._load_projects(force=True)
        elif isinstance(value, str) and value and self._provider:
            self._set_new_session(self._provider, value)
            self._confirm()

    def _confirm(self):
        self.dismiss()
        self.setFocus()
        self.selection_changed.emit()

    def _add_item(self, view, text, value=None, icon=None):
        item = QListWidgetItem(text)
        item.setData(self._DATA, value)
        item.setToolTip(text)
        item.setSizeHint(QSize(0, 29))
        if icon is not None:
            item.setIcon(icon)
        if value is None:
            item.setFlags(Qt.ItemFlag.NoItemFlags)
        view.addItem(item)
        return item

    def _first_selectable_row(self, view) -> int:
        """Skip read-only rows such as a status notice so arrow keys land on a real target."""
        for row in range(view.count()):
            item = view.item(row)
            if item.flags() != Qt.ItemFlag.NoItemFlags:
                return row
        return 0

    def _project_visible(self) -> bool:
        return bool(self._projects_view.isVisible() and self._projects_view.count())

    def _update_threads(self):
        self._request = None
        self._timer.stop()
        self._threads.clear()
        self._projects_view.clear()
        self._projects_view.setVisible(False)
        self._threads.setVisible(bool(self._provider))
        if self._panel.isVisible():
            self._position_panel()
        if not self._provider:
            return
        self._add_item(self._threads, "＋ 新建会话", NEW_SESSION)
        self._add_item(self._threads, "正在读取对话…")
        self._timer.start()

    def _load_threads(self, offset=0):
        if not self._manager or not self._provider:
            return
        provider, query = self._provider, self.text().strip() if self._panel.isVisible() else ""
        offset = offset or 0
        request = self._request = object()
        if offset and self._threads.count():
            self._threads.takeItem(self._threads.count() - 1)
            self._add_item(self._threads, "正在读取更多对话…")

        def loaded(_task, result):
            if request is not self._request:
                return
            if offset and self._threads.count():
                self._threads.takeItem(self._threads.count() - 1)
            else:
                self._threads.clear()
                self._add_item(self._threads, "＋ 新建会话", NEW_SESSION)
            if isinstance(result, Exception) or result.get("code") == -1:
                self._add_item(self._threads, "读取对话失败，点击重试", "more" if offset else "retry")
                return
            for thread in result.get("threads", []):
                if not isinstance(thread, dict) or thread.get("archived") or not thread.get("id"):
                    continue
                label = thread.get("title") or thread["id"]
                if thread.get("cwd"):
                    label = f"{label} · {thread['cwd']}"
                self._add_item(self._threads, label, thread)
                if (self.selection or {}).get("provider") == provider and self.selection.get("threadId") == thread["id"]:
                    self._set_thread(provider, thread)
            self._next_offset = result.get("nextOffset")
            if self._next_offset is not None:
                self._add_item(self._threads, "加载更多", "more")
            elif self._threads.count() <= 1:
                self._add_item(self._threads, "没有匹配的对话" if query else "暂无对话")

        start_qt_task(lambda: self._manager.screenshot_threads(provider, query, offset), loaded)

    def _open_projects(self):
        """The third stage appears beside the task list once 新建会话 is chosen."""
        if not self._provider:
            return
        self._project = ""
        self._projects_view.clear()
        self._projects_view.setVisible(True)
        self._add_item(self._projects_view, "正在读取项目…")
        self._size_columns(min(self.width(), max(230, self.width() * 2 // 5)))
        self._load_projects()

    def _load_projects(self, force: bool = False):
        if not self._manager or not self._provider:
            return
        provider = self._provider
        cached = self._projects.get(provider)
        if cached and not force:
            self._render_projects(cached)
            return
        if self._projects_loading:
            return
        self._projects_loading = True

        def loaded(_task, result):
            self._projects_loading = False
            if provider != self._provider:
                return
            if isinstance(result, Exception):
                self._projects_failed = True
                self._projects_view.clear()
                self._add_item(self._projects_view, "读取项目失败，点击重试", "retry")
                return
            self._projects_failed = False
            self._projects[provider] = result
            self._render_projects(result)

        start_qt_task(lambda: self._manager.screenshot_projects(provider), loaded)

    def _render_projects(self, projects: list[str]):
        self._projects_view.clear()
        for project in projects:
            label = f"{Path(project).name or project} · {project}"
            item = self._add_item(self._projects_view, label, project)
            item.setToolTip(project)
        if not projects:
            self._add_item(self._projects_view, "该 Agent 端没有可用的项目目录")
        if self._panel.isVisible():
            self._position_panel()
