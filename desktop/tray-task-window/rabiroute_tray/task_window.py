from __future__ import annotations

from datetime import datetime
from pathlib import Path

from PySide6.QtCore import QPoint, Qt, QTimer, Signal
from PySide6.QtGui import QFont, QIcon, QKeyEvent, QMouseEvent
from PySide6.QtWidgets import (
    QApplication,
    QFileDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMenu,
    QProgressBar,
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
from .task_repository import PlanItem, PlanSnapshot, PlanStep


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

PLAN_PRIORITY_LABELS = {"low": "低", "medium": "中", "high": "高"}
PLAN_KIND_LABELS = {"human-gate": "需人工接管"}

PLAN_STEP_DONE_STATUSES = {"已完成", "完成", "done", "completed"}
PLAN_STEP_CURRENT_STATUSES = {"进行中", "当前", "current", "in_progress", "in-progress"}

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


class MessageComposer(QTextEdit):
    send_requested = Signal()
    MIN_HEIGHT = 48
    MAX_HEIGHT = 120

    def __init__(self) -> None:
        super().__init__()
        self.setAcceptRichText(False)
        self.document().contentsChanged.connect(self._sync_height)
        QTimer.singleShot(0, self._sync_height)

    def keyPressEvent(self, event: QKeyEvent) -> None:
        if event.key() in (Qt.Key_Return, Qt.Key_Enter) and not event.modifiers() & Qt.ShiftModifier:
            self.send_requested.emit()
            event.accept()
            return
        super().keyPressEvent(event)

    def _sync_height(self) -> None:
        document_height = int(self.document().documentLayout().documentSize().height())
        target = min(self.MAX_HEIGHT, max(self.MIN_HEIGHT, document_height + 18))
        self.setFixedHeight(target)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded if target == self.MAX_HEIGHT else Qt.ScrollBarAlwaysOff)


class KeywordPanel(QFrame):
    OVERFLOW_INDICATOR = "……"

    def __init__(self, keywords: list[str]) -> None:
        super().__init__()
        self.setObjectName("keywordPanel")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        self._keywords = [keyword for keyword in keywords if keyword.strip()]
        self._expanded = False
        self.visible_keyword_count = 0

        self.summary_line = QFrame()
        self.summary_line.setObjectName("keywordSummaryLine")
        summary_layout = QHBoxLayout()
        summary_layout.setContentsMargins(20, 0, 0, 0)
        summary_layout.setSpacing(7)
        summary_label = QLabel("触发关键字")
        summary_label.setObjectName("keywordLabel")
        self.summary_label = QLabel()
        self.summary_label.setObjectName("keywordSummary")
        self.summary_label.setMinimumWidth(0)
        self.summary_label.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.summary_label.setToolTip("、".join(self._keywords) if self._keywords else "未配置")
        summary_layout.addWidget(summary_label, 0, Qt.AlignVCenter)
        summary_layout.addWidget(self.summary_label, 1, Qt.AlignVCenter)
        self.summary_line.setLayout(summary_layout)

        self.expanded_panel = QFrame()
        self.expanded_panel.setObjectName("keywordExpandedPanel")
        self.expanded_panel.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        expanded_layout = QGridLayout()
        expanded_layout.setContentsMargins(20, 0, 0, 0)
        expanded_layout.setHorizontalSpacing(7)
        expanded_layout.setVerticalSpacing(0)
        expanded_label = QLabel("触发关键字")
        expanded_label.setObjectName("keywordLabel")
        expanded_layout.addWidget(expanded_label, 0, 0, Qt.AlignTop)
        self.expanded_values = QLabel("  ·  ".join(self._keywords) if self._keywords else "未配置")
        self.expanded_values.setObjectName("keywordExpandedValues")
        self.expanded_values.setProperty("empty", not self._keywords)
        self.expanded_values.setWordWrap(True)
        self.expanded_values.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        self.expanded_values.setTextInteractionFlags(Qt.TextSelectableByMouse)
        expanded_layout.addWidget(self.expanded_values, 0, 1, Qt.AlignTop)
        expanded_layout.setColumnStretch(1, 1)
        self.expanded_panel.setLayout(expanded_layout)

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self.summary_line)
        layout.addWidget(self.expanded_panel)
        self.setLayout(layout)
        self.set_expanded(False)

    def set_expanded(self, expanded: bool) -> None:
        self._expanded = expanded
        self.summary_line.setVisible(not expanded)
        self.expanded_panel.setVisible(expanded)
        if not expanded:
            QTimer.singleShot(0, self._refresh_summary)

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if not self._expanded:
            QTimer.singleShot(0, self._refresh_summary)

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if not self._expanded:
            QTimer.singleShot(0, self._refresh_summary)

    def _refresh_summary(self) -> None:
        text, visible_count = self._summary_for_width(self.summary_label.width())
        self.visible_keyword_count = visible_count
        self.summary_label.setText(text)

    def _summary_for_width(self, width: int) -> tuple[str, int]:
        if not self._keywords:
            return "未配置", 0
        separator = "  ·  "
        metrics = self.summary_label.fontMetrics()
        for visible_count in range(len(self._keywords), -1, -1):
            visible = separator.join(self._keywords[:visible_count])
            hidden_count = len(self._keywords) - visible_count
            suffix = self.OVERFLOW_INDICATOR if hidden_count else ""
            candidate = separator.join(part for part in (visible, suffix) if part)
            if metrics.horizontalAdvance(candidate) <= max(0, width):
                return candidate, visible_count
        return self.OVERFLOW_INDICATOR, 0


