"""AST Parser using tree-sitter — parses source files into normalized Trees."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Iterable

import tree_sitter
import tree_sitter_rust
import tree_sitter_kotlin
import tree_sitter_cpp
import tree_sitter_python as tree_sitter_py

from .tree import Tree
from .node_types import (
    NodeType, rust_node_to_type, kotlin_node_to_type,
    cpp_node_to_type, python_node_to_type,
)


class Language(Enum):
    RUST = "rust"
    KOTLIN = "kotlin"
    CPP = "cpp"
    PYTHON = "python"


_LANGUAGES: dict[Language, tree_sitter.Language] = {
    Language.RUST: tree_sitter.Language(tree_sitter_rust.language()),
    Language.KOTLIN: tree_sitter.Language(tree_sitter_kotlin.language()),
    Language.CPP: tree_sitter.Language(tree_sitter_cpp.language()),
    Language.PYTHON: tree_sitter.Language(tree_sitter_py.language()),
}

_NODE_MAP_FN = {
    Language.RUST: rust_node_to_type,
    Language.KOTLIN: kotlin_node_to_type,
    Language.CPP: cpp_node_to_type,
    Language.PYTHON: python_node_to_type,
}


# ── Stop-words for doc tokenizer ─────────────────────────────────────────────
_STOP_WORDS = frozenset({"the", "and", "for", "this", "that", "with"})

# ── Operator classification sets ─────────────────────────────────────────────
_ARITH_OPS = frozenset({"+", "-", "*", "/", "%", "**"})
_CMP_OPS = frozenset({"==", "!=", "<", ">", "<=", ">=", "===", "!=="})
_LOGIC_OPS = frozenset({"&&", "||", "!"})
_BIT_OPS = frozenset({"&", "|", "^", "~", "<<", ">>"})
_ASSIGN_OPS = frozenset({"=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="})


@dataclass
class IdentifierStats:
    """Frequency map of identifiers found in source code."""

    identifier_freq: dict[str, int] = field(default_factory=dict)
    canonical_freq: dict[str, int] = field(default_factory=dict)
    total_identifiers: int = 0

    @staticmethod
    def canonicalize(name: str) -> str:
        # snake_case, camelCase, and PascalCase normalize to the same token.
        return "".join(ch.lower() for ch in name if ch != "_")

    def add_identifier(self, name: str) -> None:
        if name:
            self.identifier_freq[name] = self.identifier_freq.get(name, 0) + 1
            c = self.canonicalize(name)
            self.canonical_freq[c] = self.canonical_freq.get(c, 0) + 1
            self.total_identifiers += 1

    @staticmethod
    def _cosine_similarity_of(a: dict[str, int], b: dict[str, int]) -> float:
        if not a or not b:
            return 0.0
        all_ids = set(a) | set(b)
        dot = norm1 = norm2 = 0.0
        for ident in all_ids:
            f1 = a.get(ident, 0)
            f2 = b.get(ident, 0)
            dot += f1 * f2
            norm1 += f1 * f1
            norm2 += f2 * f2
        if norm1 < 1e-8 or norm2 < 1e-8:
            return 0.0
        return dot / (math.sqrt(norm1) * math.sqrt(norm2))

    def identifier_cosine_similarity(self, other: IdentifierStats) -> float:
        return self._cosine_similarity_of(self.identifier_freq, other.identifier_freq)

    def canonical_cosine_similarity(self, other: IdentifierStats) -> float:
        return self._cosine_similarity_of(self.canonical_freq, other.canonical_freq)

    def canonical_jaccard_similarity(self, other: IdentifierStats) -> float:
        if not self.canonical_freq and not other.canonical_freq:
            return 1.0
        if not self.canonical_freq or not other.canonical_freq:
            return 0.0
        s1 = set(self.canonical_freq)
        s2 = set(other.canonical_freq)
        union = len(s1 | s2)
        if union == 0:
            return 1.0
        return len(s1 & s2) / union

    # Backward-compat alias.
    def cosine_similarity(self, other: IdentifierStats) -> float:
        return self.identifier_cosine_similarity(other)


@dataclass
class CommentStats:
    """Statistics about comments/documentation in source code."""

    doc_comment_count: int = 0
    line_comment_count: int = 0
    block_comment_count: int = 0
    total_comment_lines: int = 0
    total_doc_lines: int = 0
    doc_texts: list[str] = field(default_factory=list)
    word_freq: dict[str, int] = field(default_factory=dict)

    def doc_coverage_ratio(self) -> float:
        if self.total_comment_lines == 0:
            return 0.0
        return self.total_doc_lines / self.total_comment_lines

    def doc_cosine_similarity(self, other: CommentStats) -> float:
        if not self.word_freq or not other.word_freq:
            return 0.0
        all_words = set(self.word_freq) | set(other.word_freq)
        dot = norm1 = norm2 = 0.0
        for w in all_words:
            f1 = self.word_freq.get(w, 0)
            f2 = other.word_freq.get(w, 0)
            dot += f1 * f2
            norm1 += f1 * f1
            norm2 += f2 * f2
        if norm1 < 1e-8 or norm2 < 1e-8:
            return 0.0
        return dot / (math.sqrt(norm1) * math.sqrt(norm2))

    def doc_jaccard_similarity(self, other: CommentStats) -> float:
        if not self.word_freq and not other.word_freq:
            return 1.0
        if not self.word_freq or not other.word_freq:
            return 0.0
        s1 = set(self.word_freq)
        s2 = set(other.word_freq)
        inter = len(s1 & s2)
        union = len(s1 | s2)
        return inter / union if union else 1.0


class ASTParser:
    """Parses source files into normalized Tree structures using tree-sitter."""

    def __init__(self) -> None:
        self._parsers: dict[Language, tree_sitter.Parser] = {}

    def _get_parser(self, lang: Language) -> tree_sitter.Parser:
        if lang not in self._parsers:
            p = tree_sitter.Parser(_LANGUAGES[lang])
            self._parsers[lang] = p
        return self._parsers[lang]

    # ── Parsing ──────────────────────────────────────────────────────────────

    def _read_combined_files(self, filepaths: Iterable[str | Path]) -> bytes:
        chunks: list[bytes] = []
        for filepath in filepaths:
            chunks.append(Path(filepath).read_bytes())
            chunks.append(b"\n\n")
        return b"".join(chunks)

    def parse_file(self, filepath: str | Path | Iterable[str | Path], lang: Language) -> Tree:
        if isinstance(filepath, (str, Path)):
            source = Path(filepath).read_bytes()
        else:
            source = self._read_combined_files(filepath)
        return self.parse_bytes(source, lang)

    def parse_string(self, source: str, lang: Language) -> Tree:
        return self.parse_bytes(source.encode(), lang)

    def parse_bytes(self, source: bytes, lang: Language) -> Tree:
        parser = self._get_parser(lang)
        ts_tree = parser.parse(source)
        root = ts_tree.root_node
        return self._convert_node(root, source, lang)

    # ── Comment extraction ───────────────────────────────────────────────────

    def extract_comments(self, source: str, lang: Language) -> CommentStats:
        return self.extract_comments_bytes(source.encode(), lang)

    def extract_comments_bytes(self, source: bytes, lang: Language) -> CommentStats:
        parser = self._get_parser(lang)
        ts_tree = parser.parse(source)
        stats = CommentStats()
        self._extract_comments_recursive(ts_tree.root_node, source, lang, stats)
        return stats

    def extract_comments_from_file(
        self,
        filepath: str | Path | Iterable[str | Path],
        lang: Language,
    ) -> CommentStats:
        try:
            if isinstance(filepath, (str, Path)):
                source = Path(filepath).read_bytes()
            else:
                source = self._read_combined_files(filepath)
        except OSError:
            return CommentStats()
        return self.extract_comments_bytes(source, lang)

    # ── Identifier extraction ────────────────────────────────────────────────

    def extract_identifiers(self, source: str, lang: Language) -> IdentifierStats:
        return self.extract_identifiers_bytes(source.encode(), lang)

    def extract_identifiers_bytes(self, source: bytes, lang: Language) -> IdentifierStats:
        parser = self._get_parser(lang)
        ts_tree = parser.parse(source)
        stats = IdentifierStats()
        self._extract_identifiers_recursive(ts_tree.root_node, source, stats)
        return stats

    def extract_identifiers_from_file(
        self,
        filepath: str | Path | Iterable[str | Path],
        lang: Language,
    ) -> IdentifierStats:
        try:
            if isinstance(filepath, (str, Path)):
                source = Path(filepath).read_bytes()
            else:
                source = self._read_combined_files(filepath)
        except OSError:
            return IdentifierStats()
        return self.extract_identifiers_bytes(source, lang)

    # ── Function extraction ──────────────────────────────────────────────────

    def extract_functions(self, source: str, lang: Language) -> list[tuple[str, Tree]]:
        return self.extract_functions_bytes(source.encode(), lang)

    def extract_functions_bytes(self, source: bytes, lang: Language) -> list[tuple[str, Tree]]:
        parser = self._get_parser(lang)
        ts_tree = parser.parse(source)
        functions: list[tuple[str, Tree]] = []
        self._extract_functions_recursive(ts_tree.root_node, source, lang, functions)
        return functions

    @staticmethod
    def _extract_function_body(
        node: tree_sitter.Node, lang: Language
    ) -> tree_sitter.Node | None:
        # Prefer body field when available.
        try:
            body_node = node.child_by_field_name("body")
            if body_node and body_node.type:
                return body_node
        except Exception:
            pass

        # Fallback for grammars where body has a dedicated node.
        for child in node.children:
            if ((lang == Language.CPP and child.type in {"compound_statement", "function_body"}) or
                    (lang in (Language.RUST, Language.KOTLIN, Language.PYTHON) and
                     child.type in {"body", "block", "function_body"})):
                return child
        return None

    @staticmethod
    def text_has_stub_markers(text: str) -> bool:
        lower = text.lower()
        return (
            "todo" in lower or
            "stub" in lower or
            "placeholder" in lower or
            "fixme" in lower or
            "not yet implemented" in lower or
            "not implemented" in lower
        )

    def has_stub_bodies(self, source: str, lang: Language) -> bool:
        parser = self._get_parser(lang)
        ts_tree = parser.parse(source.encode())

        function_types: dict[Language, set[str]] = {
            Language.RUST: {"function_item"},
            Language.KOTLIN: {"function_declaration"},
            Language.CPP: {"function_definition", "function_declarator"},
            Language.PYTHON: {"function_definition"},
        }
        body_types = {
            "function_body",
            "body",
            "block",
            "compound_statement",
            "expression_body",
        }
        marker_types = {
            "line_comment",
            "block_comment",
            "comment",
            "multiline_comment",
            "string_literal",
            "string_content",
            "raw_string_literal",
            "string",
        }

        def body_has_markers(root: tree_sitter.Node) -> bool:
            stack = [root]
            while stack:
                node = stack.pop()
                if node.type in marker_types:
                    text = (node.text or b"").decode(errors="replace")
                    if self.text_has_stub_markers(text):
                        return True
                stack.extend(node.children)
            return False

        stack = [ts_tree.root_node]
        while stack:
            node = stack.pop()
            if node.type in function_types[lang]:
                bodies = [ch for ch in node.children if ch.type in body_types]
                if not bodies:
                    bodies = [node]
                for body in bodies:
                    if body_has_markers(body):
                        return True
            stack.extend(node.children)
        return False

    def has_stub_bodies_in_files(self, filepaths: Iterable[str | Path], lang: Language) -> bool:
        for filepath in filepaths:
            try:
                source = Path(filepath).read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            if self.has_stub_bodies(source, lang):
                return True
        return False

    # ── Internal ─────────────────────────────────────────────────────────────

    def _convert_node(self, node: tree_sitter.Node, source: bytes, lang: Language) -> Tree:
        map_fn = _NODE_MAP_FN[lang]
        normalized_type = map_fn(node.type)
        tree_node = Tree(int(normalized_type), node.type)

        if node.child_count == 0:
            text = node.text
            if text:
                tree_node.label = text.decode(errors="replace")
        else:
            for child in node.children:
                if child.is_named:
                    tree_node.add_child(self._convert_node(child, source, lang))
                else:
                    op = child.type
                    op_type = self._classify_operator(op)
                    if op_type is not None:
                        op_node = Tree(int(op_type), op)
                        tree_node.add_child(op_node)

        return tree_node

    @staticmethod
    def _classify_operator(op: str) -> NodeType | None:
        if op in _ARITH_OPS:
            return NodeType.ARITHMETIC_OP
        if op in _CMP_OPS:
            return NodeType.COMPARISON_OP
        if op in _LOGIC_OPS:
            return NodeType.LOGICAL_OP
        if op in _BIT_OPS:
            return NodeType.BITWISE_OP
        if op in _ASSIGN_OPS:
            return NodeType.ASSIGNMENT_OP
        return None

    def _extract_comments_recursive(
        self, node: tree_sitter.Node, source: bytes,
        lang: Language, stats: CommentStats,
    ) -> None:
        type_s = node.type
        is_comment = False
        is_doc = False

        if lang == Language.KOTLIN:
            is_comment = type_s in ("line_comment", "multiline_comment")
        elif lang == Language.CPP:
            is_comment = type_s == "comment"
        elif lang == Language.RUST:
            is_comment = type_s in ("line_comment", "block_comment")
        elif lang == Language.PYTHON:
            is_comment = type_s == "comment"

        if is_comment:
            text = (node.text or b"").decode(errors="replace")
            lines = text.count("\n") + 1
            stats.total_comment_lines += lines

            if lang == Language.KOTLIN:
                is_doc = text.startswith("/**")
            elif lang == Language.CPP:
                is_doc = text.startswith("/**") or text.startswith("///") or text.startswith("//!")
            elif lang == Language.RUST:
                is_doc = text.startswith("///") or text.startswith("//!") or text.startswith("/**")

            if is_doc:
                stats.doc_comment_count += 1
                stats.total_doc_lines += lines
                stats.doc_texts.append(text)
                _tokenize_doc(text, stats.word_freq)
            elif text.startswith("/*"):
                stats.block_comment_count += 1
            else:
                stats.line_comment_count += 1

        for child in node.children:
            self._extract_comments_recursive(child, source, lang, stats)

    def _extract_identifiers_recursive(
        self, node: tree_sitter.Node, source: bytes, stats: IdentifierStats,
    ) -> None:
        if node.type in ("identifier", "simple_identifier", "type_identifier",
                         "field_identifier", "property_identifier"):
            text = (node.text or b"").decode(errors="replace")
            if len(text) > 1 and text not in ("it", "this"):
                stats.add_identifier(text)

        for child in node.children:
            self._extract_identifiers_recursive(child, source, stats)

    def _extract_functions_recursive(
        self, node: tree_sitter.Node, source: bytes, lang: Language,
        functions: list[tuple[str, Tree]],
    ) -> None:
        is_func = False
        type_s = node.type
        if lang == Language.RUST:
            is_func = type_s == "function_item"
        elif lang == Language.KOTLIN:
            is_func = type_s == "function_declaration"
        elif lang == Language.CPP:
            is_func = type_s in ("function_definition", "function_declarator")
        elif lang == Language.PYTHON:
            is_func = type_s == "function_definition"

        if is_func:
            func_name = ""
            for child in node.children:
                ct = child.type
                if ((lang == Language.RUST and ct == "identifier") or
                    (lang == Language.KOTLIN and ct == "simple_identifier") or
                    (lang == Language.CPP and ct in ("identifier", "field_identifier")) or
                    (lang == Language.PYTHON and ct == "identifier")):
                    func_name = (child.text or b"").decode(errors="replace")
                    break
            func_tree = self._convert_node(node, source, lang)
            functions.append((func_name, func_tree))

        for child in node.children:
            self._extract_functions_recursive(child, source, lang, functions)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _tokenize_doc(text: str, word_freq: dict[str, int]) -> None:
    current: list[str] = []
    for ch in text:
        if ch.isalnum():
            current.append(ch.lower())
        else:
            if len(current) >= 3:
                word = "".join(current)
                if word not in _STOP_WORDS:
                    word_freq[word] = word_freq.get(word, 0) + 1
            current.clear()
    if len(current) >= 3:
        word = "".join(current)
        if word not in _STOP_WORDS:
            word_freq[word] = word_freq.get(word, 0) + 1


def parse_language(s: str) -> Language:
    """Parse a language string into a Language enum."""
    s = s.lower().strip()
    for lang in Language:
        if lang.value == s:
            return lang
    raise ValueError(f"Unknown language: {s!r}. Expected one of: rust, kotlin, cpp, python")
