from __future__ import annotations

from .desktop_feature_runtime import DesktopFeatureContext
from .desktop_pet_controller import DesktopPetController


def activate(context: DesktopFeatureContext):
    """Attach the Manager-owned YeYu animation renderer to the Qt host."""
    controller = DesktopPetController(
        context.manager_url,
        "YeYu",
        context.open_desktop_pet_persona,
    )
    controller.visibility_changed.connect(
        lambda visible: context.desktop_pet_action.setText("隐藏夜雨桌宠" if visible else "显示夜雨桌宠")
    )
    controller.click_through_changed.connect(context.desktop_pet_click_through_action.setChecked)
    context.desktop_pet_action.triggered.connect(lambda _checked=False: controller.toggle())
    context.desktop_pet_click_through_action.toggled.connect(controller.set_click_through)
    return controller.close