class PlanMetadataPanel(QFrame):
    PRIMARY_KEYS = ("优先级", "类型", "项目", "截止时间", "更新时间")

    def __init__(self, fields: list[tuple[str, str]]) -> None:
        super().__init__()
        self.setObjectName("planMetadataPanel")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        layout = QVBoxLayout()
        layout.setContentsMargins(0, 1, 0, 0)
        layout.setSpacing(6)

        primary = [(key, value) for key, value in fields if key in self.PRIMARY_KEYS]
        secondary = [(key, value) for key, value in fields if key not in self.PRIMARY_KEYS]
        if primary:
            summary = QLabel("  ·  ".join(f"{key}：{value}" for key, value in primary))
            summary.setObjectName("planMetadataSummary")
            summary.setMinimumWidth(0)
            summary.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Maximum)
            summary.setMaximumHeight(44)
            summary.setWordWrap(True)
            summary.setTextInteractionFlags(Qt.TextSelectableByMouse)
            layout.addWidget(summary)

        self.details = QFrame()
        self.details.setObjectName("planMetadataDetails")
        details_layout = QGridLayout()
        details_layout.setContentsMargins(0, 0, 0, 0)
        details_layout.setHorizontalSpacing(12)
        details_layout.setVerticalSpacing(6)
        for index, (key, value) in enumerate(secondary):
            details_layout.addWidget(self._metadata_widget(key, value), index // 2, index % 2)
        details_layout.setColumnStretch(0, 1)
        details_layout.setColumnStretch(1, 1)
        self.details.setLayout(details_layout)
        self.details.setVisible(False)

        if secondary:
            self.toggle_button = QPushButton("查看计划资料")
            self.toggle_button.setObjectName("planMetadataToggle")
            self.toggle_button.setCheckable(True)
            self.toggle_button.setAccessibleName("查看或收起计划资料")
            self.toggle_button.toggled.connect(self._set_details_visible)
            layout.addWidget(self.toggle_button)
            layout.addWidget(self.details)
        else:
            self.toggle_button = None
        self.setLayout(layout)

    def _set_details_visible(self, visible: bool) -> None:
        self.details.setVisible(visible)
        if self.toggle_button is not None:
            self.toggle_button.setText("收起计划资料" if visible else "查看计划资料")

    def _metadata_widget(self, key: str, value: str) -> QFrame:
        row = QFrame()
        row.setObjectName("planMetadataItem")
        row_layout = QVBoxLayout()
        row_layout.setContentsMargins(0, 0, 0, 0)
        row_layout.setSpacing(2)
        key_label = QLabel(key)
        key_label.setObjectName("fieldKey")
        value_label = QLabel(value)
        value_label.setObjectName("fieldValue")
        value_label.setWordWrap(True)
        value_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        row_layout.addWidget(key_label)
        row_layout.addWidget(value_label)
        row.setLayout(row_layout)
        return row


class PlanDetailPanel(QFrame):
    def __init__(self, plan: PlanItem, metadata_fields: list[tuple[str, str]]) -> None:
        super().__init__()
        self.setObjectName("planDetailPanel")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        self.plan = plan

        layout = QVBoxLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        if plan.steps:
            layout.addWidget(self._progress_panel())
            blocker = _plan_blocker(plan)
            if blocker:
                layout.addWidget(self._summary_block("阻塞原因", blocker, "blocked"))
        else:
            layout.addWidget(
                self._summary_block(
                    "计划尚未拆分步骤",
                    "这条旧计划没有 steps 数据，无法展示全部步骤和准确执行位置。",
                    "warning",
                )
            )
            legacy_summary = QFrame()
            legacy_summary.setObjectName("planActionSummary")
            legacy_layout = QGridLayout()
            legacy_layout.setContentsMargins(0, 0, 0, 0)
            legacy_layout.setHorizontalSpacing(10)
            legacy_layout.setVerticalSpacing(8)
            legacy_layout.addWidget(
                self._summary_block("●  旧版当前进展", plan.current_step or "暂未填写当前进展", "current"), 0, 0
            )
            legacy_blocker = _plan_blocker(plan)
            legacy_layout.addWidget(
                self._summary_block("阻塞原因", legacy_blocker, "blocked")
                if legacy_blocker
                else self._summary_block("➜  下一步行动", plan.next_action or "暂未填写下一步行动", "next"),
                0,
                1,
            )
            legacy_layout.setColumnStretch(0, 1)
            legacy_layout.setColumnStretch(1, 1)
            legacy_summary.setLayout(legacy_layout)
            layout.addWidget(legacy_summary)

        if metadata_fields:
            layout.addWidget(PlanMetadataPanel(metadata_fields))

        self.setLayout(layout)

    def _summary_block(self, label: str, value: str, tone: str) -> QFrame:
        block = QFrame()
        block.setObjectName("planSummaryBlock")
        block.setProperty("summaryTone", tone)
        block.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        block_layout = QVBoxLayout()
        block_layout.setContentsMargins(11, 10, 11, 10)
        block_layout.setSpacing(5)
        label_widget = QLabel(label)
        label_widget.setObjectName("planSummaryLabel")
        label_widget.setProperty("summaryTone", tone)
        value_widget = QLabel(value)
        value_widget.setObjectName("planSummaryValue")
        value_widget.setMinimumWidth(0)
        value_widget.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Maximum)
        value_widget.setWordWrap(True)
        value_widget.setTextInteractionFlags(Qt.TextSelectableByMouse)
        block_layout.addWidget(label_widget)
        block_layout.addWidget(value_widget)
        block.setLayout(block_layout)
        return block

    def _progress_panel(self) -> QFrame:
        panel = QFrame()
        panel.setObjectName("planProgressPanel")
        panel_layout = QVBoxLayout()
        panel_layout.setContentsMargins(0, 2, 0, 0)
        panel_layout.setSpacing(7)

        completed_count = sum(1 for step in self.plan.steps if _plan_step_tone(step) == "done")
        total_count = len(self.plan.steps)
        percentage = round(completed_count * 100 / total_count) if total_count else 0

        current_index, current_step = self._current_step()
        blocker = _plan_blocker(self.plan)
        current_text = (
            f"当前阻塞：第 {current_index} 步 · {current_step.title}"
            if current_step is not None and blocker
            else f"当前执行：第 {current_index} 步 · {current_step.title}"
            if current_step is not None
            else "当前没有正在执行的步骤"
        )
        current_callout = QLabel(current_text)
        current_callout.setObjectName("planCurrentStepCallout")
        current_callout.setProperty("hasCurrentStep", current_step is not None)
        current_callout.setProperty("blocked", bool(blocker))
        current_callout.setWordWrap(True)
        current_callout.setAccessibleName(current_text)
        panel_layout.addWidget(current_callout)

        heading_row = QHBoxLayout()
        heading_row.setContentsMargins(0, 0, 0, 0)
        heading = QLabel(f"全部步骤（已完成 {completed_count} / {total_count}）")
        heading.setObjectName("planProgressTitle")
        percentage_label = QLabel(f"{percentage}%")
        percentage_label.setObjectName("planProgressPercent")
        heading_row.addWidget(heading)
        heading_row.addStretch(1)
        heading_row.addWidget(percentage_label)
        panel_layout.addLayout(heading_row)

        progress = QProgressBar()
        progress.setObjectName("planProgressBar")
        progress.setRange(0, max(1, total_count))
        progress.setValue(completed_count)
        progress.setTextVisible(False)
        progress.setFixedHeight(8)
        panel_layout.addWidget(progress)

        self.steps_container = QFrame()
        self.steps_container.setObjectName("planStepsContainer")
        self.steps_layout = QVBoxLayout()
        self.steps_layout.setContentsMargins(0, 2, 0, 0)
        self.steps_layout.setSpacing(3)
        self.steps_container.setLayout(self.steps_layout)
        panel_layout.addWidget(self.steps_container)

        panel.setLayout(panel_layout)
        self._render_steps()
        return panel

    def _current_step(self) -> tuple[int, PlanStep | None]:
        return _plan_current_step(self.plan)

    def _render_steps(self) -> None:
        while self.steps_layout.count():
            item = self.steps_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.setParent(None)
                widget.deleteLater()
        for index, step in enumerate(self.plan.steps, start=1):
            self.steps_layout.addWidget(self._step_widget(index, step))

    def _step_widget(self, index: int, step: PlanStep) -> QFrame:
        tone = _plan_step_tone(step, self.plan.current_step_id)
        step_blocker = step.blocked_by or (self.plan.blocked_by if tone == "current" else "")
        display_tone = "blocked" if tone == "current" and step_blocker else tone
        row = QFrame()
        row.setObjectName("planStepRow")
        row.setProperty("stepTone", display_tone)
        row_layout = QHBoxLayout()
        row_layout.setContentsMargins(2, 4, 2, 4)
        row_layout.setSpacing(8)

        marker = QLabel("✓" if tone == "done" else "!" if display_tone == "blocked" else "●" if tone == "current" else "○")
        marker.setObjectName("planStepMarker")
        marker.setProperty("stepTone", display_tone)
        marker.setFont(QFont("Segoe UI Symbol", 11))
        marker.setFixedWidth(18)
        marker.setAlignment(Qt.AlignCenter)

        text_block = QFrame()
        text_block.setObjectName("planStepTextBlock")
        text_layout = QVBoxLayout()
        text_layout.setContentsMargins(0, 0, 0, 0)
        text_layout.setSpacing(2)
        title = QLabel(f"{index}. {step.title}")
        title.setObjectName("planStepTitle")
        title.setWordWrap(True)
        text_layout.addWidget(title)
        step_detail = step.detail
        if tone == "current" and not step_detail and self.plan.current_step and self.plan.current_step != step.title:
            step_detail = self.plan.current_step
        if step_detail:
            detail = QLabel(step_detail)
            detail.setObjectName("planStepDetail")
            detail.setWordWrap(True)
            text_layout.addWidget(detail)
        if step.waiting_for:
            waiting = QLabel(f"等待：{step.waiting_for}")
            waiting.setObjectName("planStepWaiting")
            waiting.setWordWrap(True)
            text_layout.addWidget(waiting)
        text_block.setLayout(text_layout)

        state_text = step.completed_at or (
            "已完成" if tone == "done" else "已阻塞" if display_tone == "blocked" else "当前执行" if tone == "current" else "待开始"
        )
        state = QLabel(state_text)
        state.setObjectName("planStepState")
        state.setProperty("stepTone", display_tone)
        state.setAlignment(Qt.AlignRight | Qt.AlignTop)

        row_layout.addWidget(marker, 0, Qt.AlignTop)
        row_layout.addWidget(text_block, 1)
        row_layout.addWidget(state, 0, Qt.AlignTop)
        row.setLayout(row_layout)
        row.setAccessibleName(f"第 {index} 步，{step.title}，{state_text}")
        return row

