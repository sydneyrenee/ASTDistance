# Code Port - Progress Report

**Generated:** 2026-04-27
**Source:** include
**Target:** python/ast_distance_py

## Executive Summary

| Metric | Count | Percentage |
|--------|-------|------------|
| Total source files | 16 | 100% |
| Target units (paired) | 9 | - |
| Target files (total) | 9 | - |
| Porting progress | 8 | 50.0% (matched) |
| Missing files | 8 | 50.0% |

## Port Quality Analysis

**Average Similarity:** 0.13

**Quality Distribution:**
- Excellent (≥0.85): 0 files (0.0% of matched)
- Good (0.60-0.84): 0 files (0.0% of matched)
- Critical (<0.60): 8 files (100.0% of matched)

## Function and Symbol Details

Every matched file is listed with function and type parity. Missing symbol names are not capped.

| Rank | Source | Target | Similarity | Functions | Missing functions | Types | Missing types | Tests | Symbol deficit | Priority |
|------|--------|--------|------------|-----------|-------------------|-------|---------------|-------|----------------|----------|
| 1 | `ast_parser` | `ast_parser [STUB]` | 0.00 | 26/79 matched (target 44) | `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `tree_sitter_typescript`, `total_identifiers`, `doc_comment_count`, `line_comment_count`, `block_comment_count`, `total_comment_lines`, `total_doc_lines`, `doc_line_coverage_capped`, `doc_line_balance`, `start_line`, `end_line`, `line_count`, `body_line_count`, `ASTParser`, `file`, `has_stub_bodies`, `type_s`, `has_stub_bodies_in_files`, `get_unmapped_node_types`, `clear_unmapped`, `count_lines`, `tokenize_doc_comment`, `is_import_node`, `is_type_parameter_scope_node`, `ptype`, `node_type`, `detect_stubs_recursive`, `type`, `t`, `child_type`, `op_str`, `is_function_node`, `has_test_attribute`, `sib_type`, `has_kotlin_test_annotation`, `is_inside_cfg_test_mod`, `extract_function_name`, `ct`, `pt`, `extract_function_body_node`, `st`, `is_parameter_container_node`, `node_contains_byte_range`, `collect_function_parameter_nodes`, `extract_function_parameter_nodes`, `make_function_comparison_tree`, `extract_function_comparison_identifiers`, `has_stub_markers_in_node`, `current_type` | 0/0 matched | _none_ | - | 53 | 4537910.0 |
| 2 | `tree` | `tree` | 0.10 | 11/13 matched (target 14) | `node_type`, `Tree` | 0/0 matched | _none_ | - | 2 | 3021309.0 |
| 3 | `node_types` | `node_types` | 0.23 | 5/6 matched (target 5) | `typescript_node_to_type` | 0/0 matched | _none_ | - | 1 | 2010607.8 |
| 4 | `codebase` | `codebase` | 0.03 | 25/78 matched (target 33) | `dependent_count`, `dependency_count`, `line_count`, `code_lines`, `p`, `to_kebab_case`, `Codebase`, `matched_pairs`, `source_total`, `target_total`, `unmatched_source`, `unmatched_target`, `stub_mismatch_count`, `source_lines`, `target_lines`, `todo_count`, `lint_count`, `source_function_count`, `target_function_count`, `matched_function_count`, `source_test_function_count`, `matched_test_function_count`, `source_type_count`, `target_type_count`, `matched_type_count`, `source_doc_lines`, `target_doc_lines`, `source_doc_comments`, `target_doc_comments`, `function_deficit`, `type_deficit`, `symbol_deficit`, `source_symbol_surface`, `priority_score`, `CodebaseComparator`, `normalize_source_annotation_path`, `join_reasons`, `strip_kotlin_comments_and_strings`, `looks_like_lower_snake_identifier`, `kotlin_contamination_reasons_for_text`, `kotlin_contamination_reasons_for_files`, `in`, `is_test_transliteration`, `source_path_from_transliteration`, `exact_transliteration_header_match_score`, `transliteration_header_match_score`, `matched`, `source_test_count`, `matched_test_count`, `function_name_coverage_with_lang`, `read_file_to_string`, `read_files_to_string`, `type_name_coverage` | 0/0 matched | _none_ | - | 53 | 1537809.8 |
| 5 | `imports` | `imports` | 0.04 | 15/36 matched (target 28) | `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `ImportExtractor`, `file`, `extract_rust_module`, `p`, `extract_python_module`, `get_node_text`, `extract_rust_imports_recursive`, `ct`, `extract_kotlin_package_recursive`, `extract_kotlin_imports_recursive`, `extract_cpp_imports_recursive`, `type_s`, `extract_cpp_namespace_recursive`, `strip_python_import_prefix`, `trim_in_place`, `make_python_import`, `extract_python_imports_recursive` | 0/0 matched | _none_ | - | 21 | 1213609.6 |
| 6 | `porting_utils` | `porting_utils` | 0.07 | 14/29 matched (target 19) | `line_num`, `kt_line_start`, `kt_line_end`, `line_count`, `code_lines`, `comment_lines`, `blank_lines`, `camel_to_snake`, `find_project_root`, `load_rust_source_for_port`, `root_path`, `rust_has_unused_param`, `file`, `p`, `ss` | 0/0 matched | _none_ | - | 15 | 1152909.4 |
| 7 | `similarity` | `similarity` | 0.30 | 12/14 matched (target 25) | `function_parameter_body_cosine_similarity`, `collect_postorder_sample` | 0/0 matched | _none_ | - | 2 | 1021406.9 |
| 8 | `task_manager` | `task_manager [STUB]` | 0.00 | 10/18 matched (target 17) | `FileLock`, `dependent_count`, `dependency_count`, `TaskManager`, `file`, `lock`, `print_assignment`, `status_to_string` | 0/0 matched | _none_ | - | 8 | 81810.0 |

