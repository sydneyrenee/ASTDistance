"""Porting utilities: TODO scanning, lint checks, stub detection, line counting."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class TodoItem:
    file_path: str = ""
    line_num: int = 0
    tag: str = ""
    message: str = ""
    context: list[str] = field(default_factory=list)
    kt_line_start: int = 0
    kt_line_end: int = 0


@dataclass
class LintError:
    file_path: str = ""
    line_num: int = 0
    type: str = ""
    message: str = ""


@dataclass
class FileStats:
    path: str = ""
    relative_path: str = ""
    line_count: int = 0
    code_lines: int = 0
    comment_lines: int = 0
    blank_lines: int = 0
    is_stub: bool = False
    has_header_guard: bool = False
    transliterated_from: str = ""
    todos: list[TodoItem] = field(default_factory=list)
    lint_errors: list[LintError] = field(default_factory=list)


_TODO_RE = re.compile(r"//\s*TODO(\([^)]*\))?:\s*(.+)")
_LINE_REF_RE = re.compile(r"Line\s+(\d+)(?:-(\d+))?", re.IGNORECASE)
_TRANS_RE = re.compile(r"Transliterated from:\s*(.+)", re.IGNORECASE)
_PORTLINT_RE = re.compile(r"port-lint:\s*(?:source|tests)\s+(.+)", re.IGNORECASE)


class PortingAnalyzer:
    """Porting analysis utilities."""

    @staticmethod
    def scan_todos(filepath: str | Path, context_lines: int = 3) -> list[TodoItem]:
        try:
            lines = Path(filepath).read_text(errors="replace").splitlines()
        except OSError:
            return []

        todos: list[TodoItem] = []
        for i, line in enumerate(lines):
            m = _TODO_RE.search(line)
            if not m:
                continue
            todo = TodoItem(file_path=str(filepath), line_num=i + 1)
            tag_part = m.group(1) or ""
            if len(tag_part) > 2:
                todo.tag = tag_part[1:-1]
            todo.message = m.group(2)

            lm = _LINE_REF_RE.search(todo.message)
            if lm:
                todo.kt_line_start = int(lm.group(1))
                todo.kt_line_end = int(lm.group(2)) if lm.group(2) else todo.kt_line_start

            start = max(0, i - context_lines)
            end = min(len(lines), i + context_lines + 1)
            for j in range(start, end):
                prefix = ">>> " if j == i else "    "
                todo.context.append(f"{prefix}{j + 1:4d}: {lines[j]}")

            todos.append(todo)
        return todos

    @staticmethod
    def extract_transliterated_from(filepath: str | Path) -> str:
        try:
            text = Path(filepath).read_text(errors="replace")
        except OSError:
            return ""
        for line in text.splitlines()[:50]:
            m = _TRANS_RE.search(line)
            if m:
                return m.group(1).strip()
            m = _PORTLINT_RE.search(line)
            if m:
                result = m.group(1).strip()
                if result.startswith("codex-rs/"):
                    result = result[9:]
                return result
        return ""

    @staticmethod
    def analyze_file(filepath: str | Path) -> FileStats:
        filepath = Path(filepath)
        stats = FileStats(path=str(filepath), relative_path=filepath.name)
        try:
            content = filepath.read_text(errors="replace")
        except OSError:
            return stats

        in_block_comment = False
        for line in content.splitlines():
            stats.line_count += 1
            trimmed = line.lstrip()
            if not trimmed:
                stats.blank_lines += 1
            elif trimmed.startswith("//"):
                stats.comment_lines += 1
            elif "/*" in trimmed:
                stats.comment_lines += 1
                if "*/" not in trimmed:
                    in_block_comment = True
            elif in_block_comment:
                stats.comment_lines += 1
                if "*/" in trimmed:
                    in_block_comment = False
            else:
                stats.code_lines += 1

        # Header guard check
        ext = filepath.suffix
        if ext in (".hpp", ".h", ".hxx", ".hh"):
            stats.has_header_guard = "#pragma once" in content or "#ifndef" in content
        else:
            stats.has_header_guard = True

        # Stub detection
        clean = re.sub(r"//[^\n]*", "", content)
        clean = re.sub(r"/\*[\s\S]*?\*/", "", clean)
        clean = re.sub(r"#include[^\n]*", "", clean)
        clean = re.sub(r"namespace[^\{]*\{?", "", clean)
        clean = re.sub(r"#pragma[^\n]*", "", clean)
        clean = "".join(clean.split())
        # Length-based stub detection is only reliable for C/C++ skeleton files.
        # For other languages we rely on AST-based stub detection (TODO()/pass/unimplemented!/etc).
        is_cpp_like = ext in (".cpp", ".cc", ".cxx", ".hpp", ".h", ".hxx", ".hh")
        stats.is_stub = is_cpp_like and len(clean) < 50

        stats.transliterated_from = PortingAnalyzer.extract_transliterated_from(filepath)
        stats.todos = PortingAnalyzer.scan_todos(filepath)

        return stats

    @staticmethod
    def lint_file(filepath: str | Path) -> list[LintError]:
        filepath = Path(filepath)
        errors: list[LintError] = []
        ext = filepath.suffix
        if ext in (".hpp", ".h", ".hxx", ".hh"):
            try:
                content = filepath.read_text(errors="replace")
            except OSError:
                return errors
            if "#pragma once" not in content and "#ifndef" not in content:
                errors.append(LintError(
                    file_path=str(filepath), line_num=1,
                    type="missing_guard",
                    message="Missing header guard (#pragma once or #ifndef)",
                ))
        return errors
