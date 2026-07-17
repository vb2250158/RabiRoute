from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

TRAY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TRAY_ROOT))

from rabiroute_tray.task_repository import PlanRepository


class PlanRepositoryTest(unittest.TestCase):
    def test_reads_optional_step_details_without_inventing_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            project_root = Path(temporary_directory)
            plan_dir = project_root / "data" / "roles" / "Rabi" / "plans" / "items" / "active"
            plan_dir.mkdir(parents=True)
            (plan_dir / "plan.json").write_text(
                json.dumps(
                    {
                        "title": "结构化计划",
                        "status": "进行中",
                        "createdAt": "2026-07-17T10:00:00+08:00",
                        "waitingFor": "设计确认",
                        "steps": [
                            {"title": "需求梳理", "completed": True, "completedAt": "10:30"},
                            {"title": "界面实现", "current": True},
                            "联调验收",
                        ],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            snapshot = PlanRepository(project_root).load()
            plan = snapshot.current[0]
            self.assertEqual(plan.created_at, "2026-07-17T10:00:00+08:00")
            self.assertEqual(plan.waiting_for, "设计确认")
            self.assertEqual([step.status for step in plan.steps], ["已完成", "进行中", "未开始"])
            self.assertEqual(plan.steps[0].completed_at, "10:30")


if __name__ == "__main__":
    unittest.main()
