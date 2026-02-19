#!/usr/bin/env python
"""CLI for ast_distance — cross-language AST comparison and porting tools."""

from __future__ import annotations

import sys
import subprocess
from pathlib import Path

from .ast_parser import ASTParser, Language
from .codebase import Codebase, CodebaseComparator, SourceFile
from .node_types import NodeType, node_type_name
from .porting_utils import PortingAnalyzer
from .similarity import ASTSimilarity
from .task_manager import TaskManager, TaskStatus, PortTask


# ── Helpers ─────────────────────────────────────────────────────────────────

def _parse_language(s: str) -> Language:
    try:
        return Language(s)
    except ValueError:
        raise SystemExit(f"Unknown language: {s} (use rust, kotlin, cpp, or python)")


_LANG_NAMES = {
    Language.RUST: "Rust",
    Language.KOTLIN: "Kotlin",
    Language.CPP: "C++",
    Language.PYTHON: "Python",
}

_EXT_MAP: dict[str, str] = {
    ".rs": ".kt", ".kt": ".rs",
    ".cpp": ".py", ".hpp": ".py",
    ".py": ".cpp",
}


def _cpp_ast_distance_exe() -> str:
    # Repo-relative default when running from source checkout.
    repo_root = Path(__file__).resolve().parents[2]
    candidate = repo_root / "build" / "ast_distance"
    if candidate.exists():
        return str(candidate)
    return "ast_distance"


def _run_cpp_ast_distance(args: list[str]) -> int:
    exe = _cpp_ast_distance_exe()
    proc = subprocess.run([exe, *args], check=False)
    return proc.returncode


def _target_path_from_source(rel_path: str, src_lang: str, tgt_lang: str) -> str:
    """Generate expected target path from a source relative path."""
    p = Path(rel_path)
    ext_map = {
        ("rust", "kotlin"): ".kt",
        ("rust", "python"): ".py",
        ("kotlin", "rust"): ".rs",
        ("cpp", "python"): ".py",
        ("python", "cpp"): ".cpp",
    }
    new_ext = ext_map.get((src_lang, tgt_lang), p.suffix)
    result = str(p.with_suffix(new_ext))
    if result.startswith("src/"):
        result = result[4:]
    return result


# ── Commands ────────────────────────────────────────────────────────────────

def cmd_compare(file1: str, lang1: str, file2: str, lang2: str) -> None:
    """Compare two files and print AST similarity report."""
    parser = ASTParser()
    l1 = _parse_language(lang1)
    l2 = _parse_language(lang2)

    def _file_contains_macro_rules(filepath: str) -> bool:
        try:
            return "macro_rules!" in Path(filepath).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return False

    macro_friendly = ((l1 == Language.RUST and _file_contains_macro_rules(file1)) or
                      (l2 == Language.RUST and _file_contains_macro_rules(file2)))

    print(f"Parsing {_LANG_NAMES[l1]} file: {file1}")
    tree1 = parser.parse_file(file1, l1)

    print(f"Parsing {_LANG_NAMES[l2]} file: {file2}")
    tree2 = parser.parse_file(file2, l2)

    report = ASTSimilarity.compare(tree1, tree2, macro_friendly=macro_friendly)
    print()
    print(f"=== AST Comparison Report ===")
    print(f"Histogram cosine: {report['cosine_sim']:.4f}")
    print(f"Jaccard:          {report['jaccard_sim']:.4f}")
    print(f"Structure:        {report['structure_sim']:.4f}")
    print(f"Edit distance:    {report['edit_distance_sim']:.4f}")
    print(f"Combined:         {report['combined_score']:.4f}")

    ids1 = parser.extract_identifiers_from_file(file1, l1)
    ids2 = parser.extract_identifiers_from_file(file2, l2)
    content_score = ASTSimilarity.combined_similarity_with_content(tree1, tree2, ids1, ids2)

    print("\n=== Identifier Content Analysis ===")
    print(f"Identifiers:          {ids1.total_identifiers} vs {ids2.total_identifiers}")
    print(f"Unique (raw):         {len(ids1.identifier_freq)} vs {len(ids2.identifier_freq)}")
    print(f"Unique (canonical):   {len(ids1.canonical_freq)} vs {len(ids2.canonical_freq)}")
    print(f"Raw cosine:           {ids1.identifier_cosine_similarity(ids2):.4f}")
    print(f"Canonical cosine:     {ids1.canonical_cosine_similarity(ids2):.4f}")
    print(f"Canonical jaccard:    {ids1.canonical_jaccard_similarity(ids2):.4f}")

    file1_stubs = parser.has_stub_bodies_in_files([file1], l1)
    file2_stubs = parser.has_stub_bodies_in_files([file2], l2)
    if file1_stubs or file2_stubs:
        content_score = 0.0
        print("\n*** STUB DETECTED ***")
        if file1_stubs:
            print(f"  {file1} has TODO/stub/placeholder in function bodies")
        if file2_stubs:
            print(f"  {file2} has TODO/stub/placeholder in function bodies")
        print("  Content-Aware Score forced to 0.0000")
    else:
        print(f"\nContent-Aware Score:  {content_score:.4f}")

    num_types = int(NodeType.NUM_TYPES)
    if tree1:
        print(f"\n=== {_LANG_NAMES[l1]} AST Histogram ===")
        _print_histogram(tree1.node_type_histogram(num_types))
    if tree2:
        print(f"\n=== {_LANG_NAMES[l2]} AST Histogram ===")
        _print_histogram(tree2.node_type_histogram(num_types))

    # Comments comparison
    comments1 = parser.extract_comments_from_file(file1, l1)
    comments2 = parser.extract_comments_from_file(file2, l2)

    print(f"\n=== Documentation Comparison ===")
    print(f"Doc comment count: {comments1.doc_comment_count} vs {comments2.doc_comment_count}")
    print(f"Doc lines:         {comments1.total_doc_lines} vs {comments2.total_doc_lines}")

    doc_cosine = comments1.doc_cosine_similarity(comments2)
    doc_jaccard = comments1.doc_jaccard_similarity(comments2)
    print(f"Doc text cosine:  {doc_cosine * 100:.0f}%")
    print(f"Doc text jaccard: {doc_jaccard * 100:.0f}%")


