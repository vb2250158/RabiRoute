from __future__ import annotations

import json
import sys
from pathlib import Path

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from rabiroute_tray.role_context_repository import RoleContextRepository


def test_role_context_resolves_only_same_directory_persona_avatars(tmp_path: Path) -> None:
    role_dir = tmp_path / "data" / "roles" / "Rabi"
    route_dir = tmp_path / "data" / "route" / "main"
    role_dir.mkdir(parents=True)
    route_dir.mkdir(parents=True)
    avatar_path = role_dir / "avatar-123456789abc.png"
    avatar_path.write_bytes(b"png")
    (role_dir / "personaConfig.json").write_text(
        json.dumps({"avatar": avatar_path.name}),
        encoding="utf-8",
    )

    snapshot = RoleContextRepository(tmp_path).load(role_dir, route_dir)
    assert snapshot.avatar_path == avatar_path

    (role_dir / "personaConfig.json").write_text(
        json.dumps({"avatar": "../outside.png"}),
        encoding="utf-8",
    )
    assert RoleContextRepository(tmp_path).load(role_dir, route_dir).avatar_path is None
