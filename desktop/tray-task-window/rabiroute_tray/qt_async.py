from __future__ import annotations

from collections.abc import Callable
from typing import Any

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Qt, Signal, Slot


_ACTIVE_QT_TASKS: set[QRunnable] = set()


class _QtTaskSignals(QObject):
    finished = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self._task: QtAsyncTask | None = None
        self._completed_callback: Callable[[QtAsyncTask, Any], None] | None = None
        self.finished.connect(self._dispatch, Qt.QueuedConnection)

    def bind(self, task: "QtAsyncTask", completed_callback: Callable[["QtAsyncTask", Any], None]) -> None:
        self._task = task
        self._completed_callback = completed_callback

    @Slot(object)
    def _dispatch(self, result: Any) -> None:
        task = self._task
        completed_callback = self._completed_callback
        if task is None or completed_callback is None:
            return
        try:
            completed_callback(task, result)
        finally:
            _ACTIVE_QT_TASKS.discard(task)
            self._task = None
            self._completed_callback = None
            self.deleteLater()


class QtAsyncTask(QRunnable):
    """Runs one backend callable and publishes its result on the Qt UI thread."""

    def __init__(
        self,
        operation: Callable[[], Any],
        on_error: Callable[[Exception], Any] | None = None,
    ) -> None:
        super().__init__()
        self.setAutoDelete(False)
        self.operation = operation
        self.on_error = on_error
        self.signals = _QtTaskSignals()

    @Slot()
    def run(self) -> None:
        try:
            result = self.operation()
        except Exception as error:
            result = self.on_error(error) if self.on_error is not None else error
        self.signals.finished.emit(result)


def start_qt_task(
    operation: Callable[[], Any],
    completed_callback: Callable[[QtAsyncTask, Any], None],
    *,
    on_error: Callable[[Exception], Any] | None = None,
    started_callback: Callable[[QtAsyncTask], None] | None = None,
) -> QtAsyncTask:
    task = QtAsyncTask(operation, on_error)
    task.signals.bind(task, completed_callback)
    if started_callback is not None:
        started_callback(task)
    _ACTIVE_QT_TASKS.add(task)
    QThreadPool.globalInstance().start(task)
    return task


def wait_for_qt_tasks(timeout_ms: int = 5_000) -> bool:
    return QThreadPool.globalInstance().waitForDone(timeout_ms)