def cmd_dump(filepath: str, lang_str: str) -> None:
    """Dump AST structure of a file."""
    parser = ASTParser()
    lang = _parse_language(lang_str)

    print(f"Parsing {filepath} as {lang_str}...\n")
    tree = parser.parse_file(filepath, lang)
    if tree is None:
        raise SystemExit(f"Failed to parse {filepath}")

    print("AST Structure:")
    _print_tree(tree)

    print()
    hist = tree.node_type_histogram(int(NodeType.NUM_TYPES))
    _print_histogram(hist)

    print(f"\nTree Statistics:")
    print(f"  Size:  {tree.size()} nodes")
    print(f"  Depth: {tree.depth()}")


def cmd_scan(directory: str, lang: str) -> None:
    """Scan directory and show file list with import counts."""
    cb = Codebase(directory, lang)
    cb.scan()
    cb.extract_imports()

    print(f"=== Scanned {len(cb.files)} {lang} files ===\n")
    print(f"{'Qualified Name':<40} {'Imports':<8} Path")
    print("-" * 80)
    for path, sf in cb.files.items():
        print(f"{sf.qualified_name[:38]:<40} {len(sf.imports):<8} {sf.relative_path}")


def cmd_deps(directory: str, lang: str) -> None:
    """Build and show dependency graph."""
    cb = Codebase(directory, lang)
    cb.scan()
    cb.extract_imports()
    cb.build_dependency_graph()

    print(cb.print_summary())

    print("\n=== Files by Dependent Count ===\n")
    print(f"{'File':<40} {'Deps':<10} {'DepBy':<10} Status")
    print("-" * 70)

    for sf in cb.ranked_by_dependents():
        status = ""
        if sf.dependent_count >= 5:
            status = "CORE"
        elif sf.dependent_count == 0:
            status = "leaf"
        print(f"{sf.qualified_name[:38]:<40} {sf.dependency_count:<10} {sf.dependent_count:<10} {status}")

    roots = cb.root_files(3)
    if roots:
        print("\n=== Core Files (most dependents) ===")
        for sf in roots:
            print(f"\n{sf.qualified_name} ({sf.dependent_count} dependents):")
            print("  Imported by:")
            for i, dep in enumerate(sf.imported_by):
                if i >= 5:
                    print(f"    ... and {len(sf.imported_by) - 5} more")
                    break
                print(f"    - {cb.files[dep].qualified_name}")


