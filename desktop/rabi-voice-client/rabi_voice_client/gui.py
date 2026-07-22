from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import sounddevice as sd
from PySide6.QtCore import QThread, QTimer, Qt, Signal
from PySide6.QtGui import QCloseEvent, QFont, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .client import ClientState, RabiVoiceClient
from .config import ClientConfig, load_config, load_config_data, save_config_data, validate_config_data


class VoiceClientWorker(QThread):
    state_changed = Signal(object)
    log_message = Signal(str)

    def __init__(self, config: ClientConfig) -> None:
        super().__init__()
        self.config = config
        self.client: RabiVoiceClient | None = None

    def run(self) -> None:
        self.client = RabiVoiceClient(self.config, state_listener=self.state_changed.emit)
        self.log_message.emit("正在寻找 RabiSpeech 主机…")
        try:
            asyncio.run(self.client.run())
        except Exception as exc:
            self.log_message.emit(f"客户端已停止：{type(exc).__name__}: {exc}")
        finally:
            self.client = None

    def request_stop(self) -> None:
        if self.client is not None:
            self.client.request_stop()


class StatusTile(QFrame):
    def __init__(self, eyebrow: str, title: str, detail: str) -> None:
        super().__init__()
        self.setObjectName("statusTile")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(4)
        label = QLabel(eyebrow)
        label.setObjectName("eyebrow")
        self.title = QLabel(title)
        self.title.setObjectName("tileTitle")
        self.detail = QLabel(detail)
        self.detail.setObjectName("tileDetail")
        self.detail.setWordWrap(True)
        layout.addWidget(label)
        layout.addWidget(self.title)
        layout.addWidget(self.detail)


