from __future__ import annotations

from pathlib import Path
from typing import Any
from PySide6.QtCore import QObject, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices, QPixmap, QTextCursor
from PySide6.QtWidgets import (QCheckBox, QDialog, QDialogButtonBox, QHBoxLayout,
                              QLabel, QPlainTextEdit, QPushButton, QVBoxLayout)
from .manager_client import ManagerClient
from .qt_async import start_qt_task
from .system_selection import SelectionDeliveryTarget
from .screenshot_target_picker import ScreenshotTargetPicker
from .screenshot_voice import ScreenshotVoiceInput


class ScreenshotComposer(QDialog):
    send_requested = Signal(str, str)

    def __init__(self, image_path: Path, targets: list[SelectionDeliveryTarget], parent: QObject | None = None,
                 *, manager: ManagerClient | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("发送截图")
        self.setWindowFlag(Qt.WindowType.WindowStaysOnTopHint, True)
        self.setModal(False)
        self._image_path = image_path
        self._manager = manager
        self._closed = False
        self._sending = False
        self._delivery_uncertain = False
        self._reconcile_callback = None
        self._preferences_task = None
        self._pending_preferences: dict[str, Any] = {}
        self._preferences_loaded = manager is None
        self._voice_revision = 0
        self._voice = ScreenshotVoiceInput(manager, self) if manager else None
        self._preview = QLabel()
        self._preview.setAlignment(Qt.AlignmentFlag.AlignCenter)
        pixmap = QPixmap(str(image_path))
        if not pixmap.isNull():
            self._preview.setPixmap(pixmap.scaled(720, 400, Qt.AspectRatioMode.KeepAspectRatio,
                                                 Qt.TransformationMode.SmoothTransformation))
        self._target = ScreenshotTargetPicker(self, targets, manager)
        self._text = QPlainTextEdit()
        self._text.setPlaceholderText("输入随截图发送的文字，也可以打开语音输入…")
        self._text.setMinimumHeight(100)
        self._voice_toggle = QCheckBox("语音输入")
        self._voice_toggle.setEnabled(False)
        self._voice_status = QLabel()
        self._speech_settings = QPushButton("语音设置")
        self._speech_settings.setEnabled(manager is not None)
        voice_row = QHBoxLayout()
        voice_row.addWidget(self._voice_toggle)
        voice_row.addWidget(self._voice_status, 1)
        voice_row.addWidget(self._speech_settings)
        self._error = QLabel()
        self._error.setWordWrap(True)
        self._error.setStyleSheet("color: #e47c65;")
        self._error.hide()
        self._buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel | QDialogButtonBox.StandardButton.Ok)
        self._buttons.button(QDialogButtonBox.StandardButton.Ok).setText("发送")
        self._buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        self._buttons.rejected.connect(self.reject)
        self._buttons.accepted.connect(self._send)
        self._reconcile = QPushButton("核对原投递")
        self._reconcile.hide()
        layout = QVBoxLayout(self)
        layout.addWidget(self._preview, 1)
        target_label = QLabel("投递至")
        target_label.setBuddy(self._target)
        layout.addWidget(target_label)
        layout.addWidget(self._target)
        layout.addWidget(self._text)
        layout.addLayout(voice_row)
        layout.addWidget(self._error)
        layout.addWidget(self._reconcile)
        layout.addWidget(self._buttons)
        self.resize(760, 720)
        self._target.selection_changed.connect(self._target_selected)
        self._voice_toggle.toggled.connect(self._toggle_voice)
        self._speech_settings.clicked.connect(self._open_speech_settings)
        self.finished.connect(self._finish)
        if self._voice:
            self._voice.text_ready.connect(self._append_transcript)
            self._voice.failed.connect(self._voice_failed)
            self._voice.state_changed.connect(self._voice_state_changed)
        if manager:
            start_qt_task(lambda: (manager.screenshot_preferences(), manager.screenshot_agents()), self._loaded)

    @property
    def image_path(self) -> Path:
        return self._image_path

    @property
    def delivery_selection(self) -> dict[str, str] | None:
        return self._target.selection

    def _loaded(self, _task, result) -> None:
        if self._closed:
            return
        if isinstance(result, Exception):
            self.set_error(f"投递列表或偏好读取失败：{result}")
            return
        preferences, agents = result
        self._preferences_loaded = True
        self._voice_toggle.setEnabled(True)
        if not self._target.load_agents(agents, preferences.get("lastTarget")):
            self.set_error("上次投递目标已不可用，请重新选择。")
        if preferences.get("voiceInputEnabled") is True:
            self._voice_toggle.setChecked(True)

    def _target_selected(self) -> None:
        if not self._delivery_uncertain:
            self.set_error("")
        self._remember_target()

    def _remember_target(self, *_args) -> None:
        selection = self.delivery_selection
        if selection:
            self._save_preferences({"lastTarget": selection})

    def _save_preferences(self, patch: dict[str, Any]) -> None:
        if not self._manager or not self._preferences_loaded:
            return
        self._pending_preferences.update(patch)
        if self._preferences_task is not None:
            return
        saved = dict(self._pending_preferences)
        self._pending_preferences.clear()

        def completed(task, result):
            if self._preferences_task is task:
                self._preferences_task = None
            if isinstance(result, Exception):
                # An uncertain write is inspected, never replayed automatically.
                self.set_error(f"偏好保存未确认：{result}")
                self._pending_preferences.clear()
            elif self._pending_preferences:
                self._save_preferences({})
        self._preferences_task = start_qt_task(lambda: self._manager.save_screenshot_preferences(saved), completed)

    def _toggle_voice(self, enabled: bool) -> None:
        self._voice_revision += 1
        revision = self._voice_revision
        if not enabled:
            if self._voice:
                self._voice.stop()
            self._voice_status.clear()
            self._save_preferences({"voiceInputEnabled": False})
            return
        if not self._manager or not self._voice:
            return
        self._voice_toggle.setEnabled(False)
        self._voice_status.setText("检查语音服务…")

        def checked(_task, result):
            if self._closed or revision != self._voice_revision:
                return
            self._voice_toggle.setEnabled(not self._sending)
            if isinstance(result, Exception):
                self._voice_failed(str(result))
                self._open_speech_settings()
                return
            try:
                self._voice.start(result)
                self._save_preferences({"voiceInputEnabled": True})
            except Exception as error:
                self._voice_failed(str(error))
        start_qt_task(self._manager.screenshot_voice_settings, checked)

    def _voice_state_changed(self, revision: int, text: str) -> None:
        if self._voice and self._voice.is_current(revision) and not self._closed and self._voice_toggle.isChecked() and not self._sending:
            self._voice_status.setText(text)

    def _voice_failed(self, message: str) -> None:
        if self._closed:
            return
        self._voice_toggle.setChecked(False)
        self._voice_status.setText("语音不可用")
        self.set_error(message)

    def _append_transcript(self, revision: int, text: str) -> None:
        if not self._voice or not self._voice.is_current(revision) or self._closed or self._sending or not self._voice_toggle.isChecked():
            return
        cursor = self._text.textCursor()
        cursor.movePosition(QTextCursor.MoveOperation.End)
        cursor.insertText(("\n" if self._text.toPlainText() else "") + text)
        self._text.setTextCursor(cursor)

    def _open_speech_settings(self) -> None:
        if self._manager:
            QDesktopServices.openUrl(QUrl(f"{self._manager.manager_url}/#/speech"))

    def set_error(self, message: str) -> None:
        self._error.setText(message)
        self._error.setVisible(bool(message))

    def set_sending(self, sending: bool) -> None:
        self._sending = sending
        for widget in (self._target, self._text, self._voice_toggle):
            widget.setEnabled(not sending)
        self._buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(not sending)
        self._buttons.button(QDialogButtonBox.StandardButton.Cancel).setEnabled(not sending)
        if sending and self._voice:
            self._voice_revision += 1
            self._voice.stop()
            if self._voice_toggle.isChecked():
                self._voice_status.setText("语音已暂停，重新开关可继续")

    def set_delivery_uncertain(self, reconcile) -> None:
        self.set_sending(False)
        self._delivery_uncertain = True
        self._buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(False)
        self._reconcile.show()
        if self._reconcile_callback is not None:
            self._reconcile.clicked.disconnect(self._reconcile_callback)
        self._reconcile_callback = reconcile
        self._reconcile.clicked.connect(reconcile)

    def _send(self) -> None:
        if self._sending or self._delivery_uncertain:
            return
        selection = self.delivery_selection
        if not selection:
            self.set_error("请选择投递目标和对应对话。")
            return
        self._remember_target()
        key = selection.get("gatewayId") or f"agent:{selection['provider']}:{selection['threadId']}"
        self.send_requested.emit(key, self._text.toPlainText().strip())

    def _finish(self, _result) -> None:
        self._closed = True
        self._voice_revision += 1
        self._target.dismiss()
        if self._voice:
            self._voice.stop()

    def reject(self) -> None:
        if not self._sending:
            super().reject()

    def closeEvent(self, event) -> None:
        if self._sending:
            event.ignore()
            return
        self._finish(0)
        super().closeEvent(event)