def _plan_step_tone(step: PlanStep, current_step_id: str = "") -> str:
    if current_step_id and step.step_id == current_step_id:
        return "current"
    normalized = step.status.strip().lower()
    if normalized in PLAN_STEP_DONE_STATUSES:
        return "done"
    if normalized in PLAN_STEP_CURRENT_STATUSES:
        return "current"
    return "pending"


def _plan_blocker(plan: PlanItem) -> str:
    if plan.current_step_id:
        for step in plan.steps:
            if step.step_id == plan.current_step_id and step.blocked_by.strip():
                return step.blocked_by.strip()
    return plan.blocked_by.strip()


def _plan_current_step(plan: PlanItem) -> tuple[int, PlanStep | None]:
    for index, step in enumerate(plan.steps, start=1):
        if _plan_step_tone(step, plan.current_step_id) == "current":
            return index, step
    return 0, None


def _plan_current_step_summary(plan: PlanItem) -> str:
    index, step = _plan_current_step(plan)
    if step is not None:
        return f"第 {index} 步 · {step.title}"
    return plan.current_step.strip() or "暂无进行中的步骤"


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
        plan: PlanItem | None = None,
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
        self.header.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
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
            display_status = "阻塞中" if plan is not None and _plan_blocker(plan) else status
            self.status_label = QLabel(f"状态：{display_status}")
            self.status_label.setObjectName("planStatus")
            self.status_label.setProperty(
                "statusTone", "blocked" if display_status == "阻塞中" else STATUS_TONES.get(status, "unknown")
            )
            title_row.addWidget(self.status_label, 0, Qt.AlignTop)
        else:
            self.status_label = None
        header_layout.addLayout(title_row)
        if plan is not None:
            self.current_step_line = QFrame()
            self.current_step_line.setObjectName("planCurrentStepSummaryLine")
            current_step_layout = QHBoxLayout()
            current_step_layout.setContentsMargins(20, 0, 0, 0)
            current_step_layout.setSpacing(7)
            current_step_label = QLabel("当前阻塞" if _plan_blocker(plan) else "当前步骤")
            current_step_label.setObjectName("planCurrentStepSummaryLabel")
            self.current_step_value = QLabel(_plan_current_step_summary(plan))
            self.current_step_value.setObjectName("planCurrentStepSummaryValue")
            self.current_step_value.setMinimumWidth(0)
            self.current_step_value.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
            self.current_step_value.setToolTip(self.current_step_value.text())
            self.current_step_value.setProperty("blocked", bool(_plan_blocker(plan)))
            current_step_layout.addWidget(current_step_label, 0, Qt.AlignVCenter)
            current_step_layout.addWidget(self.current_step_value, 1, Qt.AlignVCenter)
            self.current_step_line.setLayout(current_step_layout)
            header_layout.addWidget(self.current_step_line)
        else:
            self.current_step_line = None
            self.current_step_value = None
        self.keywords_panel = KeywordPanel(keywords)
        header_layout.addWidget(self.keywords_panel)
        self.header.setLayout(header_layout)
        self.header.clicked.connect(self.toggle)

        self.details = QFrame()
        self.details.setObjectName("cardDetails")
        self.details.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)
        details_layout = QVBoxLayout()
        details_layout.setContentsMargins(14, 2, 0, 0)
        details_layout.setSpacing(6)
        if plan is not None:
            details_layout.addWidget(PlanDetailPanel(plan, fields))
        elif fields:
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
        self.keywords_panel.set_expanded(expanded)
        if self.current_step_line is not None:
            self.current_step_line.setVisible(not expanded)
        self.indicator.setText("v" if expanded else ">")
        self.header.set_action_word("折叠" if expanded else "展开")
        if emit:
            self.expanded_changed.emit(expanded)

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


