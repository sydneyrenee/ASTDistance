"""Codebase scanning, import resolution, dependency graphs, and cross-codebase comparison."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .ast_parser import ASTParser, Language
from .imports import ImportExtractor, Import, PackageDecl
from .porting_utils import PortingAnalyzer, FileStats, TodoItem, LintError
from .similarity import ASTSimilarity


# ── Valid extensions per language ────────────────────────────────────────────

_VALID_EXTENSIONS: dict[str, frozenset[str]] = {
    "rust": frozenset({".rs"}),
    "kotlin": frozenset({".kt", ".kts"}),
    "cpp": frozenset({".cpp", ".hpp", ".cc", ".h", ".hxx", ".hh"}),
    "python": frozenset({".py"}),
}

_SKIP_DIRS = frozenset({
    "target", "build", "build_", "_deps", "__pycache__",
    ".git", "node_modules", "dist", ".tox", ".mypy_cache",
})

_HEADER_EXTENSIONS = frozenset({".hpp", ".h", ".hxx", ".hh"})


# ── SourceFile ──────────────────────────────────────────────────────────────

@dataclass
class SourceFile:
    """A source file with metadata, imports, dependency info, and porting analysis."""

    paths: list[str] = field(default_factory=list)
    relative_path: str = ""
    filename: str = ""
    stem: str = ""
    qualified_name: str = ""
    extension: str = ""

    package: PackageDecl = field(default_factory=PackageDecl)
    imports: list[Import] = field(default_factory=list)
    imported_by: set[str] = field(default_factory=set)
    depends_on: set[str] = field(default_factory=set)

    dependent_count: int = 0
    dependency_count: int = 0

    similarity_score: float = 0.0
    matched_file: str = ""

    transliterated_from: str = ""
    line_count: int = 0
    code_lines: int = 0
    is_stub: bool = False
    todos: list[TodoItem] = field(default_factory=list)
    lint_errors: list[LintError] = field(default_factory=list)

    def identity(self) -> str:
        if self.package.parts:
            return self.package.path
        return self.qualified_name

    @staticmethod
    def make_qualified_name(rel_path: str) -> str:
        p = Path(rel_path)
        parts = [
            s for s in p.parent.parts
            if s and s != "." and s != "src"
        ]
        stem = p.stem
        if parts:
            return f"{parts[-1]}.{stem}"
        return stem

    @staticmethod
    def normalize_name(name: str) -> str:
        result: list[str] = []
        prev_lower = False
        for ch in name:
            if ch == "_":
                continue
            result.append(ch.lower())
            prev_lower = ch.islower()
        return "".join(result)

    @staticmethod
    def is_header(ext: str) -> bool:
        return ext in _HEADER_EXTENSIONS


# ── Codebase ────────────────────────────────────────────────────────────────

class Codebase:
    """Scans a directory tree, extracts imports, and builds a dependency graph."""

    def __init__(self, root: str, language: str) -> None:
        self.root_path = root
        self.language = language
        self.files: dict[str, SourceFile] = {}
        self.by_stem: dict[str, list[str]] = {}
        self.by_qualified: dict[str, str] = {}

    def scan(self) -> None:
        valid_ext = _VALID_EXTENSIONS.get(self.language, frozenset())
        root = Path(self.root_path)

        # Handle single file input
        if root.is_file():
            if root.suffix in valid_ext:
                sf = SourceFile(
                    paths=[str(root)],
                    relative_path=root.name,
                    filename=root.name,
                    stem=root.stem,
                    extension=root.suffix,
                    qualified_name=SourceFile.make_qualified_name(root.name),
                )
                key = sf.stem
                self.files[key] = sf
                self.by_stem.setdefault(sf.stem, []).append(key)
                self.by_qualified[sf.qualified_name] = key
            return

        for entry in _walk_files(root):
            if entry.suffix not in valid_ext:
                continue
            rel = str(entry.relative_to(root))

            stem = entry.stem
            directory = str(Path(rel).parent)
            if directory == ".":
                directory = ""

            # Group platform/variant files into one logical unit.
            normalized_stem = stem
            for suffix in (".common", ".concurrent", ".native", ".common_native", ".darwin", ".apple"):
                if normalized_stem.endswith(suffix):
                    normalized_stem = normalized_stem[: -len(suffix)]
                    break
            logical_key = normalized_stem if not directory else f"{directory}/{normalized_stem}"

            if logical_key in self.files:
                sf = self.files[logical_key]
                sf.paths.append(str(entry))
                if entry.suffix in _HEADER_EXTENSIONS:
                    sf.filename = entry.name
                    sf.extension = entry.suffix
                    sf.relative_path = rel
            else:
                sf = SourceFile(
                    paths=[str(entry)],
                    relative_path=rel,
                    filename=entry.name,
                    stem=stem,
                    extension=entry.suffix,
                    qualified_name=SourceFile.make_qualified_name(rel),
                )
                self.files[logical_key] = sf
                self.by_stem.setdefault(sf.stem, []).append(logical_key)
                self.by_qualified[sf.qualified_name] = logical_key

        # Disambiguate duplicate stems
        for _stem, keys in self.by_stem.items():
            if len(keys) <= 1:
                continue
            # Sort: headers first, then shorter paths
            keys.sort(key=lambda key: (
                not SourceFile.is_header(self.files[key].extension),
                len(key),
            ))
            seen: set[str] = set()
            for key in keys:
                sf = self.files[key]
                if sf.qualified_name in seen:
                    # Need more context — use full parent path
                    parts = [
                        s for s in Path(sf.relative_path).parent.parts
                        if s and s != "." and s != "src"
                    ]
                    parts.append(sf.stem)
                    sf.qualified_name = ".".join(parts)
                seen.add(sf.qualified_name)
                self.by_qualified[sf.qualified_name] = key

    def extract_imports(self) -> None:
        extractor = ImportExtractor()
        for _path, sf in self.files.items():
            sf.imports.clear()
            for p in sf.paths:
                sf.imports.extend(extractor.extract_from_file(p))
                if self.language == "python":
                    if not sf.package.parts:
                        sf.package = _derive_python_module(sf.relative_path)
                elif not sf.package.parts:
                    sf.package = extractor.extract_package_from_file(p)
            sf.dependency_count = len(sf.imports)

    def extract_porting_data(self) -> None:
        for _path, sf in self.files.items():
            sf.line_count = 0
            sf.code_lines = 0
            sf.transliterated_from = ""
            sf.todos.clear()
            sf.lint_errors.clear()
            sf.is_stub = False

            all_parts_stub = bool(sf.paths)
            for p in sf.paths:
                if not sf.transliterated_from:
                    sf.transliterated_from = PortingAnalyzer.extract_transliterated_from(p)

                stats = PortingAnalyzer.analyze_file(p)
                sf.line_count += stats.line_count
                sf.code_lines += stats.code_lines
                sf.todos.extend(stats.todos)
                sf.lint_errors.extend(PortingAnalyzer.lint_file(p))
                sf.is_stub = sf.is_stub or stats.is_stub
                all_parts_stub = all_parts_stub and stats.is_stub

            if sf.code_lines > 50:
                sf.is_stub = False
            else:
                sf.is_stub = all_parts_stub

    def transliteration_map(self) -> dict[str, str]:
        return {
            sf.transliterated_from: path
            for path, sf in self.files.items()
            if sf.transliterated_from
        }

    def build_dependency_graph(self) -> None:
        for path, sf in self.files.items():
            for imp in sf.imports:
                resolved = self._resolve_import(imp)
                if resolved and resolved != path:
                    sf.depends_on.add(resolved)
                    self.files[resolved].imported_by.add(path)
        for path, sf in self.files.items():
            sf.dependent_count = len(sf.imported_by)

    def ranked_by_dependents(self) -> list[SourceFile]:
        return sorted(self.files.values(), key=lambda s: s.dependent_count, reverse=True)

    def leaf_files(self) -> list[SourceFile]:
        return [sf for sf in self.files.values() if sf.dependent_count == 0]

    def root_files(self, min_dependents: int = 3) -> list[SourceFile]:
        result = [sf for sf in self.files.values() if sf.dependent_count >= min_dependents]
        result.sort(key=lambda s: s.dependent_count, reverse=True)
        return result

    def print_summary(self) -> str:
        lines = [
            f"Codebase: {self.root_path} ({self.language})",
            f"  Files: {len(self.files)}",
        ]
        total_imports = sum(len(sf.imports) for sf in self.files.values())
        lines.append(f"  Total imports: {total_imports}")
        if self.files:
            most = max(self.files.values(), key=lambda s: s.dependent_count)
            if most.dependent_count > 0:
                lines.append(f"  Most depended: {most.qualified_name} ({most.dependent_count} dependents)")
        return "\n".join(lines) + "\n"

    # ── Private ─────────────────────────────────────────────────────────────

    def _resolve_import(self, imp: Import) -> str:
        item = imp.item
        if item == "*":
            sep = "::" if self.language == "rust" else "."
            pos = imp.module_path.rfind(sep)
            if pos >= 0:
                item = imp.module_path[pos + len(sep):]
        normalized = SourceFile.normalize_name(item)
        for stem, paths in self.by_stem.items():
            if SourceFile.normalize_name(stem) == normalized:
                return paths[0]
        return ""


# ── CodebaseComparator ──────────────────────────────────────────────────────

@dataclass
class Match:
    """A matched pair of source/target files with comparison data."""

    source_path: str = ""
    target_path: str = ""
    source_qualified: str = ""
    target_qualified: str = ""
    similarity: float = 0.0
    source_dependents: int = 0
    target_dependents: int = 0
    source_lines: int = 0
    target_lines: int = 0
    todo_count: int = 0
    lint_count: int = 0
    is_stub: bool = False
    matched_by_header: bool = False

    source_doc_lines: int = 0
    target_doc_lines: int = 0
    source_doc_comments: int = 0
    target_doc_comments: int = 0
    doc_similarity: float = 0.0

    def doc_gap_ratio(self) -> float:
        if self.source_doc_lines == 0:
            return 0.0
        if self.target_doc_lines == 0:
            return 1.0
        ratio = 1.0 - (self.target_doc_lines / self.source_doc_lines)
        return max(0.0, ratio)


class CodebaseComparator:
    """Compare two codebases, find matching files, compute AST similarity."""

    def __init__(self, source: Codebase, target: Codebase) -> None:
        self.source = source
        self.target = target
        self.matches: list[Match] = []
        self.unmatched_source: list[str] = []
        self.unmatched_target: list[str] = []

    @staticmethod
    def name_match_score(src: SourceFile, tgt: SourceFile) -> float:
        src_norm = SourceFile.normalize_name(src.stem)
        tgt_norm = SourceFile.normalize_name(tgt.stem)
        src_qual_norm = SourceFile.normalize_name(src.qualified_name)
        tgt_qual_norm = SourceFile.normalize_name(tgt.qualified_name)

        header_boost = 0.02 if SourceFile.is_header(tgt.extension) else 0.0

        # Exact qualified name match
        if src_qual_norm == tgt_qual_norm:
            return 1.0 + header_boost

        # Extract parent directories
        src_parent = ""
        tgt_parent = ""
        src_dot = src.qualified_name.rfind(".")
        tgt_dot = tgt.qualified_name.rfind(".")
        if src_dot >= 0:
            src_parent = src.qualified_name[:src_dot]
        if tgt_dot >= 0:
            tgt_parent = tgt.qualified_name[:tgt_dot]

        # Same stem + same parent directory
        if src_norm == tgt_norm and src_parent and tgt_parent:
            if SourceFile.normalize_name(src_parent) == SourceFile.normalize_name(tgt_parent):
                return 0.95 + header_boost

        # Exact stem match (different directory)
        if src_norm == tgt_norm:
            return 0.7 + header_boost

        # Substring containment
        if src_norm in tgt_norm:
            ratio = len(src_norm) / len(tgt_norm)
            return 0.5 + 0.2 * ratio + header_boost
        if tgt_norm in src_norm:
            ratio = len(tgt_norm) / len(src_norm)
            return 0.5 + 0.2 * ratio + header_boost

        # Package path similarity
        if src.package.parts and tgt.package.parts:
            pkg_sim = src.package.similarity_to(tgt.package)
            if pkg_sim > 0.5:
                return pkg_sim * 0.6 + header_boost

        # Package last component matches filename
        if src.package.parts:
            src_last = PackageDecl.normalize(src.package.last())
            if src_last == tgt_norm or tgt_norm in src_last or src_last in tgt_norm:
                return 0.5 + header_boost
        if tgt.package.parts:
            tgt_last = PackageDecl.normalize(tgt.package.last())
            if tgt_last == src_norm or src_norm in tgt_last or tgt_last in src_norm:
                return 0.5 + header_boost

        # Same parent directory, different filename
        if src_parent and tgt_parent:
            if SourceFile.normalize_name(src_parent) == SourceFile.normalize_name(tgt_parent):
                return 0.4 + header_boost

        return 0.0

    def find_matches(self) -> None:
        matched_sources: set[str] = set()
        matched_targets: set[str] = set()

        # ── Pass 1: Match by "Transliterated from:" header ──────────────────
        header_candidates: list[tuple[float, str, str]] = []

        for tgt_path, tgt_file in self.target.files.items():
            if not tgt_file.transliterated_from:
                continue
            for src_path, src_file in self.source.files.items():
                score = 0.0

                # Full relative path match
                if src_file.relative_path in tgt_file.transliterated_from:
                    score = 1.0
                # Exact filename with path separator
                elif (tgt_file.transliterated_from.endswith("/" + src_file.filename)
                      or tgt_file.transliterated_from == src_file.filename):
                    # Verify directory context
                    tgt_dir = tgt_file.qualified_name
                    src_dir = src_file.qualified_name
                    td = tgt_dir.rfind(".")
                    sd = src_dir.rfind(".")
                    tgt_dir = tgt_dir[:td] if td >= 0 else ""
                    src_dir = src_dir[:sd] if sd >= 0 else ""
                    if SourceFile.normalize_name(tgt_dir) == SourceFile.normalize_name(src_dir):
                        score = 0.9
                    else:
                        score = 0.5
                # Stem with known extensions
                elif any(
                    tgt_file.transliterated_from.endswith("/" + src_file.stem + ext)
                    for ext in (".kt", ".rs", ".py", ".cpp", ".hpp")
                ):
                    score = 0.3

                if score > 0.0:
                    header_candidates.append((score, src_path, tgt_path))

        # Sort: highest score first, then prefer headers, then shorter paths
        header_candidates.sort(key=lambda c: (
            -c[0],
            not SourceFile.is_header(self.target.files[c[2]].extension),
            len(c[2]),
        ))

        for score, src_path, tgt_path in header_candidates:
            if src_path in matched_sources or tgt_path in matched_targets:
                continue
            src_file = self.source.files[src_path]
            tgt_file = self.target.files[tgt_path]
            self.matches.append(Match(
                source_path=src_path,
                target_path=tgt_path,
                source_qualified=src_file.qualified_name,
                target_qualified=tgt_file.qualified_name,
                similarity=0.0,
                source_dependents=src_file.dependent_count,
                target_dependents=tgt_file.dependent_count,
                source_lines=src_file.line_count,
                target_lines=tgt_file.line_count,
                todo_count=len(tgt_file.todos),
                lint_count=len(tgt_file.lint_errors),
                is_stub=tgt_file.is_stub,
                matched_by_header=True,
            ))
            matched_sources.add(src_path)
            matched_targets.add(tgt_path)

        # ── Pass 2: Name-based matching ─────────────────────────────────────
        name_candidates: list[tuple[float, str, str]] = []
        for src_path, src_file in self.source.files.items():
            if src_path in matched_sources:
                continue
            for tgt_path, tgt_file in self.target.files.items():
                if tgt_path in matched_targets:
                    continue
                score = self.name_match_score(src_file, tgt_file)
                if score > 0.4:
                    name_candidates.append((score, src_path, tgt_path))

        name_candidates.sort(key=lambda c: -c[0])

        for score, src_path, tgt_path in name_candidates:
            if src_path in matched_sources or tgt_path in matched_targets:
                continue
            src_file = self.source.files[src_path]
            tgt_file = self.target.files[tgt_path]
            self.matches.append(Match(
                source_path=src_path,
                target_path=tgt_path,
                source_qualified=src_file.qualified_name,
                target_qualified=tgt_file.qualified_name,
                similarity=0.0,
                source_dependents=src_file.dependent_count,
                target_dependents=tgt_file.dependent_count,
                source_lines=src_file.line_count,
                target_lines=tgt_file.line_count,
                todo_count=len(tgt_file.todos),
                lint_count=len(tgt_file.lint_errors),
                is_stub=tgt_file.is_stub,
                matched_by_header=False,
            ))
            matched_sources.add(src_path)
            matched_targets.add(tgt_path)

        # ── Collect unmatched ───────────────────────────────────────────────
        self.unmatched_source = [p for p in self.source.files if p not in matched_sources]
        self.unmatched_target = [p for p in self.target.files if p not in matched_targets]

    def compute_similarities(self) -> None:
        parser = ASTParser()
        src_lang = _parse_language(self.source.language)
        tgt_lang = _parse_language(self.target.language)

        def _function_name_coverage_ratio(src_paths: list[str], tgt_paths: list[str]) -> float:
            try:
                src_bytes = parser._read_combined_files(src_paths)
                tgt_bytes = parser._read_combined_files(tgt_paths)
            except OSError:
                return 1.0

            src_funcs = parser.extract_functions_bytes(src_bytes, src_lang)
            tgt_funcs = parser.extract_functions_bytes(tgt_bytes, tgt_lang)

            src_names = [
                SourceFile.normalize_name(name)
                for name, _tree in src_funcs
                if name and name != "<anonymous>"
            ]
            if not src_names:
                return 1.0

            tgt_counts = Counter(
                SourceFile.normalize_name(name)
                for name, _tree in tgt_funcs
                if name and name != "<anonymous>"
            )

            matched = 0
            for n in src_names:
                if tgt_counts.get(n, 0) > 0:
                    matched += 1
                    tgt_counts[n] -= 1

            return matched / len(src_names)

        for m in self.matches:
            try:
                src_file = self.source.files[m.source_path]
                tgt_file = self.target.files[m.target_path]

                src_tree = parser.parse_file(src_file.paths, src_lang)
                tgt_tree = parser.parse_file(tgt_file.paths, tgt_lang)

                # Flatten package/namespace nodes to reduce structural noise
                from .node_types import NodeType
                pkg_type = int(NodeType.PACKAGE)
                if src_tree:
                    src_tree.flatten_node_type(pkg_type)
                if tgt_tree:
                    tgt_tree.flatten_node_type(pkg_type)

                src_ids = parser.extract_identifiers_from_file(src_file.paths, src_lang)
                tgt_ids = parser.extract_identifiers_from_file(tgt_file.paths, tgt_lang)
                has_stubs = parser.has_stub_bodies_in_files(tgt_file.paths, tgt_lang)

                if has_stubs:
                    m.similarity = 0.0
                    m.is_stub = True
                else:
                    file_sim = ASTSimilarity.combined_similarity_with_content(
                        src_tree, tgt_tree, src_ids, tgt_ids
                    )
                    fn_cov = _function_name_coverage_ratio(src_file.paths, tgt_file.paths)
                    m.similarity = file_sim * fn_cov

                # Documentation stats
                src_docs = parser.extract_comments_from_file(src_file.paths, src_lang)
                tgt_docs = parser.extract_comments_from_file(tgt_file.paths, tgt_lang)
                m.source_doc_lines = src_docs.total_doc_lines
                m.target_doc_lines = tgt_docs.total_doc_lines
                m.source_doc_comments = src_docs.doc_comment_count
                m.target_doc_comments = tgt_docs.doc_comment_count
                m.doc_similarity = src_docs.doc_cosine_similarity(tgt_docs)
            except Exception:
                m.similarity = -1.0

    def ranked_for_porting(self) -> list[Match]:
        result = list(self.matches)
        result.sort(key=lambda m: m.source_dependents * (1.0 - m.similarity), reverse=True)
        return result

    def format_report(self) -> str:
        lines: list[str] = [
            "\n=== Codebase Comparison Report ===\n",
            f"Source: {self.source.root_path} ({len(self.source.files)} files)",
            f"Target: {self.target.root_path} ({len(self.target.files)} files)",
            "",
            f"Matched:   {len(self.matches)} files",
            f"Unmatched: {len(self.unmatched_source)} source, {len(self.unmatched_target)} target",
            "",
        ]

        if self.matches:
            lines.append("=== Matched Files (by porting priority) ===\n")
            lines.append(f"{'Source':<30} {'Target':<30} {'Sim':>6} {'Deps':>5} {'Pri':>6}")
            lines.append("-" * 80)
            for m in self.ranked_for_porting():
                priority = m.source_dependents * (1.0 - m.similarity)
                lines.append(
                    f"{m.source_qualified[:28]:<30} "
                    f"{m.target_qualified[:28]:<30} "
                    f"{m.similarity:>5.2f} "
                    f"{m.source_dependents:>5} "
                    f"{priority:>6.1f}"
                )

        if self.unmatched_source:
            lines.append("\n=== Missing from Target (need to port) ===")
            for path in self.unmatched_source:
                sf = self.source.files[path]
                lines.append(f"  {sf.qualified_name:<30} ({sf.dependent_count} dependents)")

        return "\n".join(lines) + "\n"


# ── Helpers ─────────────────────────────────────────────────────────────────

def _parse_language(lang: str) -> Language:
    try:
        return Language(lang)
    except ValueError:
        return Language.KOTLIN


def _derive_python_module(rel_path: str) -> PackageDecl:
    p = Path(rel_path)
    parts = [s for s in p.parent.parts if s and s not in (".", "src", "lib")]
    stem = p.stem
    if stem and stem != "__init__":
        parts.append(stem)
    return PackageDecl(parts=parts, path=".".join(parts))


def _walk_files(root: Path):
    """Walk directory tree, skipping build artifacts."""
    try:
        entries = sorted(root.iterdir())
    except PermissionError:
        return
    for entry in entries:
        if entry.is_dir():
            if entry.name not in _SKIP_DIRS and not entry.name.startswith("."):
                yield from _walk_files(entry)
        elif entry.is_file():
            yield entry
