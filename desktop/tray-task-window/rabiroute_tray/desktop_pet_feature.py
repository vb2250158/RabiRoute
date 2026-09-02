from __future__ import annotations

from .desktop_feature_runtime import DesktopFeatureContext
from .desktop_pet_manager import DesktopPetManager


def activate(context: DesktopFeatureContext):
    """Attach Manager-owned persona avatar renderers to the Qt host."""
    manager = DesktopPetManager(
        context.manager_url,
        context.desktop_pet_menu,
        context.open_desktop_pet_persona,
    )
    return manager.close
