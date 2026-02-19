"""Task file manager for coordinating swarm agents."""

from __future__ import annotations

import fcntl
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path


class TaskStatus(Enum):
    PENDING = "pending"
    ASSIGNED = "assigned"
    COMPLETED = "completed"
    BLOCKED = "blocked"


@dataclass
class PortTask:
    source_path: str = ""
    source_qualified: str = ""
    target_path: str = ""
    target_qualified: str = ""
    dependent_count: int = 0
    dependency_count: int = 0
    status: TaskStatus = TaskStatus.PENDING
    assigned_to: str = ""
    assigned_at: str = ""
    completed_at: str = ""
    similarity: float = 0.0
    dependencies: list[str] = field(default_factory=list)
    dependents: list[str] = field(default_factory=list)


class _FileLock:
    """RAII file lock using flock() for Unix advisory locking."""

    def __init__(self, path: str) -> None:
        self._lock_path = path + ".lock"
        self._fd: int | None = None

    def __enter__(self) -> _FileLock:
        import os
        self._fd = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o666)
        fcntl.flock(self._fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc: object) -> None:
        import os
        if self._fd is not None:
            fcntl.flock(self._fd, fcntl.LOCK_UN)
            os.close(self._fd)
            self._fd = None


class TaskManager:
    """Task file manager for coordinating swarm agents."""

    def __init__(self, task_file: str | Path) -> None:
        self.task_file_path = str(task_file)
        self.source_root: str = ""
        self.target_root: str = ""
        self.source_lang: str = ""
        self.target_lang: str = ""
        self.agents_md_path: str = ""
        self.tasks: list[PortTask] = []

    def load(self) -> bool:
        try:
            data = json.loads(Path(self.task_file_path).read_text())
        except (OSError, json.JSONDecodeError):
            return False

        self.source_root = data.get("source_root", "")
        self.target_root = data.get("target_root", "")
        self.source_lang = data.get("source_lang", "")
        self.target_lang = data.get("target_lang", "")
        self.agents_md_path = data.get("agents_md", "")

        self.tasks = []
        for t in data.get("tasks", []):
            task = PortTask(
                source_path=t.get("source_path", ""),
                source_qualified=t.get("source_qualified", ""),
                target_path=t.get("target_path", ""),
                target_qualified=t.get("target_qualified", ""),
                dependent_count=t.get("dependent_count", 0),
                dependency_count=t.get("dependency_count", 0),
                assigned_to=t.get("assigned_to", ""),
                assigned_at=t.get("assigned_at", ""),
                completed_at=t.get("completed_at", ""),
                similarity=t.get("similarity", 0.0),
            )
            status_str = t.get("status", "pending")
            try:
                task.status = TaskStatus(status_str)
            except ValueError:
                task.status = TaskStatus.PENDING
            if task.source_path:
                self.tasks.append(task)
        return True

    def save(self) -> bool:
        data = {
            "source_root": self.source_root,
            "target_root": self.target_root,
            "source_lang": self.source_lang,
            "target_lang": self.target_lang,
            "agents_md": self.agents_md_path,
            "tasks": [],
        }
        for t in self.tasks:
            td: dict = {
                "source_path": t.source_path,
                "source_qualified": t.source_qualified,
                "target_path": t.target_path,
                "dependent_count": t.dependent_count,
                "status": t.status.value,
            }
            if t.assigned_to:
                td["assigned_to"] = t.assigned_to
            if t.assigned_at:
                td["assigned_at"] = t.assigned_at
            if t.completed_at:
                td["completed_at"] = t.completed_at
            data["tasks"].append(td)

        try:
            Path(self.task_file_path).write_text(
                json.dumps(data, indent=2) + "\n")
            return True
        except OSError:
            return False

    def assign_next(self, agent_id: str) -> PortTask | None:
        """Assign highest-priority pending task. Thread-safe via flock."""
        with _FileLock(self.task_file_path):
            if not self.load():
                return None
            pending = [t for t in self.tasks if t.status == TaskStatus.PENDING]
            if not pending:
                return None
            pending.sort(key=lambda t: t.dependent_count, reverse=True)
            task = pending[0]
            task.status = TaskStatus.ASSIGNED
            task.assigned_to = agent_id
            task.assigned_at = _now()
            if not self.save():
                task.status = TaskStatus.PENDING
                task.assigned_to = ""
                task.assigned_at = ""
                return None
            return task

    def complete_task(self, source_qualified: str) -> bool:
        with _FileLock(self.task_file_path):
            if not self.load():
                return False
            for t in self.tasks:
                if t.source_qualified == source_qualified:
                    t.status = TaskStatus.COMPLETED
                    t.completed_at = _now()
                    return self.save()
        return False

    def release_task(self, source_qualified: str) -> bool:
        with _FileLock(self.task_file_path):
            if not self.load():
                return False
            for t in self.tasks:
                if t.source_qualified == source_qualified and t.status == TaskStatus.ASSIGNED:
                    t.status = TaskStatus.PENDING
                    t.assigned_to = ""
                    t.assigned_at = ""
                    return self.save()
        return False

    def get_stats(self) -> dict[str, int]:
        counts = {"pending": 0, "assigned": 0, "completed": 0, "blocked": 0}
        for t in self.tasks:
            counts[t.status.value] = counts.get(t.status.value, 0) + 1
        return counts

    def read_agents_md(self) -> str:
        if not self.agents_md_path:
            return ""
        try:
            return Path(self.agents_md_path).read_text()
        except OSError:
            return ""

    def format_assignment(self, task: PortTask, agent_number: int) -> str:
        prefix = "##" if self.target_lang == "python" else "//"
        lines = [
            "=== TASK ASSIGNMENT ===\n",
            f"You are agent #{agent_number}",
            f"Reminder: all ast_distance commands require: --agent {agent_number}\n",
            "Source File:",
            f"  Path:      {self.source_root}/{task.source_path}",
            f"  Qualified: {task.source_qualified}",
            f"  Dependents: {task.dependent_count} files depend on this\n",
            "Target File:",
            f"  Path:      {self.target_root}/{task.target_path}",
            f"  Add header: {prefix} port-lint: source {task.source_path}\n",
            f"Priority: {task.dependent_count} (higher = more critical)\n",
        ]
        agents_content = self.read_agents_md()
        if agents_content:
            lines.append("=== PORTING GUIDELINES (from AGENTS.md) ===\n")
            lines.append(agents_content)
            lines.append("")

        lines.extend([
            "=== INSTRUCTIONS ===\n",
            "1. Read the source file thoroughly",
            "2. Create the target file at the target path",
            "3. Add the port-lint header as the first line",
            "4. Transliterate the source code to idiomatic target language",
            "5. Match documentation comments from the source",
            f"6. Run: ast_distance --agent {agent_number} <source> {self.source_lang} <target> {self.target_lang}",
            "   to verify similarity (aim for >0.85)",
            f"7. When complete, run: ast_distance --agent {agent_number} --complete {self.task_file_path} {task.source_qualified}",
        ])
        return "\n".join(lines) + "\n"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
