from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QFrame, QLabel, QProgressBar, QPushButton

from rabiroute_tray.manager_client import ManagerSnapshot
from rabiroute_tray.role_context_repository import ContextEntry, RoleContextSnapshot
from rabiroute_tray.task_repository import PlanItem, PlanSnapshot, PlanStep
from rabiroute_tray.task_window import ExpandableCard, KeywordPanel, MessageComposer, STYLESHEET, TaskWindow, VIEW_LABELS
from rabiroute_tray.theme import RABI_MENU_STYLESHEET, apply_rabi_menu_theme


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

    def test_menu_theme_matches_webgui_light_palette(self) -> None:
        self.assertIn("background: #ffffff", RABI_MENU_STYLESHEET)
        self.assertIn("background: #eaf8f9", RABI_MENU_STYLESHEET)
        self.assertIn("color: #0c2a4a", RABI_MENU_STYLESHEET)
        self.assertIn("background: #e5ebef", RABI_MENU_STYLESHEET)

        apply_rabi_menu_theme(self.window.more_menu)
        self.assertEqual(self.window.more_menu.styleSheet(), RABI_MENU_STYLESHEET)

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

    def test_chat_groups_messages_under_one_separator_per_day(self) -> None:
        self.window.role_messages = [
            {"direction": "assistant", "sender": "Agent", "text": "第一条", "time": 1_768_579_200},
            {"direction": "user", "sender": "本地用户", "text": "第二条", "time": 1_768_579_260},
        ]
        self.window.set_view("chat")
        self.app.processEvents()

        separators = self.window.content_body.findChildren(QLabel, "timeSeparator")
        times = self.window.content_body.findChildren(QLabel, "chatTime")
        self.assertEqual(len(separators), 1)
        self.assertEqual(len(times), 2)
        self.assertTrue(all(len(label.text()) == 5 for label in times))

    def test_chat_attachment_uses_compact_file_row(self) -> None:
        attachment = self.window._attachment_widget({"name": "report.zip", "size": 1_572_864})
        self.assertEqual(attachment.objectName(), "chatAttachment")
        self.assertEqual(attachment.findChild(QLabel, "chatAttachmentName").text(), "report.zip")
        self.assertEqual(attachment.findChild(QLabel, "chatAttachmentSize").text(), "1.5 MB")
        attachment.close()

    def test_message_composer_sends_on_enter_and_keeps_shift_enter_for_newline(self) -> None:
        composer = MessageComposer()
        send_count = 0

        def record_send() -> None:
            nonlocal send_count
            send_count += 1

        composer.send_requested.connect(record_send)
        composer.show()
        QTest.keyClick(composer, Qt.Key_Return)
        self.assertEqual(send_count, 1)
        QTest.keyClick(composer, Qt.Key_Return, Qt.ShiftModifier)
        self.assertEqual(send_count, 1)
        self.assertIn("\n", composer.toPlainText())
        composer.close()

    def test_pending_send_keeps_draft_and_prevents_duplicate_submit(self) -> None:
        sent: list[tuple[str, list[dict]]] = []
        self.window.send_message_requested.connect(lambda text, attachments: sent.append((text, attachments)))
        self.window.message_input.setPlainText("耗时投递")

        self.window._send_message()
        self.window.set_message_send_pending(True)
        self.window._send_message()

        self.assertEqual(sent, [("耗时投递", [])])
        self.assertEqual(self.window.message_input.toPlainText(), "耗时投递")
        self.assertFalse(self.window.send_button.isEnabled())
        self.assertIn("正在投递", self.window.footer_label.text())

        self.window.complete_message_send(True)
        self.assertEqual(self.window.message_input.toPlainText(), "")
        self.assertTrue(self.window.send_button.isEnabled())

    def test_failed_send_restores_composer_without_clearing_draft(self) -> None:
        self.window.message_input.setPlainText("请保留这条消息")
        self.window.set_message_send_pending(True)
        self.window.complete_message_send(False)

        self.assertEqual(self.window.message_input.toPlainText(), "请保留这条消息")
        self.assertTrue(self.window.send_button.isEnabled())

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

    def test_expanding_card_reveals_all_keywords_in_one_wrapped_line(self) -> None:
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
        self.assertTrue(card.keywords_panel.expanded_values.isVisible())
        for keyword in ["PangHu", "Bug", "工会", "Guild", "编号1187", "messageId:12345"]:
            self.assertIn(keyword, card.keywords_panel.expanded_values.text())
        card.close()

    def test_collapsed_plan_adds_current_step_as_third_summary_row(self) -> None:
        plan = PlanItem(
            title="折叠计划摘要测试",
            status="进行中",
            current_step_id="implementation",
            steps=[
                PlanStep("需求确认", "已完成", step_id="requirements"),
                PlanStep("实现界面", "进行中", step_id="implementation"),
            ],
        )
        card = ExpandableCard("计划", plan.title, [], "plan", ["界面", "计划"], status=plan.status, plan=plan)
        card.show()
        self.app.processEvents()

        self.assertTrue(card.current_step_line.isVisible())
        self.assertEqual(card.current_step_value.text(), "第 2 步 · 实现界面")
        self.assertTrue(card.keywords_panel.summary_line.isVisible())

        card.set_expanded(True)
        self.app.processEvents()
        self.assertFalse(card.current_step_line.isVisible())
        card.close()

    def test_collapsed_legacy_plan_uses_current_step_text(self) -> None:
        plan = PlanItem(title="旧计划", status="进行中", current_step="整理历史资料")
        card = ExpandableCard("计划", plan.title, [], "plan", [], status=plan.status, plan=plan)
        card.show()
        self.app.processEvents()

        self.assertEqual(card.current_step_value.text(), "整理历史资料")
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
            current_step_id="step-3",
            next_action="完成页面实现",
            steps=[
                PlanStep(step.title, step.status, step.detail, step.completed_at, f"step-{index}")
                for index, step in enumerate(steps, start=1)
            ],
        )
        card = ExpandableCard("计划", plan.title, [("类型", "ui")], "plan", [], status=plan.status, plan=plan)
        card.resize(720, 620)
        card.show()
        card.set_expanded(True)
        self.app.processEvents()

        summary_values = [label.text() for label in card.findChildren(QLabel, "planSummaryValue")]
        self.assertEqual(summary_values, [])
        current_callout = card.findChild(QLabel, "planCurrentStepCallout")
        self.assertIsNotNone(current_callout)
        self.assertEqual(current_callout.text(), "当前执行：第 3 步 · 信息架构")
        progress = card.findChild(QProgressBar, "planProgressBar")
        self.assertIsNotNone(progress)
        self.assertEqual(progress.value(), 2)
        self.assertEqual(progress.maximum(), 7)
        self.assertEqual(len(card.findChildren(QFrame, "planStepRow")), 7)
        current_rows = [
            row for row in card.findChildren(QFrame, "planStepRow") if row.property("stepTone") == "current"
        ]
        self.assertEqual(len(current_rows), 1)
        card.close()

    def test_blocked_plan_prioritizes_blocker_and_marks_current_step(self) -> None:
        blocker = "私人订阅尚未导入，VPN 未恢复。"
        plan = PlanItem(
            title="阻塞计划测试",
            status="进行中",
            current_step_id="restore-vpn",
            next_action="重装应用",
            blocked_by="无法访问 Google Play",
            steps=[
                PlanStep("安装 Clash", "已完成", step_id="install-clash"),
                PlanStep("恢复 VPN", "进行中", step_id="restore-vpn", blocked_by=blocker),
                PlanStep("重装应用", step_id="reinstall"),
            ],
        )
        card = ExpandableCard("计划", plan.title, [], "plan", [], status=plan.status, plan=plan)
        card.resize(720, 520)
        card.show()
        card.set_expanded(True)
        self.app.processEvents()

        self.assertEqual(card.status_label.text(), "状态：阻塞中")
        self.assertEqual(card.status_label.property("statusTone"), "blocked")
        current_callout = card.findChild(QLabel, "planCurrentStepCallout")
        self.assertEqual(current_callout.text(), "当前阻塞：第 2 步 · 恢复 VPN")
        self.assertTrue(current_callout.property("blocked"))
        summary_labels = [label.text() for label in card.findChildren(QLabel, "planSummaryLabel")]
        summary_values = [label.text() for label in card.findChildren(QLabel, "planSummaryValue")]
        self.assertEqual(summary_labels, ["阻塞原因"])
        self.assertEqual(summary_values, [blocker])
        blocked_rows = [
            row for row in card.findChildren(QFrame, "planStepRow") if row.property("stepTone") == "blocked"
        ]
        self.assertEqual(len(blocked_rows), 1)
        self.assertEqual(blocked_rows[0].findChild(QLabel, "planStepState").text(), "已阻塞")
        self.assertNotIn("重装应用", summary_values)
        card.close()

    def test_waiting_qa_plan_uses_purple_status_badge(self) -> None:
        plan = PlanItem(
            title="等待 QA 的计划",
            status="进行中",
            current_step="修复已完成，等待 QA 真机结果",
            current_step_id="verify",
            steps=[
                PlanStep("实施修复", "已完成", step_id="implement"),
                PlanStep("等待QA完成验收", "进行中", step_id="verify"),
            ],
        )
        card = ExpandableCard("计划", plan.title, [], "plan", [], status=plan.status, plan=plan)
        card.show()
        self.app.processEvents()

        self.assertEqual(card.status_label.text(), "状态：待QA测试")
        self.assertEqual(card.status_label.property("statusTone"), "qa")
        card.close()

    def test_future_qa_step_does_not_change_running_status_badge(self) -> None:
        plan = PlanItem(
            title="仍在开发的计划",
            status="进行中",
            current_step="正在实现已批准方案",
            current_step_id="implement",
            steps=[
                PlanStep("实施修复", "进行中", step_id="implement"),
                PlanStep("等待QA完成验收", "未开始", step_id="verify"),
            ],
        )
        card = ExpandableCard("计划", plan.title, [], "plan", [], status=plan.status, plan=plan)
        card.show()
        self.app.processEvents()

        self.assertEqual(card.status_label.text(), "状态：进行中")
        self.assertEqual(card.status_label.property("statusTone"), "running")
        card.close()

    def test_plan_metadata_keeps_primary_fields_compact_and_secondary_fields_collapsed(self) -> None:
        plan = PlanItem(title="资料折叠测试")
        card = ExpandableCard(
            "计划",
            plan.title,
            [("优先级", "中"), ("类型", "需人工接管"), ("来源", "每日拆分"), ("文件", "C:/plan.json")],
            "plan",
            [],
            status=plan.status,
            plan=plan,
        )
        card.show()
        card.set_expanded(True)
        self.app.processEvents()

        summary = card.findChild(QLabel, "planMetadataSummary")
        details = card.findChild(QFrame, "planMetadataDetails")
        toggle = card.findChild(QPushButton, "planMetadataToggle")
        self.assertIn("优先级：中", summary.text())
        self.assertFalse(details.isVisible())
        toggle.click()
        self.app.processEvents()
        self.assertTrue(details.isVisible())
        self.assertEqual(toggle.text(), "收起计划资料")
        card.close()


if __name__ == "__main__":
    unittest.main()