### Excellent Ports (Similarity ≥ 0.85)

These files are well-ported and likely complete. This section is complete, not capped.

_None detected._

### Critical Ports (Similarity < 0.60)

These files need significant work:

- `ast_parser` → `ast_parser` (0.00, 4 deps)
- `tree` → `tree` (0.10, 3 deps)
- `node_types` → `node_types` (0.23, 2 deps)
- `codebase` → `codebase` (0.03, 1 deps)
- `imports` → `imports` (0.04, 1 deps)
- `porting_utils` → `porting_utils` (0.07, 1 deps)
- `similarity` → `similarity` (0.30, 1 deps)
- `task_manager` → `task_manager` (0.00)

## Incorrect Ports (Missing Types)

These files are matched (often via `// port-lint`) but appear to be missing one or more type declarations
present in the Rust source file.

| Source | Target | Missing types | Examples |
|--------|--------|---------------|----------|
| _None detected_ | | | |

## High Priority Missing Files

| Rank | Source file | Deps | Path |
|------|------------|------|------|
| 1 | `tensor` | 2 | `tensor.hpp` |
| 2 | `symbol_extractor` | 1 | `symbol_extractor.hpp` |
| 3 | `transliteration_similarity` | 1 | `transliteration_similarity.hpp` |
| 4 | `port_lint` | 0 | `port_lint.hpp` |
| 5 | `reexport_config` | 0 | `reexport_config.hpp` |
| 6 | `symbol_analysis` | 0 | `symbol_analysis.hpp` |
| 7 | `symbol_extraction` | 0 | `symbol_extraction.hpp` |
| 8 | `tree_lstm` | 0 | `tree_lstm.hpp` |

## Documentation Gaps

There is missing documentation that is hurting overall scoring.

**Documentation coverage:** 0 / 524 lines (0%)

Documentation gaps (>20%), complete list:

- `ast_parser` - 100% gap (161 → 0 lines)
- `porting_utils` - 100% gap (97 → 0 lines)
- `codebase` - 100% gap (79 → 0 lines)
- `similarity` - 100% gap (79 → 0 lines)
- `task_manager` - 100% gap (43 → 0 lines)
- `imports` - 100% gap (39 → 0 lines)
- `node_types` - 100% gap (22 → 0 lines)