class VoiceClientWindow(QMainWindow):
    def __init__(self, config_path: Path) -> None:
        super().__init__()
        self.config_path = config_path.resolve()
        self.config_data = load_config_data(self.config_path)
        self.worker: VoiceClientWorker | None = None
        self._closing = False

        self.setWindowTitle("Rabi Voice Client · 远程音频节点")
        self.resize(1080, 720)
        self.setMinimumSize(860, 620)
        icon = _asset_path("rabiroute-icon.png")
        if icon.exists():
            self.setWindowIcon(QIcon(str(icon)))

        self._build_ui()
        self._load_form()
        self._refresh_devices()
        self._set_state(ClientState())
        self.setStyleSheet(STYLESHEET)

        if self.config_path.exists() and self._has_token():
            QTimer.singleShot(450, self.connect_client)

    def _build_ui(self) -> None:
        root = QWidget()
        root.setObjectName("root")
        outer = QVBoxLayout(root)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)

        header = QFrame()
        header.setObjectName("header")
        header_layout = QHBoxLayout(header)
        header_layout.setContentsMargins(28, 20, 28, 18)
        header_layout.setSpacing(14)
        mark = QLabel("R")
        mark.setObjectName("brandMark")
        mark.setAlignment(Qt.AlignCenter)
        mark.setFixedSize(44, 44)
        brand = QVBoxLayout()
        brand.setSpacing(1)
        title = QLabel("Rabi Voice Client")
        title.setObjectName("brandTitle")
        subtitle = QLabel("远程音频节点 · 把这台电脑的麦克风与扬声器安全接入 RabiSpeech")
        subtitle.setObjectName("brandSubtitle")
        brand.addWidget(title)
        brand.addWidget(subtitle)
        self.status_chip = QLabel("未连接")
        self.status_chip.setObjectName("statusChip")
        self.status_chip.setProperty("tone", "offline")
        header_layout.addWidget(mark)
        header_layout.addLayout(brand)
        header_layout.addStretch(1)
        header_layout.addWidget(self.status_chip)
        outer.addWidget(header)

        scroll = QScrollArea()
        scroll.setObjectName("scroll")
        scroll.setWidgetResizable(True)
        body = QWidget()
        body.setObjectName("body")
        body_layout = QVBoxLayout(body)
        body_layout.setContentsMargins(28, 24, 28, 28)
        body_layout.setSpacing(18)

        hero = QFrame()
        hero.setObjectName("hero")
        hero_layout = QHBoxLayout(hero)
        hero_layout.setContentsMargins(22, 20, 22, 20)
        hero_layout.setSpacing(24)
        hero_copy = QVBoxLayout()
        hero_copy.setSpacing(6)
        hero_kicker = QLabel("LAN AUDIO BRIDGE")
        hero_kicker.setObjectName("heroKicker")
        hero_title = QLabel("声音留在房间，智能留在主机。")
        hero_title.setObjectName("heroTitle")
        hero_detail = QLabel("客户端只传输 PCM 与播放 WAV。VAD、转写、Route 广播、人格语音和播放队列仍由 RabiSpeech 统一负责。")
        hero_detail.setObjectName("heroDetail")
        hero_detail.setWordWrap(True)
        hero_copy.addWidget(hero_kicker)
        hero_copy.addWidget(hero_title)
        hero_copy.addWidget(hero_detail)
        self.connect_button = QPushButton("连接主机")
        self.connect_button.setObjectName("primaryButton")
        self.connect_button.clicked.connect(self._toggle_connection)
        hero_layout.addLayout(hero_copy, 1)
        hero_layout.addWidget(self.connect_button)
        body_layout.addWidget(hero)

        status_grid = QGridLayout()
        status_grid.setHorizontalSpacing(12)
        status_grid.setVerticalSpacing(12)
        self.link_tile = StatusTile("连接", "等待连接", "自动发现或指定局域网主机")
        self.capture_tile = StatusTile("麦克风", "等待主机", "只有主机要求采集时才会打开")
        self.playback_tile = StatusTile("扬声器", "空闲", "播放由主机全局 FIFO 调度")
        status_grid.addWidget(self.link_tile, 0, 0)
        status_grid.addWidget(self.capture_tile, 0, 1)
        status_grid.addWidget(self.playback_tile, 0, 2)
        status_grid.setColumnStretch(0, 1)
        status_grid.setColumnStretch(1, 1)
        status_grid.setColumnStretch(2, 1)
        body_layout.addLayout(status_grid)

        columns = QHBoxLayout()
        columns.setSpacing(18)
        columns.addWidget(self._connection_card(), 5)
        columns.addWidget(self._activity_card(), 4)
        body_layout.addLayout(columns)
        body_layout.addStretch(1)
        scroll.setWidget(body)
        outer.addWidget(scroll, 1)
        self.setCentralWidget(root)

    def _connection_card(self) -> QFrame:
        card = QFrame()
        card.setObjectName("card")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(13)
        layout.addWidget(self._section_title("连接设置", "配置保存在客户端本机，不会上传到 RabiRoute 仓库。"))

        form = QGridLayout()
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(10)
        self.server_input = QLineEdit()
        self.server_input.setPlaceholderText("auto 或 ws://192.168.1.10:8782")
        self.token_input = QLineEdit()
        self.token_input.setEchoMode(QLineEdit.Password)
        self.token_input.setPlaceholderText("连接密钥或由环境变量提供")
        self.name_input = QLineEdit()
        self.client_id_input = QLineEdit()
        self.input_combo = QComboBox()
        self.output_combo = QComboBox()
        for combo in (self.input_combo, self.output_combo):
            combo.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
            combo.setMinimumContentsLength(18)
            combo.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.chunk_input = QSpinBox()
        self.chunk_input.setRange(20, 1000)
        self.chunk_input.setSuffix(" ms")
        refresh = QPushButton("刷新设备")
        refresh.setObjectName("secondaryButton")
        refresh.clicked.connect(self._refresh_devices)

        self._add_row(form, 0, "主机地址", self.server_input)
        self._add_row(form, 1, "连接密钥", self.token_input)
        self._add_row(form, 2, "节点名称", self.name_input)
        self._add_row(form, 3, "节点 ID", self.client_id_input)
        self._add_row(form, 4, "输入设备", self.input_combo)
        self._add_row(form, 5, "输出设备", self.output_combo)
        self._add_row(form, 6, "音频分块", self.chunk_input)
        form.addWidget(refresh, 7, 1, Qt.AlignLeft)
        form.setColumnStretch(1, 1)
        layout.addLayout(form)

        note = QLabel("“auto” 只在当前局域网广播发现主机；远端断线不会悄悄改用本机 RabiSpeech 麦克风。")
        note.setObjectName("note")
        note.setWordWrap(True)
        layout.addWidget(note)

        actions = QHBoxLayout()
        actions.addStretch(1)
        save = QPushButton("保存设置")
        save.setObjectName("secondaryButton")
        save.clicked.connect(self.save_settings)
        actions.addWidget(save)
        layout.addLayout(actions)
        return card

    def _activity_card(self) -> QFrame:
        card = QFrame()
        card.setObjectName("card")
        layout = QVBoxLayout(card)
        layout.setContentsMargins(20, 18, 20, 20)
        layout.setSpacing(14)
        layout.addWidget(self._section_title("实时链路", "主机决定何时采集、何时播放；客户端不拥有路由策略。"))

        flow = QHBoxLayout()
        flow.setSpacing(7)
        for index, (glyph, label) in enumerate((("MIC", "房间麦克风"), ("LAN", "加密连接"), ("R", "RabiSpeech"))):
            node = QFrame()
            node.setObjectName("flowNode")
            node_layout = QVBoxLayout(node)
            node_layout.setContentsMargins(8, 10, 8, 10)
            node_layout.setSpacing(3)
            icon = QLabel(glyph)
            icon.setObjectName("flowGlyph")
            icon.setAlignment(Qt.AlignCenter)
            text = QLabel(label)
            text.setObjectName("flowLabel")
            text.setAlignment(Qt.AlignCenter)
            node_layout.addWidget(icon)
            node_layout.addWidget(text)
            flow.addWidget(node, 1)
            if index < 2:
                arrow = QLabel("→")
                arrow.setObjectName("flowArrow")
                flow.addWidget(arrow)
        layout.addLayout(flow)

        level_row = QHBoxLayout()
        level_label = QLabel("采集电平")
        level_label.setObjectName("fieldLabel")
        self.level_value = QLabel("0%")
        self.level_value.setObjectName("meterValue")
        level_row.addWidget(level_label)
        level_row.addStretch(1)
        level_row.addWidget(self.level_value)
        layout.addLayout(level_row)
        self.level_meter = QProgressBar()
        self.level_meter.setRange(0, 100)
        self.level_meter.setTextVisible(False)
        self.level_meter.setFixedHeight(10)
        layout.addWidget(self.level_meter)

        endpoint_label = QLabel("当前端点")
        endpoint_label.setObjectName("fieldLabel")
        self.endpoint_value = QLabel("尚未解析")
        self.endpoint_value.setObjectName("endpoint")
        self.endpoint_value.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.endpoint_value.setWordWrap(True)
        layout.addWidget(endpoint_label)
        layout.addWidget(self.endpoint_value)

        log_label = QLabel("最近事件")
        log_label.setObjectName("fieldLabel")
        self.log_value = QLabel("客户端已就绪。")
        self.log_value.setObjectName("eventLog")
        self.log_value.setWordWrap(True)
        self.log_value.setAlignment(Qt.AlignTop | Qt.AlignLeft)
        layout.addWidget(log_label)
        layout.addWidget(self.log_value, 1)
        return card

    def _section_title(self, title: str, detail: str) -> QFrame:
        frame = QFrame()
        frame.setObjectName("sectionTitle")
        layout = QVBoxLayout(frame)
        layout.setContentsMargins(0, 0, 0, 4)
        layout.setSpacing(2)
        title_label = QLabel(title)
        title_label.setObjectName("sectionHeading")
        detail_label = QLabel(detail)
        detail_label.setObjectName("sectionDetail")
        detail_label.setWordWrap(True)
        layout.addWidget(title_label)
        layout.addWidget(detail_label)
        return frame

    @staticmethod
    def _add_row(layout: QGridLayout, row: int, label: str, widget: QWidget) -> None:
        text = QLabel(label)
        text.setObjectName("fieldLabel")
        layout.addWidget(text, row, 0)
        layout.addWidget(widget, row, 1)

    def _load_form(self) -> None:
        data = self.config_data
        self.server_input.setText(str(data.get("server_url") or "auto"))
        self.token_input.setText(str(data.get("token") or ""))
        self.name_input.setText(str(data.get("name") or ""))
        self.client_id_input.setText(str(data.get("client_id") or ""))
        self.chunk_input.setValue(int(data.get("chunk_ms") or 100))

    def _refresh_devices(self) -> None:
        input_value = self.config_data.get("input_device") if self.input_combo.count() == 0 else self.input_combo.currentData()
        output_value = self.config_data.get("output_device") if self.output_combo.count() == 0 else self.output_combo.currentData()
        self.input_combo.clear()
        self.output_combo.clear()
        self.input_combo.addItem("系统默认输入", None)
        self.output_combo.addItem("系统默认输出", None)
        try:
            for index, device in enumerate(sd.query_devices()):
                name = str(device.get("name") or f"设备 {index}")
                if int(device.get("max_input_channels") or 0) > 0:
                    self.input_combo.addItem(f"{index} · {name}", index)
                if int(device.get("max_output_channels") or 0) > 0:
                    self.output_combo.addItem(f"{index} · {name}", index)
            self._select_data(self.input_combo, input_value)
            self._select_data(self.output_combo, output_value)
            self._append_log("已刷新本机音频设备。")
        except Exception as exc:
            self._append_log(f"读取音频设备失败：{exc}")

    @staticmethod
    def _select_data(combo: QComboBox, value: Any) -> None:
        index = combo.findData(value)
        combo.setCurrentIndex(max(0, index))

    def _form_data(self) -> dict[str, Any]:
        return {
            "server_url": self.server_input.text().strip() or "auto",
            "token_env": str(self.config_data.get("token_env") or "RABISPEECH_AUDIO_STREAM_TOKEN"),
            "token": self.token_input.text().strip(),
            "client_id": self.client_id_input.text().strip(),
            "name": self.name_input.text().strip(),
            "input_device": self.input_combo.currentData(),
            "output_device": self.output_combo.currentData(),
            "sample_rate": 16_000,
            "chunk_ms": self.chunk_input.value(),
            "reconnect_seconds": float(self.config_data.get("reconnect_seconds") or 3),
        }

    def save_settings(self, *, quiet: bool = False) -> bool:
        data = self._form_data()
        try:
            validate_config_data(data, require_token=False)
            save_config_data(self.config_path, data)
        except Exception as exc:
            QMessageBox.warning(self, "设置未保存", str(exc))
            return False
        self.config_data = data
        if not quiet:
            self._append_log(f"设置已保存到 {self.config_path.name}。")
        return True

    def connect_client(self) -> None:
        if self.worker is not None and self.worker.isRunning():
            return
        if not self.save_settings(quiet=True):
            return
        try:
            config = load_config(self.config_path)
        except Exception as exc:
            QMessageBox.warning(self, "无法连接", str(exc))
            return
        self.worker = VoiceClientWorker(config)
        self.worker.state_changed.connect(self._set_state)
        self.worker.log_message.connect(self._append_log)
        self.worker.finished.connect(self._worker_finished)
        self.worker.start()
        self.status_chip.setText("连接中")
        self.status_chip.setProperty("tone", "pending")
        self._repolish(self.status_chip)
        self.connect_button.setText("断开连接")
        self._set_form_enabled(False)

    def disconnect_client(self) -> None:
        if self.worker is None:
            return
        self._append_log("正在断开远程音频链路…")
        self.worker.request_stop()
        self.connect_button.setEnabled(False)

    def _toggle_connection(self) -> None:
        if self.worker is not None and self.worker.isRunning():
            self.disconnect_client()
        else:
            self.connect_client()

    def _worker_finished(self) -> None:
        if self.worker is not None:
            self.worker.deleteLater()
        self.worker = None
        self.connect_button.setEnabled(True)
        self.connect_button.setText("连接主机")
        self._set_form_enabled(True)
        self._set_state(ClientState())
        if not self._closing:
            self._append_log("连接已停止。")

    def _set_form_enabled(self, enabled: bool) -> None:
        for widget in (
            self.server_input,
            self.token_input,
            self.name_input,
            self.client_id_input,
            self.input_combo,
            self.output_combo,
            self.chunk_input,
        ):
            widget.setEnabled(enabled)

    def _set_state(self, state: ClientState) -> None:
        if state.connected:
            self.status_chip.setText("已连接")
            self.status_chip.setProperty("tone", "online")
            self.link_tile.title.setText("链路在线")
            self.link_tile.detail.setText(state.server_url or "已连接到 RabiSpeech")
        elif state.last_error:
            self.status_chip.setText("正在重连")
            self.status_chip.setProperty("tone", "warning")
            self.link_tile.title.setText("连接中断")
            self.link_tile.detail.setText(state.last_error)
        else:
            self.status_chip.setText("未连接")
            self.status_chip.setProperty("tone", "offline")
            self.link_tile.title.setText("等待连接")
            self.link_tile.detail.setText("自动发现或指定局域网主机")
        self._repolish(self.status_chip)

        self.capture_tile.title.setText("正在采集" if state.capture_enabled else "等待主机")
        self.capture_tile.detail.setText("PCM 正在发往主机" if state.capture_enabled else "主机未请求打开麦克风")
        self.playback_tile.title.setText("正在播放" if state.playing else "空闲")
        self.playback_tile.detail.setText("麦克风已暂停，避免声音回录" if state.playing else "等待主机 FIFO 下发音频")
        level = round(state.input_level * 100) if state.capture_enabled else 0
        self.level_meter.setValue(level)
        self.level_value.setText(f"{level}%")
        self.endpoint_value.setText(state.server_url or "尚未解析")
        if state.last_error:
            self._append_log(state.last_error)

    def _append_log(self, message: str) -> None:
        if hasattr(self, "log_value"):
            self.log_value.setText(message)

    def _has_token(self) -> bool:
        token_env = str(self.config_data.get("token_env") or "RABISPEECH_AUDIO_STREAM_TOKEN")
        return bool(str(self.config_data.get("token") or "").strip() or os.environ.get(token_env, "").strip())

    @staticmethod
    def _repolish(widget: QWidget) -> None:
        widget.style().unpolish(widget)
        widget.style().polish(widget)

    def closeEvent(self, event: QCloseEvent) -> None:
        self._closing = True
        if self.worker is not None and self.worker.isRunning():
            self.worker.request_stop()
            self.worker.wait(2500)
        event.accept()


