"""ast_distance — cross-language AST comparison and porting tools.

This package uses lazy imports so `ast_distance --help` works even when optional
parser dependencies are not installed or are incompatible.
"""

from __future__ import annotations

import importlib
from typing import Any

__all__ = [
    "NodeType", "node_type_name",
    "rust_node_to_type", "kotlin_node_to_type", "cpp_node_to_type", "python_node_to_type",
    "Tree",
    "ASTParser", "Language", "CommentStats", "IdentifierStats",
    "ASTSimilarity",
    "Codebase", "CodebaseComparator", "SourceFile", "Match",
    "ImportExtractor", "Import", "PackageDecl",
    "TaskManager", "TaskStatus", "PortTask",
    "PortingAnalyzer", "FileStats", "TodoItem", "LintError",
]

_LAZY: dict[str, tuple[str, str]] = {
    "NodeType": (".node_types", "NodeType"),
    "node_type_name": (".node_types", "node_type_name"),
    "rust_node_to_type": (".node_types", "rust_node_to_type"),
    "kotlin_node_to_type": (".node_types", "kotlin_node_to_type"),
    "cpp_node_to_type": (".node_types", "cpp_node_to_type"),
    "python_node_to_type": (".node_types", "python_node_to_type"),
    "Tree": (".tree", "Tree"),
    "ASTParser": (".ast_parser", "ASTParser"),
    "Language": (".ast_parser", "Language"),
    "CommentStats": (".ast_parser", "CommentStats"),
    "IdentifierStats": (".ast_parser", "IdentifierStats"),
    "ASTSimilarity": (".similarity", "ASTSimilarity"),
    "Codebase": (".codebase", "Codebase"),
    "CodebaseComparator": (".codebase", "CodebaseComparator"),
    "SourceFile": (".codebase", "SourceFile"),
    "Match": (".codebase", "Match"),
    "ImportExtractor": (".imports", "ImportExtractor"),
    "Import": (".imports", "Import"),
    "PackageDecl": (".imports", "PackageDecl"),
    "TaskManager": (".task_manager", "TaskManager"),
    "TaskStatus": (".task_manager", "TaskStatus"),
    "PortTask": (".task_manager", "PortTask"),
    "PortingAnalyzer": (".porting_utils", "PortingAnalyzer"),
    "FileStats": (".porting_utils", "FileStats"),
    "TodoItem": (".porting_utils", "TodoItem"),
    "LintError": (".porting_utils", "LintError"),
}


def __getattr__(name: str) -> Any:
    target = _LAZY.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    mod_name, attr = target
    mod = importlib.import_module(mod_name, __name__)
    value = getattr(mod, attr)
    globals()[name] = value  # Cache for subsequent lookups.
    return value


def __dir__() -> list[str]:
    return sorted(set(list(globals().keys()) + list(__all__)))
