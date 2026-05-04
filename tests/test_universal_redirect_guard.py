#!/usr/bin/env python3
"""Regression test: the redirect/pipe guard fires for every CLI mode.

Before the universal hardening, the guard was mode-gated to comparison
modes (`--compare-functions` and 4-positional-args raw comparison). Other
modes (--deep, --symbol-parity, --import-map, --scan, --stats, --todos,
--lint, --emberlint) used to be redirectable. Locking that closed.

Each invocation here pipes through `cat -` so stdout is a pipe (the most
common shape: `ast_distance ... | grep`, `ast_distance ... > file`,
`$(ast_distance ...)`). All shapes share the property that
`isatty(STDOUT_FILENO)` returns 0, which is what the guard checks.
"""
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path


REJECTED_BANNER = "*** REDIRECT GUARD REJECTED ***"


def assert_rejects(ast_distance: Path, args: list[str], scenario: str) -> None:
    inner = " ".join(shlex.quote(s) for s in [str(ast_distance), *args])
    # `2>&1 | cat -` is the minimal harness that forces stdout to be a pipe
    # without imposing any filter program. The guard must reject on the
    # isatty check alone.
    command = f"{inner} 2>&1 | cat -"
    proc = subprocess.run(
        ["bash", "-lc", command],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )
    if REJECTED_BANNER not in proc.stdout:
        raise AssertionError(
            f"{scenario}: expected guard to reject piped stdout\n"
            f"command: {command}\n"
            f"returncode: {proc.returncode}\n"
            f"--- output ---\n{proc.stdout}"
        )


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: test_universal_redirect_guard.py <ast_distance_bin>", file=sys.stderr)
        sys.exit(2)

    ast_distance = Path(sys.argv[1]).resolve()

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        rust_dir = tmp / "rust"
        kotlin_dir = tmp / "kotlin"
        rust_dir.mkdir()
        kotlin_dir.mkdir()
        (rust_dir / "sample.rs").write_text(
            "pub fn foo_bar(x: i32) -> i32 { x + 1 }\n",
            encoding="utf-8",
        )
        (kotlin_dir / "Sample.kt").write_text(
            "fun fooBar(x: Int): Int = x + 1\n",
            encoding="utf-8",
        )
        rust_file = rust_dir / "sample.rs"
        kotlin_file = kotlin_dir / "Sample.kt"

        # Cover one invocation per top-level mode shape. If any of these
        # silently goes through, a model harness can capture and truncate
        # the output without detection.
        scenarios = [
            ("file-vs-file", [str(rust_file), "rust", str(kotlin_file), "kotlin"]),
            ("--compare-functions", [
                "--compare-functions",
                str(rust_file), "rust",
                str(kotlin_file), "kotlin",
            ]),
            ("--deep", ["--deep", str(rust_dir), "rust", str(kotlin_dir), "kotlin"]),
            ("--symbol-parity", ["--symbol-parity", str(rust_dir), str(kotlin_dir)]),
            ("--scan", ["--scan", str(rust_dir), "rust"]),
            ("--stats", ["--stats", str(rust_dir)]),
            ("--todos", ["--todos", str(rust_dir)]),
            ("--lint", ["--lint", str(rust_dir)]),
            ("--import-map", ["--import-map", str(kotlin_dir)]),
        ]
        for label, args in scenarios:
            assert_rejects(ast_distance, args, label)


if __name__ == "__main__":
    main()
