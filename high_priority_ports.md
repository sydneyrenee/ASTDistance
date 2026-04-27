# High Priority Ports - Action Plan

## Files by Impact

Priority = deps * 1,000,000 + SymDeficit * 10,000 + SrcSymbols * 100 + (1 - function similarity) * 10

Dependency fanout is ranked first so the ladder favors ports that clear downstream compilation failures fastest.

This list is complete and includes function/type detail for every matched file.

| Rank | Source | Target | Function similarity | Deps | Functions | Missing functions | Types | Missing types | SymDeficit | SrcSymbols | Priority |
|------|--------|--------|------------|------|-----------|-------------------|-------|---------------|-----------|------------|----------|
| 1 | `ast_parser` | `ast_parser [STUB]` | 0.00 | 4 | 26/79 matched (target 44) | `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `tree_sitter_typescript`, `total_identifiers`, `doc_comment_count`, `line_comment_count`, `block_comment_count`, `total_comment_lines`, `total_doc_lines`, `doc_line_coverage_capped`, `doc_line_balance`, `start_line`, `end_line`, `line_count`, `body_line_count`, `ASTParser`, `file`, `has_stub_bodies`, `type_s`, `has_stub_bodies_in_files`, `get_unmapped_node_types`, `clear_unmapped`, `count_lines`, `tokenize_doc_comment`, `is_import_node`, `is_type_parameter_scope_node`, `ptype`, `node_type`, `detect_stubs_recursive`, `type`, `t`, `child_type`, `op_str`, `is_function_node`, `has_test_attribute`, `sib_type`, `has_kotlin_test_annotation`, `is_inside_cfg_test_mod`, `extract_function_name`, `ct`, `pt`, `extract_function_body_node`, `st`, `is_parameter_container_node`, `node_contains_byte_range`, `collect_function_parameter_nodes`, `extract_function_parameter_nodes`, `make_function_comparison_tree`, `extract_function_comparison_identifiers`, `has_stub_markers_in_node`, `current_type` | 0/0 matched | _none_ | 53 | 79 | 4537910.0 |
| 2 | `tree` | `tree` | 0.10 | 3 | 11/13 matched (target 14) | `node_type`, `Tree` | 0/0 matched | _none_ | 2 | 13 | 3021309.0 |
| 3 | `node_types` | `node_types` | 0.23 | 2 | 5/6 matched (target 5) | `typescript_node_to_type` | 0/0 matched | _none_ | 1 | 6 | 2010607.8 |
| 4 | `codebase` | `codebase` | 0.03 | 1 | 25/78 matched (target 33) | `dependent_count`, `dependency_count`, `line_count`, `code_lines`, `p`, `to_kebab_case`, `Codebase`, `matched_pairs`, `source_total`, `target_total`, `unmatched_source`, `unmatched_target`, `stub_mismatch_count`, `source_lines`, `target_lines`, `todo_count`, `lint_count`, `source_function_count`, `target_function_count`, `matched_function_count`, `source_test_function_count`, `matched_test_function_count`, `source_type_count`, `target_type_count`, `matched_type_count`, `source_doc_lines`, `target_doc_lines`, `source_doc_comments`, `target_doc_comments`, `function_deficit`, `type_deficit`, `symbol_deficit`, `source_symbol_surface`, `priority_score`, `CodebaseComparator`, `normalize_source_annotation_path`, `join_reasons`, `strip_kotlin_comments_and_strings`, `looks_like_lower_snake_identifier`, `kotlin_contamination_reasons_for_text`, `kotlin_contamination_reasons_for_files`, `in`, `is_test_transliteration`, `source_path_from_transliteration`, `exact_transliteration_header_match_score`, `transliteration_header_match_score`, `matched`, `source_test_count`, `matched_test_count`, `function_name_coverage_with_lang`, `read_file_to_string`, `read_files_to_string`, `type_name_coverage` | 0/0 matched | _none_ | 53 | 78 | 1537809.8 |
| 5 | `imports` | `imports` | 0.04 | 1 | 15/36 matched (target 28) | `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `ImportExtractor`, `file`, `extract_rust_module`, `p`, `extract_python_module`, `get_node_text`, `extract_rust_imports_recursive`, `ct`, `extract_kotlin_package_recursive`, `extract_kotlin_imports_recursive`, `extract_cpp_imports_recursive`, `type_s`, `extract_cpp_namespace_recursive`, `strip_python_import_prefix`, `trim_in_place`, `make_python_import`, `extract_python_imports_recursive` | 0/0 matched | _none_ | 21 | 36 | 1213609.6 |
| 6 | `porting_utils` | `porting_utils` | 0.07 | 1 | 14/29 matched (target 19) | `line_num`, `kt_line_start`, `kt_line_end`, `line_count`, `code_lines`, `comment_lines`, `blank_lines`, `camel_to_snake`, `find_project_root`, `load_rust_source_for_port`, `root_path`, `rust_has_unused_param`, `file`, `p`, `ss` | 0/0 matched | _none_ | 15 | 29 | 1152909.4 |
| 7 | `similarity` | `similarity` | 0.30 | 1 | 12/14 matched (target 25) | `function_parameter_body_cosine_similarity`, `collect_postorder_sample` | 0/0 matched | _none_ | 2 | 14 | 1021406.9 |
| 8 | `task_manager` | `task_manager [STUB]` | 0.00 | 0 | 10/18 matched (target 17) | `FileLock`, `dependent_count`, `dependency_count`, `TaskManager`, `file`, `lock`, `print_assignment`, `status_to_string` | 0/0 matched | _none_ | 8 | 18 | 81810.0 |