def cmd_rank(src_dir: str, src_lang: str, tgt_dir: str, tgt_lang: str) -> None:
    """Rank files by porting priority (dependents + similarity)."""
    source = _scan_codebase(src_dir, src_lang, build_deps=True)
    target = _scan_codebase(tgt_dir, tgt_lang, build_deps=True)

    comp = CodebaseComparator(source, target)
    comp.find_matches()
    comp.compute_similarities()
    print(comp.format_report())


def cmd_deep(src_dir: str, src_lang: str, tgt_dir: str, tgt_lang: str) -> dict:
    """Full analysis: AST + deps + TODOs + lint + line ratios.

    Returns structured metrics dict in addition to printing human-readable output.
    """
    print(f"=== Deep Analysis: {src_dir} ({src_lang}) -> {tgt_dir} ({tgt_lang}) ===\n")

    print(f"Scanning source codebase ({src_lang})...")
    source = _scan_codebase(src_dir, src_lang, build_deps=True)
    print(source.print_summary())

    print(f"Scanning target codebase ({tgt_lang})...")
    target = _scan_codebase(tgt_dir, tgt_lang, build_deps=True, porting_data=True)
    print(target.print_summary())

    print("Comparing codebases...")
    comp = CodebaseComparator(source, target)
    comp.find_matches()

    print("Computing AST similarities...")
    comp.compute_similarities()

    print(comp.format_report())

    # Porting quality summary
    print("\n=== Porting Quality Summary ===\n")
    total_todos = sum(m.todo_count for m in comp.matches)
    total_lint = sum(m.lint_count for m in comp.matches)
    stub_count = sum(1 for m in comp.matches if m.is_stub)
    header_matched = sum(1 for m in comp.matches if m.matched_by_header)
    total_matched = len(comp.matches)
    ranked = comp.ranked_for_porting()
    incomplete = sum(1 for m in ranked if m.similarity < 0.6)
    missing_count = len(comp.unmatched_source)

    print(f"Matched by header:     {header_matched} / {total_matched}")
    print(f"Matched by name:       {total_matched - header_matched} / {total_matched}")
    print(f"Total TODOs in target: {total_todos}")
    print(f"Total lint errors:     {total_lint}")
    print(f"Stub files:            {stub_count}")

    # Files with issues
    issues = [m for m in ranked if m.todo_count > 0 or m.lint_count > 0 or m.is_stub or m.similarity < 0.6]
    if issues:
        print("\n=== Files with Issues ===\n")
        print(f"{'File':<30} {'Sim':>6} {'Ratio':>6} {'TODOs':>5} {'Lint':>5} Status")
        print("-" * 70)
        for m in issues[:20]:
            status = ""
            if m.is_stub:
                status = "STUB"
            elif m.similarity < 0.4:
                status = "LOW_SIM"
            elif m.lint_count > 0:
                status = "LINT"
            elif m.todo_count > 0:
                status = "TODO"
            ratio = m.target_lines / m.source_lines if m.source_lines > 0 else 0.0
            print(f"{m.target_qualified[:28]:<30} {m.similarity:>5.2f} {ratio:>6.2f} {m.todo_count:>5} {m.lint_count:>5} {status}")
        if len(issues) > 20:
            print(f"... and {len(issues) - 20} more files")

    # Recommendations
    print("\n=== Porting Recommendations ===\n")
    print(f"Incomplete ports (similarity < 60%): {incomplete}")
    print(f"Missing files: {missing_count}")

    if incomplete > 0:
        print("\nTop priority to complete:")
        for m in [m for m in ranked if m.similarity < 0.6][:10]:
            flags = []
            if m.is_stub:
                flags.append("[STUB]")
            if m.todo_count > 0:
                flags.append(f"[{m.todo_count} TODOs]")
            print(f"  {m.source_qualified:<30} sim={m.similarity:.2f} deps={m.source_dependents} {' '.join(flags)}")

    if comp.unmatched_source:
        print("\nTop priority to create:")
        missing_sorted = sorted(
            [source.files[p] for p in comp.unmatched_source],
            key=lambda s: s.dependent_count, reverse=True,
        )
        for sf in missing_sorted[:10]:
            print(f"  {sf.qualified_name:<30} deps={sf.dependent_count}")

    # Documentation gaps
    doc_gaps = [
        (m.doc_gap_ratio(), m)
        for m in comp.matches
        if m.doc_gap_ratio() > 0.2 and m.source_doc_lines > 5
    ]
    doc_gaps.sort(key=lambda x: x[0] * x[1].source_doc_lines, reverse=True)

    total_src_doc = sum(m.source_doc_lines for m in comp.matches)
    total_tgt_doc = sum(m.target_doc_lines for m in comp.matches)

    print("\n=== Documentation Gaps ===\n")
    if not doc_gaps:
        print("No significant documentation gaps found.")
    else:
        print(f"{'File':<30} {'Src Docs':>10} {'Tgt Docs':>10} {'Gap %':>8} {'DocSim':>8}")
        print("-" * 74)
        for gap, m in doc_gaps[:25]:
            print(f"{m.source_qualified[:28]:<30} {m.source_doc_lines:>10} {m.target_doc_lines:>10} {int(gap * 100):>7}% {m.doc_similarity:>7.2f}")
        if len(doc_gaps) > 25:
            print(f"... and {len(doc_gaps) - 25} more files with doc gaps")
        pct = (100.0 * total_tgt_doc / total_src_doc) if total_src_doc > 0 else 0
        print(f"\nDocumentation coverage: {total_tgt_doc} / {total_src_doc} lines ({pct:.0f}%)")
        print(f"Files with >20% doc gap: {len(doc_gaps)}")

    # Return structured metrics for programmatic use.
    hdr_ratio = header_matched / total_matched if total_matched > 0 else 0.0
    return {
        "matched_by_header": {"count": header_matched, "total": total_matched},
        "matched_by_name": {"count": total_matched - header_matched, "total": total_matched},
        "matched_by_header_ratio": hdr_ratio,
        "total_todos": total_todos,
        "total_lint_errors": total_lint,
        "stub_files": stub_count,
        "missing_files": missing_count,
        "incomplete_ports": incomplete,
    }


