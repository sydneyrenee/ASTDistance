# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-04-27

### Added

- TypeScript NPM package (`@ast-distance/typescript`)
- Comprehensive TypeScript AST parsing with tree-sitter
- Cross-language node type mappings (TypeScript, Rust, Kotlin, C++)
- CLI commands: scan, deep, missing, dump, todos
- CI/CD workflows (test, build, publish-npm)
- Automated build scripts
- Feature parity documentation
- Vendored tree-sitter grammars so CMake builds do not fetch parser sources.
- CLI filter guard for direct file comparisons, with PTY-aware regression tests.
- Rust-to-Kotlin provenance fallback reporting for `src/` prefix and camelCase header mismatches.
- `port_lint_proposed_changes.md` generation for fallback provenance matches.

### Changed

- C++ version enhanced with TypeScript language support
- Updated node type mappings for comprehensive TypeScript coverage
- Rust-to-Kotlin deep reports now separate exact header matches from provenance fallback matches.
- Direct file comparisons now surface provenance fallback warnings and proposed `port-lint` header lines.

## [0.1.0] - TBD

### Added

- Initial C++ implementation
- Tree-sitter AST parsing for Rust, Kotlin, C++
- Similarity metrics (cosine, structure, jaccard)
- Dependency graph building
- Port-lint header support
- Codebase analysis and file matching
- TODO scanning with context
- Documentation comparison
