#pragma once

#include <fnmatch.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace ast_distance {

/**
 * Optional config loaded from ast_distance.config.json.
 *
 * reexport_modules marks source files that are declarations-only wiring
 * modules. They are still reported as consult points, but they are filtered
 * out of normal priority/missing ladders so they do not look like logic ports.
 */
struct ReexportConfig {
    std::vector<std::string> patterns;
    std::string config_path;
    bool loaded = false;
    bool had_parse_error = false;

    bool matches(const std::string& relative_path) const {
        if (!loaded || patterns.empty()) return false;
        std::filesystem::path rel(relative_path);
        std::string basename = rel.filename().string();
        for (const auto& pat : patterns) {
            int flags = 0;
            const std::string* target = &basename;
            if (pat.find('/') != std::string::npos) {
                flags = FNM_PATHNAME;
                target = &relative_path;
            }
            if (::fnmatch(pat.c_str(), target->c_str(), flags) == 0) {
                return true;
            }
        }
        return false;
    }
};

inline const char* default_reexport_config_path() {
    return "ast_distance.config.json";
}

inline bool load_reexport_config(const std::string& path, ReexportConfig& cfg) {
    cfg.config_path = path;
    cfg.loaded = false;
    cfg.had_parse_error = false;
    cfg.patterns.clear();

    std::ifstream file(path);
    if (!file.is_open()) return false;

    std::stringstream buffer;
    buffer << file.rdbuf();
    std::string content = buffer.str();

    const std::string key = "\"reexport_modules\"";
    size_t pos = content.find(key);
    if (pos == std::string::npos) {
        cfg.loaded = true;
        return true;
    }

    pos = content.find(':', pos + key.size());
    if (pos == std::string::npos) {
        cfg.had_parse_error = true;
        std::cerr << "Warning: " << path << " has reexport_modules but no ':' follows.\n";
        return true;
    }
    pos = content.find('[', pos);
    if (pos == std::string::npos) {
        cfg.had_parse_error = true;
        std::cerr << "Warning: " << path << " has reexport_modules but no '[' follows.\n";
        return true;
    }
    size_t end = content.find(']', pos);
    if (end == std::string::npos) {
        cfg.had_parse_error = true;
        std::cerr << "Warning: " << path << " has reexport_modules array with no closing ']'.\n";
        return true;
    }

    std::string array_body = content.substr(pos + 1, end - pos - 1);
    size_t i = 0;
    while (i < array_body.size()) {
        if (array_body[i] != '"') {
            ++i;
            continue;
        }
        ++i;
        std::string value;
        while (i < array_body.size() && array_body[i] != '"') {
            if (array_body[i] == '\\' && i + 1 < array_body.size()) {
                char next = array_body[i + 1];
                if (next == '"' || next == '\\' || next == '/') {
                    value += next;
                    i += 2;
                    continue;
                }
            }
            value += array_body[i++];
        }
        if (i < array_body.size()) ++i;
        if (!value.empty()) cfg.patterns.push_back(value);
    }

    cfg.loaded = true;
    return true;
}

} // namespace ast_distance