def cmd_missing(src_dir: str, src_lang: str, tgt_dir: str, tgt_lang: str) -> dict:
    """Show files missing from target, ranked by importance.

    Returns dict with missing file list for programmatic use.
    """
    source = _scan_codebase(src_dir, src_lang, build_deps=True)
    target = Codebase(tgt_dir, tgt_lang)
    target.scan()

    comp = CodebaseComparator(source, target)
    comp.find_matches()

    print(f"=== Missing from {tgt_lang} (ranked by dependents) ===\n")
    print(f"{'Source File':<40} {'Deps':<10} Path")
    print("-" * 80)

    missing = sorted(
        [source.files[p] for p in comp.unmatched_source],
        key=lambda s: s.dependent_count, reverse=True,
    )
    for sf in missing:
        print(f"{sf.qualified_name[:38]:<40} {sf.dependent_count:<10} {sf.relative_path}")
    print(f"\nTotal: {len(missing)} files missing")

    return {
        "missing": [
            {"qualified_name": sf.qualified_name, "path": sf.relative_path,
             "dependent_count": sf.dependent_count}
            for sf in missing
        ],
        "total": len(missing),
    }


def cmd_todos(directory: str, verbose: bool = True) -> None:
    """Scan for TODO comments."""
    print(f"Scanning for TODOs in: {directory}\n")
    all_todos = []
    for entry in Path(directory).rglob("*"):
        if entry.is_file() and entry.suffix in (".rs", ".kt", ".kts", ".cpp", ".hpp", ".h", ".py"):
            todos = PortingAnalyzer.scan_todos(entry)
            all_todos.extend(todos)
    print(f"Found {len(all_todos)} TODOs")
    if verbose:
        for todo in all_todos:
            print(f"\n  {todo.file_path}:{todo.line_num}")
            if todo.tag:
                print(f"  Tag: {todo.tag}")
            print(f"  {todo.message}")
            for ctx in todo.context:
                print(f"  {ctx}")


def cmd_lint(directory: str) -> None:
    """Run lint checks."""
    print(f"Running lint checks on: {directory}\n")
    lint_errors = []
    for entry in Path(directory).rglob("*"):
        if entry.is_file() and entry.suffix in (".rs", ".kt", ".kts", ".cpp", ".hpp", ".h", ".py"):
            lint_errors.extend(PortingAnalyzer.lint_file(entry))

    if not lint_errors:
        print("No lint errors found.")
        return

    print(f"Found {len(lint_errors)} lint error(s):")
    for err in lint_errors:
        print(f"  {err.file_path}:{err.line_num} [{err.type}] {err.message}")