def _asset_path(name: str) -> Path:
    if getattr(sys, "frozen", False):
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent)) / "assets" / name
    return Path(__file__).resolve().parents[3] / "assets" / name


def run_gui(config_path: Path) -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("Rabi Voice Client")
    app.setOrganizationName("RabiRoute")
    app.setFont(QFont("Microsoft YaHei UI", 10))
    window = VoiceClientWindow(config_path)
    window.show()
    return app.exec()


STYLESHEET = """
QWidget { font-family: "Microsoft YaHei UI"; color: #112033; font-size: 13px; }
QWidget#root, QWidget#body, QScrollArea#scroll, QScrollArea#scroll > QWidget > QWidget { background: #f4f9fb; }
QScrollArea#scroll { border: 0; }
QFrame#header { background: #ffffff; border-bottom: 1px solid #dbe5ea; }
QLabel#brandMark { background: #102a43; color: #ffffff; border: 3px solid #bdeced; border-radius: 13px; font-size: 21px; font-weight: 900; }
QLabel#brandTitle { color: #102a43; font-size: 19px; font-weight: 900; }
QLabel#brandSubtitle { color: #667586; font-size: 12px; }
QLabel#statusChip { border-radius: 12px; padding: 5px 12px; font-weight: 800; }
QLabel#statusChip[tone="online"] { background: #eaf8ef; border: 1px solid #b9e3c8; color: #15803d; }
QLabel#statusChip[tone="pending"] { background: #eaf8f9; border: 1px solid #b9e2e4; color: #0f8b8d; }
QLabel#statusChip[tone="warning"] { background: #fff7e6; border: 1px solid #f4d293; color: #a96008; }
QLabel#statusChip[tone="offline"] { background: #eef1f4; border: 1px solid #d8e0e5; color: #687786; }
QFrame#hero { background: #102a43; border: 1px solid #193e5e; border-radius: 12px; }
QLabel#heroKicker { color: #67d9db; font-size: 10px; font-weight: 900; letter-spacing: 2px; }
QLabel#heroTitle { color: #ffffff; font-size: 24px; font-weight: 900; }
QLabel#heroDetail { color: #c8d7e2; font-size: 13px; line-height: 1.45; }
QPushButton { min-height: 38px; border-radius: 8px; padding: 0 15px; font-weight: 800; }
QPushButton#primaryButton { background: #19bfc1; border: 1px solid #67d9db; color: #072b35; min-width: 112px; }
QPushButton#primaryButton:hover { background: #54d2d4; }
QPushButton#primaryButton:disabled { background: #6f8796; border-color: #8298a5; color: #dbe6eb; }
QPushButton#secondaryButton { background: #eef6f8; border: 1px solid #d3dfe5; color: #102a43; }
QPushButton#secondaryButton:hover { background: #e0f4f5; border-color: #a9dddf; }
QFrame#statusTile, QFrame#card { background: #ffffff; border: 1px solid #dbe5ea; border-radius: 10px; }
QLabel#eyebrow { color: #7b8996; font-size: 10px; font-weight: 900; letter-spacing: 1px; }
QLabel#tileTitle { color: #102a43; font-size: 16px; font-weight: 900; }
QLabel#tileDetail { color: #667586; font-size: 11px; }
QFrame#sectionTitle { border-left: 3px solid #19bfc1; padding-left: 10px; }
QLabel#sectionHeading { color: #0c2a4a; font-size: 17px; font-weight: 900; }
QLabel#sectionDetail { color: #667586; font-size: 11px; }
QLabel#fieldLabel { color: #52677a; font-size: 12px; font-weight: 800; }
QLineEdit, QComboBox, QSpinBox { background: #fbfdff; border: 1px solid #cad8e0; border-radius: 8px; min-height: 36px; padding: 0 9px; selection-background-color: #bdeced; }
QLineEdit:focus, QComboBox:focus, QSpinBox:focus { border: 2px solid #19bfc1; }
QLineEdit:disabled, QComboBox:disabled, QSpinBox:disabled { background: #f0f3f5; color: #8491a0; }
QComboBox::drop-down { border: 0; width: 26px; }
QLabel#note { background: #f2fbfc; border: 1px solid #c8e9ea; border-radius: 8px; color: #426579; padding: 10px; font-size: 11px; }
QFrame#flowNode { background: #f7fbfc; border: 1px solid #d6e2e8; border-radius: 9px; }
QLabel#flowGlyph { color: #0f8b8d; font-size: 12px; font-weight: 900; }
QLabel#flowLabel { color: #334e62; font-size: 10px; font-weight: 750; }
QLabel#flowArrow { color: #19bfc1; font-size: 18px; font-weight: 900; }
QProgressBar { background: #e5edf1; border: 0; border-radius: 5px; }
QProgressBar::chunk { background: #19bfc1; border-radius: 5px; }
QLabel#meterValue { color: #0f8b8d; font-weight: 900; }
QLabel#endpoint { background: #f7fafc; border: 1px solid #e1e8ec; border-radius: 7px; color: #36566b; padding: 8px; font-family: Consolas, monospace; font-size: 11px; }
QLabel#eventLog { background: #102a43; border: 1px solid #193e5e; border-radius: 8px; color: #c8e7e8; min-height: 72px; padding: 10px; font-family: Consolas, "Microsoft YaHei UI", monospace; font-size: 11px; }
QScrollBar:vertical { background: #f2f7f9; width: 10px; margin: 2px; border-radius: 5px; }
QScrollBar::handle:vertical { background: #b9cbd3; min-height: 28px; border-radius: 4px; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
"""
