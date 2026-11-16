"""Project plugin-owned audio onto the existing pet; never open an audio device."""
from __future__ import annotations


class AssistantPresentation:
    def __init__(self, persona_id: str) -> None:
        self.persona_id = persona_id
        self.owner = ""
        self.started_at = 0
        self.revision = -1
        self.response = ""

    def accept(self, payload: object, current_job: dict) -> dict | None:
        if not isinstance(payload, dict) or payload.get("personaId") != self.persona_id:
            return None
        owner, started, revision = payload.get("ownerId"), payload.get("ownerStartedAt"), payload.get("revision")
        if not isinstance(owner, str) or not owner or not isinstance(started, int) or not isinstance(revision, int):
            return None
        if started < self.started_at or owner == self.owner and revision <= self.revision:
            return None
        if owner != self.owner:
            if started <= self.started_at:
                return None
            self.owner, self.started_at = owner, started
        self.revision = revision
        if payload.get("clear"):
            return {} if current_job.get("assistantOwner") == owner else None
        response = payload.get("responseId")
        if not isinstance(response, str) or not response:
            return None
        self.response = response
        status = payload.get("speechStatus")
        return {"id": response, "assistantOwner": owner, "playbackId": payload.get("playbackId"),
                "text": str(payload.get("text") or ""), "spokenEnd": payload.get("spokenEnd", 0),
                "status": "playing" if status == "playing" and payload.get("outputEnabled", True) else "stopped"}