def _proxy_to_cpp(args: list[str]) -> None:
    rc = _run_cpp_ast_distance(args)
    if rc != 0:
        raise SystemExit(rc)


def cmd_stats(directory: str) -> None:
    """Show file statistics."""
    print(f"=== File Statistics: {directory} ===\n")
    print(f"{'File':<40} {'Lines':>6} {'Code':>6} {'Stub':>5} {'TODOs':>6}")
    print("-" * 70)
    for entry in sorted(Path(directory).rglob("*")):
        if entry.is_file() and entry.suffix in (".rs", ".kt", ".kts", ".cpp", ".hpp", ".h", ".py"):
            stats = PortingAnalyzer.analyze_file(entry)
            stub_str = "STUB" if stats.is_stub else ""
            print(f"{entry.name:<40} {stats.line_count:>6} {stats.code_lines:>6} {stub_str:>5} {len(stats.todos):>6}")


def cmd_init_tasks(src_dir: str, src_lang: str, tgt_dir: str, tgt_lang: str,
                   task_file: str, agents_md: str = "") -> dict:
    """Generate task file from missing/incomplete ports.

    Returns dict with task count and top priorities for programmatic use.
    """
    print("=== Initializing Task File ===\n")

    source = _scan_codebase(src_dir, src_lang, build_deps=True)
    target = Codebase(tgt_dir, tgt_lang)
    target.scan()

    comp = CodebaseComparator(source, target)
    comp.find_matches()

    tm = TaskManager(task_file)
    tm.source_root = src_dir
    tm.target_root = tgt_dir
    tm.source_lang = src_lang
    tm.target_lang = tgt_lang
    tm.agents_md_path = agents_md

    # Collect pending files: missing + incomplete (sim < 0.85)
    pending_files: list[SourceFile] = []
    for path in comp.unmatched_source:
        pending_files.append(source.files[path])
    for m in comp.matches:
        if m.similarity < 0.85:
            pending_files.append(source.files[m.source_path])
    pending_files.sort(key=lambda s: s.dependent_count, reverse=True)

    for sf in pending_files:
        task = PortTask(
            source_path=sf.relative_path,
            source_qualified=sf.qualified_name,
            target_path=_target_path_from_source(sf.relative_path, src_lang, tgt_lang),
            dependent_count=sf.dependent_count,
            dependency_count=sf.dependency_count,
            dependencies=[imp.module_path for imp in sf.imports],
        )
        tm.tasks.append(task)

    if not tm.save():
        raise SystemExit(f"Failed to write task file: {task_file}")

    print(f"Generated {len(tm.tasks)} tasks")
    print(f"Task file: {task_file}")

    print("\nTop 10 priority tasks:")
    for t in tm.tasks[:10]:
        print(f"  {t.source_qualified:<30} deps={t.dependent_count}")

    return {
        "task_count": len(tm.tasks),
        "task_file": task_file,
        "top_tasks": [
            {"source_qualified": t.source_qualified, "dependent_count": t.dependent_count}
            for t in tm.tasks[:10]
        ],
    }


def cmd_tasks(task_file: str) -> None:
    """Show task status summary."""
    tm = TaskManager(task_file)
    if not tm.load():
        raise SystemExit(f"Error: Could not load task file: {task_file}")

    stats = tm.get_stats()

    print("=== Task Status ===\n")
    print(f"Task file: {task_file}")
    print(f"Source root: {tm.source_root}")
    print(f"Target root: {tm.target_root}\n")
    print(f"Status Summary:")
    print(f"  Pending:   {stats['pending']}")
    print(f"  Assigned:  {stats['assigned']}")
    print(f"  Completed: {stats['completed']}")
    print(f"  Blocked:   {stats['blocked']}")
    print(f"  Total:     {len(tm.tasks)}\n")

    assigned = [t for t in tm.tasks if t.status == TaskStatus.ASSIGNED]
    if assigned:
        print("Currently Assigned:")
        for t in assigned:
            print(f"  {t.source_qualified:<30} -> {t.assigned_to} (since {t.assigned_at})")
        print()

    print("Pending Tasks (by priority):")
    print(f"{'Source':<35} {'Deps':<10} Target Path")
    print("-" * 70)
    pending = [t for t in tm.tasks if t.status == TaskStatus.PENDING]
    for t in pending[:20]:
        print(f"{t.source_qualified[:33]:<35} {t.dependent_count:<10} {t.target_path}")
    if len(pending) > 20:
        print(f"... and {len(pending) - 20} more")


