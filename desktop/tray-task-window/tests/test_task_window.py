from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from PySide6.QtWidgets import QApplication, QFrame, QLabel, QProgressBar, QPushButton

from rabiroute_tray.manager_client import ManagerSnapshot
from rabiroute_tray.role_context_repository import ContextEntry, RoleContextSnapshot
from rabiroute_tray.task_repository import PlanItem, PlanSnapshot, PlanStep
from rabiroute_tray.task_window import ExpandableCard, KeywordPanel, STYLESHEET, TaskWindow, VIEW_LABELS


class TaskWindowLayoutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        role_dir = Path("C:/RabiRoute/data/roles/Rabi")
        route_dir = Path("C:/RabiRoute/data/route/default-main")
        gateway = {
            "id": "default-main",
            "name": "默认航线",
            "routeName": "默认航线",
            "configName": "默认航线",
            "agentRoleId": "Rabi",
            "roleRouteNames": {"Rabi 默认看板娘": "Rabi"},
            "messageAdapters": ["rolePanel", "napcat"],
            "enabled": True,
            "running": True,
        }
        self.manager = ManagerSnapshot(
            connected=True,
            manager_url="http://127.0.0.1:8790",
            meta={},
            gateways=[gateway],
        )
        current_plan = PlanItem(
            title="优化托盘角色面板布局",
            status="进行中",
            priority="高",
            current_step="核对视图",
            next_action="完成实装",
            keywords=["托盘", "布局"],
            path=role_dir / "plans" / "items" / "active" / "tray-layout.json",
        )
        self.plans = PlanSnapshot(
            role_id="Rabi",
            role_dir=role_dir,
            plans_dir=role_dir / "plans",
            current=[current_plan],
            active=[current_plan],
            archived=[PlanItem(title="已完成计划", status="已归档")],
        )
        self.context = RoleContextSnapshot(
            role_dir=role_dir,
            route_dir=route_dir,
            recent_memory=[ContextEntry(title="界面约束", keywords=["布局"])],
            consolidated_memory=[ContextEntry(title="桌面入口原则", keywords=["只读"])],
            status_lines=["NapCat 已连接：True"],
        )
        self.window = TaskWindow()
        self.window.render(self.manager, gateway, self.plans, self.context, [])
        self.window.show()
        self.app.processEvents()

    def tearDown(self) -> None:
        self.window.close()
        self.window.deleteLater()
        self.app.processEvents()

    def test_all_six_views_are_primary_navigation_buttons(self) -> None:
        self.assertEqual(list(self.window.view_buttons), [key for key, _label in VIEW_LABELS])
        self.assertEqual(len(self.window.view_buttons), 6)

    def test_theme_matches_webgui_light_palette(self) -> None:
        self.assertIn("background: #f6f8fb", STYLESHEET)
        self.assertIn("color: #102a43", STYLESHEET)
        self.assertIn("#19bfc1", STYLESHEET)
        self.assertNotIn("background: #1b1e1e", STYLESHEET)

    def test_six_view_navigation_fits_minimum_window_width(self) -> None:
        self.window.resize(self.window.minimumSize())
        self.app.processEvents()
        right_edge = max(button.geometry().right() for button in self.window.view_buttons.values())
        self.assertLessEqual(right_edge, self.window.view_bar.contentsRect().right())

    def test_chat_composer_is_visible_only_for_chat(self) -> None:
        for view_key, _label in VIEW_LABELS:
            self.window.set_view(view_key)
            self.app.processEvents()
            self.assertEqual(self.window.chat_input_frame.isVisible(), view_key == "chat")

    def test_current_view_separates_plans_and_recent_memory(self) -> None:
        self.window.set_view("current")
        self.app.processEvents()
        titles = [label.text() for label in self.window.findChildren(QLabel, "sectionTitle")]
        self.assertEqual(titles, ["进行中计划", "近期记忆"])

    def test_status_view_uses_read_only_status_table(self) -> None:
        self.window.set_view("status")
        self.app.processEvents()
        self.assertIsNotNone(self.window.findChild(QLabel, "statusTableHeader"))
        keys = [label.text() for label in self.window.findChildren(QLabel, "statusTableKey")]
        self.assertIn("Manager", keys)
        self.assertIn("Manager 地址", keys)
        self.assertIn("运行状态文件", keys)

    def test_runtime_chip_exposes_semantic_status_tone(self) -> None:
        self.assertEqual(self.window.status_chip.property("statusTone"), "running")

    def test_overflow_menu_contains_actions_not_duplicate_views(self) -> None:
        self.window.set_actions([("人格目录", lambda: None, True)])
        menu_texts = [action.text() for action in self.window.more_menu.actions() if action.text()]
        self.assertIn("人格目录", menu_texts)
        self.assertIn("刷新", menu_texts)
        self.assertNotIn("近期记忆", menu_texts)
        self.assertNotIn("已归档", menu_texts)
        self.assertNotIn("诊断", menu_texts)

    def test_collapsed_keyword_summary_reveals_more_as_width_grows(self) -> None:
        panel = KeywordPanel(["PangHu", "Bug", "工会", "Guild", "编号1187", "messageId:12345"])
        narrow_text, narrow_count = panel._summary_for_width(150)
        wide_text, wide_count = panel._summary_for_width(1200)
        self.assertIn(KeywordPanel.OVERFLOW_INDICATOR, narrow_text)
        self.assertNotIn("+", narrow_text)
        self.assertGreater(wide_count, narrow_count)
        self.assertNotIn(KeywordPanel.OVERFLOW_INDICATOR, wide_text)

    def test_expanding_card_reveals_all_keyword_chips(self) -> None:
        card = ExpandableCard(
            "计划",
            "关键词展开测试",
            [("详情", "测试")],
            "plan",
            ["PangHu", "Bug", "工会", "Guild", "编号1187", "messageId:12345"],
        )
        card.resize(500, 240)
        card.show()
        self.app.processEvents()
        self.assertTrue(card.keywords_panel.summary_line.isVisible())
        self.assertFalse(card.keywords_panel.expanded_panel.isVisible())
        card.set_expanded(True)
        self.app.processEvents()
        self.assertFalse(card.keywords_panel.summary_line.isVisible())
        self.assertTrue(card.keywords_panel.expanded_panel.isVisible())
        self.assertTrue(all(chip.isVisible() for chip in card.keywords_panel.keyword_chips))
        card.close()

    def test_expanded_plan_uses_structured_summary_and_real_step_progress(self) -> None:
        steps = [
            PlanStep("需求梳理", "已完成", completed_at="05-24 10:45"),
            PlanStep("竞品分析", "已完成", completed_at="05-24 11:20"),
            PlanStep("信息架构", "进行中"),
            PlanStep("线框图"),
            PlanStep("视觉规范"),
            PlanStep("页面实现"),
            PlanStep("联调验收"),
        ]
        plan = PlanItem(
            title="计划展开结构测试",
            status="进行中",
            current_step="信息架构",
            next_action="完成页面实现",
            steps=steps,
        )
        card = ExpandableCard("计划", plan.title, [("类型", "ui")], "plan", [], status=plan.status, plan=plan)
        card.resize(720, 620)
        card.show()
        card.set_expanded(True)
        self.app.processEvents()

        summary_values = [label.text() for label in card.findChildren(QLabel, "planSummaryValue")]
        self.assertEqual(summary_values, ["信息架构", "完成页面实现"])
        progress = card.findChild(QProgressBar, "planProgressBar")
        self.assertIsNotNone(progress)
        self.assertEqual(progress.value(), 2)
        self.assertEqual(progress.maximum(), 7)
        self.assertEqual(len(card.findChildren(QFrame, "planStepRow")), 6)

        more_button = card.findChild(QPushButton, "planMoreStepsButton")
        self.assertIsNotNone(more_button)
        more_button.click()
        self.app.processEvents()
        self.assertEqual(len(card.findChildren(QFrame, "planStepRow")), 7)
        card.close()


if __name__ == "__main__":
    unittest.main()