class StatusTable(QFrame):
    def __init__(self, fields: list[tuple[str, str]]) -> None:
        super().__init__()
        self.setObjectName("statusTable")
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Maximum)

        layout = QGridLayout()
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setHorizontalSpacing(0)
        layout.setVerticalSpacing(0)

        key_header = QLabel("状态")
        key_header.setObjectName("statusTableHeader")
        value_header = QLabel("运行状态")
        value_header.setObjectName("statusTableHeader")
        layout.addWidget(key_header, 0, 0)
        layout.addWidget(value_header, 0, 1)

        for row_index, (key, value) in enumerate(fields, start=1):
            key_label = QLabel(key)
            key_label.setObjectName("statusTableKey")
            key_label.setAlignment(Qt.AlignTop | Qt.AlignLeft)
            value_label = QLabel(value)
            value_label.setObjectName("statusTableValue")
            value_label.setWordWrap(True)
            value_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
            layout.addWidget(key_label, row_index, 0)
            layout.addWidget(value_label, row_index, 1)

        layout.setColumnMinimumWidth(0, 132)
        layout.setColumnStretch(1, 1)
        self.setLayout(layout)


class TaskWindow(QWidget):
    route_selected = Signal(str)
    send_message_requested = Signal(str, object)

    def __init__(self, app_icon: QIcon | None = None) -> None:
        super().__init__()
        self.setWindowTitle("RabiRoute 角色面板")
        self.setWindowFlags(Qt.Window)
        self.setMinimumSize(760, 560)
        self.resize(920, 680)
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
        self.status_chip.setProperty("statusTone", "warning")
        self.status_detail = QLabel("正在读取 manager、计划和记忆目录...")
        self.status_detail.setObjectName("statusDetail")
        self.status_detail.setWordWrap(True)

        title_block = QVBoxLayout()
        title_block.setContentsMargins(0, 0, 0, 0)
        title_block.setSpacing(4)
        title_block.addWidget(self.title_label)
        title_block.addWidget(self.subtitle_label)

        header_top = QHBoxLayout()
        header_top.setSpacing(12)
        header_top.addWidget(self.icon_label, 0, Qt.AlignVCenter)
        header_top.addLayout(title_block, 1)
        header_top.addWidget(self.status_chip, 0, Qt.AlignVCenter)
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
        header_top.addWidget(self.collapse_button, 0, Qt.AlignVCenter)
        header_top.addWidget(self.more_button, 0, Qt.AlignVCenter)

        header_layout = QVBoxLayout()
        header_layout.setContentsMargins(16, 12, 16, 10)
        header_layout.setSpacing(7)
        header_layout.addLayout(header_top)
        header_layout.addWidget(self.status_detail)
        self.header.setLayout(header_layout)

        self.route_nav = QFrame()
        self.route_nav.setObjectName("routeNav")
        route_nav_layout = QVBoxLayout()
        route_nav_layout.setContentsMargins(0, 0, 0, 0)
        route_nav_layout.setSpacing(8)
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
        view_bar_layout.setSpacing(4)
        self.view_buttons: dict[str, QPushButton] = {}
        for view_key, label in VIEW_LABELS:
            button = QPushButton(label)
            button.setObjectName("viewButton")
            button.setCheckable(True)
            button.setAccessibleName(f"切换到{label}视图")
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
        self.content_layout.setContentsMargins(12, 10, 12, 10)
        self.content_layout.setSpacing(8)
        self.content_body.setLayout(self.content_layout)
        self.content.setWidget(self.content_body)

        self.chat_input_frame = QFrame()
        self.chat_input_frame.setObjectName("chatInput")
        chat_input_layout = QHBoxLayout()
        chat_input_layout.setContentsMargins(8, 8, 8, 8)
        chat_input_layout.setSpacing(8)
        self.message_input = MessageComposer()
        self.message_input.setObjectName("messageInput")
        self.message_input.setPlaceholderText("输入消息，发送给当前航线绑定的 Agent")
        self.message_input.send_requested.connect(self._send_message)
        self.attach_button = QPushButton("")
        self.attach_button.setObjectName("actionButton")
        self.attach_button.setFixedSize(44, 44)
        self.attach_button.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_DialogOpenButton))
        self.attach_button.setToolTip("添加文件")
        self.attach_button.setAccessibleName("添加文件")
        self.attach_button.clicked.connect(self._choose_attachment)
        self.send_button = QPushButton("")
        self.send_button.setObjectName("sendButton")
        self.send_button.setFixedSize(44, 44)
        self.send_button.setIcon(self.style().standardIcon(QStyle.StandardPixmap.SP_ArrowForward))
        self.send_button.setToolTip("发送消息")
        self.send_button.setAccessibleName("发送消息")
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

        self.footer_frame = QFrame()
        self.footer_frame.setObjectName("footerBar")
        footer = QHBoxLayout()
        footer.setContentsMargins(14, 7, 8, 7)
        footer.setSpacing(8)
        footer.addWidget(self.footer_label, 1)
        footer.addWidget(self.refresh_button)
        self.footer_frame.setLayout(footer)

        self.right_pane = QFrame()
        self.right_pane.setObjectName("rightPane")
        right_layout = QVBoxLayout()
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)
        right_layout.addWidget(self.header)
        right_layout.addWidget(self.view_bar)
        right_layout.addWidget(self.content, 1)
        right_layout.addWidget(self.chat_input_frame)
        right_layout.addWidget(self.footer_frame)
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
        self.subtitle_label.setText(
            f"Manager：{'已连接' if manager.connected else '离线'}  "
            f"Gateway：{'运行中' if running else '已停止'}"
        )
        self.status_chip.setText(self._chip_text(manager.connected, running))
        self.status_chip.setProperty("statusTone", self._status_tone(manager.connected, running))
        self.status_chip.style().unpolish(self.status_chip)
        self.status_chip.style().polish(self.status_chip)
        self.status_detail.setText(f"当前航线：{self._gateway_label(gateway) if gateway else '未选择'}")
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
            button = QPushButton(self._route_button_text(gateway))
            button.setObjectName("routeButton")
            button.setProperty("routeState", route_state(gateway))
            button.setCheckable(True)
            button.setChecked(gateway_id == selected_id)
            button.setToolTip(label)
            button.setAccessibleName(label)
            button.clicked.connect(lambda _checked=False, item_id=gateway_id: self.route_selected.emit(item_id))
            self.route_buttons[gateway_id] = button
            self.route_buttons_layout.addWidget(button)

    def _route_button_text(self, gateway: dict) -> str:
        parts = [part.strip() for part in route_subtitle(gateway).split(" · ") if part.strip()]
        identity = " · ".join(parts[:-1]) if len(parts) > 1 else ""
        adapters = parts[-1] if parts else ""
        lines = [route_title(gateway)]
        if identity:
            lines.append(identity)
        if adapters:
            lines.append(adapters)
        lines.append(f"{route_enabled_label(gateway)} / {route_running_label(gateway)}")
        return "\n".join(lines)

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
        self.attach_button.setText(str(count) if count else "")
        self.attach_button.setToolTip(f"已添加 {count} 个文件" if count else "添加文件")

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

    def _message_datetime(self, message: dict) -> datetime | None:
        value = message.get("time")
        try:
            seconds = float(value)
            if seconds > 10_000_000_000:
                seconds /= 1000
            return datetime.fromtimestamp(seconds)
        except Exception:
            return None

    def _message_day(self, message: dict) -> str:
        timestamp = self._message_datetime(message)
        return timestamp.strftime("%Y-%m-%d") if timestamp is not None else ""

    def _message_time(self, message: dict) -> str:
        timestamp = self._message_datetime(message)
        return timestamp.strftime("%H:%M") if timestamp is not None else ""

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
        body.setMaximumWidth(max(360, int(self.content.viewport().width() * 0.72)))
        body_layout = QVBoxLayout()
        body_layout.setContentsMargins(12, 9, 12, 9)
        body_layout.setSpacing(6)
        meta_row = QHBoxLayout()
        meta_row.setContentsMargins(0, 0, 0, 0)
        meta_row.setSpacing(10)
        sender = QLabel(str(message.get("sender") or ("我" if direction == "user" else "Agent")))
        sender.setObjectName("chatSender")
        message_time = QLabel(self._message_time(message))
        message_time.setObjectName("chatTime")
        meta_row.addWidget(sender)
        meta_row.addStretch(1)
        if message_time.text():
            meta_row.addWidget(message_time)
        body_layout.addLayout(meta_row)
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
        detail = self._format_file_size(size) if isinstance(size, int) and size > 0 else "文件"
        row = QFrame()
        row.setObjectName("chatAttachment")
        layout = QHBoxLayout()
        layout.setContentsMargins(8, 6, 8, 6)
        layout.setSpacing(8)
        icon = QLabel()
        icon.setObjectName("chatAttachmentIcon")
        icon.setPixmap(self.style().standardIcon(QStyle.StandardPixmap.SP_FileIcon).pixmap(16, 16))
        title = QLabel(name)
        title.setObjectName("chatAttachmentName")
        title.setMinimumWidth(0)
        title.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        title.setToolTip(str(attachment.get("path") or attachment.get("url") or name))
        size_label = QLabel(detail)
        size_label.setObjectName("chatAttachmentSize")
        layout.addWidget(icon)
        layout.addWidget(title, 1)
        layout.addWidget(size_label)
        row.setLayout(layout)
        return row

    def _format_file_size(self, size: int) -> str:
        value = float(size)
        for unit in ("B", "KB", "MB", "GB"):
            if value < 1024 or unit == "GB":
                return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
            value /= 1024
        return f"{size} B"

    def _render_current(self) -> None:
        assert self.plans is not None
        assert self.context is not None
        self._add_section_header("进行中计划", "当前状态为“进行中”的计划，只读展示。", "plan")
        if self.plans.current:
            self._add_plan_cards(self.plans.current, "进行中计划")
        else:
            self._add_info_card("进行中计划", "暂无 status=进行中 的计划。", [("计划目录", str(self.plans.plans_dir))], "empty")
        self._add_section_header("近期记忆", "Agent 维护的近期上下文条目，只读展示。", "memory")
        if self.context.recent_memory:
            self._add_context_cards(self.context.recent_memory, "近期记忆")
        else:
            self._add_info_card("近期记忆", "暂无近期记忆。", [("记忆目录", str(self.context.role_dir / "memory" / "recent"))], "empty")

    def _render_plans(self) -> None:
        assert self.plans is not None
        self._add_section_header("计划", "未归档计划的只读概览。", "plan")
        if self.plans.active:
            self._add_plan_cards(self.plans.active, "计划")
        else:
            self._add_info_card("计划", "暂无可展示计划。", [("计划目录", str(self.plans.plans_dir))], "empty")

    def _render_archived(self) -> None:
        assert self.plans is not None
        assert self.context is not None
        self._add_section_header("已归档", "已归档计划和沉淀记忆的只读概览。", "archived")
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
        self._add_section_header("诊断 / 路由状态", "manager、gateway 和角色目录的只读状态。", "status")
        self.content_layout.addWidget(StatusTable(fields))

    def _render_context_group(self, title: str, entries: list[ContextEntry]) -> None:
        assert self.context is not None
        self._add_section_header(title, "Agent 维护的上下文条目，只读展示。", "memory")
        if entries:
            self._add_context_cards(entries, title)
        else:
            self._add_info_card(title, "这个视图暂无可展示内容。", [("人格目录", str(self.context.role_dir))], "empty")

    def _add_plan_cards(self, plans: list[PlanItem], label: str) -> None:
        for plan in plans:
            fields: list[tuple[str, str]] = []
            if plan.priority:
                fields.append(("优先级", PLAN_PRIORITY_LABELS.get(plan.priority.lower(), plan.priority)))
            if plan.kind:
                fields.append(("类型", PLAN_KIND_LABELS.get(plan.kind.lower(), plan.kind)))
            if plan.project_name or plan.project_path:
                fields.append(("项目", plan.project_name or plan.project_path))
            if plan.due_at:
                fields.append(("截止时间", plan.due_at))
            if plan.source:
                fields.append(("来源", plan.source))
            if plan.created_at:
                fields.append(("创建时间", plan.created_at))
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
                plan=plan,
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
        plan: PlanItem | None = None,
    ) -> None:
        key = card_key or f"{label}:{title}"
        card = ExpandableCard(
            label,
            title,
            fields,
            tone,
            keywords,
            status=status,
            expanded=key in self._expanded_cards,
            plan=plan,
        )
        card.expanded_changed.connect(lambda expanded, item_key=key: self._set_card_expanded(item_key, expanded))
        self.content_layout.addWidget(card)

    def _add_section_header(self, title: str, detail: str, tone: str = "neutral") -> None:
        section = QFrame()
        section.setObjectName("sectionHeader")
        section.setProperty("tone", tone)
        layout = QVBoxLayout()
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setSpacing(3)
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

    def _sync_buttons(self) -> None:
        for view_key, button in self.view_buttons.items():
            button.setChecked(view_key == self.active_view)

    def _chip_text(self, manager_connected: bool, gateway_running: bool) -> str:
        if manager_connected and gateway_running:
            return "运行中"
        if manager_connected:
            return "待检查"
        return "离线"

    def _status_tone(self, manager_connected: bool, gateway_running: bool) -> str:
        if manager_connected and gateway_running:
            return "running"
        if manager_connected:
            return "warning"
        return "offline"

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
            event.accept()
            return
        super().mouseReleaseEvent(event)