def cmd_assign(task_file: str, agent_id: str) -> str:
    """Assign highest-priority pending task to an agent.

    Returns the assignment instructions text for programmatic use.
    """
    tm = TaskManager(task_file)
    if not tm.load():
        raise SystemExit(f"Error: Could not load task file: {task_file}")

    # Check if agent already has an assigned task
    for t in tm.tasks:
        if t.status == TaskStatus.ASSIGNED and t.assigned_to == agent_id:
            print(f"Agent {agent_id} already has an assigned task: {t.source_qualified}",
                  file=sys.stderr)
            print(f"Complete it with: ast_distance --complete {task_file} {t.source_qualified}",
                  file=sys.stderr)
            print(f"Or release it with: ast_distance --release {task_file} {t.source_qualified}",
                  file=sys.stderr)
            return ""

    task = tm.assign_next(agent_id)
    if task is None:
        msg = "No pending tasks available."
        stats = tm.get_stats()
        msg += (f"\nStatus: {stats['completed']}/{len(tm.tasks)} completed, "
                f"{stats['assigned']} assigned, {stats['pending']} pending")
        print(msg)
        return msg

    text = tm.format_assignment(task)
    print(text)
    return text


def cmd_complete(task_file: str, source_qualified: str) -> None:
    """Mark a task as completed and rescan."""
    tm = TaskManager(task_file)
    if not tm.load():
        raise SystemExit(f"Error: Could not load task file: {task_file}")

    if not tm.complete_task(source_qualified):
        raise SystemExit(f"Task not found: {source_qualified}")

    print(f"Marked as completed: {source_qualified}")

    # Rescan to update priorities
    if not tm.source_root or not tm.source_lang:
        print("Warning: Task file missing source/target info, cannot rescan.")
        return

    print("Rescanning codebases to update priorities...")
    source = _scan_codebase(tm.source_root, tm.source_lang, build_deps=True)
    target = Codebase(tm.target_root, tm.target_lang)
    target.scan()

    comp = CodebaseComparator(source, target)
    comp.find_matches()

    # Preserve assignment and completion states
    assigned_map: dict[str, tuple[str, str]] = {}
    completed_map: dict[str, str] = {}
    for t in tm.tasks:
        if t.status == TaskStatus.ASSIGNED:
            assigned_map[t.source_qualified] = (t.assigned_to, t.assigned_at)
        elif t.status == TaskStatus.COMPLETED:
            completed_map[t.source_qualified] = t.completed_at

    # Rebuild task list
    tm.tasks.clear()
    missing_files: list[SourceFile] = []
    for path in comp.unmatched_source:
        missing_files.append(source.files[path])
    for m in comp.matches:
        if m.similarity < 0.85:
            missing_files.append(source.files[m.source_path])
    missing_files.sort(key=lambda s: s.dependent_count, reverse=True)

    for sf in missing_files:
        if sf.qualified_name in completed_map:
            continue
        task = PortTask(
            source_path=sf.relative_path,
            source_qualified=sf.qualified_name,
            target_path=_target_path_from_source(sf.relative_path, tm.source_lang, tm.target_lang),
            dependent_count=sf.dependent_count,
            dependency_count=sf.dependency_count,
            dependencies=[imp.module_path for imp in sf.imports],
        )
        if sf.qualified_name in assigned_map:
            task.status = TaskStatus.ASSIGNED
            task.assigned_to, task.assigned_at = assigned_map[sf.qualified_name]
        tm.tasks.append(task)

    # Re-add completed tasks
    for qualified, completed_at in completed_map.items():
        task = PortTask(source_qualified=qualified, status=TaskStatus.COMPLETED, completed_at=completed_at)
        for path, sf in source.files.items():
            if sf.qualified_name == qualified:
                task.source_path = sf.relative_path
                task.dependent_count = sf.dependent_count
                break
        else:
            task.source_path = qualified
        tm.tasks.append(task)

    tm.save()
    stats = tm.get_stats()
    total = stats["pending"] + stats["assigned"] + stats["completed"]
    print(f"Progress: {stats['completed']}/{total} completed")
    print(f"Remaining: {stats['pending']} pending, {stats['assigned']} assigned")

    print("\nUpdated top priorities:")
    pending = [t for t in tm.tasks if t.status == TaskStatus.PENDING]
    for t in pending[:5]:
        print(f"  {t.source_qualified:<30} deps={t.dependent_count}")


