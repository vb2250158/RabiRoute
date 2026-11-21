"""Project the active voice assistant's input and playback onto its pet."""
from __future__ import annotations
import re


def speech_bubble_segment(text: str, spoken_end: int) -> tuple[int, str]:
    """Project the sentence currently spoken; never accumulate the entire task."""
    cursor = max(0, min(len(text) - 1, spoken_end - 1))
    for match in re.finditer(r"[^。！？!?\n]{1,240}[。！？!?\n]*|[。！？!?\n]+", text):
        if cursor < match.end():
            return match.start(), match.group().strip()
    return 0, text[:240]


class AssistantPresentation:
    def __init__(self, persona_id: str) -> None:
        self.persona_id = persona_id
        self.owner = ""
        self.started_at = 0
        self.revision = -1
        self.input_preview: tuple[str, bool] | None = None
        self._last_job: dict | None = None

    def accept(self, payload: object, current_job: dict) -> dict | None:
        if not isinstance(payload, dict) or payload.get("personaId") != self.persona_id:
            return None
        owner, started, revision = payload.get("ownerId"), payload.get("ownerStartedAt"), payload.get("revision")
        if not isinstance(owner, str) or not owner or not isinstance(started, int) or not isinstance(revision, int):
            return None
        same_owner = owner == self.owner and started == self.started_at
        if started < self.started_at or same_owner and revision <= self.revision:
            return None
        previous_owner = self.owner
        if not same_owner:
            if started <= self.started_at:
                return None
            self.owner, self.started_at = owner, started
            self._last_job = None
        self.revision = revision
        preview = payload.get("inputPreview")
        self.input_preview = None
        if not payload.get("clear") and isinstance(preview, dict):
            text, final = preview.get("text"), preview.get("final")
            if isinstance(text, str) and isinstance(final, bool):
                self.input_preview = (text[-4000:], final)
        if payload.get("clear"):
            self._last_job = None
            return {} if current_job.get("assistantOwner") in (owner, previous_owner) else None
        response = payload.get("responseId")
        if not isinstance(response, str) or not response:
            self._last_job = None
            return {} if current_job.get("assistantOwner") in (owner, previous_owner) else None
        status = payload.get("speechStatus")
        text = str(payload.get("speechText") if payload.get("speechText") is not None else payload.get("text") or "")
        spoken_end = payload.get("spokenEnd", 0)
        offset = payload.get("textOffset", 0)
        start, segment = speech_bubble_segment(text, max(0, spoken_end - offset) if isinstance(spoken_end, int) and isinstance(offset, int) else 0)
        job = {"id": response, "assistantOwner": owner, "playbackId": payload.get("playbackId"),
               "text": segment, "bubbleKey": f"{owner}:{started}:{response}:{payload.get('playbackId')}:{start}",
               "status": "playing" if status == "playing" and payload.get("outputEnabled", True) else "stopped"}
        if job == self._last_job:
            return None
        self._last_job = job
        return job