STYLESHEET = """
QWidget {
    background: #f6f8fb;
    color: #112033;
    font-family: "Segoe UI", "Microsoft YaHei UI", sans-serif;
    font-size: 13px;
}
QLabel {
    background: transparent;
}
QFrame#rightPane {
    background: #f6f8fb;
    border-left: 1px solid #dbe5ea;
}
QFrame#header {
    background: #ffffff;
    border: 0;
    border-bottom: 1px solid #dbe5ea;
    border-radius: 0;
}
QLabel#title {
    color: #0c2a4a;
    font-size: 19px;
    font-weight: 900;
}
QLabel#subtitle {
    color: #667586;
    font-size: 12px;
    font-weight: 700;
}
QLabel#statusChip {
    background: #eaf8ef;
    border: 1px solid #b9e3c8;
    border-radius: 11px;
    color: #15803d;
    font-weight: 800;
    padding: 4px 10px;
}
QLabel#statusChip[statusTone="warning"] {
    background: #fff7e6;
    border-color: #f4d293;
    color: #a96008;
}
QLabel#statusChip[statusTone="offline"] {
    background: #fff0f0;
    border-color: #f0bcbc;
    color: #c62828;
}
QLabel#statusDetail {
    color: #52677a;
    line-height: 1.4;
    font-size: 12px;
    font-weight: 600;
}
QLabel#brandIcon {
    background: #f2fbfc;
    border: 1px solid #c8e9ea;
    border-radius: 10px;
}
QPushButton#iconButton {
    background: transparent;
    border: 1px solid transparent;
    border-radius: 8px;
    color: #52677a;
    min-width: 36px;
    max-width: 36px;
    min-height: 36px;
    max-height: 36px;
    padding: 0;
    font-size: 18px;
    font-weight: 800;
}
QPushButton#iconButton:hover {
    background: #eaf8f9;
    border-color: #c8e9ea;
    color: #0f8b8d;
}
QPushButton#iconButton:focus {
    border: 2px solid #19bfc1;
}
QPushButton#iconButton::menu-indicator {
    width: 0;
}
QMenu#moreMenu {
    background: #ffffff;
    border: 1px solid #d6e2e8;
    border-radius: 8px;
    color: #112033;
    padding: 6px;
}
QMenu#moreMenu::item {
    border-radius: 6px;
    padding: 8px 28px 8px 12px;
}
QMenu#moreMenu::item:selected {
    background: #eaf8f9;
    color: #0c2a4a;
}
QMenu#moreMenu::item:disabled {
    color: #a9b4be;
}
QFrame#routeNav {
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #ffffff, stop:1 #f6fcfd);
    border-right: 1px solid #dbe5ea;
    min-width: 232px;
    max-width: 232px;
}
QLabel#routeBrand {
    background: transparent;
    color: #102a43;
    font-size: 16px;
    font-weight: 900;
    padding: 16px 14px 5px 14px;
}
QLabel#routeSearch {
    background: #ffffff;
    border: 1px solid #d6e2e8;
    border-radius: 8px;
    color: #7890a0;
    min-height: 32px;
    margin: 0 12px;
    padding: 4px 12px;
    font-weight: 700;
}
QPushButton#routeButton {
    background: #ffffff;
    border: 1px solid #dbe5ea;
    border-radius: 8px;
    color: #102a43;
    min-height: 88px;
    margin: 0 8px;
    padding: 10px 12px;
    text-align: left;
    font-weight: 800;
}
QPushButton#routeButton[routeState="running"] {
    border-left: 4px solid #19bfc1;
}
QPushButton#routeButton[routeState="stopped"] {
    background: #fffaf0;
    border-left: 4px solid #f59e0b;
}
QPushButton#routeButton[routeState="disabled"] {
    background: #f5f7f9;
    border-left: 4px solid #94a3b8;
    color: #7b8996;
}
QPushButton#routeButton:hover {
    background: #f2fbfc;
    border-color: #a9dddf;
}
QPushButton#routeButton:checked {
    background: #e8f7f8;
    border-top-color: #9edbdd;
    border-right-color: #9edbdd;
    border-bottom-color: #9edbdd;
    color: #0c2a4a;
}
QPushButton#routeButton:focus {
    border: 2px solid #19bfc1;
    border-left: 4px solid #19bfc1;
}
QFrame#viewBar {
    background: #ffffff;
    border-bottom: 1px solid #dbe5ea;
    padding: 6px 12px;
}
QLabel#actionsLabel {
    color: #7b8996;
    font-size: 11px;
    font-weight: 800;
    padding-top: 4px;
}
QFrame#panelActions {
    background: transparent;
}
QPushButton#viewButton {
    background: transparent;
    border: 1px solid transparent;
    border-bottom: 2px solid transparent;
    border-radius: 8px;
    color: #52677a;
    min-width: 54px;
    min-height: 34px;
    padding: 3px 8px;
    font-weight: 800;
}
QPushButton#sendButton {
    background: #102a43;
    border: 1px solid #102a43;
    border-radius: 8px;
    color: #ffffff;
    min-width: 44px;
    max-width: 44px;
    min-height: 44px;
    max-height: 44px;
    padding: 0;
    font-weight: 800;
}
QPushButton#sendButton:hover {
    background: #194466;
    border-color: #194466;
}
QPushButton#sendButton:focus {
    border: 2px solid #19bfc1;
}
QFrame#chatInput {
    background: #ffffff;
    border-top: 1px solid #dbe5ea;
    border-radius: 0;
}
QTextEdit#messageInput {
    background: #fbfdff;
    border: 1px solid #cad8e0;
    border-radius: 8px;
    color: #112033;
    padding: 8px;
    selection-background-color: #bdeced;
    selection-color: #0c2a4a;
}
QTextEdit#messageInput:focus {
    border: 2px solid #19bfc1;
}
QFrame#chatBubble {
    background: transparent;
    border: 0;
}
QFrame#chatBubbleBody {
    background: #ffffff;
    border: 1px solid #d6e2e8;
    border-radius: 8px;
}
QFrame#chatBubble[direction="out"] QFrame#chatBubbleBody {
    background: #e9f8f9;
    border-color: #bde4e6;
}
QFrame#chatBubble[direction="in"] QFrame#chatBubbleBody {
    background: #ffffff;
}
QLabel#chatSender {
    color: #0f8b8d;
    font-size: 11px;
    font-weight: 800;
}
QLabel#chatTime {
    color: #8491a0;
    font-size: 10px;
    font-weight: 650;
}
QLabel#chatText {
    color: #112033;
    font-size: 14px;
    line-height: 1.45;
}
QLabel#timeSeparator {
    color: #718291;
    font-size: 11px;
    font-weight: 700;
    padding: 8px 4px 4px 4px;
}
QFrame#chatAttachment {
    background: #f5f8fa;
    border: 1px solid #dbe5ea;
    border-radius: 7px;
}
QLabel#chatAttachmentIcon {
    background: transparent;
    min-width: 18px;
    max-width: 18px;
}
QLabel#chatAttachmentName {
    color: #334e62;
    font-size: 12px;
    font-weight: 750;
}
QLabel#chatAttachmentSize {
    color: #718291;
    font-size: 10px;
    font-weight: 700;
}
QPushButton#viewButton:hover {
    background: #f0f8f9;
    border-color: #d2e9ea;
    color: #0c2a4a;
}
QPushButton#viewButton:checked {
    background: #eaf8f9;
    border-color: #d2eeee;
    border-bottom-color: #19bfc1;
    color: #0c2a4a;
    font-weight: 800;
}
QPushButton#viewButton:focus {
    border: 2px solid #19bfc1;
}
QPushButton#actionButton {
    background: #eef4f7;
    border: 1px solid #d3dfe5;
    border-radius: 8px;
    color: #102a43;
    min-height: 34px;
    padding: 5px 10px;
    font-size: 12px;
    font-weight: 750;
    text-align: left;
}
QPushButton#actionButton:hover {
    background: #e0f4f5;
    border-color: #a9dddf;
}
QPushButton#actionButton:disabled {
    background: #f0f2f4;
    border-color: #e3e8eb;
    color: #a4afb8;
}
QScrollArea#content {
    background: #f4f9fb;
    border: 0;
    border-radius: 0;
}
QWidget#contentBody {
    background: #f4f9fb;
}
QFrame#sectionHeader {
    background: transparent;
    border: 0;
    border-left: 3px solid #94a3b8;
    border-radius: 0;
}
QFrame#sectionHeader[tone="plan"] {
    border-left-color: #f59e0b;
}
QFrame#sectionHeader[tone="memory"] {
    border-left-color: #19bfc1;
}
QFrame#sectionHeader[tone="archived"] {
    border-left-color: #94a3b8;
}
QFrame#sectionHeader[tone="status"] {
    border-left-color: #087f91;
}
QLabel#sectionTitle {
    color: #0c2a4a;
    font-size: 16px;
    font-weight: 900;
}
QLabel#sectionDetail {
    color: #667586;
    font-size: 12px;
}
QFrame#itemCard, QFrame#infoCard {
    background: #ffffff;
    border: 1px solid #dbe5ea;
    border-radius: 8px;
}
QFrame#itemCard[tone="plan"] {
    background: #fffdf8;
    border-left: 4px solid #f59e0b;
}
QFrame#itemCard[tone="memory"] {
    background: #f8fefe;
    border-left: 4px solid #19bfc1;
}
QFrame#infoCard[tone="neutral"] {
    background: #f8fbfe;
    border-left: 4px solid #087f91;
}
QFrame#infoCard[tone="empty"] {
    background: #ffffff;
    border-left: 4px solid #aab5bf;
}
QFrame#cardHeader {
    background: transparent;
    border: 0;
    border-radius: 8px;
}
QFrame#cardHeader:hover {
    background: #f0f8f9;
}
QFrame#cardHeader:focus {
    border: 2px solid #19bfc1;
}
QLabel#cardIndicator {
    color: #0f8b8d;
    font-size: 13px;
    font-weight: 900;
}
QLabel#cardBadge {
    background: #eef6f8;
    border: 1px solid #d4e4e8;
    border-radius: 7px;
    color: #52677a;
    font-size: 11px;
    font-weight: 800;
    padding: 2px 7px;
}
QLabel#cardTitle {
    color: #102a43;
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
    background: #eaf8ef;
    color: #15803d;
}
QLabel#planStatus[statusTone="blocked"] {
    background: #fff1e8;
    color: #b54708;
}
QLabel#planStatus[statusTone="pending"] {
    background: #fff7e6;
    color: #a96008;
}
QLabel#planStatus[statusTone="done"] {
    background: #eaf4ff;
    color: #1d63a9;
}
QLabel#planStatus[statusTone="archived"] {
    background: #eef1f4;
    color: #687786;
}
QLabel#planStatus[statusTone="unknown"] {
    background: #eef1f4;
    color: #687786;
}
QFrame#keywordPanel {
    background: transparent;
    border: 0;
}
QFrame#planCurrentStepSummaryLine {
    background: transparent;
    border: 0;
}
QLabel#planCurrentStepSummaryLabel {
    color: #7b8996;
    font-size: 11px;
    font-weight: 800;
}
QLabel#planCurrentStepSummaryValue {
    background: #f7fafc;
    border: 1px solid #dbe5ea;
    border-radius: 6px;
    color: #36566b;
    font-size: 11px;
    font-weight: 750;
    padding: 2px 7px;
}
QLabel#planCurrentStepSummaryValue[blocked="true"] {
    background: #fff8f1;
    border-color: #f1b87a;
    color: #9a4d08;
}
QFrame#keywordSummaryLine, QFrame#keywordExpandedPanel {
    background: transparent;
    border: 0;
}
QLabel#keywordLabel {
    color: #7b8996;
    font-size: 11px;
    font-weight: 800;
    padding-top: 3px;
}
QLabel#keywordSummary {
    background: #eef8f9;
    border: 1px solid #d2e9ea;
    border-radius: 6px;
    color: #36566b;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 7px;
}
QLabel#keywordExpandedValues {
    background: #eef8f9;
    border: 1px solid #d2e9ea;
    border-radius: 6px;
    color: #36566b;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 7px;
}
QLabel#keywordExpandedValues[empty="true"] {
    color: #8c99a4;
}
QFrame#cardDetails {
    background: transparent;
    border: 0;
}
QFrame#planDetailPanel, QFrame#planActionSummary, QFrame#planMetadataPanel,
QFrame#planMetadataDetails, QFrame#planProgressPanel, QFrame#planStepsContainer, QFrame#planStepTextBlock {
    background: transparent;
    border: 0;
}
QFrame#planSummaryBlock {
    background: #f8fbfd;
    border: 1px solid #dbe5ea;
    border-radius: 8px;
}
QFrame#planSummaryBlock[summaryTone="current"] {
    background: #f2fbfc;
    border-color: #c8e9ea;
}
QFrame#planSummaryBlock[summaryTone="next"] {
    background: #f6f9fd;
    border-color: #d7e3ef;
}
QFrame#planSummaryBlock[summaryTone="blocked"] {
    background: #fff8f1;
    border-color: #f1b87a;
}
QLabel#planSummaryLabel {
    color: #0f8b8d;
    font-size: 12px;
    font-weight: 900;
}
QLabel#planSummaryLabel[summaryTone="next"] {
    color: #1d63a9;
}
QLabel#planSummaryLabel[summaryTone="blocked"] {
    color: #b54708;
}
QLabel#planSummaryValue {
    color: #102a43;
    font-size: 14px;
    font-weight: 800;
    line-height: 1.45;
}
QLabel#planProgressTitle {
    color: #0c2a4a;
    font-size: 13px;
    font-weight: 900;
}
QLabel#planProgressPercent {
    color: #15803d;
    font-size: 13px;
    font-weight: 900;
}
QLabel#planCurrentStepCallout {
    background: #f7fafc;
    border: 1px solid #dbe5ea;
    border-radius: 8px;
    color: #52677a;
    font-size: 13px;
    font-weight: 850;
    padding: 9px 11px;
}
QLabel#planCurrentStepCallout[hasCurrentStep="true"] {
    background: #eef9ff;
    border-color: #a9d5f7;
    color: #145da0;
}
QLabel#planCurrentStepCallout[blocked="true"] {
    background: #fff8f1;
    border-color: #f1b87a;
    color: #9a4d08;
}
QProgressBar#planProgressBar {
    background: #e5edf1;
    border: 0;
    border-radius: 4px;
}
QProgressBar#planProgressBar::chunk {
    background: #19bfc1;
    border-radius: 4px;
}
QFrame#planStepRow {
    background: transparent;
    border: 0;
    border-bottom: 1px solid #edf1f3;
}
QFrame#planStepRow[stepTone="current"] {
    background: #eef9ff;
    border: 1px solid #a9d5f7;
    border-radius: 8px;
}
QFrame#planStepRow[stepTone="blocked"] {
    background: #fff8f1;
    border: 1px solid #f1b87a;
    border-radius: 8px;
}
QLabel#planStepMarker {
    color: #94a3b8;
    font-size: 15px;
    font-weight: 900;
}
QLabel#planStepMarker[stepTone="done"] {
    color: #16a34a;
}
QLabel#planStepMarker[stepTone="current"] {
    color: #1d7be8;
}
QLabel#planStepMarker[stepTone="blocked"] {
    color: #d46b08;
}
QLabel#planStepTitle {
    color: #334e62;
    font-size: 12px;
    font-weight: 750;
}
QLabel#planStepDetail {
    color: #718291;
    font-size: 11px;
}
QLabel#planStepWaiting {
    color: #9a5b13;
    font-size: 11px;
    font-weight: 750;
}
QLabel#planStepState {
    color: #7b8996;
    font-size: 11px;
    font-weight: 750;
}
QLabel#planStepState[stepTone="done"] {
    color: #4f7d60;
}
QLabel#planStepState[stepTone="current"] {
    color: #1d63a9;
}
QLabel#planStepState[stepTone="blocked"] {
    color: #b54708;
}
QLabel#planMetadataSummary {
    background: #f7fafc;
    border: 1px solid #e1e8ec;
    border-radius: 7px;
    color: #52677a;
    font-size: 11px;
    padding: 6px 8px;
}
QPushButton#planMetadataToggle {
    background: transparent;
    border: 0;
    border-radius: 6px;
    color: #52677a;
    min-height: 30px;
    padding: 3px 8px;
    text-align: left;
    font-size: 11px;
    font-weight: 800;
}
QPushButton#planMetadataToggle:hover {
    background: #eaf8f9;
    color: #0f8b8d;
}
QFrame#planMetadataItem {
    background: #fbfdff;
    border: 1px solid #e5ebef;
    border-radius: 7px;
    padding: 7px;
}
QFrame#fieldRow {
    background: transparent;
    border: 0;
}
QLabel#fieldKey {
    color: #7b8996;
    font-size: 11px;
    font-weight: 800;
}
QLabel#fieldValue {
    color: #334e62;
    line-height: 1.45;
}
QFrame#statusTable {
    background: #ffffff;
    border: 1px solid #d6e2e8;
    border-radius: 8px;
}
QLabel#statusTableHeader {
    background: #eaf4f6;
    border-right: 1px solid #d3e2e6;
    border-bottom: 1px solid #d3e2e6;
    color: #0c2a4a;
    font-weight: 800;
    padding: 6px 9px;
}
QLabel#statusTableKey {
    background: #f6fafb;
    border-right: 1px solid #e1e8ec;
    border-bottom: 1px solid #e1e8ec;
    color: #52677a;
    font-weight: 700;
    padding: 5px 9px;
}
QLabel#statusTableValue {
    background: #ffffff;
    border-bottom: 1px solid #e1e8ec;
    color: #334e62;
    padding: 5px 9px;
}
QFrame#footerBar {
    background: #ffffff;
    border-top: 1px solid #dbe5ea;
}
QLabel#footer {
    background: transparent;
    border: 0;
    color: #718291;
    font-size: 12px;
    padding: 0;
}
QPushButton#primaryButton {
    background: #e4f5f6;
    border: 1px solid #b9e2e4;
    border-radius: 8px;
    color: #0f8b8d;
    min-width: 40px;
    max-width: 40px;
    min-height: 36px;
    max-height: 36px;
    padding: 4px;
}
QPushButton#primaryButton:hover {
    background: #ccecee;
    border-color: #8fd3d6;
}
QPushButton#primaryButton:focus {
    border: 2px solid #19bfc1;
}
QScrollBar:vertical {
    background: #f2f7f9;
    width: 10px;
    margin: 2px;
    border-radius: 5px;
}
QScrollBar::handle:vertical {
    background: #b9cbd3;
    min-height: 28px;
    border-radius: 4px;
}
QScrollBar::handle:vertical:hover {
    background: #87bfc2;
}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
    height: 0;
}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
    background: transparent;
}
"""