def cmd_release(task_file: str, source_qualified: str) -> None:
    """Release an assigned task back to pending, with similarity guardrails."""
    tm = TaskManager(task_file)
    if not tm.load():
        raise SystemExit(f"Error: Could not load task file: {task_file}")

    task = next((t for t in tm.tasks if t.source_qualified == source_qualified), None)
    if task is None or task.status != TaskStatus.ASSIGNED:
        raise SystemExit(f"Task not found or not assigned: {source_qualified}")

    target_path = Path(tm.target_root) / task.target_path
    if target_path.exists():
        source_path = Path(tm.source_root) / task.source_path

        print(f"Error: Cannot release task - target file already exists: {target_path}",
              file=sys.stderr)
        print("Checking similarity...", file=sys.stderr)

        src_lang = _parse_language(tm.source_lang)
        tgt_lang = _parse_language(tm.target_lang)
        parser = ASTParser()
        src_tree = parser.parse_file(str(source_path), src_lang)
        tgt_tree = parser.parse_file(str(target_path), tgt_lang)

        if src_tree is None or tgt_tree is None:
            print("Error: Cannot parse files for comparison", file=sys.stderr)
            print("This usually means the target file has syntax errors.", file=sys.stderr)
            print("Fix the errors or delete the file to release.", file=sys.stderr)
            raise SystemExit(1)

        has_stubs = parser.has_stub_bodies_in_files([str(target_path)], tgt_lang)
        if has_stubs:
            print("Error: Cannot release task - target file contains stub/TODO markers in function bodies",
                  file=sys.stderr)
            print("The code is fake. Complete the real implementation or delete the file.",
                  file=sys.stderr)
            raise SystemExit(1)

        src_ids = parser.extract_identifiers_from_file(str(source_path), src_lang)
        tgt_ids = parser.extract_identifiers_from_file(str(target_path), tgt_lang)
        similarity = ASTSimilarity.combined_similarity_with_content(
            src_tree, tgt_tree, src_ids, tgt_ids
        )

        if similarity < 0.50:
            print(f"Error: Cannot release task with low similarity: {similarity:.4f}",
                  file=sys.stderr)
            print("Target file exists but identifier content doesn't match source.",
                  file=sys.stderr)
            print("Either complete the port or delete the target file to release.",
                  file=sys.stderr)
            raise SystemExit(1)

        print(f"Warning: Releasing with partial port (similarity {similarity:.4f})",
              file=sys.stderr)
        print("Consider completing it instead (use --complete).", file=sys.stderr)

    if not tm.release_task(source_qualified):
        raise SystemExit(f"Task not found or not assigned: {source_qualified}")
    print(f"Released task: {source_qualified}")


# ── Shared helpers ──────────────────────────────────────────────────────────

def _scan_codebase(root: str, lang: str, *, build_deps: bool = False,
                   porting_data: bool = False) -> Codebase:
    cb = Codebase(root, lang)
    cb.scan()
    cb.extract_imports()
    if build_deps:
        cb.build_dependency_graph()
    if porting_data:
        cb.extract_porting_data()
    return cb


def _print_tree(tree, indent: int = 0) -> None:
    from .node_types import node_type_name, NodeType
    pad = "  " * indent
    name = node_type_name(NodeType(tree.node_type))
    suffix = " [leaf]" if tree.is_leaf() else ""
    label = f" ({tree.label})" if tree.label else ""
    print(f"{pad}{name}{label}{suffix}")
    for child in tree.children:
        _print_tree(child, indent + 1)


def _print_histogram(hist: list[int]) -> None:
    print("Node Type Histogram:")
    for i, count in enumerate(hist):
        if count > 0:
            name = node_type_name(NodeType(i))
            print(f"  {name:<15}: {count}")


# ── Usage and dispatch ──────────────────────────────────────────────────────

