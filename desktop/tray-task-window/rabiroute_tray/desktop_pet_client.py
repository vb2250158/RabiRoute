from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class DesktopPetState:
    name: str
    kind: str
    asset_urls: tuple[str, ...]
    fps: int
    loop: bool
    next_state: str = ""


@dataclass(frozen=True)
class DesktopPetPack:
    pack_id: str
    name: str
    persona_id: str
    canvas_width: int
    canvas_height: int
    scale: float
    states: dict[str, DesktopPetState]


@dataclass(frozen=True)
class LoadedDesktopPetAnimation:
    state: DesktopPetState
    assets: tuple[bytes, ...]


@dataclass(frozen=True)
class DesktopPetBinding:
    enabled: bool = False
    pack_id: str = ""
    placement: dict[str, object] | None = None
    scale: float = 0.5
    opacity: float = 1.0
    always_on_top: bool = True
    click_through: bool = False
    locked: bool = False
    hide_on_fullscreen: bool = True
    bubble_enabled: bool = True
    fps_cap: int = 15


def _bounded_number(value: object, fallback: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def parse_desktop_pet_catalog(payload: object, persona_id: str) -> tuple[DesktopPetPack, ...]:
    root = payload if isinstance(payload, dict) else {}
    data = root.get("data") if isinstance(root.get("data"), dict) else {}
    if data.get("personaId") != persona_id:
        raise ValueError("Manager desktop pet catalog returned a different persona.")
    rows = data.get("packs") if isinstance(data.get("packs"), list) else []
    packs: list[DesktopPetPack] = []
    for row in rows:
        if not isinstance(row, dict) or row.get("personaId") != persona_id:
            continue
        pack_id = str(row.get("id") or "").strip()
        if not pack_id:
            continue
        canvas = row.get("canvas") if isinstance(row.get("canvas"), dict) else {}
        raw_states = row.get("states") if isinstance(row.get("states"), dict) else {}
        states: dict[str, DesktopPetState] = {}
        for name, raw_state in raw_states.items():
            if not isinstance(name, str) or not isinstance(raw_state, dict):
                continue
            kind = str(raw_state.get("type") or "")
            urls = raw_state.get("assets") if isinstance(raw_state.get("assets"), list) else []
            asset_urls = tuple(str(url) for url in urls if isinstance(url, str) and url.startswith("/"))
            if kind not in {"gif", "png-sequence"} or not asset_urls:
                continue
            states[name] = DesktopPetState(
                name=name,
                kind=kind,
                asset_urls=asset_urls,
                fps=int(_bounded_number(raw_state.get("fps"), 12, 1, 24)),
                loop=raw_state.get("loop") is not False,
                next_state=str(raw_state.get("next") or ""),
            )
        if "idle" not in states:
            continue
        packs.append(
            DesktopPetPack(
                pack_id=pack_id,
                name=str(row.get("name") or pack_id),
                persona_id=persona_id,
                canvas_width=int(_bounded_number(canvas.get("width"), 512, 1, 2048)),
                canvas_height=int(_bounded_number(canvas.get("height"), 512, 1, 2048)),
                scale=_bounded_number(row.get("scale"), 0.5, 0.1, 2),
                states=states,
            )
        )
    return tuple(packs)


class DesktopPetClient:
    """Thin HTTP adapter. Manager remains the only owner of persona pack files."""

    def __init__(
        self,
        manager_url: str,
        persona_id: str,
        timeout_seconds: float = 10.0,
        asset_interval_seconds: float = 0.1,
    ) -> None:
        self.manager_url = manager_url.rstrip("/")
        self.persona_id = persona_id
        self.timeout_seconds = timeout_seconds
        self.asset_interval_seconds = max(0.0, asset_interval_seconds)

    def packs(self) -> tuple[DesktopPetPack, ...]:
        role_id = quote(self.persona_id, safe="")
        payload = json.loads(self._get(f"/api/roles/{role_id}/desktop-pet/packs").decode("utf-8"))
        return parse_desktop_pet_catalog(payload, self.persona_id)

    def binding(self) -> DesktopPetBinding:
        role_id = quote(self.persona_id, safe="")
        payload = json.loads(self._get(f"/api/roles/{role_id}/desktop-pet").decode("utf-8"))
        data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}
        if data.get("personaId") != self.persona_id:
            raise ValueError("Manager desktop pet binding returned a different persona.")
        row = data.get("binding") if isinstance(data.get("binding"), dict) else {}
        placement = row.get("placement") if isinstance(row.get("placement"), dict) else None
        return DesktopPetBinding(
            enabled=row.get("enabled") is True,
            pack_id=str(row.get("packId") or ""),
            placement=placement,
            scale=_bounded_number(row.get("scale"), 0.5, 0.1, 2),
            opacity=_bounded_number(row.get("opacity"), 1, 0.2, 1),
            always_on_top=row.get("alwaysOnTop") is not False,
            click_through=row.get("clickThrough") is True,
            locked=row.get("locked") is True,
            hide_on_fullscreen=row.get("hideOnFullscreen") is not False,
            bubble_enabled=row.get("bubbleEnabled") is not False,
            fps_cap=int(_bounded_number(row.get("fpsCap"), 15, 6, 24)),
        )

    def update_binding(self, patch: dict[str, object]) -> DesktopPetBinding:
        role_id = quote(self.persona_id, safe="")
        url = urljoin(f"{self.manager_url}/", f"api/roles/{role_id}/desktop-pet")
        body = json.dumps({"personaId": self.persona_id, **patch}, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=body, method="PATCH", headers={"content-type": "application/json; charset=utf-8"})
        with urlopen(request, timeout=self.timeout_seconds) as response:
            payload = json.loads(response.read().decode("utf-8"))
        data = payload.get("data") if isinstance(payload, dict) and isinstance(payload.get("data"), dict) else {}
        row = data.get("binding") if isinstance(data.get("binding"), dict) else {}
        return DesktopPetBinding(
            enabled=row.get("enabled") is True,
            pack_id=str(row.get("packId") or ""),
            placement=row.get("placement") if isinstance(row.get("placement"), dict) else None,
            scale=_bounded_number(row.get("scale"), 0.5, 0.1, 2),
            opacity=_bounded_number(row.get("opacity"), 1, 0.2, 1),
            always_on_top=row.get("alwaysOnTop") is not False,
            click_through=row.get("clickThrough") is True,
            locked=row.get("locked") is True,
            hide_on_fullscreen=row.get("hideOnFullscreen") is not False,
            bubble_enabled=row.get("bubbleEnabled") is not False,
            fps_cap=int(_bounded_number(row.get("fpsCap"), 15, 6, 24)),
        )

    def load_animation(self, pack: DesktopPetPack, state_name: str) -> LoadedDesktopPetAnimation:
        if pack.persona_id != self.persona_id:
            raise ValueError("Desktop pet pack belongs to a different persona.")
        state = pack.states.get(state_name) or pack.states.get("idle")
        if state is None:
            raise ValueError("Desktop pet pack has no idle state.")
        assets: list[bytes] = []
        for index, url in enumerate(state.asset_urls):
            assets.append(self._get(url))
            if index + 1 < len(state.asset_urls) and self.asset_interval_seconds:
                time.sleep(self.asset_interval_seconds)
        return LoadedDesktopPetAnimation(state=state, assets=tuple(assets))

    def _get(self, path_or_url: str) -> bytes:
        url = urljoin(f"{self.manager_url}/", path_or_url.lstrip("/"))
        request = Request(url, method="GET", headers={"accept": "application/json, image/gif, image/png"})
        for attempt in range(6):
            try:
                with urlopen(request, timeout=self.timeout_seconds) as response:
                    return response.read()
            except HTTPError as error:
                if error.code not in {429, 503} or attempt >= 5:
                    raise
            except (URLError, OSError):
                if attempt >= 5:
                    raise
            time.sleep(min(0.25 * (2**attempt), 4.0))

        raise RuntimeError("desktop pet request retry loop exited unexpectedly")
