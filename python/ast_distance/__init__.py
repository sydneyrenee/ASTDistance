"""ast_distance — cross-language AST comparison and porting tools."""

from .node_types import NodeType, node_type_name
from .node_types import rust_node_to_type, kotlin_node_to_type, cpp_node_to_type, python_node_to_type
from .tree import Tree
from .ast_parser import ASTParser, Language, CommentStats, IdentifierStats
from .similarity import ASTSimilarity
from .codebase import Codebase, CodebaseComparator, SourceFile, Match
from .imports import ImportExtractor, Import, PackageDecl
from .task_manager import TaskManager, TaskStatus, PortTask
from .porting_utils import PortingAnalyzer, FileStats, TodoItem, LintError

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