def print_usage() -> None:
    prog = "ast_distance"
    print(f"""AST Distance - Cross-language AST comparison and porting analysis

Usage:
  {prog} <file1> <lang1> <file2> <lang2>
      Compare AST similarity between two files

  {prog} --dump <file> <rust|kotlin|cpp|python>
      Dump AST structure of a file

  {prog} --scan <directory> <rust|kotlin|cpp|python>
      Scan directory and show file list with import counts

  {prog} --deps <directory> <rust|kotlin|cpp|python>
      Build and show dependency graph

  {prog} --rank <src_dir> <src_lang> <tgt_dir> <tgt_lang>
      Rank files by porting priority (dependents + similarity)

  {prog} --deep <src_dir> <src_lang> <tgt_dir> <tgt_lang>
      Full analysis: AST + deps + TODOs + lint + line ratios

  {prog} --missing <src_dir> <src_lang> <tgt_dir> <tgt_lang>
      Show files missing from target, ranked by importance

  {prog} --todos <directory>
      Scan for TODO comments with tags and context

  {prog} --lint <directory>
      Run lint checks (unused params, missing guards)

  {prog} --stats <directory>
      Show file statistics (line counts, stubs, TODOs)

Symbol Analysis:
  {prog} --symbols <kotlin_root> <cpp_root>
      Run symbol analysis (duplicates + stubs)

  {prog} --symbols-duplicates <kotlin_root> <cpp_root>
      Show duplicate class/struct definitions

  {prog} --symbols-stubs <kotlin_root> <cpp_root>
      Show stub files/classes

  {prog} --symbols-symbol <kotlin_root> <cpp_root> <symbol> [--json]
      Analyze a specific symbol (optionally output JSON)

  {prog} --symbol-parity <rust_root> <kotlin_root> [options]
      Rust->Kotlin symbol parity analysis

  {prog} --import-map <kotlin_root> [options]
      Build type registry and show missing imports per file

  {prog} --compiler-fixup <kotlin_root> <error_file> [options]
      Parse compiler errors and suggest import fixes

Swarm Task Management:
  {prog} --init-tasks <src_dir> <src_lang> <tgt_dir> <tgt_lang> <task_file>
      Generate task file from missing/incomplete ports

  {prog} --tasks <task_file>
      Show task status summary

  {prog} --assign <task_file> <agent_id>
      Assign highest-priority pending task to an agent

  {prog} --complete <task_file> <source_qualified>
      Mark a task as completed

  {prog} --release <task_file> <source_qualified>
      Release an assigned task back to pending

  Languages: rust, kotlin, cpp, python""", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]

    if not args:
        print_usage()
        return 1

    mode = args[0]

    try:
        if mode == "--scan" and len(args) >= 3:
            cmd_scan(args[1], args[2])

        elif mode == "--deps" and len(args) >= 3:
            cmd_deps(args[1], args[2])

        elif mode == "--rank" and len(args) >= 5:
            cmd_rank(args[1], args[2], args[3], args[4])

        elif mode == "--deep" and len(args) >= 5:
            cmd_deep(args[1], args[2], args[3], args[4])

        elif mode == "--missing" and len(args) >= 5:
            cmd_missing(args[1], args[2], args[3], args[4])

        elif mode == "--todos" and len(args) >= 2:
            verbose = not (len(args) >= 3 and args[2] == "--summary")
            cmd_todos(args[1], verbose)

        elif mode == "--lint" and len(args) >= 2:
            cmd_lint(args[1])

        elif mode == "--stats" and len(args) >= 2:
            cmd_stats(args[1])

        elif mode in {
            "--symbols",
            "--symbols-duplicates",
            "--symbols-stubs",
            "--symbols-symbol",
            "--symbol-parity",
            "--import-map",
            "--compiler-fixup",
        }:
            _proxy_to_cpp(args)

        elif mode == "--init-tasks" and len(args) >= 6:
            agents_md = args[6] if len(args) >= 7 else ""
            cmd_init_tasks(args[1], args[2], args[3], args[4], args[5], agents_md)

        elif mode == "--tasks" and len(args) >= 2:
            cmd_tasks(args[1])

        elif mode == "--assign" and len(args) >= 3:
            cmd_assign(args[1], args[2])

        elif mode == "--complete" and len(args) >= 3:
            cmd_complete(args[1], args[2])

        elif mode == "--release" and len(args) >= 3:
            cmd_release(args[1], args[2])

        elif mode == "--dump" and len(args) >= 3:
            cmd_dump(args[1], args[2])

        elif not mode.startswith("-") and len(args) >= 4:
            cmd_compare(args[0], args[1], args[2], args[3])

        else:
            print_usage()
            return 1

    except SystemExit as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
