from __future__ import annotations


class CompanionFailureNotice:
    """Keep one failure incident across review retries until an actual reply arrives."""

    def __init__(self) -> None:
        self._session_id: str | None = None
        self._notified: tuple[str, str] | None = None

    def update(self, session: dict, *, can_notify: bool) -> str | None:
        session_id = session.get("id")
        if session_id != self._session_id:
            self._session_id = session_id
            self._notified = None
        review = session.get("review") or {}
        if review.get("status") == "replied":
            self._notified = None
        error = review.get("error")
        if review.get("status") != "failed" or not error or not can_notify:
            return None
        code = str(review.get("errorCode") or "")
        incident = (code, "" if code else str(error))
        if incident == self._notified:
            return None
        self._notified = incident
        return {
            "COMPANION_CONTEXT_FAILED": "companionContextFailed",
        }.get(code, "companionProcessingFailed")
