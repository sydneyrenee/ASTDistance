# Immediate Actions - High-Value Files

Based on AST analysis, here are the concrete next steps.

## Summary

- **Current Progress:** 50.0% (9/16 files)
- **Matched Files:** 8
- **Average Similarity:** 0.13
- **Critical Issues:** 8 files with <0.60 function similarity

## Priority 1: Fix Incomplete High-Dependency Files

No incomplete high-dependency files detected.

## Priority 2: Port Missing High-Value Files

Critical missing files (>10 dependencies):

No missing high-value files detected.

## Detailed Work Items

Every matched file is listed below with function and type symbol parity.

### 1. ast_parser

- **Target:** `ast_parser` `[STUB]`
- **Similarity:** 0.00
- **Dependents:** 4
- **Priority Score:** 4537910.0
- **Functions:** 26/79 matched (target 44)
- **Missing functions:** `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `tree_sitter_typescript`, `total_identifiers`, `doc_comment_count`, `line_comment_count`, `block_comment_count`, `total_comment_lines`, `total_doc_lines`, `doc_line_coverage_capped`, `doc_line_balance`, `start_line`, `end_line`, `line_count`, `body_line_count`, `ASTParser`, `file`, `has_stub_bodies`, `type_s`, `has_stub_bodies_in_files`, `get_unmapped_node_types`, `clear_unmapped`, `count_lines`, `tokenize_doc_comment`, `is_import_node`, `is_type_parameter_scope_node`, `ptype`, `node_type`, `detect_stubs_recursive`, `type`, `t`, `child_type`, `op_str`, `is_function_node`, `has_test_attribute`, `sib_type`, `has_kotlin_test_annotation`, `is_inside_cfg_test_mod`, `extract_function_name`, `ct`, `pt`, `extract_function_body_node`, `st`, `is_parameter_container_node`, `node_contains_byte_range`, `collect_function_parameter_nodes`, `extract_function_parameter_nodes`, `make_function_comparison_tree`, `extract_function_comparison_identifiers`, `has_stub_markers_in_node`, `current_type`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 2. tree

- **Target:** `tree`
- **Similarity:** 0.10
- **Dependents:** 3
- **Priority Score:** 3021309.0
- **Functions:** 11/13 matched (target 14)
- **Missing functions:** `node_type`, `Tree`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 3. node_types

- **Target:** `node_types`
- **Similarity:** 0.23
- **Dependents:** 2
- **Priority Score:** 2010607.8
- **Functions:** 5/6 matched (target 5)
- **Missing functions:** `typescript_node_to_type`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 4. codebase

- **Target:** `codebase`
- **Similarity:** 0.03
- **Dependents:** 1
- **Priority Score:** 1537809.8
- **Functions:** 25/78 matched (target 33)
- **Missing functions:** `dependent_count`, `dependency_count`, `line_count`, `code_lines`, `p`, `to_kebab_case`, `Codebase`, `matched_pairs`, `source_total`, `target_total`, `unmatched_source`, `unmatched_target`, `stub_mismatch_count`, `source_lines`, `target_lines`, `todo_count`, `lint_count`, `source_function_count`, `target_function_count`, `matched_function_count`, `source_test_function_count`, `matched_test_function_count`, `source_type_count`, `target_type_count`, `matched_type_count`, `source_doc_lines`, `target_doc_lines`, `source_doc_comments`, `target_doc_comments`, `function_deficit`, `type_deficit`, `symbol_deficit`, `source_symbol_surface`, `priority_score`, `CodebaseComparator`, `normalize_source_annotation_path`, `join_reasons`, `strip_kotlin_comments_and_strings`, `looks_like_lower_snake_identifier`, `kotlin_contamination_reasons_for_text`, `kotlin_contamination_reasons_for_files`, `in`, `is_test_transliteration`, `source_path_from_transliteration`, `exact_transliteration_header_match_score`, `transliteration_header_match_score`, `matched`, `source_test_count`, `matched_test_count`, `function_name_coverage_with_lang`, `read_file_to_string`, `read_files_to_string`, `type_name_coverage`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 5. imports

- **Target:** `imports`
- **Similarity:** 0.04
- **Dependents:** 1
- **Priority Score:** 1213609.6
- **Functions:** 15/36 matched (target 28)
- **Missing functions:** `tree_sitter_rust`, `tree_sitter_kotlin`, `tree_sitter_cpp`, `tree_sitter_python`, `ImportExtractor`, `file`, `extract_rust_module`, `p`, `extract_python_module`, `get_node_text`, `extract_rust_imports_recursive`, `ct`, `extract_kotlin_package_recursive`, `extract_kotlin_imports_recursive`, `extract_cpp_imports_recursive`, `type_s`, `extract_cpp_namespace_recursive`, `strip_python_import_prefix`, `trim_in_place`, `make_python_import`, `extract_python_imports_recursive`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 6. porting_utils

- **Target:** `porting_utils`
- **Similarity:** 0.07
- **Dependents:** 1
- **Priority Score:** 1152909.4
- **Functions:** 14/29 matched (target 19)
- **Missing functions:** `line_num`, `kt_line_start`, `kt_line_end`, `line_count`, `code_lines`, `comment_lines`, `blank_lines`, `camel_to_snake`, `find_project_root`, `load_rust_source_for_port`, `root_path`, `rust_has_unused_param`, `file`, `p`, `ss`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 7. similarity

- **Target:** `similarity`
- **Similarity:** 0.30
- **Dependents:** 1
- **Priority Score:** 1021406.9
- **Functions:** 12/14 matched (target 25)
- **Missing functions:** `function_parameter_body_cosine_similarity`, `collect_postorder_sample`
- **Types:** 0/0 matched
- **Missing types:** _none_

### 8. task_manager

- **Target:** `task_manager` `[STUB]`
- **Similarity:** 0.00
- **Dependents:** 0
- **Priority Score:** 81810.0
- **Functions:** 10/18 matched (target 17)
- **Missing functions:** `FileLock`, `dependent_count`, `dependency_count`, `TaskManager`, `file`, `lock`, `print_assignment`, `status_to_string`
- **Types:** 0/0 matched
- **Missing types:** _none_

## Success Criteria

For each file to be considered "complete":
- **Similarity ≥ 0.85** (Excellent threshold)
- All public APIs ported
- All tests ported
- Documentation ported
- port-lint header present

## Next Commands

```bash
# Initialize task queue for systematic porting
cd tools/ast_distance
./ast_distance --init-tasks ../../include cpp ../../python/ast_distance_py python tasks.json ../../AGENTS.md

# Get next high-priority task
./ast_distance --assign tasks.json <agent-id>
```