## Critical Issues (Function Similarity < 0.60 with Dependencies)

These files need immediate attention:

- **ast_parser** → `ast_parser`
  - Function similarity: 0.00
  - Dependencies: 4
  - Functions: 26/79 matched (target 44)
  - Missing functions: `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `tree_sitter_typescript`, `total_identifiers`, `doc_comment_count`, `line_comment_count`, `block_comment_count`, `total_comment_lines`, `total_doc_lines`, `doc_line_coverage_capped`, `doc_line_balance`, `start_line`, `end_line`, `line_count`, `body_line_count`, `ASTParser`, `file`, `has_stub_bodies`, `type_s`, `has_stub_bodies_in_files`, `get_unmapped_node_types`, `clear_unmapped`, `count_lines`, `tokenize_doc_comment`, `is_import_node`, `is_type_parameter_scope_node`, `ptype`, `node_type`, `detect_stubs_recursive`, `type`, `t`, `child_type`, `op_str`, `is_function_node`, `has_test_attribute`, `sib_type`, `has_kotlin_test_annotation`, `is_inside_cfg_test_mod`, `extract_function_name`, `ct`, `pt`, `extract_function_body_node`, `st`, `is_parameter_container_node`, `node_contains_byte_range`, `collect_function_parameter_nodes`, `extract_function_parameter_nodes`, `make_function_comparison_tree`, `extract_function_comparison_identifiers`, `has_stub_markers_in_node`, `current_type`
  - Types: 0/0 matched
  - Missing types: _none_

- **tree** → `tree`
  - Function similarity: 0.10
  - Dependencies: 3
  - Functions: 11/13 matched (target 14)
  - Missing functions: `node_type`, `Tree`
  - Types: 0/0 matched
  - Missing types: _none_

- **node_types** → `node_types`
  - Function similarity: 0.23
  - Dependencies: 2
  - Functions: 5/6 matched (target 5)
  - Missing functions: `typescript_node_to_type`
  - Types: 0/0 matched
  - Missing types: _none_

- **codebase** → `codebase`
  - Function similarity: 0.03
  - Dependencies: 1
  - Functions: 25/78 matched (target 33)
  - Missing functions: `dependent_count`, `dependency_count`, `line_count`, `code_lines`, `p`, `to_kebab_case`, `Codebase`, `matched_pairs`, `source_total`, `target_total`, `unmatched_source`, `unmatched_target`, `stub_mismatch_count`, `source_lines`, `target_lines`, `todo_count`, `lint_count`, `source_function_count`, `target_function_count`, `matched_function_count`, `source_test_function_count`, `matched_test_function_count`, `source_type_count`, `target_type_count`, `matched_type_count`, `source_doc_lines`, `target_doc_lines`, `source_doc_comments`, `target_doc_comments`, `function_deficit`, `type_deficit`, `symbol_deficit`, `source_symbol_surface`, `priority_score`, `CodebaseComparator`, `normalize_source_annotation_path`, `join_reasons`, `strip_kotlin_comments_and_strings`, `looks_like_lower_snake_identifier`, `kotlin_contamination_reasons_for_text`, `kotlin_contamination_reasons_for_files`, `in`, `is_test_transliteration`, `source_path_from_transliteration`, `exact_transliteration_header_match_score`, `transliteration_header_match_score`, `matched`, `source_test_count`, `matched_test_count`, `function_name_coverage_with_lang`, `read_file_to_string`, `read_files_to_string`, `type_name_coverage`
  - Types: 0/0 matched
  - Missing types: _none_

- **imports** → `imports`
  - Function similarity: 0.04
  - Dependencies: 1
  - Functions: 15/36 matched (target 28)
  - Missing functions: `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `ImportExtractor`, `file`, `extract_rust_module`, `p`, `extract_python_module`, `get_node_text`, `extract_rust_imports_recursive`, `ct`, `extract_kotlin_package_recursive`, `extract_kotlin_imports_recursive`, `extract_cpp_imports_recursive`, `type_s`, `extract_cpp_namespace_recursive`, `strip_python_import_prefix`, `trim_in_place`, `make_python_import`, `extract_python_imports_recursive`
  - Types: 0/0 matched
  - Missing types: _none_

- **porting_utils** → `porting_utils`
  - Function similarity: 0.07
  - Dependencies: 1
  - Functions: 14/29 matched (target 19)
  - Missing functions: `line_num`, `kt_line_start`, `kt_line_end`, `line_count`, `code_lines`, `comment_lines`, `blank_lines`, `camel_to_snake`, `find_project_root`, `load_rust_source_for_port`, `root_path`, `rust_has_unused_param`, `file`, `p`, `ss`
  - Types: 0/0 matched
  - Missing types: _none_

- **similarity** → `similarity`
  - Function similarity: 0.30
  - Dependencies: 1
  - Functions: 12/14 matched (target 25)
  - Missing functions: `function_parameter_body_cosine_similarity`, `collect_postorder_sample`
  - Types: 0/0 matched
  - Missing types: _none_

## Missing Files (by Dependents)

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

