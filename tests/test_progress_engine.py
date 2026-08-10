"""Black-box tests for the standalone private progress engine."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
CURRICULUM_PATH = REPO_ROOT / "config" / "curriculum.json"
SUBJECTS = ("comprehensive", "case", "essay")


def run_cli(
    data_dir: Path | None,
    *arguments: str,
    content_dir: Path | None = None,
    expected_returncode: int | None = 0,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, "-m", "progress_engine"]
    if data_dir is not None:
        command.extend(("--data-dir", str(data_dir)))
    if content_dir is not None:
        command.extend(("--content-dir", str(content_dir)))
    command.extend(arguments)
    completed = subprocess.run(
        command,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )
    if expected_returncode is not None and completed.returncode != expected_returncode:
        raise AssertionError(
            f"command returned {completed.returncode}, expected {expected_returncode}: "
            f"{' '.join(command)}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    return completed


def json_output(completed: subprocess.CompletedProcess[str]) -> dict[str, Any]:
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"expected JSON output:\n{completed.stdout}") from error
    if not isinstance(value, dict):
        raise AssertionError(f"expected JSON object, got {type(value).__name__}")
    return value


def make_content_clone(root: Path, curriculum: dict[str, Any]) -> None:
    """Create a metadata-only public-content fixture with all mapped resources."""

    for topic in curriculum["topics"]:
        for resource in topic.get("resources", []):
            target = root / resource.split("#", 1)[0]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()


class ProgressEngineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.curriculum = json.loads(CURRICULUM_PATH.read_text(encoding="utf-8"))

    def init(self, data_dir: Path) -> None:
        run_cli(
            data_dir,
            "init",
            "--exam-date",
            "2026-11-07",
            "--daily-minutes",
            "45",
            "--background",
            "backend",
        )

    def status(self, data_dir: Path) -> dict[str, Any]:
        return json_output(run_cli(data_dir, "status", "--json"))

    def record(
        self,
        data_dir: Path,
        attempt_id: str,
        item_id: str,
        score: int,
        at: str,
    ) -> subprocess.CompletedProcess[str]:
        return run_cli(
            data_dir,
            "record",
            "--topic",
            "K08.SOFTWARE_PROCESS_MODELS",
            "--skill",
            "recognition",
            "--attempt-id",
            attempt_id,
            "--item-id",
            item_id,
            "--score",
            str(score),
            "--max-score",
            "1",
            "--confidence",
            "sure",
            "--at",
            at,
        )

    def test_cold_start_never_invents_progress(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = Path(temporary) / "learner"
            before_init = run_cli(
                data_dir, "status", "--json", expected_returncode=None
            )
            self.assertEqual(before_init.returncode, 2)
            self.assertIn("缺少私人档案", before_init.stderr)

            self.init(data_dir)
            status = self.status(data_dir)
            self.assertEqual(status["topics"], {})
            self.assertIsNone(status["last_session_at"])
            for subject in SUBJECTS:
                self.assertEqual(status["subjects"][subject]["status"], "unmeasured")
                self.assertEqual(
                    status["subjects"][subject]["evidence_level"], "cold_start"
                )

    def test_default_state_uses_user_application_data_not_repository(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fake_home = Path(temporary) / "home"
            fake_home.mkdir()
            environment = dict(os.environ)
            environment["HOME"] = str(fake_home)
            environment.pop("SENIOR_ARCHITECT_DATA_DIR", None)
            environment.pop("XDG_DATA_HOME", None)
            completed = run_cli(None, "init", env=environment)
            created = Path(completed.stdout.split("：", 1)[1].splitlines()[0])
            self.assertTrue(created.is_relative_to(fake_home.resolve()))
            self.assertFalse(created.is_relative_to(REPO_ROOT))
            self.assertNotIn(".study", created.parts)
            self.assertTrue((created / "state.json").is_file())
            self.assertFalse((REPO_ROOT / ".study").exists())

    def test_external_content_clone_is_used_for_resource_checks(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_dir = root / "learner"
            content_dir = root / "public-review-clone"
            make_content_clone(content_dir, self.curriculum)

            healthy = json_output(
                run_cli(
                    data_dir,
                    "doctor",
                    "--json",
                    content_dir=content_dir,
                )
            )
            self.assertTrue(healthy["healthy"])
            curriculum_check = next(
                check for check in healthy["checks"] if check["name"] == "curriculum"
            )
            self.assertTrue(curriculum_check["healthy"])

            first_resource = self.curriculum["topics"][0]["resources"][0]
            (content_dir / first_resource.split("#", 1)[0]).unlink()
            broken = run_cli(
                data_dir,
                "doctor",
                "--json",
                content_dir=content_dir,
                expected_returncode=1,
            )
            self.assertIn(first_resource, broken.stdout)

    def test_weak_subject_is_a_hard_recommendation_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = Path(temporary) / "learner"
            self.init(data_dir)
            for minute, (subject, score) in enumerate(
                (("comprehensive", 70), ("case", 44), ("essay", 70))
            ):
                run_cli(
                    data_dir,
                    "mock",
                    "--subject",
                    subject,
                    "--mock-id",
                    f"hard-gate-{subject}",
                    "--paper-id",
                    f"fixture-{subject}",
                    "--score",
                    str(score),
                    "--duration-minutes",
                    "90",
                    "--complete",
                    "--at",
                    f"2026-08-10T10:0{minute}:00+08:00",
                )
            payload = json_output(
                run_cli(
                    data_dir,
                    "recommend",
                    "--json",
                    "--limit",
                    "6",
                    "--today",
                    "2026-08-10",
                )
            )
            self.assertEqual(payload["target_subject"], "case")
            self.assertEqual(payload["recommendations"][0]["subject"], "case")
            allocation = payload["subject_allocation"]
            self.assertGreater(allocation["case"], allocation["comprehensive"])
            self.assertGreater(allocation["case"], allocation["essay"])

    def test_latest_wrong_answer_downgrades_pass_ready_mastery(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = Path(temporary) / "learner"
            self.init(data_dir)
            for number in range(6):
                day = 10 if number < 3 else 11
                self.record(
                    data_dir,
                    f"pass-{number}",
                    f"independent-{number}",
                    1,
                    f"2026-08-{day:02d}T10:{number:02d}:00+08:00",
                )
            before = self.status(data_dir)["topics"]["K08.SOFTWARE_PROCESS_MODELS"]
            self.assertEqual(before["mastery"]["recognition"]["status"], "pass_ready")

            self.record(
                data_dir,
                "regression",
                "new-wrong-item",
                0,
                "2026-08-12T10:00:00+08:00",
            )
            after = self.status(data_dir)["topics"]["K08.SOFTWARE_PROCESS_MODELS"]
            recognition = after["mastery"]["recognition"]
            self.assertEqual(recognition["status"], "fragile")
            self.assertTrue(recognition["regression_active"])
            self.assertEqual(recognition["next_review_at"], "2026-08-13")

    def test_record_and_mock_are_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = Path(temporary) / "learner"
            self.init(data_dir)
            arguments = (
                "record",
                "--topic",
                "K08.SOFTWARE_PROCESS_MODELS",
                "--skill",
                "recognition",
                "--attempt-id",
                "same-attempt",
                "--item-id",
                "same-item",
                "--score",
                "1",
                "--max-score",
                "1",
                "--at",
                "2026-08-10T10:00:00+08:00",
            )
            run_cli(data_dir, *arguments)
            first = self.status(data_dir)
            repeated = run_cli(data_dir, *arguments)
            second = self.status(data_dir)
            self.assertIn("幂等跳过", repeated.stdout)
            self.assertEqual(first, second)
            events = (data_dir / "attempts.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(events), 1)

            mock_arguments = (
                "mock",
                "--subject",
                "case",
                "--mock-id",
                "same-mock",
                "--paper-id",
                "same-paper",
                "--score",
                "50",
                "--duration-minutes",
                "90",
                "--complete",
                "--at",
                "2026-08-10T11:00:00+08:00",
            )
            run_cli(data_dir, *mock_arguments)
            repeated_mock = run_cli(data_dir, *mock_arguments)
            self.assertIn("幂等跳过", repeated_mock.stdout)
            self.assertEqual(len(self.status(data_dir)["subjects"]["case"]["mock_scores"]), 1)

    def test_concurrent_records_are_serialized_without_lost_updates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            data_dir = Path(temporary) / "learner"
            self.init(data_dir)
            processes: list[subprocess.Popen[str]] = []
            for number in range(8):
                command = [
                    sys.executable,
                    "-m",
                    "progress_engine",
                    "--data-dir",
                    str(data_dir),
                    "record",
                    "--topic",
                    "K08.SOFTWARE_PROCESS_MODELS",
                    "--skill",
                    "recognition",
                    "--attempt-id",
                    f"concurrent-{number}",
                    "--item-id",
                    f"concurrent-item-{number}",
                    "--score",
                    "1",
                    "--max-score",
                    "1",
                    "--at",
                    f"2026-08-10T10:{number:02d}:00+08:00",
                ]
                processes.append(
                    subprocess.Popen(
                        command,
                        cwd=REPO_ROOT,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                    )
                )
            failures = []
            for process in processes:
                stdout, stderr = process.communicate(timeout=30)
                if process.returncode != 0:
                    failures.append((process.returncode, stdout, stderr))
            self.assertEqual(failures, [])
            recognition = self.status(data_dir)["topics"]
            recognition = recognition["K08.SOFTWARE_PROCESS_MODELS"]["mastery"]
            self.assertEqual(recognition["recognition"]["attempt_count"], 8)
            events = (data_dir / "attempts.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(events), 8)
            self.assertEqual(
                len({json.loads(event)["attempt_id"] for event in events}), 8
            )

    def test_wal_replay_backup_doctor_and_repair(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            data_dir = root / "learner"
            content_dir = root / "content"
            make_content_clone(content_dir, self.curriculum)
            self.init(data_dir)
            original_state = (data_dir / "state.json").read_bytes()
            original_backup = (data_dir / "state.json.bak").read_bytes()
            self.record(
                data_dir,
                "wal-event",
                "wal-item",
                1,
                "2026-08-10T10:00:00+08:00",
            )
            (data_dir / "state.json").write_bytes(original_state)
            (data_dir / "state.json.bak").write_bytes(original_backup)

            replayed = self.status(data_dir)
            recognition = replayed["topics"]["K08.SOFTWARE_PROCESS_MODELS"]["mastery"]
            self.assertEqual(recognition["recognition"]["attempt_count"], 1)
            healthy = json_output(
                run_cli(
                    data_dir,
                    "doctor",
                    "--json",
                    content_dir=content_dir,
                )
            )
            self.assertTrue(healthy["healthy"])

            (data_dir / "state.json").write_text("{broken", encoding="utf-8")
            broken = run_cli(
                data_dir,
                "doctor",
                "--json",
                content_dir=content_dir,
                expected_returncode=1,
            )
            self.assertIn("invalid/corrupt", broken.stdout)
            run_cli(data_dir, "repair")
            repaired = self.status(data_dir)
            self.assertEqual(
                repaired["topics"]["K08.SOFTWARE_PROCESS_MODELS"]["mastery"]
                ["recognition"]["attempt_count"],
                1,
            )
            final_doctor = json_output(
                run_cli(
                    data_dir,
                    "doctor",
                    "--json",
                    content_dir=content_dir,
                )
            )
            self.assertTrue(final_doctor["healthy"])


if __name__ == "__main__":
    unittest.main()
