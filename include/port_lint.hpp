#pragma once

#include <string>
#include <optional>
#include <regex>
#include <fstream>
#include <filesystem>

namespace fs = std::filesystem;

/**
 * Port-lint support for tracking Rust -> Kotlin provenance.
 *
 * Supports these comment annotations:
 *
 * PROVENANCE:
 *   // port-lint: source core/src/codex.rs
 *   // port-lint: tests core/src/codex.rs (for test files)
 *
 * Based on tools/port_linter.py
 */

namespace port_lint {

/**
 * Extract port-lint source annotation from a Kotlin file.
 *
 * Searches the first 50 lines for:
 *   // port-lint: source <path>
 *   // port-lint: tests <path>
 *
 * Returns the Rust source path if found (e.g., "core/src/codex.rs")
 */
inline std::optional<std::string> extract_source_annotation(const fs::path& file_path) {
    std::ifstream file(file_path);
    if (!file.is_open()) {
        return std::nullopt;
    }

    // Regex: // port-lint: source <path> OR // port-lint: tests <path>
    //
    // NOTE: Some ports append extra qualifiers after the path (e.g. "(tests)").
    // For matching purposes we only want the path token.
    std::regex pattern(R"(//\s*port-lint:\s*(?:source|tests)\s+([^\s]+))", std::regex::icase);
    
    std::string line;
    int line_count = 0;
    while (std::getline(file, line) && line_count++ < 50) {
        std::smatch match;
        if (std::regex_search(line, match, pattern)) {
            std::string path_str = match[1].str();
            // Trim whitespace
            path_str.erase(0, path_str.find_first_not_of(" \t\r\n"));
            path_str.erase(path_str.find_last_not_of(" \t\r\n") + 1);
            return path_str;
        }
    }
    
    return std::nullopt;
}

} // namespace port_lint
